import { Injectable } from "@nestjs/common";
import { UpstreamCallFailure } from "./upstream-failure";
import { statedNumber, upstreamField } from "./upstream-record";

import { BaseProvider, joinEndpoint, resolveUpstreamModel } from "./base.provider";
import { openSseRequest, readSseMessages } from "./sse";
import { ANTHROPIC_WIRE_DEFAULTS, resolveWire, thinkingFragment } from "./wire";
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
  ChatReasoning,
  UpstreamCallRecord,
} from "../types/runtime.types";

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  /** `thinking` 块的思维链正文。 */
  thinking?: string;
  /**
   * `thinking` 块的签名。**不可重建** —— 改写过的签名和丢掉是同一个 400。
   * 它是 `ChatReasoning` 信封必须整体回传、而不能只回传 `text` 的直接原因。
   */
  signature?: string;
  /** `redacted_thinking` 块的密文载荷。同样不可解析、只可原样回传。 */
  data?: string;
}

/**
 * Anthropic 的 `thinking` / `redacted_thinking` 块 → `ChatReasoning` 信封。
 *
 * **信封里装块,不装文本。** `signature` 不在思维链正文里,而 Anthropic 要求
 * assistant 轮次原样回传整个块(含签名),否则 400 —— 只交付文本等于让调用方去
 * 重建一个它拿不到的东西,而「改写过的签名」和「丢掉签名」是同一个 400。
 *
 * `text` 仍然给出,那是可读投影,供展示用;它不是回传的依据。
 */
function claudeReasoningFromBlocks(
  blocks: ClaudeContentBlock[],
): ChatReasoning | undefined {
  const thinking = blocks.filter(
    (b) => b.type === "thinking" || b.type === "redacted_thinking",
  );
  if (thinking.length === 0) return undefined;
  const text = thinking
    .map((b) => b.thinking)
    .filter((t): t is string => typeof t === "string")
    .join("");
  return {
    ...(text.length > 0 ? { text } : {}),
    /* 原样保留。调用方 MUST NOT 解析,适配器也不重排、不裁剪。 */
    claudeBlocks: thinking,
  };
}

/**
 * 信封 → Anthropic 的块数组,放回 assistant 轮次的**最前面**。
 *
 * 位置不是随意的:Anthropic 要求 `thinking` 块出现在同一轮的 `text` / `tool_use`
 * 之前。顺序错了和丢掉一样是 400。
 */
function claudeReasoningToBlocks(
  reasoning: ChatReasoning | undefined,
): ClaudeContentBlock[] {
  const raw = reasoning?.["claudeBlocks"];
  return Array.isArray(raw) ? (raw as ClaudeContentBlock[]) : [];
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

/**
 * Anthropic streaming event envelope (`/v1/messages` with `stream:true`).
 * One shape covering every event type - each event only populates the fields
 * relevant to it.
 */
interface ClaudeStreamEvent {
  type?: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    thinking?: string;
    signature?: string;
    data?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    thinking?: string;
    signature?: string;
  };
  /** `message_delta` carries the running totals; newer API versions repeat the input side here too. */
  usage?: ClaudeUsage;
  error?: { type?: string; message?: string };
}

/**
 * Anthropic's usage object. Its `input_tokens` EXCLUDES both cache kinds -
 * unlike OpenAI's `prompt_tokens`, which includes the cached part. Atlas's
 * convention (incr/04) is that `promptTokens` counts every input token, so the
 * three are added in {@link claudeTokenUsage}; storing `input_tokens` as-is made
 * a Claude row's "uncached = input - cached" come out short or negative.
 *
 * There is no counterpart for `reasoningTokens`: Anthropic bills thinking
 * inside `output_tokens` and reports no separate figure, so that split stays
 * absent here rather than being invented (TD-047).
 */
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** The write split by TTL; the 1-hour write is priced above the 5-minute one. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** Usage-record batch 4 (C7, F4). */
  service_tier?: string;
  server_tool_use?: { web_search_requests?: number };
}

