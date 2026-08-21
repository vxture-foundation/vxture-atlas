import { Injectable, Logger } from "@nestjs/common";
import type { EntitlementResponseSingle } from "@vxture/shared";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
/**
 * Hard upper bound on cached workspaces. The cache is keyed by caller-supplied
 * workspace ids, so without a cap a caller cycling ids grows the map without
 * limit for the life of the process.
 */
const CACHE_MAX_ENTRIES = 10_000;
const PRODUCT_CODE = "atlas";

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
  async resolve(workspaceId: string): Promise<EntitlementOutcome> {
    const base = this.baseUrl;
    const token = this.token;
    if (!base || !token) {
      return { kind: "not-configured" };
    }

    const cached = this.cache.get(workspaceId);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.outcome;
      }
      // An expired entry is dead weight - reads skip it, so leaving it in the
      // map is unbounded growth, one workspace at a time.
      this.cache.delete(workspaceId);
    }

    const url = `${base.replace(/\/+$/, "")}/platform/entitlements?workspace_id=${encodeURIComponent(workspaceId)}&product=${PRODUCT_CODE}`;
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
        return this.degraded(`platform returned ${response.status}`);
      }

      const view = (await response.json()) as EntitlementResponseSingle;
      const outcome: EntitlementOutcome = { kind: "resolved", view };
      // At the cap, a new workspace displaces the oldest insertion - Map
      // iteration order is insertion order, so the first key is the oldest.
      if (
        this.cache.size >= CACHE_MAX_ENTRIES &&
        !this.cache.has(workspaceId)
      ) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(workspaceId, {
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
   * C3 consume, the platform's **sole** write path into the
   * metering kernel (`data_commerce_200_metering.md` §11: products must not
   * write the usage tables directly).
   *
   * Called after the work is done, because the amount is the realized amount
   * (tokens for chat/embed, candidates for rerank). Gating already happened
   * on the C2 read, which is cheap and cached; this call is the accounting
   * write.
   *
   * Returns `billed: false` for every failure mode - including a `409 gated`
   * (quota exhausted). Refusing to serve a response we have *already produced*
   * would waste the upstream spend without recovering anything; the honest
   * record is that it ran and was not billed, which reconciliation can see.
   *
   * Never throws: an accounting failure must not turn a served inference into
   * an error for the caller.
   */
  async consume(input: {
    workspaceId: string;
    metric: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<ConsumeOutcome> {
    const base = this.baseUrl;
    const token = this.token;
    if (!base || !token) return NOT_BILLED;
    if (!Number.isFinite(input.amount) || input.amount <= 0) return NOT_BILLED;

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
            product: PRODUCT_CODE,
            metric: input.metric,
            amount: Math.trunc(input.amount),
            // Stable per request, so a retry cannot double-charge - the
            // platform's usage_idempotencies table is keyed on this.
            idempotency_key: input.idempotencyKey,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn(
          `C3 consume returned ${response.status} for workspace=${input.workspaceId} metric=${input.metric} - request served, not billed`,
        );
        return NOT_BILLED;
      }
      // Defensive parse: today's ConsumeResponseBody carries no event id
      // (correlation is via request_id / idempotency_key on both sides), but
      // the design (210 §4) wants the platform's usage_events.id echoed back
      // into reqlog. Read it if/when the platform ships the field, under
      // either naming convention, without making success depend on the body.
      let usageEventId: string | undefined;
      try {
        const body = (await response.json()) as Record<string, unknown>;
        const raw = body["event_id"] ?? body["eventId"];
        if (typeof raw === "string" && raw.trim()) usageEventId = raw;
      } catch {
        // body unreadable - billing still succeeded, correlation via request_id
      }
      return { billed: true, ...(usageEventId ? { usageEventId } : {}) };
    } catch (error) {
      this.logger.warn(
        `C3 consume failed (${error instanceof Error ? error.message : String(error)}) - request served, not billed`,
      );
      return NOT_BILLED;
    } finally {
      clearTimeout(timer);
    }
  }

  private degraded(reason: string): EntitlementOutcome {
    this.logger.warn(`C2 entitlement read failed (${reason}) - degrading`);
    return { kind: "unreachable", reason };
  }
}
