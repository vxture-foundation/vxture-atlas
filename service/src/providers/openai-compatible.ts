import { joinEndpoint, resolveUpstreamModel } from "./base.provider";
import type {
  OpenAiCompatibleChatResponse,
  OpenAiCompatibleChatStreamChunk,
  OpenAiToolCall,
  OpenAiUsage,
} from "./openai-compatible.types";
import { openSseRequest, readSseMessages } from "./sse";
import { OPENAI_WIRE_DEFAULTS } from "./wire";
import type { ResolvedWire } from "./wire";
import { errorFrame } from "../types/runtime.types";
import type {
  ChatMessage,
  FinishReason,
  ProviderChatRequest,
  ProviderChatResponse,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../types/runtime.types";

/**
 * OpenAI 兼容线格式的共享实现。
 *
 * doubao / zhipu / private 三家上游都讲 OpenAI 的 `/chat/completions` 方言，
 * 差异只在 endpoint 与鉴权 header。此前这一整套住在 `doubao.provider.ts` 里，
 * 另外两家反向 import 一个同级 provider —— 依赖方向是错的，且让"共享线格式"
 * 看起来像是豆包的私有实现。
 */

export function buildOpenAiCompatibleBody(
  request: ProviderChatRequest,
  stream: boolean,
  wire: ResolvedWire = OPENAI_WIRE_DEFAULTS,
): Record<string, unknown> {
  const maxTokensParam = wire.paramMap["maxTokens"] ?? "max_tokens";

  // `wire.extraBody` 先铺底，适配器管理的键随后覆盖。保留键在写入侧就被拒
  // （wire.ts RESERVED_BODY_KEYS），这里的顺序是第二道保险，不是第一道。
  const body: Record<string, unknown> = {
    ...wire.extraBody,
    model: resolveUpstreamModel(request),
    messages: request.messages.map(toWireMessage),
    stream,
  };

  // 只在调用方真的给了值时才写。此前是无条件赋值，对线上字节没有区别
  // （`undefined` 会被 JSON.stringify 丢掉），但它会把 `extraBody` 里配的同名
  // 默认值抹掉 —— 一个配了却不生效的开关，正是 extraBody 要消除的东西。
  if (wire.supports.temperature && request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (wire.supports.topP && request.topP !== undefined) {
    body.top_p = request.topP;
  }
  if (request.maxTokens !== undefined) {
    body[maxTokensParam] = request.maxTokens;
  }

  if (wire.supports.tools && request.tools?.length) {
    body.tools = request.tools.map(toWireTool);
  }
  if (wire.supports.toolChoice && request.toolChoice !== undefined) {
    body.tool_choice = toWireToolChoice(request.toolChoice);
  }

  // usage 的 opt-in。不带这个，OpenAI 系上游流式默认不回 usage，
  // 而 runtime.service 只在 done 携带 usage 时才写计量行 —— 漏掉它等于
  // 这次流式调用完全不被计量（设计文档 §9 / TD-017）。
  if (stream && wire.streamUsage === "stream_options") {
    body.stream_options = { include_usage: true };
  }

  return body;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toWireToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "string") {
    return choice;
  }
  return {
    type: "function",
    function: { name: choice.name },
  };
}

export function normalizeOpenAiCompatibleResponse(
  providerName: string,
  response: OpenAiCompatibleChatResponse,
): ProviderChatResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = parseOpenAiToolCalls(message?.tool_calls);

  if (!content && toolCalls.length === 0) {
    throw new Error(
      `${providerName} returned invalid response: ${describeEmptyResponse(response)}`,
    );
  }

  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;

  const mappedToolCalls = toolCalls.length > 0 ? toolCalls : undefined;
  const mappedFinishReason = mapFinishReason(choice?.finish_reason ?? undefined);
  return {
    content,
    ...(mappedToolCalls !== undefined ? { toolCalls: mappedToolCalls } : {}),
    ...(mappedFinishReason !== undefined
      ? { finishReason: mappedFinishReason }
      : {}),
    promptTokens,
    completionTokens,
    totalTokens:
      response.usage?.total_tokens ?? promptTokens + completionTokens,
    ...readCostSplits(response.usage),
    // Zeros above are placeholders when the upstream sent no usage object;
    // metering records NULL for those instead of a fabricated free request.
    usageReported: response.usage != null,
  };
}

/**
 * The cost splits, when the upstream reported them (TD-047).
 *
 * Spread into the usage object rather than assigned, so a missing split stays
 * ABSENT instead of becoming `undefined` or 0. The distinction is the whole
 * point of the columns: a cached token costs 1/30 of an uncached one, and a
 * zero written where the upstream said nothing would report unmeasured traffic
 * as free.
 */
