import { describe, it, expect } from "vitest";

import {
  normalizeOpenAiCompatibleResponse,
  resolveChatCompletionsEndpoint,
} from "./openai-compatible";
import type { OpenAiCompatibleChatResponse } from "./openai-compatible.types";

// ── resolveChatCompletionsEndpoint ────────────────────────────────────────────

describe("resolveChatCompletionsEndpoint", () => {
  it("returns the URL unchanged when it already ends with /chat/completions", () => {
    const url = "https://api.openai.com/v1/chat/completions";
    expect(resolveChatCompletionsEndpoint(url)).toBe(url);
  });

  it("appends /chat/completions to a bare base URL", () => {
    expect(resolveChatCompletionsEndpoint("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("appends correctly when the base has a trailing slash", () => {
    expect(resolveChatCompletionsEndpoint("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("appends correctly for a custom endpoint", () => {
    expect(resolveChatCompletionsEndpoint("https://my-proxy.internal")).toBe(
      "https://my-proxy.internal/chat/completions",
    );
  });
});

// ── normalizeOpenAiCompatibleResponse ─────────────────────────────────────────

function makeResponse(
  overrides: Partial<OpenAiCompatibleChatResponse> = {},
): OpenAiCompatibleChatResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

describe("normalizeOpenAiCompatibleResponse", () => {
  it("maps a normal text response", () => {
    const result = normalizeOpenAiCompatibleResponse("test", makeResponse());
    expect(result.content).toBe("Hello!");
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
    expect(result.totalTokens).toBe(15);
  });

  it('maps finish_reason "stop"', () => {
    const result = normalizeOpenAiCompatibleResponse("test", makeResponse());
    expect(result.finishReason).toBe("stop");
  });

  it('maps finish_reason "length"', () => {
    const result = normalizeOpenAiCompatibleResponse(
      "test",
      makeResponse({
        choices: [{ message: { content: "Hi" }, finish_reason: "length" }],
      }),
    );
    expect(result.finishReason).toBe("length");
  });

  it('maps finish_reason "tool_calls"', () => {
    const response = makeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"BJ"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = normalizeOpenAiCompatibleResponse("test", response);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("get_weather");
    expect(result.toolCalls?.[0]?.arguments).toEqual({ city: "BJ" });
  });

  it("maps function_call finish_reason to tool_calls", () => {
    const response = makeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c",
                type: "function",
                function: { name: "fn", arguments: "{}" },
              },
            ],
          },
          finish_reason: "function_call",
        },
      ],
    });
    const result = normalizeOpenAiCompatibleResponse("test", response);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("omits finishReason for unknown finish_reason values", () => {
    const result = normalizeOpenAiCompatibleResponse(
      "test",
      makeResponse({
        choices: [
          { message: { content: "Hi" }, finish_reason: "unknown_value" },
        ],
      }),
    );
    expect(result.finishReason).toBeUndefined();
  });

  it("falls back to prompt+completion sum when total_tokens is absent", () => {
    const result = normalizeOpenAiCompatibleResponse("test", {
      choices: [{ message: { content: "Hi" } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    });
    expect(result.totalTokens).toBe(12);
  });

  it("defaults token counts to 0 when usage is absent", () => {
    const result = normalizeOpenAiCompatibleResponse("test", {
      choices: [{ message: { content: "Hi" } }],
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it("throws when content is empty and no tool calls", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [{ message: { content: "" } }],
    };
    expect(() =>
      normalizeOpenAiCompatibleResponse("test-provider", response),
    ).toThrow("test-provider returned invalid response: empty model response");
  });

  it("includes the provider error message when present", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [{ message: { content: "" } }],
      error: { message: "rate limit exceeded" },
    };
    expect(() =>
      normalizeOpenAiCompatibleResponse("my-provider", response),
    ).toThrow("my-provider returned invalid response: rate limit exceeded");
  });

  it("throws when choices is absent", () => {
    expect(() => normalizeOpenAiCompatibleResponse("test", {})).toThrow();
  });

  it("omits toolCalls from result when there are none", () => {
    const result = normalizeOpenAiCompatibleResponse("test", makeResponse());
    expect(result.toolCalls).toBeUndefined();
  });
});

// ── empty-response diagnostics ────────────────────────────────────────────────
//
// 每一条都对应运营在自检页面上看到的那句话。它们此前被压成同一句
// "empty model response"，而三种成因的处置完全不同 —— 一个是调大预算，一个是
// 关思考，一个是上游真的坏了。

describe("normalizeOpenAiCompatibleResponse - why the response was empty", () => {
  it("names the reasoning chain when it ate the whole output budget", () => {
    // DeepSeek V4 默认开思考、effort=high，思考链算 completion。预算太小时
    // content 为空而 finish_reason=length —— 模型完全正常。
    const response: OpenAiCompatibleChatResponse = {
      choices: [
        {
          message: { content: "", reasoning_content: "let me think about ping" },
          finish_reason: "length",
        },
      ],
    };

    expect(() =>
      normalizeOpenAiCompatibleResponse("openai-compatible", response),
    ).toThrow(/reasoning chain.*finish_reason=length.*23 chars/s);
  });

  it("tells the operator both ways out - raise the budget or turn thinking off", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [
        { message: { content: "", reasoning_content: "..." }, finish_reason: "length" },
      ],
    };

    const run = () =>
      normalizeOpenAiCompatibleResponse("openai-compatible", response);
    expect(run).toThrow(/raise max_tokens/);
    expect(run).toThrow(/config\.wire\.extraBody/);
  });

  it("reports a truncated non-thinking response without inventing a reasoning chain", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    };

    const run = () => normalizeOpenAiCompatibleResponse("test", response);
    expect(run).toThrow(/finish_reason=length/);
    expect(run).not.toThrow(/reasoning/);
  });

  it("reports reasoning-only output that was not truncated", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [
        { message: { content: null, reasoning_content: "hmm" }, finish_reason: "stop" },
      ],
    };

    expect(() => normalizeOpenAiCompatibleResponse("test", response)).toThrow(
      "test returned invalid response: model returned 3 chars of reasoning_content and no content",
    );
  });

  it("names the content filter rather than blaming the model", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
    };

    expect(() => normalizeOpenAiCompatibleResponse("test", response)).toThrow(
      /content filter/,
    );
  });

  it("distinguishes an empty choices array from an empty message", () => {
    expect(() => normalizeOpenAiCompatibleResponse("test", { choices: [] })).toThrow(
      "test returned invalid response: response carried no choices",
    );
  });

  it("still prefers the upstream's own error message over any of the above", () => {
    const response: OpenAiCompatibleChatResponse = {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      error: { message: "insufficient balance" },
    };

    expect(() => normalizeOpenAiCompatibleResponse("test", response)).toThrow(
      "test returned invalid response: insufficient balance",
    );
  });
});

