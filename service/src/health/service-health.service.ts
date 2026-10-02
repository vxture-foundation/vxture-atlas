import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import { prisma } from "../prisma";
import { routeSeverity, type HealthSeverity } from "./health-state";
import { evaluateRoute, type RouteConfigIssue } from "./route-config";
import { PrismaHealthStore } from "./health.store";
import { upstreamHealth } from "./upstream-health";
import { VendorBalanceMonitor, type VendorBalanceView } from "./vendor-balance.monitor";

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

export interface ServiceHealthView {
  generatedAt: string;
  models: {
    modelCode: string;
    providerCode: string;
    state: string;
    since: string;
    upstreamStatus?: number;
    detail?: string;
  }[];
  routes: {
    code: string;
    state: string;
    severity: HealthSeverity | null;
    primary: { modelCode: string; state: string };
    fallback: { modelCode: string; state: string } | null;
    /** A named model that cannot serve this route, and why (design 120 section 4.4). Empty = none found. */
    configIssues: RouteConfigIssue[];
  }[];
  /** Vendor balances (P1): ok / balance_low / not_supported / unknown, with the thresholds in effect. */
  vendors: VendorBalanceView[];
}

export interface HealthEventView {
  id: string;
  createdAt: string;
  subjectKind: string;
  subjectKey: string;
  providerCode: string | null;
  from: string;
  to: string;
  severity: string;
  upstreamStatus: number | null;
  detail: string | null;
  affectedRoutes: string[];
}

function refuse(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message, retryable: false });
}

/** Opaque cursor: the (created_at, id) of the last event the caller has. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = new Date(iso ?? "");
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw refuse("HEALTH_INVALID_CURSOR", "cursor is not one this endpoint issued");
  }
  return { createdAt, id };
}

/**
 * The operator-plane read of `upstreamHealth` (ADR-013, design 120 section 6).
 * The platform's server-side watcher pulls both: current state, and the
 * transitions after the cursor it last kept.
 */
@Injectable()
export class ServiceHealthService {
  private readonly store = new PrismaHealthStore();

  constructor(@Inject(VendorBalanceMonitor) private readonly balances: VendorBalanceMonitor) {}

  /**
   * Current state. Routes are evaluated now, from the routes as configured
   * this moment, so a route that has never changed state still appears.
   */
  async current(): Promise<ServiceHealthView> {
    const snapshot = upstreamHealth.snapshot();
    const [routes, vendors] = await Promise.all([this.store.listRoutes(), this.balances.view()]);
    const stateOf = (code: string): string => upstreamHealth.modelState(code) ?? "unknown";

    return {
      generatedAt: new Date().toISOString(),
      models: snapshot.models.map((m) => ({
        modelCode: m.modelCode,
        providerCode: m.providerCode,
        state: m.state,
        since: m.since.toISOString(),
        ...(m.upstreamStatus !== undefined ? { upstreamStatus: m.upstreamStatus } : {}),
        ...(m.detail !== undefined ? { detail: m.detail } : {}),
      })),
      routes: routes.map((r) => {
        const state = evaluateRoute(r, (code) => upstreamHealth.modelState(code));
        return {
          code: r.code,
          state,
          severity: state === "ok" ? null : routeSeverity(state),
          primary: { modelCode: r.primary, state: stateOf(r.primary) },
          fallback: r.fallback ? { modelCode: r.fallback, state: stateOf(r.fallback) } : null,
          configIssues: r.configIssues ?? [],
        };
      }),
      vendors,
    };
  }

  async events(query: { after?: string; limit?: string }): Promise<{
    items: HealthEventView[];
    nextCursor: string | null;
  }> {
    const limit = query.limit === undefined ? DEFAULT_EVENT_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      throw refuse("HEALTH_INVALID_LIMIT", `limit must be an integer from 1 to ${MAX_EVENT_LIMIT}`);
    }
    const after = query.after !== undefined ? decodeCursor(query.after) : undefined;
    const where = after
      ? {
          OR: [
            { createdAt: { gt: after.createdAt } },
            { createdAt: after.createdAt, id: { gt: after.id } },
          ],
        }
      : undefined;

    const rows = await prisma.healthEvent.findMany({
      ...(where ? { where } : {}),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    const last = rows.at(-1);
    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        subjectKind: r.subjectKind,
        subjectKey: r.subjectKey,
        providerCode: r.providerCode,
        from: r.fromState,
        to: r.toState,
        severity: r.severity,
        upstreamStatus: r.upstreamStatus,
        detail: r.detail,
        affectedRoutes: r.affectedRoutes,
      })),
      // A full page may have more behind it; an empty or short page is the end
      // for now. The watcher keeps the last cursor it saw and asks again later.
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : (query.after ?? null),
    };
  }
}
