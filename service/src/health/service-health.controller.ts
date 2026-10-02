import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { rejectUnknownFilters } from "../http-query";
import { OperatorAuthGuard } from "../runtime/guards/operator-auth.guard";
import {
  ServiceHealthService,
  type HealthEventView,
  type ServiceHealthView,
} from "./service-health.service";

const HEALTH_FILTERS = [] as const;
const EVENT_FILTERS = ["after", "limit"] as const;

/**
 * Vendor model and route health (ADR-013, design 120 section 6). Operator
 * plane: the platform's watcher pulls current state and the transitions after
 * its cursor, and turns them into admin notices.
 */
@Controller("capability")
@UseGuards(OperatorAuthGuard)
export class ServiceHealthController {
  constructor(
    @Inject(ServiceHealthService)
    private readonly health: ServiceHealthService,
  ) {}

  @Get("health")
  current(@Query() all: Record<string, string>): Promise<ServiceHealthView> {
    rejectUnknownFilters(all, HEALTH_FILTERS, "HEALTH_UNKNOWN_FILTER");
    return this.health.current();
  }

  @Get("health/events")
  events(
    @Query() all: Record<string, string>,
    @Query("after") after?: string,
    @Query("limit") limit?: string,
  ): Promise<{ items: HealthEventView[]; nextCursor: string | null }> {
    rejectUnknownFilters(all, EVENT_FILTERS, "HEALTH_UNKNOWN_FILTER");
    return this.health.events({
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}
