import { Injectable } from "@nestjs/common";
import { upstreamField } from "./upstream-record";

import { joinEndpoint, resolveUpstreamModel } from "./base.provider";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider";
import type {
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderRerankRequest,
  ProviderRerankResponse,
} from "../types/runtime.types";

/**
 * https://docs.bigmodel.cn/api-reference/模型-api/文本嵌入
 * `data` is index-ordered to match the input `input` array 1:1 (no explicit
 * correlation id in Zhipu's response - order is the contract).
 */
interface ZhipuUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ZhipuEmbeddingResponse {
  model: string;
  object: "list";
  data: Array<{ index: number; object: "embedding"; embedding: number[] }>;
  usage?: ZhipuUsage;
}

/** https://docs.bigmodel.cn/api-reference/模型-api/文本重排序 */
interface ZhipuRerankResponse {
  id: string;
  results: Array<{ index: number; relevance_score: number; document?: string }>;
  usage?: ZhipuUsage;
}

/** Map upstream usage to the shared shape; undefined when absent so callers
 *  can distinguish "provider reported nothing" from zeros. */
function toTokenUsage(usage: ZhipuUsage | undefined) {
  if (!usage) return undefined;
  const out: { promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  if (typeof usage.prompt_tokens === "number") out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") out.totalTokens = usage.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Zhipu (BigModel).
 *
 * chat 走通用 `openai-chat-completions` 协议（继承而来，无覆盖）。这个子类
 * 存在的理由是它在该协议**之外**还多支持两项能力：真实的 Embedding-3/2 与
 * rerank API —— 这两个不是 OpenAI Chat Completions 的一部分，无法用
 * `config.wire` 表达，因此属于设计文档 §7 所说的"特例层"。
 */
@Injectable()
export class ZhipuProvider extends OpenAiCompatibleProvider {
  override readonly providerName = "zhipu";

  /**
   * A1 embedding - real Zhipu Embedding-3/Embedding-2 API. `modelCode` is
   * passed straight through as Zhipu's `model` field (must be a literal
   * `embedding-3`/`embedding-2`, per TD-012 - no provider-code prefix).
   */
  override async embed(
    request: ProviderEmbedRequest,
  ): Promise<ProviderEmbedResponse> {
    const response = await this.postJson<ZhipuEmbeddingResponse>(
      joinEndpoint(request.endpointUrl, "embeddings"),
      { authorization: `Bearer ${request.apiKey}` },
      { model: resolveUpstreamModel(request), input: request.texts },
    );

    // Response `data` is documented index-ordered, but sort defensively
    // rather than trust it blindly - a caller depends on vectors lining up
    // 1:1 with `texts`.
    const vectors = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    const usage = toTokenUsage(response.usage);
    return {
      modelVersion: response.model,
      dimension: vectors[0]?.length ?? 0,
      vectors,
      ...(usage ? { usage } : {}),
      ...upstreamField(undefined, response.model, undefined, response.usage),
    };
  }

  /**
   * A3 rerank - real Zhipu rerank API. Zhipu's `documents` param is bare
   * strings with no caller-supplied id - correlate `results[].index` back to
   * `request.candidates[index].id` ourselves.
   */
  override async rerank(
    request: ProviderRerankRequest,
  ): Promise<ProviderRerankResponse> {
    const response = await this.postJson<ZhipuRerankResponse>(
      joinEndpoint(request.endpointUrl, "rerank"),
      { authorization: `Bearer ${request.apiKey}` },
      {
        model: resolveUpstreamModel(request),
        query: request.query,
        documents: request.candidates.map((candidate) => candidate.text),
      },
    );

    const usage = toTokenUsage(response.usage);
    return {
      scores: response.results.map((result) => ({
        id: request.candidates[result.index]?.id ?? String(result.index),
        score: result.relevance_score,
      })),
      ...(usage ? { usage } : {}),
      ...upstreamField(response.id, undefined, undefined, response.usage),
    };
  }
}