interface ClaudeChatResponse {
  id?: string;
  model?: string;
  content?: ClaudeContentBlock[];
  usage?: ClaudeUsage;
  stop_reason?: string;
  error?: {
    message?: string;
  };
}

@Injectable()
export class ClaudeProvider extends BaseProvider {
  readonly providerName = "claude";

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const wire = resolveClaudeWire(request);
    const response = await this.postJson<ClaudeChatResponse>(
      resolveClaudeMessagesEndpoint(request.endpointUrl),
      buildClaudeHeaders(request, wire),
      buildClaudeBody(request, false, wire),
      request.signal,
    );

    /* `thinking` / `redacted_thinking` 块整组留下来（TD-046 已修）。
       **留的是块，不是文本。** Anthropic 要求原样回传，而 `signature` 不在文本里
       ——只把思维链文本交出去，回传就永远拼不出来。 */
    const reasoning = claudeReasoningFromBlocks(response.content ?? []);

    const content = (response.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .filter((text): text is string => typeof text === "string")
      .join("");

    const toolCalls: ToolCall[] = (response.content ?? [])
      .filter(
        (block) =>
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string",
      )
      .map((block) => ({
        id: block.id as string,
        name: block.name as string,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      }));

    if (!content && toolCalls.length === 0) {
      const providerMessage = response.error?.message ?? "empty model response";
      // TD-037, same as the OpenAI-dialect adapter: a response that arrives
      // complete, with usage, and no content is a failure the provider still
      // charged for. Anthropic names its cached half `cache_read_input_tokens`
      // and reports no reasoning split at all - `thinking` blocks are counted
      // in `output_tokens` and not broken out - so `reasoningTokens` stays
      // absent here rather than being invented as 0.
      throw new UpstreamCallFailure(
        `${this.providerName} returned invalid response: ${providerMessage}`,
        response.usage ? claudeTokenUsage(response.usage) : {},
        {
          outputBudgetExhausted: response.stop_reason === "max_tokens",
          ...upstreamField(
            response.id,
            response.model,
            response.stop_reason,
            response.usage,
            claudeExtras(response.usage),
          ),
        },
      );
    }

    const usage = claudeTokenUsage(response.usage ?? {});

    const mappedToolCalls = toolCalls.length > 0 ? toolCalls : undefined;
    const mappedFinishReason = mapClaudeStopReason(response.stop_reason);
    return {
      content,
      ...(mappedToolCalls !== undefined ? { toolCalls: mappedToolCalls } : {}),
      ...(mappedFinishReason !== undefined
        ? { finishReason: mappedFinishReason }
        : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...usage,
      // Zeros above are placeholders when the upstream sent no usage object;
      // metering records NULL for those instead of a fabricated free request.
      usageReported: response.usage != null,
      ...upstreamField(
        response.id,
        response.model,
        response.stop_reason,
        response.usage,
            claudeExtras(response.usage),
      ),
    };
  }

  override async *chatStream(
    request: ProviderChatRequest,
  ): AsyncGenerator<StreamEvent> {
    const wire = resolveClaudeWire(request);
    const body = await openSseRequest({
      providerName: this.providerName,
      url: resolveClaudeMessagesEndpoint(request.endpointUrl),
      headers: buildClaudeHeaders(request, wire),
      body: buildClaudeBody(request, true, wire),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    yield* parseClaudeStream(body);
  }
}

/**
 * 与 openai-compatible 侧同一个描述符，同一套解析。单独提出来是因为本适配器
 * 的 header 与 body 都要用它，各自 resolve 一次会让"生效值"有两个来源。
 */
function resolveClaudeWire(request: ProviderChatRequest): ResolvedWire {
  return resolveWire(
    ANTHROPIC_WIRE_DEFAULTS,
    request.providerConfig,
    request.config,
  );
}

/** 导出仅为可测：`extraBody` 若在这一侧静默失效，就成了"配了不生效"的开关。 */
export function buildClaudeBody(
  request: ProviderChatRequest,
  stream: boolean,
  wire: ResolvedWire,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // extraBody 先铺底，适配器管理的键随后覆盖 —— 与 openai-compatible 同规则。
    // 这里必须一起支持，否则 `config.wire.extraBody` 就成了"在一半适配器上配了
    // 不生效"的开关。
    ...wire.extraBody,
    // ADR-009, same position and rule as the openai-compatible adapter.
    ...thinkingFragment(wire, request.thinking),
    model: resolveUpstreamModel(request),
    system: buildSystemPrompt(request.messages),
    messages: buildClaudeMessages(request.messages),
    // Anthropic 要求 max_tokens 必填，没有服务端默认值。
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature,
    top_p: request.topP,
    stream,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map(toClaudeTool);
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice = toClaudeToolChoice(request.toolChoice);
  }
  return body;
}

function buildClaudeHeaders(
  request: ProviderChatRequest,
  wire: ResolvedWire,
): Record<string, string> {
  const headers: Record<string, string> = { ...wire.headers };

  // `config.anthropicVersion` 是 wire 描述符之前的写法，仍然优先 —— 存量数据
  // 不该因为引入新约定而失效（设计文档 §6 的收编说明）。
  const legacyVersion = request.config?.["anthropicVersion"];
  if (typeof legacyVersion === "string" && legacyVersion.trim()) {
    headers["anthropic-version"] = legacyVersion.trim();
  }

  if (request.apiKey && wire.authStyle !== "none") {
    if (wire.authStyle === "bearer") {
      headers.authorization = `Bearer ${request.apiKey}`;
    } else {
      headers["x-api-key"] = request.apiKey;
    }
  }

  return headers;
}

/**
 * Anthropic 的流式协议与 OpenAI 方言不同，不能复用
 * `parseOpenAiCompatibleStream`：
 *
 * - 事件类型放在 SSE 的 `event:` 字段，而不是 payload 里的 `choices`；
 * - 没有 `[DONE]` 哨兵，流以 `message_stop` 结束；
 * - usage 分两处到达：`message_start` 带 input_tokens，`message_delta` 带
 *   累计的 output_tokens。任何一处漏读，这次调用就会漏计量（TD-017）。
 * - 工具调用的入参是 `input_json_delta.partial_json` 分片拼接，与 OpenAI 的
 *   `tool_calls[].function.arguments` 分片是两套字段。
 */
export async function* parseClaudeStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const toolBlocks = new Map<
    number,
    { id: string; name: string; partialJson: string }
  >();
  /* thinking / redacted_thinking 块，按上游给的 index 归位。 */
  const thinkingBlocks = new Map<number, ClaudeContentBlock>();
  /* The usage object is merged across message_start (input and cache side)
     and message_delta (running totals). Keeping the merged object, not two
     loose numbers, is what lets the cache fields survive the stream - before
     this, streaming dropped cache_read_input_tokens that the non-stream path
     kept. */
  let rawUsage: ClaudeUsage | undefined;
  let finishReason: FinishReason | undefined;
  let nativeStopReason: string | undefined;
  let upstreamId: string | undefined;
  let upstreamModel: string | undefined;

  function emitToolBlock(index: number): StreamEvent | undefined {
    const block = toolBlocks.get(index);
    if (!block) return undefined;
    toolBlocks.delete(index);
    return {
      type: "tool_call",
      toolCall: {
        id: block.id,
        name: block.name,
        arguments: parseToolInput(block.partialJson),
      },
    };
  }

  for await (const message of readSseMessages(body)) {
    const payload = message.data.trim();
    if (!payload) continue;

    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(payload) as ClaudeStreamEvent;
    } catch {
      yield errorFrame(
        "UPSTREAM_FRAME_UNPARSEABLE",
        `Invalid SSE chunk: ${payload}`,
      );
      continue;
    }

    // `event:` 行与 payload 的 `type` 字段在 Anthropic 协议里始终一致，
    // 以 payload 为准（代理层有可能不透传 event 行）。
    switch (event.type ?? message.event) {
      case "message_start": {
        if (event.message?.id) upstreamId = event.message.id;
        if (event.message?.model) upstreamModel = event.message.model;
        const usage = event.message?.usage;
        if (usage) rawUsage = { ...rawUsage, ...usage };
        break;
      }

      case "content_block_start": {
        const block = event.content_block;
        if (
          (block?.type === "thinking" || block?.type === "redacted_thinking") &&
          event.index !== undefined
        ) {
          /* 开一个块并按 index 记住。累的是**块**,不是一段文本:`signature_delta`
             要落到它所属的那个块上,而一次响应里可以有多个 thinking 块。 */
          thinkingBlocks.set(event.index, {
            type: block.type,
            ...(typeof block.thinking === "string"
              ? { thinking: block.thinking }
              : {}),
            ...(typeof block.signature === "string"
              ? { signature: block.signature }
              : {}),
            ...(typeof block.data === "string" ? { data: block.data } : {}),
          });
        }
        if (block?.type === "tool_use" && event.index !== undefined) {
          toolBlocks.set(event.index, {
            id: block.id ?? "",
            name: block.name ?? "",
            partialJson: "",
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text", delta: delta.text };
        } else if (delta?.type === "input_json_delta") {
          const block =
            event.index !== undefined ? toolBlocks.get(event.index) : undefined;
          if (block && typeof delta.partial_json === "string") {
            block.partialJson += delta.partial_json;
          }
        }
        /* thinking_delta / signature_delta（TD-046 已修）。
           两者处置**不同**:思维链有可读投影,所以既 yield 分片又累积;签名没有可读
           意义,**只累积、不 yield** —— 把它当成正文的一部分发出去只会让调用方看到
           一串乱码,而它真正的用途是回传。 */
        else if (delta?.type === "thinking_delta" && delta.thinking) {
          const blk =
            event.index !== undefined
              ? thinkingBlocks.get(event.index)
              : undefined;
          if (blk) blk.thinking = (blk.thinking ?? "") + delta.thinking;
          yield { type: "reasoning", delta: delta.thinking };
        } else if (delta?.type === "signature_delta" && delta.signature) {
          const blk =
            event.index !== undefined
              ? thinkingBlocks.get(event.index)
              : undefined;
          if (blk) blk.signature = (blk.signature ?? "") + delta.signature;
        }
        break;
      }

      case "content_block_stop": {
        if (event.index !== undefined) {
          const toolCall = emitToolBlock(event.index);
          if (toolCall) yield toolCall;
        }
        break;
      }

      case "message_delta": {
        if (event.delta?.stop_reason) {
          nativeStopReason = event.delta.stop_reason;
          finishReason =
            mapClaudeStopReason(event.delta.stop_reason) ?? finishReason;
        }
        if (event.usage) rawUsage = { ...rawUsage, ...event.usage };
        break;
      }

      case "error": {
        // The upstream's own code (`overloaded_error`, ...) used to go out as
        // Atlas's `code`. It is vendor-private - the same condition is spelled
        // differently by Doubao/Zhipu - so a consumer branching on it would be
        // branching on which provider happened to serve the call, which is the
        // one thing an L1 model platform exists to hide. Atlas's own code goes
        // on the wire; the vendor's wording stays in `message` for diagnosis.
        yield errorFrame(
          "PROVIDER_UNAVAILABLE",
          event.error?.type
            ? `claude stream error (${event.error.type}): ${event.error.message ?? ""}`.trim()
            : (event.error?.message ?? "claude stream error"),
        );
        break;
      }

      // message_stop / ping / content_block_stop 之外的事件无需处理。
      default:
        break;
    }
  }

  // 上游提前断开时仍要交付已聚合的工具调用，并且始终收敛出一个 done ——
  // runtime.service 只在 done 携带 usage 时才写计量。
  for (const index of [...toolBlocks.keys()]) {
    const toolCall = emitToolBlock(index);
    if (toolCall) yield toolCall;
  }

  const usage: TokenUsage | undefined = rawUsage
    ? claudeTokenUsage(rawUsage)
    : undefined;

  /* 按 index 升序还原块顺序。Map 的插入序恰好就是上游发来的顺序,但依赖插入序
     等于依赖一个没人声明的性质——排一次是便宜的。 */
  const orderedThinking = [...thinkingBlocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, blk]) => blk);

