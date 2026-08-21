import { Injectable } from "@nestjs/common";

import { BaseProvider, joinEndpoint, resolveUpstreamModel } from "./base.provider";
import { openSseRequest, readSseMessages } from "./sse";
import { ANTHROPIC_WIRE_DEFAULTS, resolveWire } from "./wire";
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

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

interface ClaudeChatResponse {
  content?: ClaudeContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  stop_reason?: string;
  error?: {
    message?: string;
  };
}

@Injectable()
export class ClaudeProvider extends BaseProvider {
  readonly providerName = "claude";

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const response = await this.postJson<ClaudeChatResponse>(
      resolveClaudeMessagesEndpoint(request.endpointUrl),
      buildClaudeHeaders(request),
      buildClaudeBody(request, false),
      request.signal,
    );

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
      throw new Error(
        `${this.providerName} returned invalid response: ${providerMessage}`,
      );
    }

    const promptTokens = response.usage?.input_tokens ?? 0;
    const completionTokens = response.usage?.output_tokens ?? 0;

    const mappedToolCalls = toolCalls.length > 0 ? toolCalls : undefined;
    const mappedFinishReason = mapClaudeStopReason(response.stop_reason);
    return {
      content,
      ...(mappedToolCalls !== undefined ? { toolCalls: mappedToolCalls } : {}),
      ...(mappedFinishReason !== undefined
        ? { finishReason: mappedFinishReason }
        : {}),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      // Zeros above are placeholders when the upstream sent no usage object;
      // metering records NULL for those instead of a fabricated free request.
      usageReported: response.usage != null,
    };
  }

  override async *chatStream(
    request: ProviderChatRequest,
  ): AsyncGenerator<StreamEvent> {
    const body = await openSseRequest({
      providerName: this.providerName,
      url: resolveClaudeMessagesEndpoint(request.endpointUrl),
      headers: buildClaudeHeaders(request),
      body: buildClaudeBody(request, true),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    yield* parseClaudeStream(body);
  }
}

function buildClaudeBody(
  request: ProviderChatRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
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
): Record<string, string> {
  const wire = resolveWire(
    ANTHROPIC_WIRE_DEFAULTS,
    request.providerConfig,
    request.config,
  );

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
  let promptTokens = 0;
  let completionTokens = 0;
  let sawUsage = false;
  let finishReason: FinishReason | undefined;

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
        const usage = event.message?.usage;
        if (usage) {
          promptTokens = usage.input_tokens ?? 0;
          completionTokens = usage.output_tokens ?? 0;
          sawUsage = true;
        }
        break;
      }

      case "content_block_start": {
        const block = event.content_block;
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
        // thinking_delta / signature_delta 等块类型对上层不可见，忽略。
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
          finishReason =
            mapClaudeStopReason(event.delta.stop_reason) ?? finishReason;
        }
        if (event.usage?.output_tokens !== undefined) {
          completionTokens = event.usage.output_tokens;
          sawUsage = true;
        }
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

  const usage: TokenUsage | undefined = sawUsage
    ? {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      }
    : undefined;

  yield {
    type: "done",
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
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
      const blocks: ClaudeContentBlock[] = [];
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

    result.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }
  return result;
}
