import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import { ModelRegistryRepository } from "../registry/model-registry.repository";
import type {
  ErrorLogRecord,
  RequestLogRecord,
} from "../reqlog/request-log.types";
import {
  COST_ROLLUP_BASIS,
  computeCostRollup,
  type CostRollupResult,
} from "./cost-rollup";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const VALID_STATUSES = new Set(["success", "error", "timeout"]);

const WINDOW_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export interface LogCostQuery {
  window?: string;
  modelCode?: string;
  providerCode?: string;
}

export interface LogCostResult extends CostRollupResult {
  from: string;
  to: string;
  /** Travels with the numbers; see COST_ROLLUP_BASIS. */
  basis: typeof COST_ROLLUP_BASIS;
}

export interface LogSearchQuery {
  tenantId?: string;
  modelCode?: string;
  providerCode?: string;
  endpointCode?: string;
  status?: string;
  requestId?: string;
  /** product_251 X-2: "everything this agent task did". */
  taskId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

/**
 * Counts leave here as plain numbers, not the BigInt Prisma reads from the
 * BIGINT columns: JSON.stringify rejects BigInt outright, so a raw row would
 * 500 the whole page - after the query has already run. Counts sit far below
 * 2^53, so Number is lossless.
 *
 * The conversion is applied to whatever bigint the row actually carries
 * (`toSerializableRow`), not to a hand-kept column list. The query selects no
 * explicit column set, so every BIGINT column added to `reqlog.request_records`
 * arrives here automatically - `billed_amount` did, and a list would have kept
 * missing it until the first billed row made the page 500 (vxture-atlas#193).
 */
export interface LogSearchResultRow
  extends Omit<
    RequestLogRecord,
    "inputTokens" | "outputTokens" | "totalTokens"
  > {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  error: ErrorLogRecord | null;
}

export interface LogSearchResult {
  items: LogSearchResultRow[];
  nextCursor: string | null;
}

export interface LogSummaryQuery {
  window?: string;
  modelCode?: string;
  providerCode?: string;
  endpointCode?: string;
}

/**
 * `endpointCode: null` is a real group, not a gap: it is every call routed by
 * an explicit `modelCode`/`taskProfile` rather than through an entry point,
 * plus every row written before `incr/03_reqlog_endpoint_code.sql`. It is
 * reported as its own bucket rather than dropped, so the group counts still
 * add up to `overall` - a UI that hides it would silently under-report.
 */
interface LogSummaryGroup {
  modelCode: string | null;
  providerCode: string | null;
  endpointCode: string | null;
  requests: number;
  errors: number;
  errorRate: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

type LogSummaryTotals = Omit<
  LogSummaryGroup,
  "modelCode" | "providerCode" | "endpointCode"
>;

/**
 * The wire shape of `/capability/logs/summary` (product_251 A-4).
 *
 * A-4 decides envelope-vs-bare-array by one test: did the server *resolve*
 * something the caller must be told about? Here it did - `window` defaults to
 * `24h`, so a caller that sent no window has no other way to learn which 24
 * hours it got. Hence an envelope, carrying the resolved window.
 *
 * The field names are A-4's, not this module's: `from`/`to` for the resolved
 * window and `items` for the collection, matching runos `/audit/usage-summaries`.
 * They used to be `windowStart`/`windowEnd`/`byGroup` - three private words for
 * two concepts runos already had words for, which is how an operator ends up
 * reading two aggregates that mean the same thing and look nothing alike.
 *
 * `overall` stays. It is a peer aggregate, not the collection, and A-4 only
 * fixes the collection key. It deliberately carries no token sum of its own -
 * see the note in `summarize()`.
 */
export interface LogSummaryResult {
  from: string;
  to: string;
  overall: LogSummaryTotals;
  items: LogSummaryGroup[];
}

/**
 * Cursor is opaque to the caller on purpose - base64(JSON) rather than a raw
 * `createdAt_id` string, so callers can't be tempted to hand-construct one
 * (e.g. "give me everything after midnight" by guessing the format) and so
 * the encoding can change later without being a contract break.
 */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { createdAt: string; id: string };
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !parsed.id) {
      throw new Error("malformed");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException({
      code: "OBSERVABILITY_INVALID_CURSOR",
      message: "cursor is malformed or expired",
    });
  }
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      code: "OBSERVABILITY_INVALID_DATE",
      message: `${field} must be an ISO8601 date`,
      field,
    });
  }
  return parsed;
}

@Injectable()
export class ObservabilityService {
  constructor(
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
  ) {}