  const doneReasoning = claudeReasoningFromBlocks(orderedThinking);

  yield {
    type: "done",
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(doneReasoning !== undefined ? { reasoning: doneReasoning } : {}),
    ...upstreamField(upstreamId, upstreamModel, nativeStopReason, rawUsage, claudeExtras(rawUsage)),
  };
}

/**
 * Anthropic usage -> Atlas's convention: `promptTokens` counts every input
 * token (plain + cache read + cache write), and both cache kinds are subsets
 * of it. A split the upstream did not send stays absent, never 0.
 */
export function claudeTokenUsage(usage: ClaudeUsage): TokenUsage {
  const plain = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens;
  const write =
    usage.cache_creation_input_tokens ??
    (usage.cache_creation
      ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) +
        (usage.cache_creation.ephemeral_1h_input_tokens ?? 0)
      : undefined);
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  const promptTokens = plain + (read ?? 0) + (write ?? 0);
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(typeof read === "number" ? { cachedInputTokens: read } : {}),
    ...(typeof write === "number" ? { cacheWriteInputTokens: write } : {}),
    ...(typeof write1h === "number" ? { cacheWrite1hInputTokens: write1h } : {}),
  };
}

function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toClaudeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toClaudeToolChoice(choice: ToolChoice): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return undefined;
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function mapClaudeStopReason(
  value: string | undefined,
): FinishReason | undefined {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return undefined;
  }
}

