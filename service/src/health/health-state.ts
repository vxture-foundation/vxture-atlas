/**
 * health-state.ts - the state machine of a vendor model and of a route
 * (ADR-013, design 120 section 5). Pure: no clock, no I/O, so every rule is
 * pinned by a test that names it.
 */

export const MODEL_HEALTH_STATES = [
  "ok",
  "rate_limited",
  "account_refused",
  "unavailable",
  "unreachable",
  "model_missing",
  "unknown",
  "degraded",
] as const;
export type ModelHealthState = (typeof MODEL_HEALTH_STATES)[number];

export type RouteHealthState = "ok" | "degraded" | "down";
export type HealthSeverity = "info" | "warning" | "critical";

/** What one upstream call said about the model's health. */
export type HealthSignal =
  | "success"
  | "account"
  | "rate_limited"
  | "unavailable"
  | "unreachable"
  | "model_missing"
  /** A 200 with no content and no tool call, not the caller's budget (F3b-B). */
  | "empty"
  /** From the degradation evaluator: slower than its own baseline / back to normal. */
  | "slow"
  | "not_slow";

/** Empty answers in a row that make a model degraded. */
export const DEGRADED_AFTER_EMPTY = 3;

/** Consecutive failures that make a model unavailable - the breaker's own threshold. */
export const UNAVAILABLE_AFTER_FAILURES = 5;
/** Or: every call failed for this long. */
export const UNAVAILABLE_AFTER_MS = 10 * 60_000;
/** Throttling has to persist this long before it is a state rather than a blip. */
export const RATE_LIMITED_AFTER_MS = 5 * 60_000;

export interface ModelHealthRecord {
  state: ModelHealthState;
  /** When the model entered `state`, epoch ms. */
  since: number;
  upstreamStatus?: number;
  detail?: string;
  /** Failures since the last success (unavailable / unreachable only). */
  consecutiveFailures: number;
  firstFailureAt?: number;
  firstRateLimitAt?: number;
  /** Empty answers since the last answer with content (F3b-B). */
  consecutiveEmpty?: number;
  /** Set by the degradation evaluator; survives successes until it clears it. */
  slow?: boolean;
}

export function initialRecord(at: number): ModelHealthRecord {
  return { state: "unknown", since: at, consecutiveFailures: 0 };
}

/** States a route cannot rely on. */
const FAILING: ReadonlySet<ModelHealthState> = new Set([
  "rate_limited",
  "account_refused",
  "unavailable",
  "unreachable",
  "model_missing",
]);

export function isFailing(state: ModelHealthState | undefined): boolean {
  return state !== undefined && FAILING.has(state);
}

/**
 * The next record for one signal.
 *
 * - success: ok, and every counter cleared. One success is enough - the model
 *   answered.
 * - account / model_missing: entered on the FIRST occurrence. They do not fix
 *   themselves; waiting for a threshold only delays the notice.
 * - unavailable / unreachable: after UNAVAILABLE_AFTER_FAILURES in a row, or
 *   when every call has failed for UNAVAILABLE_AFTER_MS. Which of the two is
 *   decided by the LATEST failure: `unreachable` (DNS / TLS / connect - the
 *   path from Atlas, someone on Atlas's side acts) versus `unavailable` (the
 *   vendor answered badly or not in time - the vendor acts). Kept apart
 *   because different people fix them (P1, owner 2026-10-02).
 * - rate_limited: when throttling has lasted RATE_LIMITED_AFTER_MS.
 *
 * Once a model is account_refused or model_missing, an outage or throttling
 * signal does not move it: the account is still refused. Only a success does.
 *
 * - degraded (F3b-B): the model answers, but badly - DEGRADED_AFTER_EMPTY empty
 *   answers in a row, or slower than its own baseline (`slow`, set and cleared
 *   by the evaluator). Entered only from a serving state (ok / unknown /
 *   degraded): a refused account stays refused. A success clears the empty
 *   count but not `slow`; a model that is slow stays degraded until the
 *   evaluator says otherwise. Routes still count it as serving.
 */
