import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { prisma } from "../prisma";
import { ModelRegistryService } from "../registry/model-registry.service";
import { upstreamHealth } from "./upstream-health";

/**
 * model-degradation.ts - a model that answers, but slower than it usually
 * does (ADR-013, design 120 section 4.7, F3b-B).
 *
 * Compared with the model's OWN history, not a fixed number: production
 * medians ran from 5.8 s (deepseek-v4-flash) to 64 s (doubao pro) on
 * 2026-10-03, so one threshold would either never fire or always fire. Chat
 * models are compared per output token - a long answer is slower and that is
 * not degradation. Production volume is low (65 calls a week on the busiest
 * model), so the recent sample is the last calls, not the last hour.
 */

/** The recent sample: this many latest successes, within the last 24 hours. */
export const RECENT_CALLS = 10;
/** The baseline: the 7 days before them, at least this many calls. */
export const BASELINE_MIN_CALLS = 30;
/** Slow at this multiple of the baseline median... */
export const SLOW_RATIO = 3;
/** ...and normal again below this one. Between the two, the state holds. */
export const CLEAR_RATIO = 2;
/** Output tokens a chat call needs before its per-token latency means anything. */
export const MIN_OUTPUT_TOKENS = 20;

export interface LatencyRow {
  modelCode: string;
  recentN: number;
  recentMs: number | null;
  recentTokN: number;
  recentMsPerTok: number | null;
  baseN: number;
  baseMs: number | null;
  baseTokN: number;
  baseMsPerTok: number | null;
}

export type SlowVerdict =
  | { kind: "slow"; detail: string }
  | { kind: "normal"; detail: string }
  /** Between the ratios: keep the current state. */
  | { kind: "hold" }
  /** Too few calls to say. */
  | { kind: "unknown" };

export function judgeLatency(row: LatencyRow, modelType: string): SlowVerdict {
  const perToken = modelType === "chat";
  const recentN = perToken ? row.recentTokN : row.recentN;
  const baseN = perToken ? row.baseTokN : row.baseN;
  const recent = perToken ? row.recentMsPerTok : row.recentMs;
  const base = perToken ? row.baseMsPerTok : row.baseMs;
  if (recentN < RECENT_CALLS || baseN < BASELINE_MIN_CALLS || recent === null || base === null || base <= 0) {
    return { kind: "unknown" };
  }
  const ratio = recent / base;
  const unit = perToken ? "ms per output token" : "ms";
  const text = `median ${recent.toFixed(1)} ${unit} over the last ${recentN} calls, ${ratio.toFixed(1)}x its 7-day median of ${base.toFixed(1)}`;
  if (ratio >= SLOW_RATIO) return { kind: "slow", detail: `slower than usual: ${text}` };
  if (ratio < CLEAR_RATIO) return { kind: "normal", detail: text };
  return { kind: "hold" };
}

const TICK_MS = 10 * 60_000;
const FIRST_PASS_MS = 60_000;

/** The last RECENT_CALLS successes of each model in 24 h, and the 7 days before them. Probes excluded. */
const LATENCY_SQL = `
WITH s AS (
  SELECT model_code, latency_ms, output_tokens, created_at,
         row_number() OVER (PARTITION BY model_code ORDER BY created_at DESC) AS rn
  FROM reqlog.request_records
  WHERE created_at > now() - interval '7 days'
    AND status = 'success'
    AND usage_type IS DISTINCT FROM 'test'
    AND latency_ms IS NOT NULL
    AND model_code IS NOT NULL
), t AS (
  SELECT *, (rn <= ${RECENT_CALLS} AND created_at > now() - interval '24 hours') AS recent,
            (output_tokens >= ${MIN_OUTPUT_TOKENS}) AS tok
  FROM s
)
SELECT model_code AS "modelCode",
  count(*) FILTER (WHERE recent)::int                                                         AS "recentN",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE recent)               AS "recentMs",
  count(*) FILTER (WHERE recent AND tok)::int                                                 AS "recentTokN",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms::float8 / output_tokens)
    FILTER (WHERE recent AND tok)                                                             AS "recentMsPerTok",
  count(*) FILTER (WHERE rn > ${RECENT_CALLS})::int                                           AS "baseN",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE rn > ${RECENT_CALLS}) AS "baseMs",
  count(*) FILTER (WHERE rn > ${RECENT_CALLS} AND tok)::int                                   AS "baseTokN",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms::float8 / output_tokens)
    FILTER (WHERE rn > ${RECENT_CALLS} AND tok)                                               AS "baseMsPerTok"
FROM t
GROUP BY model_code`;

/**
 * Every ten minutes: judge each active model's latency against its own
 * baseline and tell `upstreamHealth`. A slow model becomes `degraded`
 * (warning); routes still count it as serving.
 */
@Injectable()
export class ModelDegradationMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModelDegradationMonitor.name);
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;

  constructor(@Inject(ModelRegistryService) private readonly registry: ModelRegistryService) {}

  onModuleInit(): void {
    // A first pass a minute after start, not ten: a restart should not leave
    // a slow model unjudged for ten minutes.
    this.first = setTimeout(() => void this.tick(), FIRST_PASS_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Public for tests. */
  async tick(): Promise<{ judged: Record<string, SlowVerdict["kind"]> }> {
    const judged: Record<string, SlowVerdict["kind"]> = {};
    try {
      const [models, rows] = await Promise.all([
        this.registry.listActiveModels(),
        prisma.$queryRawUnsafe<LatencyRow[]>(LATENCY_SQL),
      ]);
      const byCode = new Map(rows.map((r) => [r.modelCode, r]));
      for (const model of models) {
        const row = byCode.get(model.modelCode);
        if (!row) continue;
        const verdict = judgeLatency(normalise(row), model.modelType);
        judged[model.modelCode] = verdict.kind;
        if (verdict.kind === "slow") upstreamHealth.markSlow(model.modelCode, model.provider, true, verdict.detail);
        if (verdict.kind === "normal") upstreamHealth.markSlow(model.modelCode, model.provider, false);
      }
    } catch (error) {
      this.logger.warn(`degradation pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { judged };
  }
}

/** pg returns percentile_cont as a number or a numeric string depending on the driver; counts as numbers. */
function normalise(row: LatencyRow): LatencyRow {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    modelCode: row.modelCode,
    recentN: Number(row.recentN),
    recentMs: num(row.recentMs),
    recentTokN: Number(row.recentTokN),
    recentMsPerTok: num(row.recentMsPerTok),
    baseN: Number(row.baseN),
    baseMs: num(row.baseMs),
    baseTokN: Number(row.baseTokN),
    baseMsPerTok: num(row.baseMsPerTok),
  };
}
