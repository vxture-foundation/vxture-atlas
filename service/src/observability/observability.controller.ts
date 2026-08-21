import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { OperatorAuthGuard } from "../runtime/guards/operator-auth.guard";
import {
  ObservabilityService,
  type LogSearchResult,
  type LogSummaryResult,
} from "./observability.service";
import { rejectUnknownFilters } from "../http-query";

/**
 * Operator-facing read layer over `reqlog` (`RequestLogService` owns the
 * writes; this is the first thing that reads them back). Guarded the same
 * as every other `/capability/*` admin surface - operator tooling, not S2S.
 */
/**
 * Same reason as the audit surface: an unrecognised filter here would return a
 * page the caller did not ask for, with a 200. `taskId` was added to this list
 * the day the column landed - a filter that exists in the service but not in
 * this list would be refused, which is loud, and the reverse would be silent.
 */
const LOG_FILTERS = [
  "tenantId",
  "modelCode",
  "providerCode",
  "endpointCode",
  "status",
  "requestId",
  "taskId",
  "from",
  "to",
  "cursor",
  "limit",
] as const;

const SUMMARY_FILTERS = [
  "window",
  "modelCode",
  "providerCode",
  "endpointCode",
] as const;

@Controller("capability")
@UseGuards(OperatorAuthGuard)
export class ObservabilityController {
  constructor(
    @Inject(ObservabilityService)
    private readonly observability: ObservabilityService,
  ) {}

  @Get("logs")
  searchLogs(
    @Query() all: Record<string, string>,
    @Query("tenantId") tenantId?: string,
    @Query("modelCode") modelCode?: string,
    @Query("providerCode") providerCode?: string,
    @Query("endpointCode") endpointCode?: string,
    @Query("status") status?: string,
    @Query("requestId") requestId?: string,
    @Query("taskId") taskId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<LogSearchResult> {
    rejectUnknownFilters(all, LOG_FILTERS, "OBSERVABILITY_UNKNOWN_FILTER");
    return this.observability.searchLogs({
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(modelCode !== undefined ? { modelCode } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(endpointCode !== undefined ? { endpointCode } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Get("logs/summary")
  summarize(
    @Query() all: Record<string, string>,
    @Query("window") window?: string,
    @Query("modelCode") modelCode?: string,
    @Query("providerCode") providerCode?: string,
    @Query("endpointCode") endpointCode?: string,
  ): Promise<LogSummaryResult> {
    rejectUnknownFilters(all, SUMMARY_FILTERS, "OBSERVABILITY_UNKNOWN_FILTER");
    return this.observability.summarize({
      ...(window !== undefined ? { window } : {}),
      ...(modelCode !== undefined ? { modelCode } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(endpointCode !== undefined ? { endpointCode } : {}),
    });
  }
}
