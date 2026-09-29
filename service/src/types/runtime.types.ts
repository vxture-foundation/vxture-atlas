// One-way: runtime.errors imports nothing from here, so this is not a cycle.
import { isRetryable } from "../runtime/runtime.errors";
import type { ModelRuntimeErrorCode } from "../runtime/runtime.errors";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * 思考型模型的推理载荷 —— **一个不透明信封，不是一段正文。**
 *
 * ## 为什么不是 `reasoningContent: string`
 *
 * DeepSeek 的文档写明一条硬约束：携带 `tools` 时，`reasoning_content` 必须在所有
 * 后续交互中**完整回传**，否则 400。那就说明它不是 content —— content 是可以展示、
 * 截断、摘要、太长就丢的东西，而这四件每一件都会破坏回传。破坏之后的 400 出现在
 * **调用方**那一侧，而没有任何一处说得出为什么。**名字把字段的用途告诉错了**，
 * 这比少一个字段坏得多。
 *
 * 第二个理由是它只合一家。各供应商的回传材料形状完全不同：DeepSeek 是一段可读
 * 文本；Anthropic 的 thinking 块带 `signature`，还有 `redacted_thinking`；OpenAI
 * o 系列压根不给可读文本，只给不透明的续算态。一个 `string` 字段会逼出「JSON 塞进
 * 字符串」或者「再加第二个字段」——后者正是 product_251 P2 / X-4 禁的那件事。
 *
 * ## 用法：读 `text` 展示，回传整个对象
 *
 * - `text` 是**可读投影**，**仅供展示**。可截断、可不显示。它**不是回传的依据**。
 * - 回传时把整个 `reasoning` 对象**原样**带回，**包括你不认识的键**。
 *   常见错法是 `{ text: msg.reasoning.text }` 重建一个——那会丢掉 `signature`
 *   一类的键，在 DeepSeek 上看不出来，换到 Anthropic 就 400。
 * - 缺省 = **上游没给**。不是空字符串，也不是「模型没思考」。
 *
 * 推理的**成本**另有出口，不在这里：`TokenUsage.reasoningTokens`（TD-047）。
 */
export interface ChatReasoning {
  /** 可读投影。有的供应商不给（OpenAI o 系列）。 */
  text?: string;
  /** 供应商专有的续算材料。调用方 **MUST NOT** 解析，只原样回传。 */
  [key: string]: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 角色：模型本轮发起的工具调用列表 */
  toolCalls?: ToolCall[];
  /** tool 角色：本条消息对应的 toolCall ID */
  toolCallId?: string;
  /** tool 角色：工具名称（部分 provider 要求） */
  name?: string;
  /**
   * assistant 角色：本轮的推理载荷。响应里由 Atlas 填；**请求里由调用方原样回传**
   * ——带 `tools` 的多轮对话缺了它，上游直接 400。详见 {@link ChatReasoning}。
   */
  reasoning?: ChatReasoning;
}

/**
 * 工具定义（function calling 兼容形态）
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 工具选择策略
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

/**
 * 模型发起的一次工具调用
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 模型结束原因
 */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export type ApplicationType =
  | "agent"
  | "workflow"
  | "api_client"
  | "internal_service";