function readCostSplits(
  usage: OpenAiUsage | undefined,
): { cachedInputTokens?: number; reasoningTokens?: number } {
  if (!usage) return {};

  // OpenAI nests it; DeepSeek also exposes it top-level. Either is authoritative.
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;

  return {
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * 为什么这条错误值得一个专门的函数：`empty model response` 这句话把三种成因
 * 压成了一句什么也没说的话，而运营在管理页面上看到的就是它。最贵的一种是
 * **思考型模型**（DeepSeek V4 默认开思考且 effort=high，思考链算在
 * completion 里）—— 输出预算被思考链吃光，`content` 为空、`finish_reason`
 * 为 `length`，看起来和"上游坏了"一模一样，实际只需要把预算调大或用
 * `config.wire.extraBody` 关掉思考。
 *
 * 这里只负责把成因说清楚，不负责把它变成成功：一次没有正文的应答对调用方
 * 就是失败，静默地放它过去只会把问题推到更远的地方。
 */
function describeEmptyResponse(
  response: OpenAiCompatibleChatResponse,
): string {
  if (response.error?.message) return response.error.message;

  const choice = response.choices?.[0];
  if (!choice) return "response carried no choices";

  const reasoning = choice.message?.reasoning_content;
  const reasoningChars = typeof reasoning === "string" ? reasoning.length : 0;

  if (choice.finish_reason === "length") {
    return reasoningChars > 0
      ? `output budget exhausted by the reasoning chain before any content was produced ` +
          `(finish_reason=length, ${reasoningChars} chars of reasoning_content) - raise max_tokens, ` +
          `or turn the thinking mode off via config.wire.extraBody`
      : "output budget exhausted before any content was produced (finish_reason=length) - raise max_tokens";
  }

  if (reasoningChars > 0) {
    return `model returned ${reasoningChars} chars of reasoning_content and no content`;
  }

  if (choice.finish_reason === "content_filter") {
    return "upstream content filter left the response empty (finish_reason=content_filter)";
  }

  return "empty model response";
}

function parseOpenAiToolCalls(
  toolCalls: OpenAiToolCall[] | undefined,
): ToolCall[] {
  if (!toolCalls?.length) return [];
  const parsed: ToolCall[] = [];
  for (const call of toolCalls) {
    if (!call.id || !call.function?.name) continue;
    parsed.push({
      id: call.id,
      name: call.function.name,
      arguments: parseArgs(call.function.arguments),
    });
  }
  return parsed;
}

export function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function mapFinishReason(
  value: string | undefined,
): FinishReason | undefined {
  switch (value) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return undefined;
  }
}

/**
 * 发起并解析一次 OpenAI 兼容的流式对话。
 */
export async function* streamOpenAiCompatibleChat(
  providerName: string,
  request: ProviderChatRequest,
  headers: Record<string, string>,
  wire: ResolvedWire = OPENAI_WIRE_DEFAULTS,
): AsyncGenerator<StreamEvent> {
  const body = await openSseRequest({
    providerName,
    url: resolveChatCompletionsEndpoint(request.endpointUrl, wire.chatPath),
    headers,
    body: buildOpenAiCompatibleBody(request, true, wire),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });

  yield* parseOpenAiCompatibleStream(body);
}

export async function* parseOpenAiCompatibleStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  // 工具调用分片聚合：OpenAI 协议下 tool_calls 的 arguments 按字符流式拼接，
  // 完整入参只有在流结束时才能确定。
  const toolBuffers = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  let usage: TokenUsage | undefined;
  let finishReason: FinishReason | undefined;

  function* flush(): Generator<StreamEvent> {
    for (const buf of toolBuffers.values()) {
      yield {
        type: "tool_call",
        toolCall: {
          id: buf.id,
          name: buf.name,
          arguments: parseArgs(buf.args),
        },
      };
    }
    yield {
      type: "done",
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  for await (const message of readSseMessages(body)) {
    const payload = message.data.trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      yield* flush();
      return;
    }

    let chunk: OpenAiCompatibleChatStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAiCompatibleChatStreamChunk;
    } catch {
      yield errorFrame(
        "UPSTREAM_FRAME_UNPARSEABLE",
        `Invalid SSE chunk: ${payload}`,
      );
      continue;
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens:
          chunk.usage.total_tokens ??
          (chunk.usage.prompt_tokens ?? 0) +
            (chunk.usage.completion_tokens ?? 0),
        ...readCostSplits(chunk.usage),
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      yield { type: "text", delta: delta.content };
    }

    if (delta?.tool_calls?.length) {
      for (const partial of delta.tool_calls) {
        const idx = partial.index ?? 0;
        const buf = toolBuffers.get(idx) ?? { id: "", name: "", args: "" };
        if (partial.id) buf.id = partial.id;
        if (partial.function?.name) buf.name = partial.function.name;
        if (typeof partial.function?.arguments === "string") {
          buf.args += partial.function.arguments;
        }
        toolBuffers.set(idx, buf);
      }
    }

    if (choice.finish_reason) {
      finishReason = mapFinishReason(choice.finish_reason) ?? finishReason;
    }
  }

  // 流在没有 [DONE] 的情况下自然结束（上游提前关闭、或本就不发哨兵）：
  // 已聚合的工具调用与 usage 仍然要交付，否则这一次调用不会被计量。
  yield* flush();
}

export function resolveChatCompletionsEndpoint(
  endpointUrl: string,
  chatPath: string | null = null,
): string {
  const suffix = chatPath ?? "/chat/completions";

  if (endpointUrl.endsWith(suffix)) {
    return endpointUrl;
  }

  return joinEndpoint(endpointUrl, suffix);
}
