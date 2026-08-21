import { Injectable } from "@nestjs/common";

import {
  BaseProvider,
  ProviderCapabilityNotImplementedError,
  resolveUpstreamModel,
} from "./base.provider";
import {
  buildOpenAiCompatibleBody,
  normalizeOpenAiCompatibleResponse,
  resolveChatCompletionsEndpoint,
  streamOpenAiCompatibleChat,
} from "./openai-compatible";
import type { OpenAiCompatibleChatResponse } from "./openai-compatible.types";
import {
  buildParseMessages,
  parseProviderParseResponse,
} from "./parse-vision";
import { OPENAI_WIRE_DEFAULTS, resolveWire } from "./wire";
import type { ResolvedWire } from "./wire";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
  StreamEvent,
  ProviderParseRequest,
  ProviderParseResult,
} from "../types/runtime.types";

/**
 * `openai-chat-completions` 协议的适配器。
 *
 * 它服务于**所有**讲这套方言的上游 —— doubao、zhipu、deepseek、通义、
 * moonshot、siliconflow、vLLM、Ollama 的 OpenAI shim、任何 OpenAI 兼容网关。
 * 接入其中任何一家不需要新的子类，只需要一条注册表记录把 `protocol` 设成
 * `openai-chat-completions`（设计文档 §5）。
 *
 * 子类只在一种情况下存在：这家上游在本协议之外**还多支持了别的能力**
 * （如智谱的 embed/rerank）。仅仅是参数或端点不同，属于 `config.wire` 的
 * 数据范畴，不是子类的理由。
 */
@Injectable()
export class OpenAiCompatibleProvider extends BaseProvider {
  readonly providerName: string = "openai-compatible";

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const wire = this.wireFor(request);

    const response = await this.postJson<OpenAiCompatibleChatResponse>(
      resolveChatCompletionsEndpoint(request.endpointUrl, wire.chatPath),
      authHeaders(request, wire),
      buildOpenAiCompatibleBody(request, false, wire),
      request.signal,
    );

    return normalizeOpenAiCompatibleResponse(this.providerName, response);
  }

  override async *chatStream(
    request: ProviderChatRequest,
  ): AsyncGenerator<StreamEvent> {
    const wire = this.wireFor(request);

    yield* streamOpenAiCompatibleChat(
      this.providerName,
      request,
      authHeaders(request, wire),
      wire,
    );
  }

  /**
   * A2 parse, served by whatever vision model the registry points at.
   *
   * One upstream call per page, sequentially. Parse pages are whole rasters -
   * a handful of them is already a large request - and firing them
   * concurrently would multiply that against the per-model rate limits this
   * service exists to respect. A caller wanting throughput can send fewer
   * pages per request; a caller wanting one call cannot un-exceed a rate
   * limit.
   *
   * Multi-page requests return the FIRST page's structure, because
   * `ProviderParseResponse` describes a single page. Later pages are still
   * parsed and validated rather than skipped, so a malformed page three is an
   * error instead of silence - the alternative would let a caller believe a
   * five-page document parsed when only page one was ever looked at.
   */
  override async parseDocument(
    request: ProviderParseRequest,
  ): Promise<ProviderParseResult> {
    // Parse only routes to a model an operator has explicitly declared
    // vision-capable. Without this gate, implementing parseDocument would have
    // QUIETLY DEGRADED the error: a caller naming a text model used to get a
    // clean `501 MODEL_NOT_IMPLEMENTED`, and would instead get whatever an
    // upstream says when handed an image it cannot read - a worse answer to
    // the same mistake.
    //
    // It also keeps "which model parses documents" an explicit registry act
    // rather than something inferred from a protocol value. A model does not
    // become a document parser by speaking OpenAI's wire format.
    if (request.config?.["supportsVision"] !== true) {
      throw new ProviderCapabilityNotImplementedError(
        this.providerName,
        "parseDocument",
      );
    }

    if (request.pages.length === 0) {
      throw new Error("parse request carries no pages");
    }

    // Same wire resolution as chat: `config.upstreamModel` is the vendor's
    // bare model id (modelCode is Atlas's dispatch key and may carry a
    // provider prefix), and authStyle/chatPath/headers come from the wire
    // descriptor - a model whose chat works must not 404/401 on parse.
    const wire = resolveWire(
      OPENAI_WIRE_DEFAULTS,
      request.providerConfig,
      request.config,
    );
    const endpoint = resolveChatCompletionsEndpoint(
      request.endpointUrl,
      wire.chatPath,
    );
    const headers = authHeaders(request, wire);
    const model = resolveUpstreamModel(request);

    // Every page is fetched, then every page is returned. This kept only
    // `first` until 2026-08-16 while still making - and billing - one upstream
    // call per page; see ProviderParseResponse for the shape that had no room
    // to put the rest.
    const rendered: Array<{ pageIndex: number; rawContent: string }> = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let usageSeen = false;

    for (const page of request.pages) {
      const response = await this.postJson<OpenAiCompatibleChatResponse>(
        endpoint,
        headers,
        {
          model,
          messages: buildParseMessages(request.task, page),
          // Structure is the entire deliverable here, so temperature is
          // pinned rather than left to the model's default - a creative
          // reading of a table is simply a wrong one.
          temperature: 0,
          response_format: { type: "json_object" },
        },
      );

      if (response.usage) {
        usageSeen = true;
        promptTokens += response.usage.prompt_tokens ?? 0;
        completionTokens += response.usage.completion_tokens ?? 0;
        totalTokens += response.usage.total_tokens ?? 0;
      }

      const content = response.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error(
          `parse model returned no content for page ${page.pageIndex}`,
        );
      }

      rendered.push({ pageIndex: page.pageIndex, rawContent: content });
    }

    return {
      ...parseProviderParseResponse(request.task, rendered),
      // Summed across the per-page calls; absent when the upstream reported
      // none - metering must see NULL, not an invented zero.
      ...(usageSeen
        ? { usage: { promptTokens, completionTokens, totalTokens } }
        : {}),
    };
  }

  protected wireFor(request: ProviderChatRequest): ResolvedWire {
    return resolveWire(
      OPENAI_WIRE_DEFAULTS,
      request.providerConfig,
      request.config,
    );
  }
}

/**
 * 无 key 时不下发鉴权头 —— 内网自建端点（vLLM / Ollama）通常没有 bearer
 * 鉴权，发一个 `Bearer undefined` 会被部分网关判成非法凭据而 401。
 */
function authHeaders(
  request: { apiKey?: string },
  wire: ResolvedWire,
): Record<string, string> {
  const headers: Record<string, string> = { ...wire.headers };

  if (!request.apiKey || wire.authStyle === "none") {
    return headers;
  }

  if (wire.authStyle === "x-api-key") {
    headers["x-api-key"] = request.apiKey;
  } else {
    headers.authorization = `Bearer ${request.apiKey}`;
  }

  return headers;
}
