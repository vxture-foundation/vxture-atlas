/**
 * record-facts.ts - small, dependency-free helpers both reqlog writers use
 * (the chat runtime and the S2S wrapper), kept here so neither imports the
 * other. Usage-record batch 4.
 */
import type { DimensionStatus } from "./dimension-status";
import type { RequestLogEntry } from "./request-log.types";
import type { UpstreamCallRecord } from "../types/runtime.types";

/**
 * Usage-record batch 4: the vendor extras and the adapter's declaration of what
 * its protocol lacks. Shared by the chat and S2S writers.
 */
export function batch4Columns(
  upstream: UpstreamCallRecord | undefined,
): Partial<RequestLogEntry> {
  if (!upstream) return {};
  const out: Partial<RequestLogEntry> = {};
  if (upstream.serviceTier !== undefined) out.serviceTier = upstream.serviceTier;
  if (upstream.inputImageTokens !== undefined) out.inputImageTokens = upstream.inputImageTokens;
  if (upstream.inputAudioTokens !== undefined) out.inputAudioTokens = upstream.inputAudioTokens;
  if (upstream.outputAudioTokens !== undefined) out.outputAudioTokens = upstream.outputAudioTokens;
  if (upstream.outputImageTokens !== undefined) out.outputImageTokens = upstream.outputImageTokens;
  if (upstream.toolUsePromptTokens !== undefined) {
    out.toolUsePromptTokens = upstream.toolUsePromptTokens;
  }
  if (upstream.webSearchRequests !== undefined) out.webSearchRequests = upstream.webSearchRequests;
  if (upstream.notSupported !== undefined) out.notSupported = upstream.notSupported;
  return out;
}

/**
 * Usage-record batch 4: why the platform columns are empty on a served row.
 * The platform is "the other side" here: it refused (not_reported), could not
 * be reached (not_reached), or is not linked (not_configured).
 *
 * Since vxture-platform#547 (ADR-013) the platform answers a report with the
 * deduction's `event_id` when it deducted, and with a `credit_skip_reason`
 * when it recorded the raw fact and, by design, moved no credit for it: a
 * backfilled row, a failed attempt, a report with no rate in force. Those
 * rows have no deduction event to echo, so the empty id is `not_applicable`;
 * the raw fact is still correlated by `request_id`. A deduction the platform
 * did not name is its omission: `not_reported`.
 */
export function billingReasons(
  consumed: {
    billed: boolean;
    usageEventId?: string;
    notBilledBecause?: string;
    creditSkipReason?: string;
    creditsDeducted?: number;
  },
  context: { reported: boolean; workspaceKnown: boolean },
): Partial<Record<string, DimensionStatus>> {
  const all = (status: DimensionStatus) => ({
    billedMetricKey: status,
    billedAmount: status,
    costUnit: status,
    usageEventId: status,
  });
  if (consumed.billed) {
    if (consumed.usageEventId !== undefined) return {};
    // Not charged by design, or only the fractional carry moved: no deduction
    // event exists for this call.
    if (consumed.creditSkipReason !== undefined || consumed.creditsDeducted === 0) {
      return { usageEventId: "not_applicable" };
    }
    return { usageEventId: "not_reported" };
  }
  if (!context.workspaceKnown) return all("not_specified");
  if (!context.reported) return all("not_reported");
  switch (consumed.notBilledBecause) {
    case "not_configured":
      return all("not_configured");
    case "rejected":
      return all("not_reported");
    case "failed":
      return all("not_reached");
    case "no_amount":
      return all("not_applicable");
    case "no_caller":
      // ADR-010: nothing to attribute the report to - the caller did not identify itself.
      return all("not_specified");
    default:
      return all("capture_failed");
  }
}

/** The host of an endpoint URL, or undefined when it is not a URL. */
export function hostOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
