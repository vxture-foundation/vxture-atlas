/**
 * context-overflow.ts - recognise an upstream's "input too long" refusal.
 *
 * ADR-008: Atlas does not estimate tokens; it recognises the upstream's own
 * refusal and answers it as `CONTEXT_LENGTH_EXCEEDED`. Every upstream says it
 * differently (researched 2026-09-29, table in the ADR), so recognition is a
 * list of per-vendor signatures.
 *
 * The signatures are DATA on purpose, not branches: TD-055 moves them into
 * per-provider configuration, and a list of plain objects can move there
 * without rewriting any logic. Until then this list is the one place they live.
 *
 * An unrecognised overflow is NOT misclassified - it stays
 * `UPSTREAM_REJECTED_REQUEST`, which is handled identically (non-retryable,
 * no breaker count, fallback tried). A missing signature costs precision,
 * never a wrong action; that is what makes a hand-kept list acceptable.
 */

export interface ContextOverflowSignature {
  /** Who says it this way - for the test that pins it, and for TD-055. */
  vendor: string;
  /** `error.code` in the upstream body, compared as a string. */
  code?: string;
  /** Case-insensitive pattern the upstream's message must contain. */
  message?: RegExp;
}

/**
 * A signature matches when EVERY field it declares matches. That is what
 * keeps DeepSeek's `quota_limit_reached` safe: that code alone means a quota
 * problem, so its entry also requires the overflow message.
 */
export const CONTEXT_OVERFLOW_SIGNATURES: readonly ContextOverflowSignature[] = [
  // OpenAI dialect, and every OpenAI-compatible upstream that copies it.
  { vendor: "openai-dialect", code: "context_length_exceeded" },
  // Same condition where the code is absent but the standard wording is kept
  // (DeepSeek's first form: "This model's maximum context length is N tokens.
  // However, you requested M tokens ...").
  { vendor: "openai-dialect", message: /maximum context length is \d+ tokens/iu },
  // DeepSeek's second form, spelled as a quota error. The message is required.
  { vendor: "deepseek", code: "quota_limit_reached", message: /input tokens? exceeds? the limit/iu },
  // Zhipu: business code 1261, "prompt too long" (docs.bigmodel.cn error-code table).
  { vendor: "zhipu", code: "1261" },
  // Claude: a plain 400 invalid_request_error; only the wording identifies it.
  // Observed wording, not documented by the vendor: "prompt is too long:
  // 250000 tokens > 200000 maximum".
  { vendor: "claude", message: /prompt is too long/iu },
];

interface UpstreamErrorFields {
  code?: string;
  message: string;
}

/**
 * Pull `code` / `message` from the shapes the upstreams use: OpenAI-style
 * `{error: {code, message}}`, Anthropic `{type: "error", error: {type,
 * message}}`, and flat `{code, message}` (DeepSeek's quota form). Anything
 * unparseable is matched on its raw text, so a signature with only a message
 * pattern still has something to read.
 */
function fieldsOf(responseBody: string): UpstreamErrorFields {
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const inner =
      typeof parsed["error"] === "object" && parsed["error"] !== null
        ? (parsed["error"] as Record<string, unknown>)
        : parsed;
    const code = inner["code"] ?? parsed["code"];
    const message = inner["message"] ?? parsed["message"];
    return {
      ...(code === undefined || code === null ? {} : { code: String(code) }),
      message: typeof message === "string" ? message : responseBody,
    };
  } catch {
    return { message: responseBody };
  }
}

/** Is this upstream refusal a context-window overflow? Only a 400 can be. */
export function isContextOverflow(
  status: number,
  responseBody: string | undefined,
  signatures: readonly ContextOverflowSignature[] = CONTEXT_OVERFLOW_SIGNATURES,
): boolean {
  if (status !== 400 || !responseBody) return false;
  const fields = fieldsOf(responseBody);
  return signatures.some(
    (signature) =>
      (signature.code === undefined || signature.code === fields.code) &&
      (signature.message === undefined || signature.message.test(fields.message)),
  );
}
