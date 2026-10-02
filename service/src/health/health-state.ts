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
  "model_missing",
  "unknown",
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
  | "model_missing";

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
}

export function initialRecord(at: number): ModelHealthRecord {
  return { state: "unknown", since: at, consecutiveFailures: 0 };
}

/** States a route cannot rely on. */
const FAILING: ReadonlySet<ModelHealthState> = new Set([
  "rate_limited",
  "account_refused",
  "unavailable",
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
 *   when every call has failed for UNAVAILABLE_AFTER_MS.
 * - rate_limited: when throttling has lasted RATE_LIMITED_AFTER_MS.
 *
 * Once a model is account_refused or model_missing, an outage or throttling
 * signal does not move it: the account is still refused. Only a success does.
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

  if (signal === "success") {
    return { state: "ok", since: record.state === "ok" ? record.since : at, consecutiveFailures: 0 };
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
    return { ...enter("unavailable"), consecutiveFailures, firstFailureAt };
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
  return isFailing(to) ? "warning" : "info";
}

export function routeSeverity(to: RouteHealthState): HealthSeverity {
  if (to === "down") return "critical";
  if (to === "degraded") return "warning";
  return "info";
}
