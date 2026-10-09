import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { rejectUnknownFilters } from "../http-query";
import { HealthReadGuard } from "../runtime/guards/health-read.guard";
import {
  ServiceHealthService,
  type ServiceHealthView,
} from "./service-health.service";

const HEALTH_FILTERS = [] as const;

/**
 * S2S health read (platform#562). Same `ServiceHealthView` the operator plane
 * serves at `/capability/health`, but mounted at `/s2s/health` behind
 * `HealthReadGuard` (scope `health:atlas`, `mode=service`) so the platform's
 * unattended watchdog can poll it with a service token — no operator session.
 *
 * Mounted OUTSIDE `/capability` on purpose: `OperatorAuthGuard` and the
 * capability-write `AuditMiddleware` are left untouched, and the management
 * plane is not widened. Read-only; no settings edit, no events feed here
 * (the watchdog works off the snapshot + its own dedup, not a cursor).
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
}
