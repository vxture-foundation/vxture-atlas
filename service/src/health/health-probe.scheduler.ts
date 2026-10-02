import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { prisma } from "../prisma";
import { ModelRegistryService } from "../registry/model-registry.service";
import { ModelProbeService } from "../runtime/model-probe.service";
import type { AiModelRecord } from "../types/runtime.types";
import { PrismaHealthStore } from "./health.store";
import {
  effectiveProbeSettings,
  readGlobalProbeSettings,
  type GlobalProbeSettings,
  type ProbeSettingRow,
} from "./probe-settings";
import { upstreamHealth } from "./upstream-health";

const TICK_MS = 60_000;
const CONCURRENCY = 3;

/**
 * health-probe.scheduler.ts - active probes (ADR-013, design 120 section 4.2).
 *
 * Every minute, each probe target whose last result is older than its interval
 * (60 minutes by default) gets one minimal call; a model with real traffic has
 * a fresh result and is skipped - the traffic is the probe. A model in a
 * failing state is probed on the same cadence, so recovery is noticed without
 * waiting for a user.
 *
 * Targets: the active models a route names (primary or fallback), plus any
 * model already seen. The route-named set is what callers depend on; probing
 * every registered model would spend calls on models nothing routes to.
 */
@Injectable()
export class HealthProbeScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthProbeScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private global!: GlobalProbeSettings;
  private readonly store = new PrismaHealthStore();

  constructor(
    @Inject(ModelRegistryService) private readonly registry: ModelRegistryService,
    @Inject(ModelProbeService) private readonly prober: ModelProbeService,
  ) {}

  /** Throws on an unreadable .env value, failing start-up - see readGlobalProbeSettings. */
  onModuleInit(): void {
    this.global = readGlobalProbeSettings();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  globalSettings(): GlobalProbeSettings {
    return this.global ?? readGlobalProbeSettings();
  }

  /** One pass. Public for tests; skipped while a previous pass is still running. */
  async tick(now: number = Date.now()): Promise<{ probed: string[] }> {
    if (this.running) return { probed: [] };
    this.running = true;
    try {
      const targets = await this.targets();
      const rows = (await prisma.healthProbeSetting.findMany()) as ProbeSettingRow[];
      const global = this.globalSettings();
      const due: AiModelRecord[] = [];

      for (const model of targets) {
        const settings = effectiveProbeSettings(
          { modelCode: model.modelCode, providerCode: model.provider },
          rows,
          global,
        );
        const intervalMs = settings.intervalMinutes * 60_000;
        // Two silent intervals: an `ok` model nobody has heard from is unknown.
        upstreamHealth.markUnknownIfSilent(model.modelCode, 2 * intervalMs);
        if (!settings.enabled) continue;
        const last = upstreamHealth.lastResultAt(model.modelCode);
        if (last === undefined || now - last >= intervalMs) due.push(model);
      }

      for (let i = 0; i < due.length; i += CONCURRENCY) {
        await Promise.all(due.slice(i, i + CONCURRENCY).map((m) => this.probeOne(m)));
      }
      return { probed: due.map((m) => m.modelCode) };
    } catch (error) {
      this.logger.warn(
        `health probe pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { probed: [] };
    } finally {
      this.running = false;
    }
  }

  /** Route-named active models, plus models already seen that are still active. */
  async targets(): Promise<AiModelRecord[]> {
    const [active, routes] = await Promise.all([
      this.registry.listActiveModels(),
      this.store.listRoutes(),
    ]);
    const wanted = new Set<string>(upstreamHealth.seenModels());
    for (const r of routes) {
      wanted.add(r.primary);
      if (r.fallback) wanted.add(r.fallback);
    }
    return active.filter((m) => wanted.has(m.modelCode));
  }

  private async probeOne(model: AiModelRecord): Promise<void> {
    try {
      const result = await this.prober.probeForHealth(model);
      if (result.ok) upstreamHealth.recordSuccess(model.modelCode, model.provider);
      else upstreamHealth.recordFailure(model.modelCode, model.provider, result.error);
    } catch (error) {
      this.logger.warn(
        `health probe ${model.modelCode} could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
