import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { OperatorAuthGuard } from "../runtime/guards/operator-auth.guard";
import { AuditService, type AuditSearchResult } from "./audit.service";
import { rejectUnknownFilters } from "../http-query";

/**
 * The filters this endpoint understands. Anything else is refused rather than
 * ignored - see `rejectUnknownFilters` for why that matters most on an audit
 * search, and why it matters MORE the week a filter gets renamed.
 */
const AUDIT_FILTERS = [
  "objectType",
  "objectId",
  "actorId",
  "action",
  "outcome",
  "from",
  "to",
  "cursor",
  "limit",
] as const;

/**
 * Read side of the operator change trail (product_250 M-5).
 *
 * Deliberately read-only: there is no route here that writes, amends or
 * deletes a record, and the service role could not honour one if there were.
 * The writes come from `AuditMiddleware` (registered `forRoutes("*")` in
 * atlas.module.ts), off the requests being audited. Middleware and not an
 * interceptor on purpose: the record is written from `res.on("finish")`, so
 * the outcome is the status the client actually received, and a guard-rejected
 * write is still recorded (as `actorId: "unknown"`) because middleware runs
 * ahead of the guard chain. An interceptor would see neither.
 */
@Controller("capability")
@UseGuards(OperatorAuthGuard)
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /**
   * "Who deactivated this provider, and when" - filter by
   * `objectType=providers&objectId=<id>` and read the newest row.
   */
  @Get("audit-logs")
  searchAuditLogs(
    @Query() all: Record<string, string>,
    @Query("objectType") objectType?: string,
    @Query("objectId") objectId?: string,
    @Query("actorId") actorId?: string,
    @Query("action") action?: string,
    @Query("outcome") outcome?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<AuditSearchResult> {
    rejectUnknownFilters(all, AUDIT_FILTERS, "AUDIT_UNKNOWN_FILTER");
    return this.audit.search({
      ...(objectType !== undefined ? { objectType } : {}),
      ...(objectId !== undefined ? { objectId } : {}),
      ...(actorId !== undefined ? { actorId } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}
