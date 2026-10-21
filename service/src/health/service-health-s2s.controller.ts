import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { rejectUnknownFilters } from "../http-query";
import { HealthReadGuard } from "../runtime/guards/health-read.guard";
import {
  ServiceHealthService,
  type ServiceHealthView,
  type HealthEventView,
} from "./service-health.service";

const HEALTH_FILTERS = [] as const;
const EVENT_FILTERS = ["after", "limit"] as const;

/**
 * S2S health read (platform#562). Same `ServiceHealthView` the operator plane
 * serves at `/capability/health`, but mounted at `/s2s/health` behind
 * `HealthReadGuard` (scope `health:atlas`, `mode=service`) so the platform's
 * unattended watchdog can poll it with a service token — no operator session.
 *
 * Mounted OUTSIDE `/capability` on purpose: `OperatorAuthGuard` and the
 * capability-write `AuditMiddleware` are left untouched, and the management
 * plane is not widened. Both snapshot and ordered transitions are read-only;
 * settings writes remain on the operator plane.
 */
@Controller("s2s")
@UseGuards(HealthReadGuard)
export class ServiceHealthS2sController {
  constructor(
    @Inject(ServiceHealthService)
    private readonly health: ServiceHealthService,
  ) {}

  @Get("health")
  current(@Query() all: Record<string, string>): Promise<ServiceHealthView> {
    rejectUnknownFilters(all, HEALTH_FILTERS, "HEALTH_UNKNOWN_FILTER");
    return this.health.current();
  }

  /** Read the existing durable feed under the same health-only machine scope. */
  @Get("health/events")
  events(@Query() all: Record<string, string>): Promise<{
    items: HealthEventView[];
    nextCursor: string | null;
  }> {
    rejectUnknownFilters(all, EVENT_FILTERS, "HEALTH_UNKNOWN_FILTER");
    return this.health.events({
      ...(all["after"] !== undefined ? { after: all["after"] } : {}),
      ...(all["limit"] !== undefined ? { limit: all["limit"] } : {}),
    });
  }
}