// ── cost splits (TD-047) ─────────────────────────────────────────────────────
//
// These two numbers decide what a call COST, as opposed to how large it was.
// Atlas is the only place they are available, so a split dropped here is lost
// for the whole company - and unlike a price, a token count cannot be
// backfilled.

describe("normalizeOpenAiCompatibleResponse - cost splits", () => {
  const withUsage = (usage: Record<string, unknown>) => ({
    choices: [{ message: { content: "hi" } }],
    usage,
  });

  it("reads the cached-input count from OpenAI's nested spelling", () => {
    const r = normalizeOpenAiCompatibleResponse("test", withUsage({
      prompt_tokens: 84, completion_tokens: 16, total_tokens: 100,
      prompt_tokens_details: { cached_tokens: 64 },
    }));

    expect(r.cachedInputTokens).toBe(64);
  });

  it("reads DeepSeek's top-level spelling of the same fact", () => {
    // Verified against the live API 2026-08-24: DeepSeek sends both, and a
    // reader that only knew the nested one would silently meter every DeepSeek
    // call as fully uncached - 30x the real input cost.
    const r = normalizeOpenAiCompatibleResponse("test", withUsage({
      prompt_tokens: 84, completion_tokens: 16, total_tokens: 100,
      prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 64,
    }));

    expect(r.cachedInputTokens).toBe(20);
  });

  it("reads the reasoning-token count", () => {
    const r = normalizeOpenAiCompatibleResponse("test", withUsage({
      prompt_tokens: 84, completion_tokens: 227, total_tokens: 311,
      completion_tokens_details: { reasoning_tokens: 211 },
    }));

    expect(r.reasoningTokens).toBe(211);
  });

  it("leaves both ABSENT when the upstream reported neither", () => {
    // Absent, not 0. The column must stay NULL: "the upstream said nothing" and
    // "it cost nothing" are different facts and only one of them is free.
    const r = normalizeOpenAiCompatibleResponse("test", withUsage({
      prompt_tokens: 12, completion_tokens: 3, total_tokens: 15,
    }));

    expect(r.cachedInputTokens).toBeUndefined();
    expect(r.reasoningTokens).toBeUndefined();
    expect("cachedInputTokens" in r).toBe(false);
  });

  it("keeps a reported zero, which is a measurement", () => {
    const r = normalizeOpenAiCompatibleResponse("test", withUsage({
      prompt_tokens: 84, completion_tokens: 16, total_tokens: 100,
      prompt_cache_hit_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
    }));

    expect(r.cachedInputTokens).toBe(0);
    expect(r.reasoningTokens).toBe(0);
  });

  it("reports no splits at all when the upstream sent no usage object", () => {
    const r = normalizeOpenAiCompatibleResponse("test", {
      choices: [{ message: { content: "hi" } }],
    });

    expect(r.usageReported).toBe(false);
    expect(r.cachedInputTokens).toBeUndefined();
  });
});
