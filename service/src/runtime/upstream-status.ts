import { ProviderHttpError } from "../providers/base.provider";
import { metricsRegistry } from "./metrics.registry";

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
