import { describe, it, expect } from "vitest";

import {
  buildOpenAiCompatibleBody,
  resolveChatCompletionsEndpoint,
} from "./openai-compatible";
import { OPENAI_WIRE_DEFAULTS, resolveWire } from "./wire";
import type { ProviderChatRequest } from "../types/runtime.types";

function request(
  overrides: Partial<ProviderChatRequest> = {},
): ProviderChatRequest {
  return {
    endpointUrl: "https://api.example/v1",
    apiKey: "k",
    modelCode: "m",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
    topP: 0.9,
    temperature: 0.5,
    ...overrides,
  };
}

const wireFrom = (...configs: Array<Record<string, unknown> | undefined>) =>
  resolveWire(OPENAI_WIRE_DEFAULTS, ...configs);

describe("buildOpenAiCompatibleBody - stream usage opt-in", () => {
  it("asks for usage on a stream by default", () => {
    // 这是本次的行为变更：此前一处都没有下发 stream_options，而
    // runtime.service 只在 done 携带 usage 时才写计量行。
    const body = buildOpenAiCompatibleBody(request(), true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("never sends stream_options on a non-streaming call", () => {
    const body = buildOpenAiCompatibleBody(request(), false);
    expect(body.stream_options).toBeUndefined();
  });

  it.each(["native", "none"])(
    "omits stream_options when the provider declares streamUsage=%s",
    (streamUsage) => {
      // 上游若拒绝这个参数，修法是一条注册表数据，不是改代码。
      const body = buildOpenAiCompatibleBody(
        request(),
        true,
        wireFrom({ wire: { streamUsage } }),
      );
      expect(body.stream_options).toBeUndefined();
    },
  );
});

describe("buildOpenAiCompatibleBody - capability gating", () => {
  it("drops tools when the provider declares no tool support", () => {
    const body = buildOpenAiCompatibleBody(
      request({
        tools: [{ name: "t", description: "d", parameters: {} }],
        toolChoice: "auto",
      }),
      false,
      wireFrom({ wire: { supports: { tools: false, toolChoice: false } } }),
    );

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("sends tools by default", () => {
    const body = buildOpenAiCompatibleBody(
      request({ tools: [{ name: "t", description: "d", parameters: {} }] }),
      false,
    );
    expect(body.tools).toHaveLength(1);
  });

  it("drops top_p and temperature when unsupported", () => {
    const body = buildOpenAiCompatibleBody(
      request(),
      false,
      wireFrom({ wire: { supports: { topP: false, temperature: false } } }),
    );

    expect(body.top_p).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });
});

describe("buildOpenAiCompatibleBody - paramMap", () => {
  it("renames max_tokens when the upstream calls it something else", () => {
    const body = buildOpenAiCompatibleBody(
      request(),
      false,
      wireFrom({ wire: { paramMap: { maxTokens: "max_completion_tokens" } } }),
    );

    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
  });

  it("uses max_tokens by default", () => {
    expect(buildOpenAiCompatibleBody(request(), false).max_tokens).toBe(100);
  });
});

describe("resolveChatCompletionsEndpoint", () => {
  it("appends the default path", () => {
    expect(resolveChatCompletionsEndpoint("https://api.example/v1")).toBe(
      "https://api.example/v1/chat/completions",
    );
  });

  it("honours a provider-declared chatPath", () => {
    expect(
      resolveChatCompletionsEndpoint("https://api.example", "/v1/chat"),
    ).toBe("https://api.example/v1/chat");
  });

  it("does not double-append a path the URL already ends with", () => {
    expect(
      resolveChatCompletionsEndpoint("https://api.example/v1/chat", "/v1/chat"),
    ).toBe("https://api.example/v1/chat");
  });
});
