import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleProvider } from "./openai-compatible.provider";
import { ZhipuProvider } from "./zhipu.provider";

/**
 * tenderforge#69, 2026-09-30: a non-streaming chat to Doubao or DeepSeek gets
 * its response headers only once the whole answer is generated. A 30 s
 * first-byte wait therefore failed every non-streaming answer that took longer,
 * regardless of the caller's timeoutMs. These run the real adapters against a
 * fetch that answers late, with the first-byte window shrunk to 50 ms.
 */

const LATE_MS = 150;

/** A fetch that answers after LATE_MS, and rejects like fetch when aborted. */
function lateFetch(body: unknown) {
  return vi.fn((_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(new Response(JSON.stringify(body), { status: 200 })),
        LATE_MS,
      );
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    }),
  );
}

beforeEach(() => {
  process.env["PROVIDER_CONNECT_TIMEOUT_MS"] = "50";
});

afterEach(() => {
  delete process.env["PROVIDER_CONNECT_TIMEOUT_MS"];
  vi.unstubAllGlobals();
});

describe("header wait by kind of call", () => {
  it("a non-streaming chat waits for the whole answer, past the first-byte window", async () => {
    vi.stubGlobal(
      "fetch",
      lateFetch({
        choices: [{ message: { content: "long answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );

    const result = await new OpenAiCompatibleProvider().chat({
      endpointUrl: "https://ark.example/api/v3",
      apiKey: "k",
      modelCode: "doubao-x",
      messages: [{ role: "user", content: "write a lot" }],
    });

    expect(result.content).toBe("long answer");
  });

  it("an embed call keeps the first-byte window - it does not generate", async () => {
    vi.stubGlobal("fetch", lateFetch({ data: [] }));

    await expect(
      new ZhipuProvider().embed({
        endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "k",
        modelCode: "embedding-3",
        texts: ["a"],
      }),
    ).rejects.toThrow(/did not send response headers within 50ms/);
  });

  it("the caller's deadline still ends a non-streaming chat", async () => {
    vi.stubGlobal("fetch", lateFetch({ choices: [] }));

    await expect(
      new OpenAiCompatibleProvider().chat({
        endpointUrl: "https://ark.example/api/v3",
        apiKey: "k",
        modelCode: "doubao-x",
        messages: [{ role: "user", content: "hi" }],
        signal: AbortSignal.timeout(20),
      }),
    ).rejects.toThrow();
  });
});
