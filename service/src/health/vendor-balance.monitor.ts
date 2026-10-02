import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { prisma } from "../prisma";
import { ProviderKeyService } from "../provider-keys/provider-key.service";
import { ModelRegistryService } from "../registry/model-registry.service";
import { metricsRegistry } from "../runtime/metrics.registry";
import { resolveApiKey } from "../runtime/resolve-api-key";
import type { AiModelRecord } from "../types/runtime.types";
import { PrismaHealthStore } from "./health.store";
import type { HealthSeverity } from "./health-state";
import type { Transition } from "./upstream-health";
import {
  PROJECTION_WINDOW_MS,
  VENDOR_BALANCE_STATES,
  balanceReaderFor,
  effectiveBalanceSettings,
  evaluateBalance,
  parseDeepSeekBalance,
  projectedDays,
  readGlobalBalanceSettings,
  type BalanceReader,
  type BalanceReading,
  type BalanceSettingRow,
  type EffectiveBalanceSettings,
  type GlobalBalanceSettings,
  type VendorBalanceState,
} from "./vendor-balance";

const TICK_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
const ERROR_MAX = 300;

export interface VendorEntry {
  providerCode: string;
  state: VendorBalanceState;
  since: number;
  detail?: string;
  reading?: BalanceReading;
  daysLeft?: number;
  lastReadAt?: number;
  lastReadError?: string;
  /** First failed read since the last good one; reads failing for two poll intervals make the state unknown. */
  firstFailureAt?: number;
}

export interface VendorBalanceView {
  providerCode: string;
  state: VendorBalanceState;
  since: string;
  detail?: string;
  currency?: string;
  balance?: number;
  daysLeft?: number;
  lastReadAt?: string;
  lastReadError?: string;
  settings: EffectiveBalanceSettings;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/gu, " ").trim().slice(0, ERROR_MAX);
}

/**
 * vendor-balance.monitor.ts - vendor balances (ADR-013, design 120 section 4.3).
 *
 * Every minute: each active vendor whose balance Atlas can read is read when
 * its poll interval (60 minutes by default) has passed; every vendor's state is
 * re-judged from its last reading, so a threshold edited in opera takes effect
 * within a minute without spending a read. A vendor Atlas cannot read is
 * `not_supported` with the reason - stated, not hidden.
 *
 * A reading is stored in `health.balance_samples`; the state transitions go
 * through the same store as model and route health, so the platform watcher
 * reads them from the same `/capability/health/events` feed.
 */
