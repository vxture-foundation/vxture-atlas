import type { UpstreamCallRecord } from "../types/runtime.types";

/**
 * Usage-record batch 1 (A3, C4, G2, H3): what the upstream said about a call,
 * unmapped, for the reqlog row. Every adapter builds it here so the rule is
 * stated once: an absent field stays absent. An empty string or `{}` would read
 * as "the vendor sent this", which is the one thing the record must not claim.
 */
export function upstreamRecord(
  id: string | undefined,
  model: string | undefined,
  finishReason: string | undefined,
  usage: object | undefined,
): UpstreamCallRecord {
  return {
    ...(typeof id === "string" && id ? { upstreamRequestId: id } : {}),
    ...(typeof model === "string" && model ? { upstreamModel: model } : {}),
    ...(typeof finishReason === "string" && finishReason
      ? { nativeFinishReason: finishReason }
      : {}),
    ...(usage !== undefined && usage !== null
      ? { rawUsage: usage as Record<string, unknown> }
      : {}),
  };
}

/**
 * `{ upstream }` when the vendor said anything, `{}` otherwise - for spreading
 * into a response or a done frame, which should not carry an empty record.
 */
export function upstreamField(
  id: string | undefined,
  model: string | undefined,
  finishReason: string | undefined,
  usage: object | undefined,
): { upstream?: UpstreamCallRecord } {
  const record = upstreamRecord(id, model, finishReason, usage);
  return Object.keys(record).length > 0 ? { upstream: record } : {};
}