export interface ChatRequest {
  /** Exactly one of modelCode / endpointCode / taskProfile must resolve to a model. */
  modelCode?: string;
  /**
   * Endpoint routing (`model.model_endpoints`): a stable capability entry
   * point such as `chat/default`, so a business system hard-codes the NAME
   * and an operator repoints it without a caller-side change. The endpoint's
   * own `fallbackModelCode` drives failover for this request - the resolved
   * model's `config.fallbackModelCodes` is not also applied, so the chain has
   * exactly one authority.
   */
  endpointCode?: string;
  /**
   * Task-profile routing on the LEGACY TENANT AXIS. A product integrating
   * today wants `endpointCode` above instead.
   *
   * Resolves through `model.model_grants.task_profile` (see
   * `ModelRegistryService.resolveModelCodeForTaskProfile`), which is keyed by
   * tenant - so naming a label here drags in a `tenantId` the caller may have
   * no reason to hold, and repointing the label costs a grant row per tenant.
   * `model_grant_authorizations_total{axis}` exists to count that axis down to
   * zero.
   *
   * **The tenant is not what decides the answer** - it is an artefact of where
   * label routing happened to be built. `endpointCode` does the same job with
   * no tenant and repoints better: change what the endpoint points at and every
   * product holding it follows, with no grant row touched at all.
   *
   * This was not documented, and a consumer was steered here and blocked on a
   * tenant uuid it does not have (vxture-atlas#4/#39, corrected in #47).
   *
   * **Not extended.** "Different customers get different tiers" is properly a
   * business MODE the product selects - cost-first / quality-first /
   * latency-first - with operators deciding what serves each: O(modes) rather
   * than O(tenants), and the label keeps stating what the CALLER needs, which
   * tenant identity does not carry. Owner ruling 2026-08-26, TD-052.
   */
  taskProfile?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /**
   * ADR-009. Omitted means the upstream's own default - today's behaviour, so
   * no existing caller changes. A mode the routed model cannot honour is
   * refused (`THINKING_MODE_UNSUPPORTED`), never silently dropped.
   */
  thinking?: ThinkingMode;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  stream?: boolean;
  tenantId: string;
  applicationId?: string;
  applicationType?: ApplicationType;
  /** @deprecated 迁移期兼容字段，会映射为 applicationId + applicationType=agent */
  agentId?: string;
  userId?: string;
  featureId?: string;
  requestId?: string;
  /**
   * product_251 X-2: the agent TASK this call belongs to, stable across every
   * call the task makes - to Atlas and to runos alike. `requestId` identifies
   * one call; only this makes a task addable up. Recorded verbatim.
   */
  taskId?: string;
  businessId?: string;
  usageType?: "normal" | "retry" | "test";
}

/**
 * A per-call thinking mode (ADR-009). Vendor-neutral on purpose: each model
 * translates it through `config.wire.thinking`, so a caller never spells a
 * vendor's field and never has to know which model served it.
 */
export type ThinkingMode = "off" | "on";

export const THINKING_MODES: readonly ThinkingMode[] = ["off", "on"];

export interface ChatResponse {
  id: string;
  modelCode: string;
  message: ChatMessage;
  usage: TokenUsage;
  latencyMs: number;
  finishReason?: FinishReason;
  /**
   * The mode this call ran with: the one asked for, or `null` when none was
   * asked and the upstream's own default applied (ADR-009 decision 5).
   */
  thinking: ThinkingMode | null;
}

/**
 * 流式响应事件（与 ai-sdk LLMStreamChunk 形态对齐）
 *
 * Model Runtime 以 SSE 形式逐条 `data: <json>` 推送，
 * 流尾以 `data: [DONE]` 结束。
 */
export type StreamEvent =
  | { type: "text"; delta: string }
  /**
   * 推理分片。**只供展示**，不是回传的依据 —— 回传要用 `done` 帧上的
   * `reasoning` 信封（见下）。
   *
   * 不能复用 `text`：把思维链混进正文流，调用方无法区分，比不发更糟。两个事件
   * 分开之后，「只想要答案」的调用方忽略 `reasoning` 即可，什么都不必改。
   */
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | {
      type: "done";
      usage?: TokenUsage;
      finishReason?: FinishReason;
      /** Stamped by `runtime.service`, like `modelCode` below; see `ChatResponse.thinking`. */
      thinking?: ThinkingMode | null;
      /**
       * Which model actually answered.
       *
       * Routing by `taskProfile` or `endpointCode` means the caller did NOT
       * name a model - that is the point of it, and it is why an operator can
       * repoint a task profile without the product shipping code. The cost is
       * that the product would otherwise have no way to notice it had been
       * repointed: same request, different model, no error, no version change.
       * The non-streaming surfaces have always echoed the resolved code
       * (`ChatResponse` / `EmbedResponse` / `RerankResponse` / `ParseResponse`);
       * a stream had nowhere to say it, so it did not.
       *
       * Optional on this type because an ADAPTER cannot fill it - it knows the
       * vendor's `upstreamModel`, not the registry code. `runtime.service`
       * enriches the frame before it leaves, so **on `/v1/chat` it is always
       * present**, and that guarantee is held by a test rather than by this
       * sentence. It reports what actually served, so after a failover it
       * carries the FALLBACK's code, not the one that was tried first.
       */
      modelCode?: string;
      /**
       * 本轮推理载荷的**完整信封**，用于下一轮回传。
       *
       * 为什么不让调用方把 `reasoning` 分片自己拼起来:分片只是可读投影，而回传要
       * 的是整个对象——包括供应商专有的、根本不在分片里出现的键（Anthropic 的
       * `signature`）。让调用方拼，等于要求它自己发明一个它拿不到的东西。
       *
       * 缺省 = 上游没给推理载荷。详见 {@link ChatReasoning}。
       */
      reasoning?: ChatReasoning;
    }
  /**
   * Same envelope as the HTTP error body, only carried on a different
   * transport (product_251 X-1: the position follows the transport, the
   * contents do not). `code` was a bare `string` here, which is how
   * `PARSE_FAILED` and `MODEL_RUNTIME_STREAM_FAILED` reached callers without
   * ever appearing in the published vocabulary.
   */
  | {
      type: "error";
      code: ModelRuntimeErrorCode;
      message: string;
      retryable: boolean;
    };

