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

// ── extraBody ────────────────────────────────────────────────────────────────
//
// 存在的理由：厂商开关（DeepSeek 的 thinking / reasoning_effort、各家的
// response_format / stop / logprobs）都是**新字段**，paramMap 只能改名塞不进去。
// 没有这一层，"接一家改一次代码"就从后门回来了。

describe("buildOpenAiCompatibleBody - wire.extraBody", () => {
  it("merges vendor switches into the request body verbatim", () => {
    const body = buildOpenAiCompatibleBody(
      request(),
      false,
      wireFrom({
        wire: {
          extraBody: {
            thinking: { type: "disabled" },
            reasoning_effort: "low",
          },
        },
      }),
    );

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  it("lets the model layer override the provider layer", () => {
    const body = buildOpenAiCompatibleBody(
      request(),
      false,
      wireFrom(
        { wire: { extraBody: { thinking: { type: "disabled" } } } },
        { wire: { extraBody: { thinking: { type: "enabled" } } } },
      ),
    );

    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("cannot hijack the keys the adapter owns", () => {
    // 一个把 model 写进 extraBody 的行会让注册表里的模型名与真正发出去的不是
    // 同一个 - 静默地计错量、算错钱。写入侧拒，这里再兜一次底。
    const body = buildOpenAiCompatibleBody(
      request({ modelCode: "real-model" }),
      true,
      wireFrom({
        wire: {
          extraBody: {
            model: "smuggled",
            messages: [],
            stream: false,
            stream_options: { include_usage: false },
          },
        },
      }),
    );

    expect(body.model).toBe("real-model");
    expect(body.messages).toHaveLength(1);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("keeps an extraBody default when the caller sends no value of its own", () => {
    // 此前 `body.max_tokens = request.maxTokens` 是无条件赋值，会把配好的默认值
    // 抹成 undefined - 一个配了却不生效的开关，正是 extraBody 要消除的东西。
    // exactOptionalPropertyTypes: 缺席与 undefined 是两回事, 这里要的是缺席。
    const bare: ProviderChatRequest = {
      endpointUrl: "https://api.example/v1",
      apiKey: "k",
      modelCode: "m",
      messages: [{ role: "user", content: "hi" }],
    };

    const body = buildOpenAiCompatibleBody(
      bare,
      false,
      wireFrom({
        wire: { extraBody: { max_tokens: 4096, temperature: 0.7, top_p: 0.8 } },
      }),
    );

    expect(body.max_tokens).toBe(4096);
    // toBeCloseTo, not toBe: 浮点数的精确相等比较是 S1244。这里要的是"值原样
    // 透传",不是"某个特定的二进制表示"。
    expect(body.temperature).toBeCloseTo(0.7);
    expect(body.top_p).toBeCloseTo(0.8);
  });

  it("still lets an explicit caller value win over the configured default", () => {
    const body = buildOpenAiCompatibleBody(
      request({ maxTokens: 32 }),
      false,
      wireFrom({ wire: { extraBody: { max_tokens: 4096 } } }),
    );

    expect(body.max_tokens).toBe(32);
  });

  it("follows paramMap when the upstream renamed max_tokens", () => {
    const body = buildOpenAiCompatibleBody(
      request({ maxTokens: 64 }),
      false,
      wireFrom({ wire: { paramMap: { maxTokens: "max_completion_tokens" } } }),
    );

    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
  });
});
