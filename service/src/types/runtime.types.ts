// One-way: runtime.errors imports nothing from here, so this is not a cycle.
import { isRetryable } from "../runtime/runtime.errors";
import type { ModelRuntimeErrorCode } from "../runtime/runtime.errors";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 角色：模型本轮发起的工具调用列表 */
  toolCalls?: ToolCall[];
  /** tool 角色：本条消息对应的 toolCall ID */
  toolCallId?: string;
  /** tool 角色：工具名称（部分 provider 要求） */
  name?: string;
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
   * Task-profile routing (docs/70-workplan): when `modelCode` is omitted, Atlas
   * resolves it from the tenant's active `model.model_grants.task_profile`
   * match (see `ModelRegistryService.resolveModelCodeForTaskProfile`) instead
   * of requiring the caller to know a specific modelCode up front.
   */
  taskProfile?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
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

export interface ChatResponse {
  id: string;
  modelCode: string;
  message: ChatMessage;
  usage: TokenUsage;
  latencyMs: number;
  finishReason?: FinishReason;
}

/**
 * 流式响应事件（与 ai-sdk LLMStreamChunk 形态对齐）
 *
 * Model Runtime 以 SSE 形式逐条 `data: <json>` 推送，
 * 流尾以 `data: [DONE]` 结束。
 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; usage?: TokenUsage; finishReason?: FinishReason }
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