@Injectable()
export class VendorBalanceMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VendorBalanceMonitor.name);
  private readonly vendors = new Map<string, VendorEntry>();
  private readonly store = new PrismaHealthStore();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private global!: GlobalBalanceSettings;
  /** Tests replace this. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(
    @Inject(ModelRegistryService) private readonly registry: ModelRegistryService,
    @Inject(ProviderKeyService) private readonly providerKeys: ProviderKeyService,
  ) {}

  /** Throws on an unreadable .env value, failing start-up - see readGlobalBalanceSettings. */
  onModuleInit(): void {
    this.global = readGlobalBalanceSettings();
    void this.restore().catch((error: unknown) => {
      this.logger.warn(`vendor balance restore failed: ${errorText(error)}`);
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  globalSettings(): GlobalBalanceSettings {
    return this.global ?? readGlobalBalanceSettings();
  }

  /** The last known state of each vendor; vendors seen this process first. */
  async restore(): Promise<void> {
    const rows = await prisma.healthSubjectState.findMany({ where: { subjectKind: "vendor" } });
    const known: ReadonlySet<string> = new Set(VENDOR_BALANCE_STATES);
    for (const r of rows) {
      if (this.vendors.has(r.subjectKey) || !known.has(r.state)) continue;
      this.vendors.set(r.subjectKey, {
        providerCode: r.subjectKey,
        state: r.state as VendorBalanceState,
        since: r.since.getTime(),
        ...(r.detail !== null ? { detail: r.detail } : {}),
      });
    }
  }

  async view(): Promise<VendorBalanceView[]> {
    const rows = (await prisma.healthProbeSetting.findMany()) as BalanceSettingRow[];
    const global = this.globalSettings();
    return [...this.vendors.values()]
      .sort((a, b) => a.providerCode.localeCompare(b.providerCode))
      .map((v) => ({
        providerCode: v.providerCode,
        state: v.state,
        since: new Date(v.since).toISOString(),
        ...(v.detail !== undefined ? { detail: v.detail } : {}),
        ...(v.reading ? { currency: v.reading.currency, balance: v.reading.total } : {}),
        ...(v.daysLeft !== undefined ? { daysLeft: Math.round(v.daysLeft * 10) / 10 } : {}),
        ...(v.lastReadAt !== undefined ? { lastReadAt: new Date(v.lastReadAt).toISOString() } : {}),
        ...(v.lastReadError !== undefined ? { lastReadError: v.lastReadError } : {}),
        settings: effectiveBalanceSettings(v.providerCode, v.reading?.currency, rows, global),
      }));
  }

  /** One pass. Public for tests; skipped while a previous pass is still running. */
  async tick(now: number = Date.now()): Promise<{ read: string[] }> {
    if (this.running) return { read: [] };
    this.running = true;
    const read: string[] = [];
    try {
      const vendors = await this.vendorsToWatch();
      const rows = (await prisma.healthProbeSetting.findMany()) as BalanceSettingRow[];
      const global = this.globalSettings();
      for (const [providerCode, model] of vendors) {
        const reader = balanceReaderFor(model.endpointUrl);
        if (reader.kind === "not_supported") {
          await this.transition(providerCode, "not_supported", now, "info", reader.reason, false);
          continue;
        }
        const entry = this.vendors.get(providerCode);
        const settings = effectiveBalanceSettings(providerCode, entry?.reading?.currency, rows, global);
        const pollMs = settings.pollMinutes * 60_000;
        if (entry?.lastReadAt === undefined || now - entry.lastReadAt >= pollMs) {
          read.push(providerCode);
          await this.read(providerCode, model, reader, now, pollMs);
        }
        await this.judge(providerCode, rows, global, now);
      }
      return { read };
    } catch (error) {
      this.logger.warn(`vendor balance pass failed: ${errorText(error)}`);
      return { read };
    } finally {
      this.running = false;
    }
  }

  /** One active model per active vendor - its endpoint and key are what the balance read uses. */
  private async vendorsToWatch(): Promise<Map<string, AiModelRecord>> {
    const models = await this.registry.listActiveModels();
    const out = new Map<string, AiModelRecord>();
    for (const m of [...models].sort((a, b) => a.modelCode.localeCompare(b.modelCode))) {
      if (!m.providerActive || out.has(m.provider)) continue;
      out.set(m.provider, m);
    }
    return out;
  }

  private entry(providerCode: string, now: number): VendorEntry {
    let e = this.vendors.get(providerCode);
    if (!e) {
      e = { providerCode, state: "unknown", since: now };
      this.vendors.set(providerCode, e);
    }
    return e;
  }

  private async read(
    providerCode: string,
    model: AiModelRecord,
    reader: Extract<BalanceReader, { kind: "deepseek" }>,
    now: number,
    pollMs: number,
  ): Promise<void> {
    const e = this.entry(providerCode, now);
    e.lastReadAt = now;
    try {
      const key = await resolveApiKey(
        { resolveManagedKey: (code, alias) => this.providerKeys.resolveKey(code, alias) },
        model,
      );
      const response = await this.fetchImpl(reader.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, ERROR_MAX);
        throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      const reading = parseDeepSeekBalance(await response.json());
      await prisma.healthBalanceSample.create({
        data: {
          providerCode,
          sampledAt: new Date(now),
          currency: reading.currency,
          totalBalance: reading.total,
          isAvailable: reading.isAvailable,
        },
      });
      const samples = await prisma.healthBalanceSample.findMany({
        where: {
          providerCode,
          currency: reading.currency,
          sampledAt: { gte: new Date(now - PROJECTION_WINDOW_MS) },
        },
        orderBy: { sampledAt: "asc" },
      });
      e.reading = reading;
      const days = projectedDays(
        samples.map((s) => ({ at: s.sampledAt.getTime(), total: Number(s.totalBalance.toString()) })),
        now,
      );
      if (days === undefined) delete e.daysLeft;
      else e.daysLeft = days;
      delete e.lastReadError;
      delete e.firstFailureAt;
      metricsRegistry.incCounter("health_balance_reads_total", { provider: providerCode, outcome: "ok" });
    } catch (error) {
      e.lastReadError = errorText(error);
      e.firstFailureAt ??= now;
      metricsRegistry.incCounter("health_balance_reads_total", { provider: providerCode, outcome: "failed" });
      this.logger.warn(`balance read ${providerCode} failed: ${e.lastReadError}`);
      // A reading nobody has refreshed for two intervals is not a state Atlas can vouch for.
      if (e.state !== "unknown" && now - e.firstFailureAt >= 2 * pollMs) {
        await this.transition(providerCode, "unknown", now, "warning", `balance unreadable: ${e.lastReadError}`, true);
        delete e.reading;
        delete e.daysLeft;
      }
    }
  }

  /** The state from the last reading and the thresholds in effect now. */
  private async judge(
    providerCode: string,
    rows: readonly BalanceSettingRow[],
    global: GlobalBalanceSettings,
    now: number,
  ): Promise<void> {
    const e = this.vendors.get(providerCode);
    if (!e?.reading) return;
    const settings = effectiveBalanceSettings(providerCode, e.reading.currency, rows, global);
    const verdict = evaluateBalance(e.reading, e.daysLeft, {
      minAmount: settings.minAmount,
      minDays: settings.minDays,
    });
    // The first sighting of a healthy balance is not news.
    const event = !(e.state === "unknown" && verdict.state === "ok");
    await this.transition(providerCode, verdict.state, now, verdict.severity, verdict.detail, event);
  }

  private async transition(
    providerCode: string,
    to: VendorBalanceState,
    now: number,
    severity: HealthSeverity,
    detail: string,
    event: boolean,
  ): Promise<void> {
    const e = this.entry(providerCode, now);
    e.detail = detail;
    if (e.state === to) return;
    const from = e.state;
    e.state = to;
    e.since = now;
    metricsRegistry.incCounter("health_transitions_total", { kind: "vendor", to });
    const t: Transition = {
      subjectKind: "vendor",
      subjectKey: providerCode,
      providerCode,
      from,
      to,
      since: new Date(now),
      severity,
      detail,
      affectedRoutes: [],
      // not_supported is a fact about the vendor's API, not news.
      event: event && to !== "not_supported",
    };
    try {
      await this.store.save(t);
    } catch (error) {
      metricsRegistry.incCounter("health_write_failures_total", {});
      this.logger.warn(`vendor health write failed: ${errorText(error)}`);
    }
  }

  /** Tests only. */
  resetForTests(): void {
    this.vendors.clear();
    this.running = false;
  }
}