  async searchLogs(query: LogSearchQuery): Promise<LogSearchResult> {
    if (query.status !== undefined && !VALID_STATUSES.has(query.status)) {
      throw new BadRequestException({
        code: "OBSERVABILITY_INVALID_STATUS",
        message: `status must be one of ${[...VALID_STATUSES].join(", ")}`,
        field: "status",
      });
    }

    const limit = clampLimit(query.limit);
    const from = parseDate(query.from, "from");
    const to = parseDate(query.to, "to");
    const rows = await this.repository.searchRequestLogs({
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.modelCode ? { modelCode: query.modelCode } : {}),
      ...(query.providerCode ? { providerCode: query.providerCode } : {}),
      ...(query.endpointCode ? { endpointCode: query.endpointCode } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestId ? { requestId: query.requestId } : {}),
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
      // Fetch one extra row purely to know whether a next page exists,
      // without the caller having to make a throwaway request to find out.
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const failedRequestIds = page
      .filter((row) => row.status !== "success")
      .map((row) => row.requestId);
    const errors = await this.repository.findErrorRecordsByRequestIds(
      failedRequestIds,
    );
    const errorByRequestId = new Map(errors.map((e) => [e.requestId, e]));

    const lastRow = page[page.length - 1];

    return {
      items: page.map((row) => ({
        ...toSerializableRow(row),
        error: errorByRequestId.get(row.requestId) ?? null,
      })),
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    };
  }

  async summarize(query: LogSummaryQuery): Promise<LogSummaryResult> {
    const windowKey = query.window ?? "24h";
    const windowMs = WINDOW_MS[windowKey];
    if (!windowMs) {
      throw new BadRequestException({
        code: "OBSERVABILITY_INVALID_WINDOW",
        message: `window must be one of ${Object.keys(WINDOW_MS).join(", ")}`,
        field: "window",
      });
    }

    const to = new Date();
    const from = new Date(to.getTime() - windowMs);

    const { overall, byGroup } = await this.repository.summarizeRequestLogs({
      from,
      to,
      ...(query.modelCode ? { modelCode: query.modelCode } : {}),
      ...(query.providerCode ? { providerCode: query.providerCode } : {}),
      ...(query.endpointCode ? { endpointCode: query.endpointCode } : {}),
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      // `overall` has no token sum of its own - it comes from a separate
      // aggregate that predates this field. Summing the groups would be a
      // second source of truth for the same number, so it is left to the
      // caller to add up `items` when it wants a window total.
      overall: toSummaryNumbers(overall),
      // The repository keeps calling its half `byGroup` - that name is correct
      // for the storage layer, and A-4 only governs the wire.
      items: byGroup.map((group) => ({
        modelCode: group.modelCode,
        providerCode: group.providerCode,
        endpointCode: group.endpointCode,
        ...toSummaryNumbers(group),
      })),
    };
  }

  /**
   * TD-047. What the traffic in a window cost, as an estimate for the internal
   * pool - never an invoice, and never the tenant-facing quota.
   *
   * Its own route rather than extra fields on `logs/summary`, deliberately:
   * `logs/summary` is a published response shape, and product_251 A-4 makes
   * changing one a three-party conversation. Adding a route is unilateral, and
   * a cost estimate wants its own `basis` beside it anyway - a reader who does
   * not know reasoning tokens are excluded from the sum will reconcile against
   * the provider's invoice and conclude the meter is broken.
   */
  async summarizeCost(query: LogCostQuery): Promise<LogCostResult> {
    const windowKey = query.window ?? "24h";
    const windowMs = WINDOW_MS[windowKey];
    if (!windowMs) {
      throw new BadRequestException({
        code: "OBSERVABILITY_INVALID_WINDOW",
        message: `window must be one of ${Object.keys(WINDOW_MS).join(", ")}`,
        field: "window",
      });
    }

    const to = new Date();
    const from = new Date(to.getTime() - windowMs);

    const rows = await this.repository.summarizeRequestCost({
      from,
      to,
      ...(query.modelCode ? { modelCode: query.modelCode } : {}),
      ...(query.providerCode ? { providerCode: query.providerCode } : {}),
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      basis: COST_ROLLUP_BASIS,
      ...computeCostRollup(rows),
    };
  }
}

/**
 * See `LogSearchResultRow`. Converts every bigint the row carries, so a new
 * BIGINT column cannot reintroduce the 500 by being forgotten here. NULL stays
 * NULL - an absent count and a zero count are different facts.
 */
function toSerializableRow(row: RequestLogRecord): LogSearchResultRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out as unknown as LogSearchResultRow;
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException({
      code: "OBSERVABILITY_INVALID_LIMIT",
      message: "limit must be a positive integer",
      field: "limit",
    });
  }
  return Math.min(parsed, MAX_LIMIT);
}

function toSummaryNumbers(group: {
  requests: bigint;
  errors: bigint;
  totalTokens?: bigint;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}): LogSummaryTotals {
  const requests = Number(group.requests);
  const errors = Number(group.errors);
  return {
    requests,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
    totalTokens: Number(group.totalTokens ?? 0n),
    // Postgres avg() over an integer column yields `numeric`, which Prisma
    // surfaces as Decimal and serializes as a JSON string; p95 is `double
    // precision` and arrives as a real number. Both must leave as numbers.
    avgLatencyMs:
      group.avgLatencyMs === null ? null : Number(group.avgLatencyMs),
    p95LatencyMs: group.p95LatencyMs,
  };
}
