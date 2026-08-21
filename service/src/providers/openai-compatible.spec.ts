import { describe, it, expect } from "vitest";

import { parseOpenAiCompatibleStream } from "./openai-compatible";
import { collect, streamOf } from "./stream.fixtures";
import type { StreamEvent } from "../types/runtime.types";

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
