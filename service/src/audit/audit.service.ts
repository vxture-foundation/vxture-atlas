import { BadRequestException, Injectable, Logger } from "@nestjs/common";

import { prisma } from "../prisma";

/**
 * The operator change trail (product_250 M-5).
 *
 * Writes are append-only at the database level, not by convention: the service
 * role holds INSERT and SELECT on `audit.change_records` and nothing else, so
 * no code path here - present or future - can amend or remove a row.
 */

export interface AuditEntry {
  objectType: string;
  objectId: string | null;
  action: string;
  actorId: string;
  actorConsole?: string;
  changedFields: string[];
  requestId?: string;
  outcome: "success" | "failure";
}

export interface AuditRecord {
  eventId: string;
  objectType: string;
  objectId: string | null;
  action: string;
  actorId: string;
  actorConsole: string | null;
  changedFields: string[];
  requestId: string | null;
  outcome: string;
  occurredAt: Date;
}

export interface AuditSearchQuery {
  objectType?: string;
  objectId?: string;
  actorId?: string;
  action?: string;
  outcome?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

export interface AuditSearchResult {
  items: AuditRecord[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const OUTCOMES = new Set(["success", "failure"]);

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Never throws into the caller.
   *
   * The alternative - failing the request when the audit write fails - would
   * mean a full audit partition or a transient database blip takes the whole
   * operator plane down. That trade is wrong for a *change* trail: losing the
   * record of a deactivation is bad, but refusing to let an operator
   * deactivate a failing provider during an incident is worse. The failure is
   * logged at error level so the gap is visible rather than silent.
   *
   * (`reqlog` makes the same call for the same reason - see
   * `request-log.service.ts`.)
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await prisma.changeRecord.create({
        data: {
          objectType: entry.objectType.slice(0, 64),
          objectId: entry.objectId?.slice(0, 128) ?? null,
          action: entry.action.slice(0, 32),
          actorId: entry.actorId.slice(0, 128),
          actorConsole: entry.actorConsole?.slice(0, 128) ?? null,
          changedFields: entry.changedFields,
          requestId: entry.requestId?.slice(0, 128) ?? null,
          outcome: entry.outcome,
        },
      });
    } catch (error) {
      this.logger.error(
        `audit write failed for ${entry.action} ${entry.objectType}/${
          entry.objectId ?? "-"
        } by ${entry.actorId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * `GET /capability/audit-logs`. Cursor-paginated on `(occurredAt, id)` DESC,
   * the same shape `/capability/logs` uses - this is the second unbounded
   * table on the operator plane, and it grows for as long as the platform is
   * operated.
   */
  async search(query: AuditSearchQuery): Promise<AuditSearchResult> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const from = parseDate(query.from, "from");
    const to = parseDate(query.to, "to");

    if (query.outcome !== undefined && !OUTCOMES.has(query.outcome)) {
      throw new BadRequestException({
        code: "AUDIT_INVALID_OUTCOME",
        message: 'outcome must be "success" or "failure"',
        field: "outcome",
      });
    }

    const rows = await prisma.changeRecord.findMany({
      where: {
        ...(query.objectType ? { objectType: query.objectType } : {}),
        ...(query.objectId ? { objectId: query.objectId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, eventId: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { eventId: "desc" }],
      take: limit,
    });

    const last = rows[rows.length - 1];
    return {
      items: rows,
      // A full page is not proof of a next one, but claiming "no more" on a
      // full page is the error that silently truncates a trail, so a short
      // page is the only thing treated as the end.
      nextCursor: last && rows.length === limit ? encodeCursor(last) : null,
    };
  }
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException({
      code: "AUDIT_INVALID_LIMIT",
      message: "limit must be a positive integer",
      field: "limit",
    });
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      code: "AUDIT_INVALID_DATE",
      message: `${field} must be an ISO 8601 timestamp`,
      field,
    });
  }
  return parsed;
}

/** Opaque on purpose, same reasoning as the reqlog cursor. */
/**
 * The cursor payload deliberately keeps its `id` key through the X-3 rename.
 * It is opaque to callers (base64 of a private shape), so the name inside it is
 * not part of any contract - and renaming it would invalidate every cursor a
 * console is currently holding, 400-ing in-flight "load more" for no gain.
 * Only the FIELD it reads from moved.
 */
function encodeCursor(row: { occurredAt: Date; eventId: string }): string {
  return Buffer.from(
    JSON.stringify({ occurredAt: row.occurredAt.toISOString(), id: row.eventId }),
  ).toString("base64url");
}

function decodeCursor(
  raw: string | undefined,
): { occurredAt: Date; id: string } | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString()) as {
      occurredAt?: unknown;
      id?: unknown;
    };
    const occurredAt = new Date(String(parsed.occurredAt));
    if (Number.isNaN(occurredAt.getTime()) || typeof parsed.id !== "string") {
      throw new Error("malformed cursor payload");
    }
    return { occurredAt, id: parsed.id };
  } catch {
    throw new BadRequestException({
      code: "AUDIT_INVALID_CURSOR",
      message: "cursor is not a valid pagination token",
      field: "cursor",
    });
  }
}
