import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from "@nestjs/common";

import { rejectUnknownFilters } from "../http-query";
import {
  OperatorAuthGuard,
  type OperatorAuthenticatedRequest,
} from "../runtime/guards/operator-auth.guard";
import {
  HealthSettingsService,
  type HealthSettingsView,
  type ProbeSettingOverride,
} from "./health-settings.service";
import type { EffectiveProbeSettings } from "./probe-settings";
import {
  ServiceHealthService,
  type HealthEventView,
  type ServiceHealthView,
} from "./service-health.service";

const HEALTH_FILTERS = [] as const;
const EVENT_FILTERS = ["after", "limit"] as const;
const SETTINGS_FILTERS = [] as const;

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
    @Inject(HealthSettingsService)
    private readonly settings: HealthSettingsService,
  ) {}

  /** Probe settings: the global level, every override, and what each target runs with. */
  @Get("health-settings")
  listSettings(@Query() all: Record<string, string>): Promise<HealthSettingsView> {
    rejectUnknownFilters(all, SETTINGS_FILTERS, "HEALTH_UNKNOWN_FILTER");
    return this.settings.view();
  }

  /**
   * `:subject` is `model:<model_code>` or `provider:<provider_code>`. Body:
   * `probeIntervalMinutes` (5-60) and/or `probeEnabled`; `null` clears an
   * override so the level above applies. The writer comes from the verified
   * operator token, never the body.
   */
  @Patch("health-settings/:subject")
  updateSettings(
    @Param("subject") subject: string,
    @Body() body: unknown,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<{ override: ProbeSettingOverride; effective: EffectiveProbeSettings }> {
    return this.settings.update(subject, body, req.operatorAuth?.operatorId);
  }

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
