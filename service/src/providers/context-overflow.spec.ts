import { describe, expect, it } from "vitest";

import {
  CONTEXT_OVERFLOW_SIGNATURES,
  isContextOverflow,
} from "./context-overflow";

/**
 * Each entry pins one vendor's refusal as that vendor sends it (ADR-008 table,
 * researched 2026-09-29). The look-alikes below matter as much: a signature
 * that also fires on a quota or parameter error sends the caller off to split
 * an input that was never too long.
 */
const OVERFLOWS: Array<[string, string]> = [
  [
    "OpenAI dialect, by code",
    JSON.stringify({
      error: {
        message: "This model's maximum context length is 128000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    }),
  ],
  [
    "DeepSeek, standard wording without the code",
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 1048576 tokens. However, you requested 1049647 tokens (985647 in the messages, 64000 in the completion).",
        type: "invalid_request_error",
      },
    }),
  ],
  [
    "DeepSeek, spelled as a quota error",
    JSON.stringify({
      message: "Input token exceed the limit (request id: abc)",
      type: "api_error",
      param: "",
      code: "quota_limit_reached",
    }),
  ],
  [
    "Zhipu 1261",
    // "Prompt 超长" = "prompt too long", as the vendor sends it.
    JSON.stringify({ error: { code: "1261", message: "Prompt 超长" } }),
  ],
  [
    "Doubao (recorded 2026-09-30 from a real over-context request)",
    JSON.stringify({
      error: {
        code: "InvalidParameter",
        message:
          "Total tokens of multi-modal content and text exceed max message tokens. Request id: <redacted>",
        param: "",
        type: "BadRequest",
      },
    }),
  ],
  [
    "Claude",
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 250000 tokens > 200000 maximum",
      },
    }),
  ],
  ["unparseable body carrying the wording", "prompt is too long: 250000 tokens > 200000 maximum"],
];

const LOOKALIKES: Array<[string, number, string]> = [
  [
    "DeepSeek's REAL quota error - same code, no overflow wording",
    400,
    JSON.stringify({ message: "quota exhausted", code: "quota_limit_reached" }),
  ],
  [
    "Doubao's generic InvalidParameter for some other parameter",
    400,
    JSON.stringify({
      error: { code: "InvalidParameter", message: "The parameter `temperature` specified in the request is not valid", type: "BadRequest" },
    }),
  ],
  [
    "Zhipu 1210 parameter error",
    400,
    JSON.stringify({ error: { code: "1210", message: "API call parameter error" } }),
  ],
  [
    "Claude's other 400s",
    400,
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This model does not support assistant message prefill.",
      },
    }),
  ],
  [
    "overflow wording on a 413 (a byte cap, not the context window)",
    413,
    JSON.stringify({ error: { code: "context_length_exceeded", message: "x" } }),
  ],
  ["empty body", 400, ""],
];

describe("isContextOverflow", () => {
  it.each(OVERFLOWS)("recognises %s", (_name, body) => {
    expect(isContextOverflow(400, body)).toBe(true);
  });

  it.each(LOOKALIKES)("does not fire on %s", (_name, status, body) => {
    expect(isContextOverflow(status, body)).toBe(false);
  });

  // A signature declaring neither field matches every 400 - one careless
  // entry would relabel every content refusal as an overflow.
  it("has no signature that matches unconditionally", () => {
    for (const signature of CONTEXT_OVERFLOW_SIGNATURES) {
      expect(signature.code !== undefined || signature.message !== undefined).toBe(true);
    }
  });
});