function resolveClaudeMessagesEndpoint(endpointUrl: string): string {
  if (endpointUrl.endsWith("/messages")) {
    return endpointUrl;
  }

  return joinEndpoint(endpointUrl, "/v1/messages");
}

function buildSystemPrompt(messages: ChatMessage[]): string | undefined {
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);

  return systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined;
}

function buildClaudeMessages(messages: ChatMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          } as ClaudeContentBlock,
        ],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      /* thinking 块必须排在 text / tool_use 之前 —— 见 claudeReasoningToBlocks。 */
      const blocks: ClaudeContentBlock[] = claudeReasoningToBlocks(
        message.reasoning,
      );
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }

    const plainBlocks = claudeReasoningToBlocks(message.reasoning);
    if (message.role === "assistant" && plainBlocks.length > 0) {
      /* 有推理载荷的 assistant 轮次必须走块形态:字符串 content 装不下 thinking 块,
         而这一轮在多轮里同样要回传。 */
      result.push({
        role: "assistant",
        content: [
          ...plainBlocks,
          ...(message.content ? [{ type: "text", text: message.content }] : []),
        ],
      });
      continue;
    }
    result.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }
  return result;
}

/**
 * Usage-record batch 4. Anthropic states its service tier and server-side
 * tool use inside `usage`. It reports no reasoning split (thinking is billed
 * inside output_tokens) and no modality or tool-use-prompt splits at all.
 */
function claudeExtras(usage: ClaudeUsage | undefined): Partial<UpstreamCallRecord> {
  return {
    ...(usage?.service_tier ? { serviceTier: usage.service_tier } : {}),
    ...(statedNumber(usage?.server_tool_use?.web_search_requests) !== undefined
      ? { webSearchRequests: usage?.server_tool_use?.web_search_requests as number }
      : {}),
    notSupported: CLAUDE_LACKS,
  };
}

export const CLAUDE_LACKS: readonly string[] = [
  "reasoningTokens",
  "inputImageTokens",
  "inputAudioTokens",
  "outputAudioTokens",
  "outputImageTokens",
  "toolUsePromptTokens",
];
