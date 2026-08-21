import { EventSourceParserStream } from "eventsource-parser/stream";
import type { EventSourceMessage } from "eventsource-parser/stream";

import { ProviderHttpError } from "./base.provider";
import { describeAbort, guardTimeToFirstByte } from "./upstream-timeout";

/**
 * SSE 分帧解析层。
 *
 * 分帧交给 `eventsource-parser`（MIT）而不是手写。此前的手写实现藏在
 * `doubao.provider.ts` 里，行为大体正确 —— 换掉它不是为了修分帧 bug，而是
 * 因为分帧是 SSE 规范已经定死的部分（`\r\n` 与 `\n` 混用、多行 `data:`、
 * 注释心跳、`event:`/`id:` 字段、跨包切断的多字节字符），没有任何 Atlas 特有
 * 语义，不值得自己维护一份并为它写回归测试。各 provider 的差异只在「帧里装
 * 什么」，那部分留在各自的适配器里（见 ADR-004 的借鉴结论）。
 *
 * 一个规范行为需要知道：未以空行结束的流尾帧会被丢弃（见 `sse.spec.ts`）。
 * 因此上层解析器必须始终从已累积的状态收敛出一个 `done` 事件，而不能依赖
 * 最后一帧一定到达 —— 否则 usage 丢失就是漏计量（TD-017）。
 */
export async function* readSseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EventSourceMessage> {
  const messages = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  const reader = messages.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // 消费方提前跳出（客户端断连、上层 fallback 放弃这一路）时，必须主动
    // cancel 上游，否则 provider 侧连接会一直挂着直到超时。仅 releaseLock
    // 不会关闭底层连接。
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * 发起一次 SSE 形式的 provider 请求，返回可分帧读取的响应体。
 *
 * doubao/zhipu/private/claude 四家的这一段此前是四份逐字重复的 fetch +
 * 错误处理；差异只有 header 与 body。
 */
export async function openSseRequest(options: {
  providerName: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  const guard = guardTimeToFirstByte(options.providerName, options.signal);

  let response: Response;
  try {
    response = await fetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify(options.body),
      signal: guard.signal,
    });
  } catch (error) {
    throw describeAbort(error, guard, options.providerName);
  } finally {
    // 流式尤其需要在头部到达后解除计时：SSE 的 body 本来就要开着很久。
    guard.settle();
  }

  if (!response.ok) {
    throw new ProviderHttpError(
      `${options.providerName} stream request failed with status ${response.status}`,
      response.status,
      options.providerName,
      await safeReadText(response),
    );
  }

  if (!response.body) {
    throw new Error(`${options.providerName} returned empty stream body`);
  }

  return response.body;
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