/**
 * Build an SSE error frame. Everything that emits one goes through here so
 * `retryable` is always derived from the single table in runtime.errors rather
 * than typed out at each `yield`, where the two would eventually disagree.
 */
export function errorFrame(
  code: ModelRuntimeErrorCode,
  message: string,
): Extract<StreamEvent, { type: "error" }> {
  return { type: "error", code, message, retryable: isRetryable(code) };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * TD-047. The two numbers that decide what a call actually COST, as opposed
   * to how large it was.
   *
   * `cachedInputTokens` is the part of `promptTokens` the upstream served from
   * its prompt cache - billed at 1/30 of the uncached rate on DeepSeek, so two
   * months with identical `promptTokens` can differ by an order of magnitude in
   * spend. `reasoningTokens` is the part of `completionTokens` spent on a
   * reasoning chain: billed at the output rate, and the one output cost an
   * operator can switch off (`config.wire.extraBody`).
   *
   * Absent means the upstream did not report it. Never coerce that to 0 -
   * "unmeasured" and "free" are different facts, and only one of them is good
   * news.
   */
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface IModelProvider {
  readonly providerName: string;
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
  chatStream(request: ProviderChatRequest): AsyncGenerator<StreamEvent>;
  // S2S provider surface (A1/A2/A3, docs/30-design/200-s2s-provider-surface.md).
  // BaseProvider gives these a default "not implemented" throw (same pattern
  // as chatStream); which provider/model backs each capability is a
  // product/cost decision, not part of this interface's contract.
  embed(request: ProviderEmbedRequest): Promise<ProviderEmbedResponse>;
  rerank(request: ProviderRerankRequest): Promise<ProviderRerankResponse>;
  parseDocument(request: ProviderParseRequest): Promise<ProviderParseResult>;
}

// ── A1 embedding ──────────────────────────────────────────────────────────────

export interface ProviderEmbedRequest {
  endpointUrl: string;
  apiKey: string;
  modelCode: string;
  texts: string[];
  config?: ModelConfig;
}

export interface ProviderEmbedResponse {
  modelVersion: string;
  dimension: number;
  vectors: number[][];
  /** Upstream-reported usage, when the provider returns it (zhipu does). */
  usage?: Partial<TokenUsage>;
}

// ── A2 parse (layout / OCR / table / formula) ──────────────────────────────────

export type ParseTask = "layout" | "ocr" | "table" | "formula";

export interface ProviderParsePage {
  pageIndex: number;
  imageRef?: string;
  imageBase64?: string;
  regions?: unknown[];
}

export interface ProviderParseRequest {
  endpointUrl: string;
  apiKey: string;
  modelCode: string;
  task: ParseTask;
  pages: ProviderParsePage[];
  config?: ModelConfig;
  /** 服务商行的 config；与 `config` 一起解析出 `wire` 描述符（见 providers/wire.ts）。 */
  providerConfig?: ModelConfig;
}

/**
 * One page's structure. `pageIndex` is echoed from the request so a caller can
 * correlate without relying on array order.
 */
export interface ParseLayoutPage {
  pageIndex: number;
  blocks: Array<{ bbox: number[]; blockType: string }>;
}
export interface ParseOcrPage {
  pageIndex: number;
  spans: Array<{ bbox: number[]; text: string }>;
}
export interface ParseTablePage {
  pageIndex: number;
  rows: number;
  cols: number;
  cells: Array<{
    rowSpan: number;
    colSpan: number;
    text: string;
    bbox: number[];
  }>;
}
export interface ParseFormulaPage {
  pageIndex: number;
  latex: string;
  bbox: number[];
}

/**
 * A2 parse result: one entry per page of the request.
 *
 * This carried a single flat structure until 2026-08-16 - `{task:"ocr",
 * spans:[...]}` with no page dimension at all - while the request took a
 * `pages` array and the adapter made one upstream call per page. The adapter
 * kept the FIRST page and discarded the rest (`first ??= parsed`), summing
 * usage across all of them. So an N-page parse cost N upstream calls, billed N
 * pages, and returned page one, with the caller receiving a well-formed
 * response and no way to tell. `docs/30-design/200-s2s-provider-surface.md`
 * advertised the opposite ("one `pages` array carries multiple pages - no
 * per-page round trip").
 *
 * `task` stays at the top rather than repeating on every page: a caller
 * narrows once, and the task is a property of the request, not of a page.
 */
export type ProviderParseResponse =
  | { task: "layout"; pages: ParseLayoutPage[] }
  | { task: "ocr"; pages: ParseOcrPage[] }
  | { task: "table"; pages: ParseTablePage[] }
  | { task: "formula"; pages: ParseFormulaPage[] };

/**
 * What the adapter hands back to the parse service: the page structure plus
 * the upstream token spend, summed across the per-page calls. Usage rides
 * outside the discriminated union so metering never depends on the task shape.
 */
export type ProviderParseResult = ProviderParseResponse & {
  usage?: Partial<TokenUsage>;
};

// ── A3 rerank ───────────────────────────────────────────────────────────────

export interface ProviderRerankCandidate {
  id: string;
  text: string;
}

export interface ProviderRerankRequest {
  endpointUrl: string;
  apiKey: string;
  modelCode: string;
  query: string;
  candidates: ProviderRerankCandidate[];
  config?: ModelConfig;
}

export interface ProviderRerankResponse {
  scores: Array<{ id: string; score: number }>;
  /** Upstream-reported usage, when the provider returns it (zhipu does). */
  usage?: Partial<TokenUsage>;
}

export interface ProviderChatRequest {
  endpointUrl: string;
  apiKey: string;
  modelCode: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Already checked against the model by the runtime; the adapter only spreads its fragment. */
  thinking?: ThinkingMode;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  config?: ModelConfig;
  /** 服务商行的 config；与 `config` 一起解析出 `wire` 描述符（见 providers/wire.ts）。 */
  providerConfig?: ModelConfig;
  /**
   * 调用方的取消信号（自检的整体超时、HTTP 客户端断开等）。适配器把它并入
   * 内部的首字节超时一起传给 fetch，见 providers/upstream-timeout.ts。
   */
  signal?: AbortSignal;
}

export interface ProviderChatResponse extends TokenUsage {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  /** 本轮推理载荷。适配器从上游读出，`runtime.service` 放进 `message`。 */
  reasoning?: ChatReasoning;
  /**
   * False when the upstream response carried no usage object and the token
   * counts above are placeholder zeros. Metering must then record NULL, not
   * 0 - "unreported" and "free" are different facts. Absent means reported.
   */
  usageReported?: boolean;
}

export type ModelConfig = Record<string, unknown>;
export type DecimalLike = { toString(): string };

export interface ModelProviderRecord {
  id: string;
  providerCode: string;
  providerType: string;
  providerName: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  consoleUrl: string | null;
  billingUrl: string | null;
  isActive: boolean;
  config: ModelConfig | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AiModelRecord {
  id: string;
  providerId: string | null;
  modelCode: string;
  modelName: string;
  provider: string;
  endpointUrl: string;
  protocol: string;
  modelType: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  supportsStreaming: boolean;
  isActive: boolean;
  sort: number;
  config: ModelConfig | null;
  /**
   * 所属服务商行的 `config`（join 带出，非 model.models 的列）。
   * `wire` 描述符的服务商级默认住在这里，由模型自己的 `config.wire` 覆盖。
   */
  providerConfig: ModelConfig | null;
  /** Whether the owning provider is active. A model under a deactivated
   *  provider is not usable, however active its own row says it is. */
  providerActive: boolean;
  /**
   * product_251 X-4: when this model was retired with notice, or null. A
   * deprecated model is still ACTIVE and still resolves - that is the point.
   */
  deprecatedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AiModelGrantRecord {
  id: string;
  modelId: string;
  tenantId: string;
  applicationId: string | null;
  applicationType: ApplicationType | null;
  agentId: string | null;
  /** Task-profile routing (docs/70-workplan) - see `ChatRequest.taskProfile`. */
  taskProfile: string | null;
  priority: number;
  reason: string | null;
  expiresAt: Date | null;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ModelPriceRuleRecord {
  id: string;
  modelId: string;
  billingMode: string;
  currency: string;
  unitTokens: number;
  inputUnitPrice: DecimalLike;
  outputUnitPrice: DecimalLike;
  requestUnitPrice: DecimalLike;
  /**
   * TD-047. Price for the input tokens the upstream served from its prompt
   * cache. `null` means no cached rate was declared - not that cached input is
   * free - so a cost calculation falls back to `inputUnitPrice`.
   */
  cachedInputUnitPrice: DecimalLike | null;
  isActive: boolean;
  effectiveAt: Date;
  expiresAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelPolicyRecord {
  id: string;
  modelId: string;
  tenantId: string | null;
  name: string | null;
  priority: number;
  maxConcurrent: number | null;
  rateLimitRpm: number | null;
  rateLimitTpm: bigint | null;
  rateLimitTpd: bigint | null;
  maxContextTokens: number | null;
  isActive: boolean;
  effectiveAt: Date;
  expiresAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
/**
 * Aggregated from Atlas's own `reqlog.request_records` - not a mirror of the
 * platform's `metering.usage_summary_months`. No `totalQuota`/`statType`/
 * `featureId`/`agentId`: those are platform billing-cycle concepts with no
 * reqlog equivalent.
 */
export interface TenantUsageSummaryRecord {
  tenantId: string;
  /**
   * The billing subject is the (tenant, workspace) PAIR, not either alone -
   * grouping by tenant hides which workspace burned it, grouping by workspace
   * loses which customer to bill. Nullable because rows written before the
   * token carried a workspace claim have none.
   */
  workspaceId: string | null;
  /**
   * WHICH PRODUCT drove the call - `karda`, `arda`, `runos`, ... Taken from
   * the token's `act.sub`, so unlike `applicationId` a caller cannot omit or
   * forge it.
   *
   * `applicationId` does NOT substitute for this. It names an instance INSIDE
   * a product (one product holds many agents and workflows), it is a bare
   * uuid that carries no product attribution of its own, and a caller that
   * sends none gets a sentinel - at which point the row would say
   * `internal_service` and nothing about who ran it. Product is the level at
   * which "what does running karda cost" can be answered.
   *
   * Nullable for rows written before `product_code` existed, and for probe
   * calls, which have no calling product by definition.
   */
  productCode: string | null;
  cycleMonth: string;
  applicationId: string | null;
  applicationType: ApplicationType | null;
  requests: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  totalTokens: bigint;
  errors: bigint;
}

/**
 * The axis a usage rollup is grouped on.
 *
 * `tenant` is the default, so a caller that passes no `groupBy` keeps its
 * exact response shape. `provider`/`model` answer the two questions the
 * tenant rollup structurally cannot - "which model burned the most tokens",
 * "which provider's volume is climbing".
 *
 * `endpoint` carries a caveat the other axes do not: rows with NULL
 * endpoint_code (pre-migration, or routed by an explicit model/taskProfile)
 * are excluded rather than bucketed - see the read path.
 */
/**
 * What an endpoint is actually doing, derived at read time - never stored.
 *
 * Deriving rather than cascading a write is the whole design. Deactivating a
 * model could instead flip `isActive` on every endpoint pointing at it, but
 * that loses information three ways: it kills endpoints whose FALLBACK is
 * still fine (defeating the failover the operator configured), it overwrites
 * an operator's own decision to disable an endpoint, and reactivating the
 * model cannot tell which endpoints it should switch back on. A derived value
 * has none of those problems and costs one join.
 *
 * - `inactive`     - the operator turned this endpoint off. Only the operator
 *                    sets it, and no model or provider action may overwrite it.
 *                    Spelled the same as the object's own `state` on purpose
 *                    (product_251 M-B3): this is a derived field, but the
 *                    condition it reports is the object state, and two words
 *                    for one condition in one console is the defect the clause
 *                    exists to remove.
 * - `unresolvable` - neither primary nor fallback can serve. Calls fail.
 * - `degraded`     - the primary cannot serve but the fallback can. Calls
 *                    still succeed, on the fallback. This is the state that
 *                    was invisible before and is the one worth alerting on.
 * - `serving`      - the primary can serve.
 */
export type EndpointResolutionState =
  | "inactive"
  | "unresolvable"
  | "degraded"
  | "serving";

/**
 * Why a referenced model cannot serve. `provider_inactive` matters on its own:
 * it distinguishes a vendor switched off at provider level from a model-level
 * deactivation.
 */
export type ModelAvailability =
  | "available"
  | "model_inactive"
  | "provider_inactive"
  | "missing";

export interface EndpointModelRef {
  modelCode: string;
  availability: ModelAvailability;
}

export type UsageRollupDimension =
  | "tenant"
  | "provider"
  | "model"
  | "endpoint"
  | "product";

/**
 * One row of a `provider`/`model` rollup. Deliberately NOT grouped by
 * application the way the tenant rollup is: this axis exists to answer "how
 * much did this model cost us this month" across all callers, and splitting by
 * application would multiply the row count without serving that question.
 */
export interface UsageRollupRecord {
  groupKey: string;
  cycleMonth: string;
  requests: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  totalTokens: bigint;
  errors: bigint;
}
export interface CreateAiModelInput {
  providerId?: string | null;
  modelCode: string;
  modelName: string;
  provider: string;
  endpointUrl: string;
  protocol: string;
  modelType?: string;
  description?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities: string[];
  supportsStreaming?: boolean;
  sort?: number;
  config?: ModelConfig | null;
}

export interface UpdateAiModelInput {
  providerId?: string | null;
  modelCode?: string;
  modelName?: string;
  provider?: string;
  endpointUrl?: string;
  protocol?: string;
  modelType?: string;
  description?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: string[];
  supportsStreaming?: boolean;
  sort?: number;
  config?: ModelConfig | null;
  isActive?: boolean;
  /** product_251 X-4 - set by POST :id/deprecate, cleared by :id/undeprecate. */
  deprecatedAt?: Date | null;
}

export interface CreateAiModelGrantInput {
  modelId: string;
  tenantId: string;
  applicationId?: string | null;
  applicationType?: ApplicationType | null;
  agentId?: string | null;
  taskProfile?: string | null;
  priority?: number;
  reason?: string | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}

export interface UpdateAiModelGrantInput {
  applicationId?: string | null;
  applicationType?: ApplicationType | null;
  agentId?: string | null;
  taskProfile?: string | null;
  priority?: number;
  reason?: string | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}

export interface CreateModelProviderInput {
  providerCode: string;
  providerType?: string;
  providerName: string;
  description?: string | null;
  logoUrl?: string | null;
  homepageUrl?: string | null;
  consoleUrl?: string | null;
  billingUrl?: string | null;
  config?: ModelConfig | null;
  isActive?: boolean;
}

export type UpdateModelProviderInput = Partial<CreateModelProviderInput>;

/** model.model_endpoints row. */
export interface ModelEndpointRecord {
  id: string;
  code: string;
  category: string;
  primaryModelCode: string;
  fallbackModelCode: string | null;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateModelEndpointInput {
  code: string;
  category?: string;
  primaryModelCode: string;
  fallbackModelCode?: string | null;
  isActive?: boolean;
}

export type UpdateModelEndpointInput = Partial<
  Omit<CreateModelEndpointInput, "code">
>;

export interface CreateModelPriceRuleInput {
  modelId: string;
  billingMode?: string;
  currency?: string;
  unitTokens?: number;
  inputUnitPrice?: string;
  outputUnitPrice?: string;
  requestUnitPrice?: string;
  /** TD-047. Absent leaves the column NULL; see `ModelPriceRuleRecord`. */
  cachedInputUnitPrice?: string | null;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  isActive?: boolean;
}

export type UpdateModelPriceRuleInput = Partial<
  Omit<CreateModelPriceRuleInput, "modelId">
>;

export interface CreateModelPolicyInput {
  modelId: string;
  tenantId?: string | null;
  name?: string | null;
  priority?: number;
  maxConcurrent?: number | null;
  rateLimitRpm?: number | null;
  rateLimitTpm?: bigint | null;
  rateLimitTpd?: bigint | null;
  maxContextTokens?: number | null;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  isActive?: boolean;
}

export type UpdateModelPolicyInput = Partial<
  Omit<CreateModelPolicyInput, "modelId">
>;
