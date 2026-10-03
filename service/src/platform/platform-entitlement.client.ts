import { Injectable, Logger } from "@nestjs/common";
import type { EntitlementResponseSingle } from "@vxture/shared";
import { atlasHealth } from "../health/atlas-health";

import { metricsRegistry } from "../runtime/metrics.registry";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
/**
 * Hard upper bound on cached workspaces. The cache is keyed by caller-supplied
 * workspace ids, so without a cap a caller cycling ids grows the map without
 * limit for the life of the process.
 */
const CACHE_MAX_ENTRIES = 10_000;

/**
 * Why the outcome is a discriminated union rather than
 * `ProductEntitlementView | null`: "the platform says this workspace has no
 * entitlement" and "we could not ask the platform" are opposite facts that a
 * nullable return would flatten into one. The first is an authorization
 * answer; the second is a degradation.
 */
export type EntitlementOutcome =
  | { kind: "resolved"; view: EntitlementResponseSingle }
  | { kind: "unreachable"; reason: string }
  | { kind: "not-configured" };

/**
 * Result of a C3 consume attempt. `usageEventId` is present only when the
 * platform's response carries its usage_events id (contract addition pending
 * on the platform side; parsed defensively until then - see consume()).
 */
export interface ConsumeOutcome {
  billed: boolean;
  usageEventId?: string;
  /**
   * Usage-record batch 4: why it was not billed, for the row's
   * dimension_status. `not_configured` = no platform link, `rejected` = the
   * platform refused it, `failed` = it could not be reached.
   */
  notBilledBecause?:
    | "not_configured"
    | "no_amount"
    | "rejected"
    | "failed"
    /** ADR-010: a report is attributed to the CALLER's product; without a verified caller there is nothing to attribute it to. */
    | "no_caller";
}

/**
 * ADR-010 / platform ADR-013 (vxture-platform#547): one inference, reported as raw
 * tokens in four non-overlapping dimensions, under the CALLER's product. The
 * platform converts to `ai.credit` with an operator-set rate and deducts; Atlas
 * neither converts nor pre-deducts.
 */
export interface TokenReport {
  workspaceId: string;
  /** `act.sub` on the verified S2S token - the product the usage counts against. Never "atlas". */
  callerProductCode: string;
  /** One per logical request; with `attemptIndex` it is the platform's idempotency key. */
  requestId: string;
  attemptIndex?: number;
  /** `failed` = a failover attempt the upstream charged for and the caller got nothing from. Recorded, never deducted (owner 2026-10-03). */
  outcome?: "served" | "failed";
  /** When the call happened (started_at), not when it is reported - a backfill keeps the original instant. */
  occurredAt: Date;
  modelCode?: string;
  providerCode?: string;
  /** Four non-overlapping counts: uncached input, output, cache write, cache read. */
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** Subset of output; listed, never added. */
  reasoningTokens?: number;
  rerankCandidates?: number;
  parsePages?: number;
  /** Historical rows replayed after the cutover: facts only, no credit deduction (owner 2026-10-03). */
  backfill?: boolean;
}

export interface TokenReportOutcome extends ConsumeOutcome {
  /** The platform's raw-fact row (metering.token_usage_events.id). */
  tokenEventId?: string;
  /** Micro-credits this report converted to (1 credit = 1,000,000); absent when not converted. */
  creditsMicro?: number;
  /** Whole credits actually deducted after the fractional carry (0 = only the carry moved). */
  creditsDeducted?: number;
  creditSkipReason?: "pre_cutover" | "failed_attempt" | "no_rate";
  /** The platform's quota did not cover the deduction - information, not a verdict (the call was already served). */
  gated?: boolean;
}

/**
 * Atlas's `input_tokens` counts EVERY input token (uncached, cache read and
 * cache write - see 210 §3 "Token convention"); the platform wants the four
 * dimensions non-overlapping, so the uncached part is what is left after the
 * two cache kinds. Clamped at 0: an upstream that reports a cache figure larger
 * than its prompt total is a vendor bug, and a negative token count must not
 * reach the platform (its CHECK would refuse the whole report).
 */
export function splitUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
}): TokenReport["tokens"] {
  const cacheRead = Math.max(0, Math.trunc(usage.cachedInputTokens ?? 0));
  const cacheWrite = Math.max(0, Math.trunc(usage.cacheWriteInputTokens ?? 0));
  const input = Math.max(0, Math.trunc(usage.promptTokens) - cacheRead - cacheWrite);
  return {
    input,
    output: Math.max(0, Math.trunc(usage.completionTokens)),
    cacheWrite,
    cacheRead,
  };
}

const NOT_BILLED: ConsumeOutcome = { billed: false };

