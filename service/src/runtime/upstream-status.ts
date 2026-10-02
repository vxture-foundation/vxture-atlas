import { HttpStatus } from "@nestjs/common";

import { ProviderHttpError } from "../providers/base.provider";
import { metricsRegistry } from "./metrics.registry";
import { ModelRuntimeException } from "./runtime.errors";

/**
 * upstream-status.ts - which HTTP status an upstream failed with, by vendor.
 *
 * Found on production 2026-10-01: DeepSeek had answered `402` sixteen times
 * since 09-30 - its account had run out of balance. Nothing named it. The
 * runtime filed every one as `PROVIDER_UNAVAILABLE{provider="deepseek"}`, the
 * same series a vendor outage lands in, and `chat/default` quietly failed over
 * to Doubao, so callers were served and no one looked. An outage fixes itself;
 * an empty account does not, and only the owner can fix it.
 *
 * So the status is counted where the vendor is known (the adapter only knows
 * its own name - `openai-compatible` serves DeepSeek and Doubao alike), with a
 * class an alert can key on without listing codes.
 */

export type UpstreamStatusClass = "account" | "rate_limit" | "request" | "server" | "other";

export function upstreamStatusClass(status: number): UpstreamStatusClass {
  if (status === 401 || status === 402 || status === 403) return "account";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "request";
  return "other";
}

/** What the status means for whoever reads the error row; empty when it says nothing new. */
export function upstreamStatusHint(status: number): string {
  switch (status) {
    case 401:
      return " (vendor account: the API key was refused)";
    case 402:
      return " (vendor account: payment required - usually an exhausted balance)";
    case 403:
      return " (vendor account: access forbidden for this key or model)";
    default:
      return "";
  }
}

/** Count a failed upstream call by vendor and status; a no-op for anything but an HTTP failure. */
export function recordUpstreamHttpStatus(error: unknown, provider: string | undefined): void {
  if (!(error instanceof ProviderHttpError)) return;
  metricsRegistry.incCounter("upstream_http_errors_total", {
    provider: provider ?? error.provider,
    status: String(error.status),
    class: upstreamStatusClass(error.status),
  });
}

/**
 * The two upstream statuses whose meaning the caller needs, not just the
 * operator (owner, 2026-10-01, after the production evening of 10-01: Doubao
 * answered 429 under a burst, the breaker took it out for 30 s, every request
 * fell through to a DeepSeek account answering 402, and 180 of 188 calls
 * failed - each one marked retryable, so the caller retried into the same
 * wall).
 *
 * - 429: the vendor is throttling Atlas. `RATE_LIMITED`, retryable, with the
 *   vendor's own Retry-After when it sent one. Not a health signal - the model
 *   is fine, it is busy - so the breaker does not count it.
 * - 401/402/403: the vendor refused Atlas's account. `UPSTREAM_ACCOUNT_REFUSED`,
 *   not retryable: only the owner changes the outcome.
 *
 * Anything else: undefined, and the caller keeps its existing handling.
 */
export function classifyUpstreamStatus(
  error: unknown,
  scope: { requestId: string; modelCode: string; provider: string },
): ModelRuntimeException | undefined {
  if (!(error instanceof ProviderHttpError)) return undefined;
  if (error.status === 429) {
    return new ModelRuntimeException(
      HttpStatus.TOO_MANY_REQUESTS,
      "RATE_LIMITED",
      `${scope.provider} is rate-limiting Atlas (upstream 429)`,
      { ...scope, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) },
    );
  }
  if (upstreamStatusClass(error.status) === "account") {
    return new ModelRuntimeException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "UPSTREAM_ACCOUNT_REFUSED",
      `${scope.provider} provider returned status ${error.status}${upstreamStatusHint(error.status)}`,
      scope,
    );
  }
  return undefined;
}

/**
 * Which failure a chain that ran out reports. The last one - unless an
 * earlier candidate failed in a way that waiting fixes and the last did not.
 * "Doubao is throttling, DeepSeek has no balance" is retryable as a whole:
 * the same request succeeds once Doubao has room. Reporting the 402 would
 * tell the caller to give up on a request that a retry will serve.
 */
export function preferReported(
  previous: ModelRuntimeException | undefined,
  next: ModelRuntimeException,
): ModelRuntimeException {
  if (previous === undefined) return next;
  return !isRetryableError(next) && isRetryableError(previous) ? previous : next;
}

function isRetryableError(error: ModelRuntimeException): boolean {
  const body = error.getResponse() as { retryable?: unknown };
  return body.retryable === true;
}
