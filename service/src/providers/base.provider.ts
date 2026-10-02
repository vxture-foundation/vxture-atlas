import { describeAbort, guardTimeToFirstByte, type HeaderWait } from "./upstream-timeout";
import type {
  IModelProvider,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderParseRequest,
  ProviderParseResult,
  ProviderRerankRequest,
  ProviderRerankResponse,
  StreamEvent,
} from "../types/runtime.types";

/**
 * `model_code` is Atlas's internal dispatch key (which adapter to route to),
 * not necessarily the literal value an upstream vendor API accepts - the two
 * only look identical for the three legacy unprefixed rows
 * (`vxture-platform`'s `42-model-provider-registry-plan.md` §1.1).
 *
 * `config.upstreamModel` (existing jsonb column, no DDL) is the vendor's real
 * bare model id when it differs from `model_code`. Every adapter should
 * resolve through this rather than reading `request.modelCode` directly for
 * the outbound wire value - falling back to `modelCode` covers both the
 * legacy unprefixed rows and any model that has not been given an explicit
 * `upstreamModel` yet.
 */
export function resolveUpstreamModel(request: {
  modelCode: string;
  config?: Record<string, unknown>;
}): string {
  const upstreamModel = request.config?.["upstreamModel"];
  return typeof upstreamModel === "string" && upstreamModel.trim()
    ? upstreamModel.trim()
    : request.modelCode;
}

export class ProviderCapabilityNotImplementedError extends Error {
  constructor(
    readonly providerName: string,
    readonly capability: "embed" | "rerank" | "parseDocument",
  ) {
    super(`${providerName} does not implement ${capability} yet`);
    this.name = "ProviderCapabilityNotImplementedError";
  }
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: string,
    readonly responseBody?: string,
    /** The upstream's own `Retry-After`, in ms, when it sent one (a 429 usually does). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 10.2.3).
 * Undefined when absent or unreadable - a guessed wait is worse than none.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export abstract class BaseProvider implements IModelProvider {
  abstract readonly providerName: string;

  abstract chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;

  // 默认抛错；具体 provider 根据是否支持流式自行覆盖。
  async *chatStream(
    _request: ProviderChatRequest,
  ): AsyncGenerator<StreamEvent> {
    throw new Error(`${this.providerName} stream chat is not enabled yet`);
  }

  // S2S provider surface (A1/A2/A3) - default "not implemented" throw, same
  // pattern as chatStream. Which provider/model backs each capability is a product/
  // cost decision (docs/30-design/200-s2s-provider-surface.md), not decided here - a
  // concrete provider overrides the relevant method once that decision is made.
  async embed(_request: ProviderEmbedRequest): Promise<ProviderEmbedResponse> {
    throw new ProviderCapabilityNotImplementedError(this.providerName, "embed");
  }

  async rerank(
    _request: ProviderRerankRequest,
  ): Promise<ProviderRerankResponse> {
    throw new ProviderCapabilityNotImplementedError(this.providerName, "rerank");
  }

  async parseDocument(
    _request: ProviderParseRequest,
  ): Promise<ProviderParseResult> {
    throw new ProviderCapabilityNotImplementedError(
      this.providerName,
      "parseDocument",
    );
  }

  protected async postJson<TResponse>(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    callerSignal?: AbortSignal,
    /** Non-streaming generation sends headers only once the answer is done. */
    wait: HeaderWait = "first_byte",
  ): Promise<TResponse> {
    const guard = guardTimeToFirstByte(this.providerName, callerSignal, wait);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: guard.signal,
      });
    } catch (error) {
      throw describeAbort(error, guard, this.providerName);
    } finally {
      // 头部到了就解除计时 - 之后的 body 读取属于"上游在干活"，不该被误杀。
      guard.settle();
    }

    const responseText = await response.text();

    if (!response.ok) {
      throw new ProviderHttpError(
        `${this.providerName} request failed with status ${response.status}`,
        response.status,
        this.providerName,
        responseText,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }

    return parseJson<TResponse>(responseText);
  }
}

export function joinEndpoint(baseUrl: string, suffix: string): string {
  let normalizedBase = baseUrl;
  while (normalizedBase.endsWith("/")) {
    normalizedBase = normalizedBase.slice(0, -1);
  }
  let normalizedSuffix = suffix;
  while (normalizedSuffix.startsWith("/")) {
    normalizedSuffix = normalizedSuffix.slice(1);
  }
  return `${normalizedBase}/${normalizedSuffix}`;
}

export function parseJson<TResponse>(text: string): TResponse {
  if (!text.trim()) {
    throw new Error("Provider returned an empty response");
  }

  return JSON.parse(text) as TResponse;
}