export function nextRecord(
  record: ModelHealthRecord,
  signal: HealthSignal,
  at: number,
  facts: { upstreamStatus?: number; detail?: string } = {},
): ModelHealthRecord {
  const enter = (state: ModelHealthState): ModelHealthRecord => ({
    ...record,
    state,
    since: record.state === state ? record.since : at,
    ...(facts.upstreamStatus !== undefined ? { upstreamStatus: facts.upstreamStatus } : {}),
    ...(facts.detail !== undefined ? { detail: facts.detail } : {}),
  });

  const serving = record.state === "ok" || record.state === "unknown" || record.state === "degraded";
  const settle = (r: ModelHealthRecord, why: string | undefined): ModelHealthRecord => {
    const degraded = r.slow === true || (r.consecutiveEmpty ?? 0) >= DEGRADED_AFTER_EMPTY;
    const state: ModelHealthState = degraded ? "degraded" : "ok";
    const base = { ...r, state, since: record.state === state ? record.since : at };
    delete base.upstreamStatus;
    delete base.detail;
    return degraded && why !== undefined ? { ...base, detail: why } : degraded && record.detail !== undefined ? { ...base, detail: record.detail } : base;
  };

  if (signal === "success") {
    const cleared: ModelHealthRecord = {
      state: "ok",
      since: record.since,
      consecutiveFailures: 0,
      ...(record.slow ? { slow: true } : {}),
    };
    return settle(cleared, record.slow ? record.detail : undefined);
  }
  if (signal === "slow" || signal === "not_slow") {
    const marked = { ...record, slow: signal === "slow" };
    if (!serving) return marked;
    return settle(marked, signal === "slow" ? facts.detail : undefined);
  }
  if (signal === "empty") {
    const consecutiveEmpty = (record.consecutiveEmpty ?? 0) + 1;
    const counted = { ...record, consecutiveEmpty };
    if (!serving) return counted;
    if (consecutiveEmpty < DEGRADED_AFTER_EMPTY && record.state !== "degraded") return counted;
    return settle(counted, `${consecutiveEmpty} empty answers in a row${facts.detail ? `: ${facts.detail}` : ""}`);
  }
  if (signal === "account") return enter("account_refused");
  if (signal === "model_missing") return enter("model_missing");

  const sticky = record.state === "account_refused" || record.state === "model_missing";

  if (signal === "rate_limited") {
    const firstRateLimitAt = record.firstRateLimitAt ?? at;
    const next = { ...record, firstRateLimitAt };
    if (sticky || at - firstRateLimitAt < RATE_LIMITED_AFTER_MS) return next;
    return { ...enter("rate_limited"), firstRateLimitAt };
  }

  // unavailable | unreachable
  const consecutiveFailures = record.consecutiveFailures + 1;
  const firstFailureAt = record.firstFailureAt ?? at;
  const next = { ...record, consecutiveFailures, firstFailureAt };
  if (sticky) return next;
  if (
    consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES ||
    at - firstFailureAt >= UNAVAILABLE_AFTER_MS
  ) {
    return { ...enter(signal === "unreachable" ? "unreachable" : "unavailable"), consecutiveFailures, firstFailureAt };
  }
  return next;
}

/**
 * A route's state, and so the severity (design 120 section 5.2): the primary
 * serving -> ok; the primary failing but the fallback serving -> degraded,
 * callers are still served; nothing serving -> down, callers are failing.
 * A model never seen yet (`unknown`, or absent) is not counted as failing.
 */
export function routeState(
  primary: ModelHealthState | undefined,
  fallback: ModelHealthState | undefined,
  hasFallback: boolean,
): RouteHealthState {
  if (!isFailing(primary)) return "ok";
  if (hasFallback && !isFailing(fallback)) return "degraded";
  return "down";
}

export function modelSeverity(to: ModelHealthState): HealthSeverity {
  return isFailing(to) || to === "degraded" ? "warning" : "info";
}

export function routeSeverity(to: RouteHealthState): HealthSeverity {
  if (to === "down") return "critical";
  if (to === "degraded") return "warning";
  return "info";
}
