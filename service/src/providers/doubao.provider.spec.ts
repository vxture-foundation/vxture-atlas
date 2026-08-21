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
