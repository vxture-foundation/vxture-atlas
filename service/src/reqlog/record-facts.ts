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
 * be reached (not_reached), is not linked (not_configured), or never returns
 * an event id at all (not_supported, until vxture-platform#547).
 */
export function billingReasons(
  consumed: { billed: boolean; usageEventId?: string; notBilledBecause?: string },
  context: { reported: boolean; workspaceKnown: boolean },
): Partial<Record<string, DimensionStatus>> {
  const all = (status: DimensionStatus) => ({
    billedMetricKey: status,
    billedAmount: status,
    costUnit: status,
    usageEventId: status,
  });
  if (consumed.billed) {
    return consumed.usageEventId === undefined ? { usageEventId: "not_supported" } : {};
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
