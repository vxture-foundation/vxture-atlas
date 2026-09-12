import { describe, it, expect } from "vitest";

import {
  buildOpenAiCompatibleBody,
  normalizeOpenAiCompatibleResponse,
  parseOpenAiCompatibleStream,
} from "./openai-compatible";
import { collect, streamOf } from "./stream.fixtures";
import type {
  ChatMessage,
  ProviderChatRequest,
  StreamEvent,
} from "../types/runtime.types";

/** Build one OpenAI-dialect SSE frame. */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textChunk(content: string): string {
  return frame({ choices: [{ index: 0, delta: { content } }] });
}

describe("parseOpenAiCompatibleStream", () => {
  it("emits text deltas and terminates on the [DONE] sentinel", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          textChunk("Hello"),
          textChunk(" world"),
          frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events).toEqual<StreamEvent[]>([
      { type: "text", delta: "Hello" },
      { type: "text", delta: " world" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("carries usage from the final usage-bearing chunk into done", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          textChunk("hi"),
          frame({
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              total_tokens: 17,
            },
          }),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events.at(-1)).toEqual<StreamEvent>({
      type: "done",
      usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    });
  });

  it("derives total_tokens when the provider omits it", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          frame({
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      usage: { totalTokens: 7 },
    });
  });

  it("assembles a tool call from streamed argument fragments", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          frame({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "search", arguments: '{"q":' },
                    },
                  ],
                },
              },
            ],
          }),
          frame({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"atlas"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events[0]).toEqual<StreamEvent>({
      type: "tool_call",
      toolCall: { id: "call_1", name: "search", arguments: { q: "atlas" } },
    });
    expect(events[1]).toMatchObject({ finishReason: "tool_calls" });
  });

  it("still emits done with usage when the stream ends without [DONE]", async () => {
    // Upstream closed the connection after delivering usage. The tokens were
    // really consumed, so the call must still be metered (TD-017).
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          textChunk("partial"),
          frame({
            choices: [{ index: 0, delta: {}, finish_reason: "length" }],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 2,
              total_tokens: 10,
            },
          }),
        ),
      ),
    );

    expect(events.at(-1)).toEqual<StreamEvent>({
      type: "done",
      usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
      finishReason: "length",
    });
  });

  it("omits usage entirely when the provider never reported any", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(streamOf(textChunk("hi"), "data: [DONE]\n\n")),
    );

    expect(events.at(-1)).toEqual<StreamEvent>({ type: "done" });
  });

  it("reports an unparseable frame as an error event and continues", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf("data: {not json\n\n", textChunk("after"), "data: [DONE]\n\n"),
      ),
    );

    expect(events[0]?.type).toBe("error");
    expect(events[1]).toEqual<StreamEvent>({ type: "text", delta: "after" });
  });

  it("skips empty content deltas rather than emitting blank text events", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          frame({ choices: [{ index: 0, delta: { role: "assistant" } }] }),
          textChunk(""),
          textChunk("real"),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", delta: "real" },
    ]);
  });
});

describe("parseOpenAiCompatibleStream - cost splits (TD-047)", () => {
  it("carries the cached and reasoning counts out of the usage frame", async () => {
    // The streaming half matters more than the non-streaming one: a thinking
    // model spends most of its output on the reasoning chain, and that is the
    // cost an operator can actually switch off.
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          textChunk("hi"),
          frame({
            choices: [],
            usage: {
              prompt_tokens: 84,
              completion_tokens: 469,
              total_tokens: 553,
              prompt_cache_hit_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 440 },
            },
          }),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events.at(-1)).toEqual<StreamEvent>({
      type: "done",
      usage: {
        promptTokens: 84,
        completionTokens: 469,
        totalTokens: 553,
        cachedInputTokens: 20,
        reasoningTokens: 440,
      },
    });
  });

  it("omits the splits when the frame does not report them", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(
          textChunk("hi"),
          frame({
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
          "data: [DONE]\n\n",
        ),
      ),
    );

    expect(events.at(-1)).toEqual<StreamEvent>({
      type: "done",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
  });
});

/**
 * 思考型模型的推理载荷（TD-046 / vxture-platform#50）。
 *
 * 这条缺陷的实质不是「少交付了一段文本」，是**回传义务没有出口**：DeepSeek 带
 * `tools` 时要求 `reasoning_content` 完整回传，否则 400，而那个 400 出现在调用方
 * 那一侧。所以判据的重点在**信封的完整性**，不在文本好不好看。
 */