interface CacheEntry {
  outcome: EntitlementOutcome;
  expiresAt: number;
}

/**
 * The C2 entitlement client. Credential is the shared-secret header
 * (`x-vxture-internal-auth`), the same path arda uses in production. T1 is
 * rejected while atlas's plan catalog is an unpublished draft - it would fail
 * for every workspace.
 */
@Injectable()
export class PlatformEntitlementClient {
  private readonly logger = new Logger(PlatformEntitlementClient.name);
  private readonly cache = new Map<string, CacheEntry>();

  private get baseUrl(): string | undefined {
    return process.env["PLATFORM_API_URL"]?.trim() || undefined;
  }

  private get token(): string | undefined {
    return process.env["PLATFORM_INTERNAL_AUTH_TOKEN"]?.trim() || undefined;
  }

  private get ttlMs(): number {
    const raw = Number(process.env["PLATFORM_ENTITLEMENT_CACHE_TTL_MS"]);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Resolved per workspace, cached briefly. The cache exists because this sits
   * on the hot path of every inference call - without it, one upstream request
   * becomes two, and a platform hiccup becomes an Atlas latency spike.
   *
   * Deliberately caches negative outcomes too, but only `resolved` ones: an
   * `unreachable` result must not pin a degraded verdict for the whole TTL
   * once the platform recovers.
   */
  async resolve(
    workspaceId: string,
    /**
     * ADR-010 / ADR-013 D11: the C2 view is per (workspace, product), and the
     * product is the CALLER's (`act.sub`), never "atlas" - atlas left the
     * platform catalog on 2026-09-23 and `product=atlas` resolves nothing.
     * `ai.credit` is a platform-level shared key, so the workspace's pools show
     * up under any product that participates.
     */
    callerProductCode: string,
  ): Promise<EntitlementOutcome> {
    const base = this.baseUrl;
    const token = this.token;
    if (!base || !token) {
      return { kind: "not-configured" };
    }

    // Keyed by (product, workspace): two products reading the same workspace are
    // two views, and the platform's sharing policy may answer them differently.
    const cacheKey = `${callerProductCode}:${workspaceId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.outcome;
      }
      // An expired entry is dead weight - reads skip it, so leaving it in the
      // map is unbounded growth, one workspace at a time.
      this.cache.delete(cacheKey);
    }

    const url = `${base.replace(/\/+$/, "")}/platform/entitlements?workspace_id=${encodeURIComponent(workspaceId)}&product=${encodeURIComponent(callerProductCode)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-vxture-internal-auth": token,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await refusalDetail(response);
        return this.degraded(
          `platform returned ${response.status}: ${detail.message}`,
        );
      }

      const view = (await response.json()) as EntitlementResponseSingle;
      const outcome: EntitlementOutcome = { kind: "resolved", view };
      // At the cap, a new workspace displaces the oldest insertion - Map
      // iteration order is insertion order, so the first key is the oldest.
      if (
        this.cache.size >= CACHE_MAX_ENTRIES &&
        !this.cache.has(cacheKey)
      ) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, {
        outcome,
        expiresAt: Date.now() + this.ttlMs,
      });
      return outcome;
    } catch (error) {
      return this.degraded(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ADR-010 / platform ADR-013: report one inference as raw tokens under the
   * caller's product. Same endpoint as `consume` (`POST /usage/consume`); the
   * `tokens` field selects the shape on the platform side.
   *
   * Same posture as `consume`: called after the fact, never throws, every
   * failure mode is `billed: false` with a reason the reqlog row can name.
   * `billed: true` means the platform recorded the raw fact; whether credits
   * were deducted is a separate answer (`creditsDeducted` / `creditSkipReason`)
   * - a backfilled or failed attempt is recorded and deliberately not charged.
   */
  async reportTokens(input: TokenReport): Promise<TokenReportOutcome> {
    const base = this.baseUrl;
    const token = this.token;
    const metric = "ai.tokens";
    if (!base || !token) {
      recordConsume(metric, "skipped", "not_configured");
      return { ...NOT_BILLED, notBilledBecause: "not_configured" };
    }
    if (!input.callerProductCode) {
      recordConsume(metric, "skipped", "no_caller");
      return { ...NOT_BILLED, notBilledBecause: "no_caller" };
    }
    const t = input.tokens;
    const total = t.input + t.output + t.cacheWrite + t.cacheRead;
    const units = (input.rerankCandidates ?? 0) + (input.parsePages ?? 0);
    if (
      ![t.input, t.output, t.cacheWrite, t.cacheRead].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      (total <= 0 && units <= 0)
    ) {
      recordConsume(metric, "skipped", "no_amount");
      return { ...NOT_BILLED, notBilledBecause: "no_amount" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${base.replace(/\/+$/, "")}/usage/consume`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vxture-internal-auth": token,
          },
          body: JSON.stringify({
            workspace_id: input.workspaceId,
            product: input.callerProductCode,
            request_id: input.requestId,
            ...(input.attemptIndex !== undefined
              ? { attempt_index: input.attemptIndex }
              : {}),
            ...(input.outcome ? { outcome: input.outcome } : {}),
            occurred_at: input.occurredAt.toISOString(),
            ...(input.modelCode ? { model_code: input.modelCode } : {}),
            ...(input.providerCode ? { provider_code: input.providerCode } : {}),
            tokens: {
              input: t.input,
              output: t.output,
              cache_write: t.cacheWrite,
              cache_read: t.cacheRead,
            },
            ...(input.reasoningTokens !== undefined
              ? { reasoning_tokens: input.reasoningTokens }
              : {}),
            ...(input.rerankCandidates !== undefined
              ? { rerank_candidates: input.rerankCandidates }
              : {}),
            ...(input.parsePages !== undefined
              ? { parse_pages: input.parsePages }
              : {}),
            ...(input.backfill ? { backfill: true } : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const detail = await refusalDetail(response);
        recordConsume(metric, "rejected", detail.reason);
        this.logger.warn(
          `token report returned ${response.status} (${detail.message}) for workspace=${input.workspaceId} product=${input.callerProductCode} request=${input.requestId} - request served, not billed`,
        );
        return { ...NOT_BILLED, notBilledBecause: "rejected" };
      }
      recordConsume(metric, "billed", "ok");
      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        // body unreadable - the fact landed (200), correlation via request_id
      }
      const str = (k: string): string | undefined =>
        typeof body[k] === "string" && (body[k] as string).trim()
          ? (body[k] as string)
          : undefined;
      const num = (k: string): number | undefined =>
        typeof body[k] === "number" ? (body[k] as number) : undefined;
      // Read each once into a const so the conditional spreads narrow to the
      // defined type (exactOptionalPropertyTypes refuses `prop: T | undefined`).
      const usageEventId = str("event_id");
      const tokenEventId = str("token_event_id");
      const creditsMicro = num("credits_micro");
      const creditsDeducted = num("credits_deducted");
      const skip = str("credit_skip_reason");
      const creditSkipReason =
        skip === "pre_cutover" || skip === "failed_attempt" || skip === "no_rate"
          ? skip
          : undefined;
      return {
        billed: true,
        ...(usageEventId !== undefined ? { usageEventId } : {}),
        ...(tokenEventId !== undefined ? { tokenEventId } : {}),
        ...(creditsMicro !== undefined ? { creditsMicro } : {}),
        ...(creditsDeducted !== undefined ? { creditsDeducted } : {}),
        ...(creditSkipReason !== undefined ? { creditSkipReason } : {}),
        ...(body.gated === true ? { gated: true as const } : {}),
      };
    } catch (error) {
      recordConsume(metric, "failed", "unreachable");
      this.logger.warn(
        `token report failed (${error instanceof Error ? error.message : String(error)}) - request served, not billed`,
      );
      return { ...NOT_BILLED, notBilledBecause: "failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  private degraded(reason: string): EntitlementOutcome {
    this.logger.warn(`C2 entitlement read failed (${reason}) - degrading`);
    return { kind: "unreachable", reason };
  }
}

function recordConsume(
  metric: string,
  outcome: "billed" | "rejected" | "failed" | "skipped",
  reason: string,
): void {
  metricsRegistry.incCounter("platform_consume_outcomes_total", {
    metric,
    outcome,
    reason,
  });
  atlasHealth.recordConsume(outcome, reason);
}

/**
 * The platform's refusal word travels as Nest's `{ message }` - e.g.
 * `unknown_product`, `invalid_amount`. It becomes a metric label only when it
 * looks like such a word: a label is a series, and free text from another
 * service is an unbounded number of them. Anything else is labelled by status
 * and still reaches the log line.
 */
const REFUSAL_WORD = /^[a-z][a-z0-9_]{0,63}$/;

async function refusalDetail(
  response: Response,
): Promise<{ reason: string; message: string }> {
  const fallback = `http_${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    const raw = Array.isArray(body.message)
      ? body.message.join("; ")
      : body.message;
    if (typeof raw !== "string" || !raw.trim()) {
      return { reason: fallback, message: "no reason given" };
    }
    const message = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      reason: REFUSAL_WORD.test(message) ? message : fallback,
      message,
    };
  } catch {
    return { reason: fallback, message: "body unreadable" };
  }
}
