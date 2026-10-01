/**
 * usage-keys.ts - which fields of a vendor's usage object Atlas knows.
 *
 * An adapter's `notSupported` list (ADR-011) is a claim about the vendor: "this
 * protocol has no such field". Nothing checked it. When a vendor starts sending
 * a new figure, it lands in `upstream_usage` verbatim, the normalized column
 * stays NULL, and `dimension_status` keeps saying `not_supported` - correct
 * the day it was written, false from then on, and silent about it.
 *
 * This is the check. Every leaf of the raw usage object that is not in the
 * list below is counted (`upstream_usage_unmapped_keys_total{provider,key}`).
 * A non-zero series means a vendor reports something Atlas does not map: map
 * it to a column, or add it here as deliberately ignored - either way a person
 * has read it.
 *
 * "Known" means read OR deliberately ignored. `total_tokens` is not a column
 * of its own derivation but is known; that is why the list is not generated
 * from the adapters' reads.
 */

/** Leaf paths, dotted, across every dialect Atlas speaks. */
export const KNOWN_USAGE_PATHS: ReadonlySet<string> = new Set([
  // OpenAI dialect (OpenAI, DeepSeek, Doubao, Zhipu chat)
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_tokens_details.cached_tokens",
  "prompt_tokens_details.audio_tokens",
  "completion_tokens_details.reasoning_tokens",
  "completion_tokens_details.audio_tokens",
  // DeepSeek's top-level spellings; the miss count is input - hit, so ignored.
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  // Anthropic
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation.ephemeral_5m_input_tokens",
  "cache_creation.ephemeral_1h_input_tokens",
  "service_tier",
  "server_tool_use.web_search_requests",
]);

/** Deeper than any usage object seen; bounds the walk on a hostile payload. */
const MAX_DEPTH = 3;
/** A label value; a vendor key is short, anything else is not a key. */
const LABEL = /^[A-Za-z0-9_.]{1,80}$/;

/**
 * The leaf paths of `usage` that are not known. A null or absent value states
 * nothing and is skipped, so `prompt_tokens_details: null` is not a new field.
 */
export function unmappedUsagePaths(usage: unknown): string[] {
  const out: string[] = [];
  walk(usage, "", 0, out);
  return out;
}

function walk(value: unknown, prefix: string, depth: number, out: string[]): void {
  if (value === null || value === undefined) return;
  const isObject = typeof value === "object" && !Array.isArray(value);
  if (!isObject || depth >= MAX_DEPTH) {
    if (prefix !== "" && !KNOWN_USAGE_PATHS.has(prefix)) {
      out.push(LABEL.test(prefix) ? prefix : "malformed");
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walk(child, prefix === "" ? key : `${prefix}.${key}`, depth + 1, out);
  }
}