describe("推理载荷 · 流式（TD-046）", () => {
  function reasoningChunk(delta: string): string {
    return frame({ choices: [{ index: 0, delta: { reasoning_content: delta } }] });
  }

  it("推理分片是独立事件，不并进 text", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(reasoningChunk("想"), reasoningChunk("一下"), textChunk("答案"), "data: [DONE]\n\n"),
      ),
    );
    /* 决定性的一条：正文流里只有正文。混进去的话调用方无法区分，而它拿到的
       「答案」会变成「想一下答案」——比不发更糟。 */
    const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
    expect(text).toBe("答案");
    const reasoning = events
      .filter((e): e is Extract<StreamEvent, { type: "reasoning" }> => e.type === "reasoning")
      .map((e) => e.delta);
    expect(reasoning).toEqual(["想", "一下"]);
  });

  it("done 帧带完整信封 —— 调用方不必自己拼分片", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(
        streamOf(reasoningChunk("前"), reasoningChunk("后"), textChunk("x"), "data: [DONE]\n\n"),
      ),
    );
    const done = events.find((e) => e.type === "done") as Extract<
      StreamEvent,
      { type: "done" }
    >;
    /* 拼分片是能拼出本上游的文本的——但那只对本上游成立。别的上游（Anthropic 的
       `signature`）根本不在分片里，让调用方拼等于要求它发明拿不到的东西。 */
    expect(done.reasoning).toEqual({ text: "前后" });
  });

  it("没有推理载荷时 done 上不出现该键 —— 缺省不等于空串", async () => {
    const events = await collect(
      parseOpenAiCompatibleStream(streamOf(textChunk("x"), "data: [DONE]\n\n")),
    );
    const done = events.find((e) => e.type === "done") as Extract<
      StreamEvent,
      { type: "done" }
    >;
    /* 一个 `{ text: "" }` 会让调用方以为有东西要回传，然后回传空串——对上游来说
       那和没传不是一回事。 */
    expect("reasoning" in done).toBe(false);
  });
});

/**
 * 回传那一半 —— **TD-046 的实质在这里，不在上面。**
 *
 * 上面那组证明的是「推理文本能交付出去」。真正会 400 的是回传:调用方把上一轮的
 * assistant 消息带回来时，`reasoning` 必须完整到达上游。
 */
describe("推理载荷 · 回传（TD-046 的实质）", () => {
  const base = {
    modelCode: "deepseek-v4",
    messages: [] as ChatMessage[],
  } as unknown as ProviderChatRequest;

  function wireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    const body = buildOpenAiCompatibleBody(
      { ...base, messages } as ProviderChatRequest,
      false,
    );
    return body["messages"] as Array<Record<string, unknown>>;
  }

  it("带 tool_calls 的 assistant 轮次把 reasoning 送回上游", () => {
    const [msg] = wireMessages([
      {
        role: "assistant",
        content: "",
        reasoning: { text: "上一轮的思考" },
        toolCalls: [{ id: "c1", name: "search", arguments: { q: "x" } }],
      },
    ]);
    /* 这正是 DeepSeek 要求的那个场景:带 tools 的多轮，缺了它就是 400。 */
    expect(msg?.["reasoning_content"]).toBe("上一轮的思考");
    expect(msg?.["tool_calls"]).toBeDefined();
  });

  it("普通 assistant 轮次也送回 —— 上一轮没调工具不等于没有推理", () => {
    const [msg] = wireMessages([
      { role: "assistant", content: "答案", reasoning: { text: "思考" } },
    ]);
    expect(msg?.["reasoning_content"]).toBe("思考");
  });

  it("信封里不认识的键**照样铺开**，不静默丢弃", () => {
    /* 决定性的一条。调用方被要求「原样回传整个对象」；如果适配器在这里丢掉它不
       认识的键，那条要求就成了一句空话——而症状会在换供应商的那天才出现，且表现
       为上游 400 而不是本仓的任何失败。 */
    const [msg] = wireMessages([
      {
        role: "assistant",
        content: "x",
        reasoning: { text: "t", signature: "sig-abc", redacted: true },
      },
    ]);
    expect(msg?.["reasoning_content"]).toBe("t");
    expect(msg?.["signature"]).toBe("sig-abc");
    expect(msg?.["redacted"]).toBe(true);
  });

  it("没有 reasoning 时线上不出现该键", () => {
    const [msg] = wireMessages([{ role: "assistant", content: "x" }]);
    expect("reasoning_content" in (msg ?? {})).toBe(false);
  });

  it("非流式响应把上游的 reasoning_content 读成信封", () => {
    const out = normalizeOpenAiCompatibleResponse("deepseek", {
      choices: [
        { message: { role: "assistant", content: "答案", reasoning_content: "思考" } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(out.reasoning).toEqual({ text: "思考" });
  });

  it("上游给空串 → 不构造空信封", () => {
    const out = normalizeOpenAiCompatibleResponse("deepseek", {
      choices: [
        { message: { role: "assistant", content: "答案", reasoning_content: "" } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(out.reasoning).toBeUndefined();
  });
});
