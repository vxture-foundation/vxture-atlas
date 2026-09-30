import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { costUnitForMetric } from "../reqlog/cost-unit";
import { isUuid } from "../uuid";
import { countingRejections } from "./pre-log-rejection";

/** The C3 metric the chat plane consumes against; also keys its cost unit. */
const CHAT_METRIC = "atlas.chat";
import { metricsRegistry } from "./metrics.registry";
import {
  REASONING_TOOL_EXPOSURE_METRIC,
  classifyReasoningToolCall,
  reasoningTokensOf,
} from "../observability/reasoning-tool-exposure";
import { randomUUID } from "node:crypto";

import { ProviderHttpError } from "../providers/base.provider";
import {
  CONTEXT_OVERFLOW_SIGNATURES,
  isContextOverflow,
  signaturesFromConfig,
} from "../providers/context-overflow";
import { resolveWireFor, supportedThinkingModes } from "../providers/wire";
import {
  UpstreamCallFailure,
  usageColumns,
  upstreamFromError,
  usageFromError,
  type UpstreamUsageSnapshot,
} from "../providers/upstream-failure";
import { RequestLogService } from "../reqlog/request-log.service";
import type { RequestLogEntry } from "../reqlog/request-log.types";
import { PlatformEntitlementClient } from "../platform/platform-entitlement.client";
import type { S2sAuthContext } from "./guards/s2s-auth.guard";
import { ModelCircuitBreakerService } from "./model-circuit-breaker.service";
import { ModelRegistryService } from "../registry/model-registry.service";
import { ModelRouterService } from "../router/model-router.service";
import { QuotaService } from "../quota/quota.service";
import { resolveApplicationScope } from "../quota/quota.service";
import {
  ModelRateLimiterService,
  rateLimitKey,
} from "../quota/model-rate-limiter.service";
import { ModelRuntimeException } from "./runtime.errors";
import { requireTaskId } from "./task-attribution";
import type {
  ModelRuntimeErrorCode,
  ModelRuntimeErrorResponse,
} from "./runtime.errors";
import { managedKeyAliasOf, resolveApiKey } from "./resolve-api-key";
import { ProviderKeyService } from "../provider-keys/provider-key.service";
import type {
  AiModelRecord,
  ChatRequest,
  ChatResponse,
  FinishReason,
  ProviderChatRequest,
  StreamEvent,
  ThinkingMode,
  TokenUsage,
  UpstreamCallRecord,
} from "../types/runtime.types";
import { THINKING_MODES } from "../types/runtime.types";

/**
 * Upstream statuses that refuse the request's content rather than signal an
 * unhealthy service: 400 (context too long, parameter refused), 413 (payload
 * over the vendor's cap), 422 (well-formed but unprocessable). Deliberately
 * absent: 401/403/404, which mean Atlas's own key or model mapping is wrong -
 * a platform fault every caller shares, so it SHOULD trip the breaker - and
 * 408/429/5xx, which are the upstream's capacity.
 */
const UPSTREAM_REJECTS_REQUEST: ReadonlySet<number> = new Set([400, 413, 422]);

/** Can this model run with `mode`? Read from the same wire the adapter will use. */
function honoursThinking(model: AiModelRecord, mode: ThinkingMode): boolean {
  return supportedThinkingModes(
    resolveWireFor({
      protocol: model.protocol,
      providerConfig: model.providerConfig,
      config: model.config,
    }),
  ).includes(mode);
}

/**
 * Failures that say nothing about the model's health, so never the breaker:
 * refusals of the request's content, and the caller's own budget running out
 * (B6) - a tight `timeoutMs` from one caller must not take a model offline for
 * everyone.
 */
const NOT_A_HEALTH_SIGNAL: ReadonlySet<ModelRuntimeErrorCode> = new Set([
  "UPSTREAM_REJECTED_REQUEST",
  "CONTEXT_LENGTH_EXCEEDED",
  "DEADLINE_EXCEEDED",
  "OUTPUT_BUDGET_EXHAUSTED",
]);

/** B6 bounds on `timeoutMs`. */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/** Either signal cancels; `undefined` when neither exists. */
function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** Enough of the vendor's error body to name the cause, not to echo a prompt back. */
const UPSTREAM_DETAIL_MAX_CHARS = 300;

/**
 * TD-049. What every step of one chat request needs to know about it.
 *
 * `chat()` and `chatStream()` used to pass these five names as a fresh object
 * literal into each helper. That is how a dimension gets added to six of eight
 * call sites: nothing type-checks the omission, the log line simply comes out
 * thinner on one path than the other, and the path with fewer tests is the one
 * that keeps the old shape.
 */
/**
 * TD-049. Who the caller is, in the shape `reqlog` records it.
 *
 * `recordUsage` and `recordFailure` assembled these seven fields identically.
 * They are the dimensions every per-tenant report groups by, so a field added
 * to one writer and not the other makes a slice of traffic vanish from those
 * reports while the totals stay right - which is the failure `tenant_id`
 * already produced once.
 */

function callerDimensions(
  request: ChatRequest,
  applicationScope: ReturnType<typeof resolveApplicationScope>,
  auth: S2sAuthContext | undefined,
): Record<string, unknown> {
  return {
    ...(auth?.workspaceId !== undefined ? { workspaceId: auth.workspaceId } : {}),
    ...(auth?.userId !== undefined ? { userId: auth.userId } : {}),
    tenantId: auth?.tenantId ?? request.tenantId,
    applicationId: applicationScope.applicationId,
    applicationType: applicationScope.applicationType,
    agentId: applicationScope.agentId,
    ...(request.featureId !== undefined ? { featureId: request.featureId } : {}),
  };
}

interface ChatAttemptContext {
  request: ChatRequest;
  requestId: string;
  applicationScope: ReturnType<typeof resolveApplicationScope>;
  auth?: S2sAuthContext | undefined;
  routed: {
    endpointCode: string | null;
    fallbackModelCodes: string[] | null;
  };
  modelCode: string;
  /** Usage-record batch 2 (D4): set by the entry point, not by the caller's body. */
  streamed: boolean;
  /**
   * B6: the caller's total budget, started once per request so every
   * candidate spends the same budget. Absent when no `timeoutMs` was given.
   */
  deadline?: AbortSignal | undefined;
}

@Injectable()
export class ModelRuntimeService {
  private readonly logger = new Logger(ModelRuntimeService.name);

  constructor(
    @Inject(ModelRegistryService)
    private readonly registry: ModelRegistryService,
    @Inject(ModelRouterService)
    private readonly router: ModelRouterService,
    @Inject(QuotaService)
    private readonly quota: QuotaService,
    @Inject(ProviderKeyService)
    private readonly providerKeys: ProviderKeyService,
    @Inject(RequestLogService)
    private readonly requestLog: RequestLogService,
    @Inject(PlatformEntitlementClient)
    private readonly entitlements: PlatformEntitlementClient,
    @Inject(ModelCircuitBreakerService)
    private readonly circuitBreaker: ModelCircuitBreakerService,
    @Inject(ModelRateLimiterService)
    private readonly rateLimiter: ModelRateLimiterService,
  ) {}

  private readonly resolveManagedKey = (
    providerCode: string,
    keyAlias: string,
  ): Promise<string | null> => this.providerKeys.resolveKey(providerCode, keyAlias);

  async chat(
    request: ChatRequest,
    auth?: S2sAuthContext,
  ): Promise<ChatResponse> {
    const ctx = await this.beginChatRequest(request, auth, "model_runtime_request_start", false);
    const { routed, modelCode, requestId } = ctx;

    try {
      const models = await this.resolveCandidatesOrFail(
        ctx,
        "model_runtime_request_failed",
      );
      let lastProviderError: ModelRuntimeException | undefined;

      for (const [fallbackAttempt, model] of models.entries()) {
        // B6: a spent budget ends the chain - trying a fallback would spend
        // time the caller no longer has.
        if (ctx.deadline?.aborted && lastProviderError !== undefined) break;
        if (this.skipTripped(ctx, model, fallbackAttempt, models.length)) continue;

        await this.assertQuotaOrRecordRefusal(
          ctx,
          model,
          fallbackAttempt,
          "model_runtime_request_failed",
        );

        const startedAt = Date.now();

        try {
          const provider = this.router.resolve(model);
          const apiKey = await resolveApiKey({ resolveManagedKey: this.resolveManagedKey }, model, requestId);
          this.logAttempt(ctx, model, fallbackAttempt, "model_runtime_provider_start", "started");
          const providerResponse = await provider.chat(
            this.buildUpstreamRequest(model, request, apiKey, ctx.deadline),
          );
          const latencyMs = Date.now() - startedAt;
          this.circuitBreaker.recordSuccess(model.modelCode);

          await this.recordUsage(
            model,
            request,
            requestId,
            providerResponse,
            latencyMs,
            auth,
            routed.endpointCode,
            fallbackAttempt,
            {
              upstream: providerResponse.upstream,
              finishReason: providerResponse.finishReason,
              facts: {
                ...requestFacts(request, false),
                startedAt: new Date(startedAt),
                ...keyAliasColumn(model),
              },
            },
          );

          this.logAttempt(
            ctx,
            model,
            fallbackAttempt,
            "model_runtime_request_success",
            "success",
            { latencyMs, totalTokens: providerResponse.totalTokens },
          );

          return {
            id: requestId,
            modelCode: model.modelCode,
            thinking: request.thinking ?? null,
            message: {
              role: "assistant",
              content: providerResponse.content,
              ...(providerResponse.toolCalls !== undefined
                ? { toolCalls: providerResponse.toolCalls }
                : {}),
              /* 推理载荷原样交付。**带 tools 的多轮对话，调用方必须把它整个带回**
                 ——缺了上游 400，而错误出现在调用方那一侧（TD-046）。 */
              ...(providerResponse.reasoning !== undefined
                ? { reasoning: providerResponse.reasoning }
                : {}),
            },
            usage: {
              promptTokens: providerResponse.promptTokens,
              completionTokens: providerResponse.completionTokens,
              totalTokens: providerResponse.totalTokens,
            },
            latencyMs,
            ...(providerResponse.finishReason !== undefined
              ? { finishReason: providerResponse.finishReason }
              : {}),
          };
        } catch (error) {
          lastProviderError = await this.failCandidate(
            ctx,
            model,
            fallbackAttempt,
            error,
            startedAt,
            "model_runtime_provider_failed",
          );
        } finally {
          // 无论这个 candidate 有没有配限流策略、有没有真的 acquire 过,
          // release 都是安全的空操作 - 见 ModelRateLimiterService.releaseConcurrency。
          this.rateLimiter.releaseConcurrency(
            rateLimitKey(model.id, request.tenantId),
          );
        }
      }

      this.logChainExhausted(ctx, "model_runtime_request_failed", models.length, lastProviderError);

      // TD-037. No terminal row here, and that is the change rather than an
      // omission. Every exit from the loop above records its own attempt: a
      // candidate either succeeds, is refused by the gate, or fails and is
      // caught - and `resolveCandidateModels` always returns at least the
      // primary, so the loop always runs at least once. A row written here
      // would therefore be an N+1th record of a failure already counted N
      // times, landing in exactly the rollups this change exists to make
      // comparable.
      //
      // The guard that used to stand here was a branch nothing could enter,
      // which is worse than no branch: it reads as a safety net while being
      // dead code. What replaces it is a test - "writes N rows when every
      // candidate fails, not N+1" - which fails loudly if the invariant this
      // relies on ever stops holding.

      throw (
        lastProviderError ??
        new ModelRuntimeException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "PROVIDER_UNAVAILABLE",
          "No provider candidate completed the request",
          { requestId, modelCode },
        )
      );
    } finally {
      this.incrementInflightRequest(-1);
    }
  }

  /**
   * 流式对话，返回 AsyncGenerator<StreamEvent>
   *
   * 控制器把每个 event 序列化为 SSE `data:` 行写回客户端。
   * 用量统计在流结束（done 事件）时写入。
   */
  async *chatStream(
    request: ChatRequest,
    auth?: S2sAuthContext,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const ctx = await this.beginChatRequest(request, auth, "model_runtime_stream_start", true);
    const { routed, modelCode, requestId } = ctx;

    try {
      const candidateModels = await this.resolveCandidatesOrFail(
        ctx,
        "model_runtime_stream_failed",
      );

      const models = candidateModels.filter((model) => model.supportsStreaming);

      if (models.length === 0) {
        this.logRuntimeEvent("model_runtime_stream_failed", {
          request,
          requestId,
          applicationScope: ctx.applicationScope,
          modelCode,
          status: "provider_error",
          errorCode: "MODEL_NOT_ROUTABLE",
          fallbackAttempt: 0,
        });
        throw new ModelRuntimeException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "MODEL_NOT_ROUTABLE",
          `AI model "${modelCode}" does not support streaming and has no streaming fallback`,
          { requestId, modelCode },
        );
      }

      let lastUsage: TokenUsage | undefined;
      /* Usage-record batch 1: the done frame's vendor facts, for the row. */
      let lastUpstream: UpstreamCallRecord | undefined;
      let lastFinishReason: FinishReason | undefined;
      let lastProviderError: ModelRuntimeException | undefined;

      for (const [fallbackAttempt, model] of models.entries()) {
        // The caller is gone - no candidate may be attempted on its behalf.
        // The abort-during-attempt case below records the in-flight row; here
        // nothing was in flight, so there is nothing to record.
        if (signal?.aborted) return;

        if (this.skipTripped(ctx, model, fallbackAttempt, models.length)) continue;

        await this.assertQuotaOrRecordRefusal(
          ctx,
          model,
          fallbackAttempt,
          "model_runtime_stream_failed",
        );

        const startedAt = Date.now();
        lastUsage = undefined;
        lastUpstream = undefined;
        lastFinishReason = undefined;
        let firstTokenAt: number | undefined;
        // Once any event reached the client, failing over would concatenate a
        // second answer into the same SSE stream - after first yield, the only
        // honest outcomes are completion or an explicit error frame.
        let yieldedThisAttempt = false;
        let upstreamErrorFrame = false;

        try {
          const provider = this.router.resolve(model);
          const apiKey = await resolveApiKey({ resolveManagedKey: this.resolveManagedKey }, model, requestId);
          this.logAttempt(ctx, model, fallbackAttempt, "model_runtime_provider_stream_start", "started");
          for await (const event of provider.chatStream(
            this.buildUpstreamRequest(
              model,
              request,
              apiKey,
              combineSignals(signal, ctx.deadline),
            ),
          )) {
            if (event.type === "error") {
              // Adapters emit a RECOVERABLE `UPSTREAM_FRAME_UNPARSEABLE` frame
              // for a single malformed SSE chunk and keep the stream (and its
              // final usage frame) alive - forward it and keep consuming. Only
              // terminal error frames may end the candidate.
              if (event.code === "UPSTREAM_FRAME_UNPARSEABLE") {
                yield event;
                continue;
              }
              // An in-stream terminal error is a provider FAILURE, not a
              // stream that "completed". Before any output: throw, so the
              // normal catch/failover applies. After partial output: forward
              // the frame so the client knows, then stop this candidate.
              if (!yieldedThisAttempt) {
                throw new ModelRuntimeException(
                  HttpStatus.SERVICE_UNAVAILABLE,
                  "PROVIDER_UNAVAILABLE",
                  event.message || "provider reported an in-stream error",
                  {
                    requestId,
                    modelCode: model.modelCode,
                    provider: model.provider,
                  },
                );
              }
              upstreamErrorFrame = true;
              yield event;
              break;
            }
            if (event.type === "done" && event.usage) {
              lastUsage = event.usage;
            }
            if (event.type === "done") {
              lastUpstream = event.upstream;
              lastFinishReason = event.finishReason;
            }
            // Usage-record batch 2 (A5): the first event this attempt hands
            // the caller. TTFT = first_token_at - started_at.
            if (!yieldedThisAttempt) firstTokenAt = Date.now();
            yieldedThisAttempt = true;
            // The one place a stream can say WHO answered. The adapter cannot:
            // it knows the vendor's upstream name, not the registry code. After
            // a failover this is the candidate that actually served, which is
            // the fact worth reporting - not the one that was tried first.
            // `upstream` is for the usage record only: vendor ids and raw usage
            // are not part of the caller contract, so the frame loses it here.
            yield event.type === "done"
              ? {
                  ...withoutUpstream(event),
                  modelCode: model.modelCode,
                  thinking: request.thinking ?? null,
                }
              : event;
          }

          const latencyMs = Date.now() - startedAt;

          if (upstreamErrorFrame) {
            const streamError = new ModelRuntimeException(
              HttpStatus.SERVICE_UNAVAILABLE,
              "PROVIDER_UNAVAILABLE",
              "provider reported an in-stream error after partial output",
              {
                requestId,
                modelCode: model.modelCode,
                provider: model.provider,
              },
            );
            this.circuitBreaker.recordFailure(model.modelCode);
            this.logAttempt(
              ctx,
              model,
              fallbackAttempt,
              "model_runtime_provider_stream_failed",
              "provider_error",
              { latencyMs, errorCode: streamError.code },
            );
            await this.recordFailure(
              request,
              requestId,
              model.modelCode,
              model.provider,
              streamError,
              latencyMs,
              auth,
              routed.endpointCode,
              fallbackAttempt,
              undefined,
              undefined,
              {
                ...requestFacts(request, true),
                startedAt: new Date(startedAt),
                ...(firstTokenAt !== undefined
                  ? { firstTokenAt: new Date(firstTokenAt) }
                  : {}),
                ...keyAliasColumn(model),
              },
            );
            return;
          }

          this.circuitBreaker.recordSuccess(model.modelCode);

          // Recorded even when the done frame carried no usage: a served
          // stream with NULL token columns is still a served request, and a
          // row that never exists is invisible to every rollup and to the
          // billed-amount reconciliation signal.
          await this.recordUsage(
            model,
            request,
            requestId,
            lastUsage,
            latencyMs,
            auth,
            routed.endpointCode,
            fallbackAttempt,
            {
              upstream: lastUpstream,
              finishReason: lastFinishReason,
              facts: {
                ...requestFacts(request, true),
                startedAt: new Date(startedAt),
                ...(firstTokenAt !== undefined
                  ? { firstTokenAt: new Date(firstTokenAt) }
                  : {}),
                ...keyAliasColumn(model),
              },
            },
          );
          this.logAttempt(
            ctx,
            model,
            fallbackAttempt,
            "model_runtime_stream_success",
            "success",
            {
              latencyMs,
              ...(lastUsage !== undefined
                ? { totalTokens: lastUsage.totalTokens }
                : {}),
            },
          );

          return;
        } catch (error) {
          // B6, checked BEFORE the client abort: the deadline also aborts the
          // same fetch, and it must be reported as the caller's budget running
          // out, not as the caller disconnecting.
          if (ctx.deadline?.aborted) {
            lastProviderError = await this.failCandidate(
              ctx,
              model,
              fallbackAttempt,
              error,
              startedAt,
              "model_runtime_provider_stream_failed",
            );
            break;
          }
          // A client-initiated abort is not a provider failure: the model is
          // healthy, so it must not count against the circuit breaker, and
          // the caller is gone, so no fallback may be attempted for it. The
          // row is still recorded - a disconnect that burned upstream tokens
          // must stay visible.
          if (signal?.aborted) {
            const abortError = new ModelRuntimeException(
              HttpStatus.BAD_REQUEST,
              "CLIENT_ABORTED",
              "client disconnected before the stream completed",
              {
                requestId,
                modelCode: model.modelCode,
                provider: model.provider,
              },
            );
            this.logAttempt(
              ctx,
              model,
              fallbackAttempt,
              "model_runtime_stream_failed",
              "client_aborted",
              {
                latencyMs: Date.now() - startedAt,
                errorCode: abortError.code,
              },
            );
            await this.recordFailure(
              request,
              requestId,
              model.modelCode,
              model.provider,
              abortError,
              Date.now() - startedAt,
              auth,
              routed.endpointCode,
              fallbackAttempt,
              undefined,
              undefined,
              {
                ...requestFacts(request, true),
                startedAt: new Date(startedAt),
                ...(firstTokenAt !== undefined
                  ? { firstTokenAt: new Date(firstTokenAt) }
                  : {}),
                ...keyAliasColumn(model),
              },
            );
            return;
          }
          lastProviderError = await this.failCandidate(
            ctx,
            model,
            fallbackAttempt,
            error,
            startedAt,
            "model_runtime_provider_stream_failed",
          );
          // Partial output already reached the client - do not let a fallback
          // stream a second answer into the same response. The comment sat
          // above the wrong statement until TD-049 moved it here.
          if (yieldedThisAttempt) break;
        } finally {
          this.rateLimiter.releaseConcurrency(
            rateLimitKey(model.id, request.tenantId),
          );
        }
      }

      this.logChainExhausted(ctx, "model_runtime_stream_failed", models.length, lastProviderError);

      // TD-037. No terminal row here either; see chat() for why one would
      // be an N+1th record of a failure already counted N times.

      throw (
        lastProviderError ??
        new ModelRuntimeException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "PROVIDER_UNAVAILABLE",
          "No streaming provider candidate completed the request",
          { requestId, modelCode },
        )
      );
    } finally {
      this.incrementInflightRequest(-1);
    }
  }

  private incrementInflightRequest(delta = 1): void {
    try {
      metricsRegistry.changeGauge("model_request_in_flight", delta);
    } catch (err) {
      this.logger.debug(`metrics update error: ${String(err)}`);
    }
  }

  private logRuntimeEvent(
    event: string,
    input: {
      /** request 含 prompt，日志序列化时必须显式排除。 */
      request: ChatRequest;
      requestId: string;
      applicationScope: ReturnType<typeof resolveApplicationScope>;
      modelCode: string;
      status: string;
      providerCode?: string;
      latencyMs?: number;
      errorCode?: string | null;
      fallbackAttempt: number;
      totalTokens?: number;
    },
  ): void {
    // 只构造允许运维关联的字段，避免 prompt 或 response 内容进入日志。
    const safeLog: Record<string, unknown> = {
      event,
      request_id: input.requestId,
      tenant_id: input.request.tenantId,
      application_id: input.applicationScope.applicationId,
      application_type: input.applicationScope.applicationType,
      model_code: input.modelCode,
      status: input.status,
      fallback_attempt: input.fallbackAttempt,
    };

    if (input.providerCode) safeLog["provider_code"] = input.providerCode;
    if (input.latencyMs !== undefined) safeLog["latency_ms"] = input.latencyMs;
    if (input.errorCode) safeLog["error_code"] = input.errorCode;
    if (input.totalTokens !== undefined)
      safeLog["total_tokens"] = input.totalTokens;

    // 输出 JSON 字符串，便于日志系统按字段解析。
    this.logger.log(JSON.stringify(safeLog));

    // 更新轻量指标（非阻塞）：失败指标、延迟与总量由事件状态驱动，尽量不影响主链路。
    try {
      metricsRegistry.incCounter("model_requests_total", {
        operation: event.includes("stream") ? "stream" : "chat",
        status: String(input.status),
        ...(input.providerCode ? { provider: input.providerCode } : {}),
      });
      if (input.latencyMs !== undefined) {
        metricsRegistry.observeHistogram(
          "model_request_latency_ms",
          Number(input.latencyMs),
          {
            ...(input.providerCode ? { provider: input.providerCode } : {}),
            operation: event.includes("stream") ? "stream" : "chat",
          },
        );
      }
      if (input.errorCode) {
        metricsRegistry.incCounter("model_request_errors_total", {
          code: String(input.errorCode),
          ...(input.providerCode ? { provider: input.providerCode } : {}),
        });
      }
    } catch (err) {
      // 指标写入不能影响模型调用主链路。
      this.logger.debug(`metrics update error: ${String(err)}`);
    }
  }

  private validateChatRequest(request: ChatRequest): void {
    requireTaskId(request.taskId);

    if (typeof request.tenantId !== "string" || !request.tenantId.trim()) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "TENANT_ID_REQUIRED",
        "tenantId is required",
      );
    }

    // Refused at the boundary, where the message can name the real problem.
    //
    // Accepting it was never harmless: the attribution column is `uuid`, so
    // the value is written NULL and the traffic then exists under product_code
    // and is absent from every tenant-dimension report, with nothing raised
    // (#198 section 4). Worse, it surfaced much later wearing a different
    // error's face - once a product grant stopped matching, the tenant axis
    // answered `400 INVALID_TENANT_ID`, pointing at the one thing that had not
    // changed.
    if (!isUuid(request.tenantId)) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "INVALID_TENANT_ID",
        "tenantId must be a UUID - use the platform tenant id from your token context, not an internal composite identifier",
      );
    }

    if (
      !request.modelCode?.trim() &&
      !request.endpointCode?.trim() &&
      !request.taskProfile?.trim()
    ) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "TARGET_SELECTOR_REQUIRED",
        "one of modelCode, endpointCode or taskProfile is required",
      );
    }

    // ADR-009. A value outside the vocabulary is refused here rather than
    // treated as "not asked": dropping it would serve the upstream default,
    // which is exactly the call the caller was trying not to make.
    if (
      request.thinking !== undefined &&
      !THINKING_MODES.includes(request.thinking)
    ) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "CHAT_THINKING_INVALID",
        `thinking must be one of: ${THINKING_MODES.join(", ")}`,
      );
    }

    // B6. Bounded both ways: below a second no upstream can answer, and
    // above ten minutes a caller wants the batch path, not a held socket.
    if (
      request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) ||
        request.timeoutMs < MIN_TIMEOUT_MS ||
        request.timeoutMs > MAX_TIMEOUT_MS)
    ) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "CHAT_TIMEOUT_INVALID",
        `timeoutMs must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }

    const validApplicationTypes = new Set([
      "agent",
      "workflow",
      "api_client",
      "internal_service",
    ]);

    if (
      request.applicationType !== undefined &&
      !validApplicationTypes.has(request.applicationType)
    ) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "APPLICATION_TYPE_INVALID",
        "applicationType is invalid",
      );
    }

    if (request.applicationId !== undefined && !request.applicationId.trim()) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "APPLICATION_ID_REQUIRED",
        "applicationId cannot be empty",
      );
    }

    if (request.applicationId && !request.applicationType) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "APPLICATION_TYPE_REQUIRED",
        "applicationType is required when applicationId is provided",
      );
    }

    if (request.applicationType && !request.applicationId && !request.agentId) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "APPLICATION_ID_REQUIRED",
        "applicationId is required when applicationType is provided",
      );
    }

    // The data plane accepts only "normal" (or absence). "test" is reserved
    // for the operator probe and "retry" for internal retry accounting - a
    // caller-supplied "test" would hide billed traffic from every operator
    // rollup, and an out-of-vocabulary value would fail the reqlog CHECK
    // after the workspace was already billed.
    if (request.usageType !== undefined && request.usageType !== "normal") {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "USAGE_TYPE_INVALID",
        'usageType only accepts "normal" on the data plane',
      );
    }

    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "CHAT_MESSAGES_REQUIRED",
        "messages cannot be empty",
      );
    }

    const validRoles = new Set(["system", "user", "assistant", "tool"]);
    const invalidMessage = request.messages.some((message) => {
      if (!validRoles.has(message.role)) return true;
      if (typeof message.content !== "string") return true;
      // assistant 发起 tool_calls 时 content 允许为空字符串；其他角色必须非空
      if (message.role === "assistant" && message.toolCalls?.length)
        return false;
      return !message.content.trim();
    });

    if (invalidMessage) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "CHAT_MESSAGES_INVALID",
        "messages contain invalid role or content",
      );
    }
  }

  /**
   * `validateChatRequest` already guarantees at least one of `modelCode`/
   * `taskProfile` is present. Task-profile resolution (docs/70-workplan)
   * requires a real tenant/grant lookup, so this is async and DB-backed.
   */
  /**
   * The three ways a caller can say which model to use, in precedence order:
   * an explicit `modelCode`, a stable `endpointCode`, or a per-tenant
   * `taskProfile`. Precedence is most-specific-first, so passing more than
   * one is not an error - the narrower instruction simply wins.
   *
   * Returns the fallback chain alongside the model, because only endpoint
   * routing carries its own chain. `fallbackModelCodes: null` means "this
   * route has no opinion, use the model's own `config.fallbackModelCodes`",
   * which is what the other two paths have always done.
   *
   * `endpointCode` is the endpoint that ACTUALLY routed, not whatever the
   * caller happened to send. A request naming both a `modelCode` and an
   * `endpointCode` is routed by the model - so this comes back null, and the
   * endpoint is not credited in metering for traffic it did not direct.
   */
  private async resolveRoute(request: ChatRequest): Promise<{
    modelCode: string;
    fallbackModelCodes: string[] | null;
    endpointCode: string | null;
  }> {
    const modelCode = request.modelCode?.trim();
    if (modelCode) {
      return { modelCode, fallbackModelCodes: null, endpointCode: null };
    }

    const endpointCode = request.endpointCode?.trim();
    if (endpointCode) {
      const resolved = await this.registry.resolveEndpoint(endpointCode);
      return {
        modelCode: resolved.modelCode,
        fallbackModelCodes: resolved.fallbackModelCodes,
        endpointCode,
      };
    }

    const applicationScope = resolveApplicationScope(request);
    const fromProfile = await this.registry.resolveModelCodeForTaskProfile({
      tenantId: request.tenantId,
      taskProfile: request.taskProfile!.trim(),
      applicationId: applicationScope.applicationId,
      applicationType: applicationScope.applicationType,
    });
    return {
      modelCode: fromProfile,
      fallbackModelCodes: null,
      endpointCode: null,
    };
  }

  /**
   * `routeFallbacks` is the chain the ROUTE dictated (endpoint routing), or
   * null when the route had no opinion. Only then does the model's own
   * `config.fallbackModelCodes` apply - so a request routed through an
   * endpoint fails over exactly where the endpoint says, and nowhere else.
   */
  private async resolveCandidateModels(
    modelCode: string,
    routeFallbacks: string[] | null = null,
    thinking?: ThinkingMode,
  ): Promise<AiModelRecord[]> {
    const primary = await this.registry.getActiveModel(modelCode);
    // ADR-009 decision 3: the primary must honour the requested mode or the
    // request is refused - serving it anyway would bill the caller for the
    // behaviour it asked to avoid, and say nothing.
    if (thinking !== undefined && !honoursThinking(primary, thinking)) {
      throw new ModelRuntimeException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "THINKING_MODE_UNSUPPORTED",
        `model ${primary.modelCode} cannot run with thinking "${thinking}"`,
        { modelCode: primary.modelCode, provider: primary.provider },
      );
    }
    const fallbackCodes = (
      routeFallbacks ??
      readStringArrayConfig(primary.config, "fallbackModelCodes")
    ).filter((candidateCode) => candidateCode !== primary.modelCode);

    const fallbacks: AiModelRecord[] = [];
    for (const fallbackCode of fallbackCodes) {
      try {
        const fallback = await this.registry.getActiveModel(fallbackCode);
        // Skipped, not refused: the primary can serve this mode, and a
        // fallback that cannot is as unusable for this call as a missing one.
        if (thinking !== undefined && !honoursThinking(fallback, thinking)) continue;
        fallbacks.push(fallback);
      } catch {
        // fallback 配置错误不能阻断主模型调用；主模型失败后只尝试可用 fallback。
      }
    }

    return [primary, ...fallbacks];
  }

  private toProviderUnavailableError(
    error: unknown,
    model: AiModelRecord,
    requestId: string,
  ): ModelRuntimeException {
    if (error instanceof ModelRuntimeException) {
      return this.enrichRuntimeError(error, requestId, {
        modelCode: model.modelCode,
        provider: model.provider,
      });
    }

    // Walkthrough 2026-09-30: this was PROVIDER_UNAVAILABLE (retryable, breaker
    // counted) - liveness pings with a tiny maxTokens on a thinking model could
    // have tripped it for every product.
    if (error instanceof UpstreamCallFailure && error.outputBudgetExhausted) {
      return new ModelRuntimeException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "OUTPUT_BUDGET_EXHAUSTED",
        error.message,
        { requestId, modelCode: model.modelCode, provider: model.provider },
      );
    }

    if (
      error instanceof ProviderHttpError &&
      UPSTREAM_REJECTS_REQUEST.has(error.status)
    ) {
      // The vendor's own wording is the diagnosis ("context length exceeded",
      // "request too large") and only exists in its body, so a bounded slice
      // goes into `message`. The code stays Atlas's: vendor codes differ per
      // provider, and a caller must not branch on which one served the call.
      const detail = (error.responseBody ?? "").replace(/\s+/gu, " ").trim();
      // ADR-008: the narrower code when the vendor's refusal is recognisably a
      // context overflow; same status, same handling, only the code differs.
      // TD-055: the built-in signatures plus any this provider/model declares.
      const overflow = isContextOverflow(error.status, error.responseBody, [
        ...CONTEXT_OVERFLOW_SIGNATURES,
        ...signaturesFromConfig(
          resolveWireFor({
            protocol: model.protocol,
            providerConfig: model.providerConfig,
            config: model.config,
          }).contextOverflow,
        ),
      ]);
      return new ModelRuntimeException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        overflow ? "CONTEXT_LENGTH_EXCEEDED" : "UPSTREAM_REJECTED_REQUEST",
        `${model.provider} rejected the request with status ${error.status}` +
          (detail ? `: ${detail.slice(0, UPSTREAM_DETAIL_MAX_CHARS)}` : ""),
        { requestId, modelCode: model.modelCode, provider: model.provider },
      );
    }

    const message =
      error instanceof ProviderHttpError
        ? `${model.provider} provider returned status ${error.status}`
        : error instanceof Error
          ? error.message
          : "Provider request failed";

    return new ModelRuntimeException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "PROVIDER_UNAVAILABLE",
      message,
      { requestId, modelCode: model.modelCode, provider: model.provider },
    );
  }

  private enrichRuntimeError(
    error: unknown,
    requestId: string,
    metadata: {
      modelCode?: string;
      provider?: string;
    } = {},
  ): ModelRuntimeException {
    if (!(error instanceof ModelRuntimeException)) {
      const message =
        error instanceof Error ? error.message : "Provider request failed";
      return new ModelRuntimeException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "PROVIDER_UNAVAILABLE",
        message,
        { requestId, ...metadata },
      );
    }

    const response = error.getResponse();
    const payload =
      typeof response === "object" && response !== null
        ? (response as ModelRuntimeErrorResponse)
        : undefined;

    if (payload?.requestId) {
      return error;
    }

    return new ModelRuntimeException(
      error.getStatus(),
      error.code,
      error.message,
      {
        requestId,
        ...((payload?.modelCode ?? metadata.modelCode) !== undefined
          ? { modelCode: payload?.modelCode ?? metadata.modelCode }
          : {}),
        ...((payload?.provider ?? metadata.provider) !== undefined
          ? { provider: payload?.provider ?? metadata.provider }
          : {}),
        // Dropping this silenced the Retry-After header on every RATE_LIMITED:
        // the quota gate throws without a requestId, so it always comes here.
        ...(payload?.retryAfterMs !== undefined
          ? { retryAfterMs: payload.retryAfterMs }
          : {}),
      },
    );
  }

  /**
   * A request that was accepted and then failed is still a served
   * request - it consumed a slot, may have burned upstream quota, and is
   * exactly what an operator wants to see. Recorded with `status: "error"` and
   * no token counts (none were billed), plus a row in `reqlog.error_records`
   * carrying the provider/protocol detail.
   */
  /**
   * TD-037. One reqlog row for one attempt that failed.
   *
   * The chat surface used to write a single row per logical request, so a
   * candidate that failed on the way to a success was invisible to reqlog
   * entirely - it existed in logs and in a Prometheus counter, and nowhere
   * durable. That is why chat error rates could not be derived from reqlog the
   * way the S2S surface's already could, and why nothing counted across the two
   * was comparable.
   *
   * Every attempt recording itself is also why the terminal failure path is now
   * guarded: with these rows in place, a row written after the loop would be an
   * N+1th record of a failure already counted N times, and the double count
   * would land in exactly the rollups this change exists to make comparable.
   *
   * Extracted rather than repeated in both loops. The first version of this
   * change pasted the same fourteen lines into the streaming and non-streaming
   * paths, and SonarCloud's duplication gate is what said so - a fair call: two
   * copies of a rule about not double-counting is two places for it to drift.
   */
  /**
   * TD-049. The request body handed to an upstream adapter, defined once.
   *
   * `chat()` and `chatStream()` built this object independently and identically
   * apart from `signal`. That is not a tidiness problem: adding a pass-through
   * parameter meant editing two places, and forgetting the second one produces
   * a parameter that works on non-streaming calls and is silently dropped on
   * streaming ones. Nothing type-checks that away and no test would have caught
   * it - the request simply goes upstream without the field, and the answer
   * still looks like an answer.
   *
   * `signal` is the one real difference: a non-streaming call has nothing to
   * abort partway.
   */
  /**
   * TD-049. Everything both chat surfaces do before their first candidate.
   *
   * `chat()` and `chatStream()` carried byte-identical copies of this, differing
   * only in the name of the event they log. That is the shape TD-049 is about:
   * a fix applied to one loop and not the other looks fixed from every angle
   * except the failing path, and the streaming half is the one that gets
   * forgotten because it is the one with fewer tests.
   *
   * The ordering here is load-bearing and unchanged: the in-flight gauge is
   * incremented AFTER routing, because `resolveRoute` throws in the blind spot
   * this counter exists to light up, and the caller owns the matching decrement
   * in its `finally`.
   */
  private async beginChatRequest(
    request: ChatRequest,
    auth: S2sAuthContext | undefined,
    startEvent: string,
    streamed: boolean,
  ): Promise<ChatAttemptContext> {
    // Routing joins validation inside the wrapper, not because it is
    // validation but because it fails in the same blind spot: `resolveRoute`
    // throws ENDPOINT_NOT_ROUTABLE / TASK_PROFILE_NOT_ROUTABLE before the
    // in-flight gauge and before the first log line, so those refusals were
    // as invisible as the ones this counter was added for. They are also the
    // ones an operator is most likely to be asked about - they are what a
    // caller sees the moment an endpoint is deactivated.
    const routed = await countingRejections(auth, request.requestId, async () => {
      this.validateChatRequest(request);
      return this.resolveRoute(request);
    });
    const modelCode = routed.modelCode;

    const requestId = request.requestId?.trim() || randomUUID();
    const applicationScope = resolveApplicationScope(request);
    this.incrementInflightRequest();
    this.logRuntimeEvent(startEvent, {
      request,
      requestId,
      applicationScope,
      modelCode,
      status: "started",
      fallbackAttempt: 0,
    });

    // TD-049. Returns the context itself rather than its parts. A caller
    // that reassembles them is a caller that can assemble them differently.
    return {
      request,
      requestId,
      applicationScope,
      auth,
      routed,
      modelCode,
      streamed,
      ...(request.timeoutMs !== undefined
        ? { deadline: AbortSignal.timeout(request.timeoutMs) }
        : {}),
    };
  }

  /**
   * TD-049. The candidate chain, or a logged and enriched refusal.
   *
   * Same duplication as `beginChatRequest`, same reason for collapsing it: the
   * two copies differed only by an event name.
   */
  private async resolveCandidatesOrFail(
    ctx: ChatAttemptContext,
    failedEvent: string,
  ): Promise<AiModelRecord[]> {
    try {
      return await this.resolveCandidateModels(
        ctx.modelCode,
        ctx.routed.fallbackModelCodes,
        ctx.request.thinking,
      );
    } catch (error) {
      this.logRuntimeEvent(failedEvent, {
        request: ctx.request,
        requestId: ctx.requestId,
        applicationScope: ctx.applicationScope,
        modelCode: ctx.modelCode,
        status: "provider_error",
        errorCode: readRuntimeErrorCode(error),
        fallbackAttempt: 0,
      });
      throw this.enrichRuntimeError(error, ctx.requestId, {
        modelCode: ctx.modelCode,
      });
    }
  }

  /**
   * TD-049. Skip a candidate whose breaker is open - unless it is the last one.
   *
   * A skip on the final candidate turns a request that could still have been
   * served into one that certainly is not, so the last candidate is always
   * really attempted. Both surfaces had this rule written out; the streaming
   * copy carried the comment "same as chat(), see there", which is a duplicate
   * announcing itself.
   */
  private skipTripped(
    ctx: ChatAttemptContext,
    model: AiModelRecord,
    fallbackAttempt: number,
    candidateCount: number,
  ): boolean {
    if (
      fallbackAttempt >= candidateCount - 1 ||
      !this.circuitBreaker.isTripped(model.modelCode)
    ) {
      return false;
    }
    this.logRuntimeEvent("model_runtime_circuit_open", {
      request: ctx.request,
      requestId: ctx.requestId,
      applicationScope: ctx.applicationScope,
      modelCode: model.modelCode,
      providerCode: model.provider,
      status: "circuit_open",
      fallbackAttempt,
    });
    return true;
  }

  /**
   * TD-049. The quota gate, and the row a refusal leaves behind.
   *
   * A gate refusal is the caller's answer, but it is still a served request:
   * it has to be visible in reqlog, or "quota exhausted" shows up as flat
   * traffic with no errors - the invisible failure reqlog exists to prevent.
   * Throws the enriched error; the caller does not continue the chain, because
   * a quota refusal applies to the request, not to the candidate.
   */
  private async assertQuotaOrRecordRefusal(
    ctx: ChatAttemptContext,
    model: AiModelRecord,
    fallbackAttempt: number,
    failedEvent: string,
  ): Promise<void> {
    try {
      await this.quota.assertAllowed(model, ctx.request, ctx.auth);
    } catch (error) {
      this.logRuntimeEvent(failedEvent, {
        request: ctx.request,
        requestId: ctx.requestId,
        applicationScope: ctx.applicationScope,
        modelCode: model.modelCode,
        providerCode: model.provider,
        status: runtimeStatusFromError(error),
        errorCode: readRuntimeErrorCode(error),
        fallbackAttempt,
      });
      await this.recordAttemptFailure(ctx, model, fallbackAttempt, { error });
      throw this.enrichRuntimeError(error, ctx.requestId, {
        modelCode: model.modelCode,
        provider: model.provider,
      });
    }
  }

  /**
   * TD-049. One attempt, one log line, one shape.
   *
   * Six sites wrote this object out by hand. A dimension added to five of them
   * produces logs that answer an operator's question on one path and not the
   * other, and nothing fails.
   */
  /**
   * TD-049. One candidate failed: normalise, trip the breaker, log, record.
   *
   * Both loops did these four things in this order, and the order matters -
   * the row is written with the normalised error so `error_records.error_code`
   * carries the runtime vocabulary rather than whatever the adapter threw.
   * Returns the normalised error so the caller can keep it as the chain's last,
   * which is what the exhaustion path reports.
   */
  private async failCandidate(
    ctx: ChatAttemptContext,
    model: AiModelRecord,
    fallbackAttempt: number,
    error: unknown,
    startedAt: number,
    event: string,
  ): Promise<ModelRuntimeException> {
    const normalised = ctx.deadline?.aborted
      ? new ModelRuntimeException(
          HttpStatus.GATEWAY_TIMEOUT,
          "DEADLINE_EXCEEDED",
          `the caller's ${ctx.request.timeoutMs}ms budget ran out before ${model.provider} finished; the upstream call was cancelled`,
          { requestId: ctx.requestId, modelCode: model.modelCode, provider: model.provider },
        )
      : this.toProviderUnavailableError(error, model, ctx.requestId);
    // A request the upstream refused for its CONTENT says nothing about the
    // model's health. Counting it would let one caller retrying an oversized
    // request trip the breaker and take the model offline for everyone.
    // The candidate loop still moves on to the next model: a fallback with a
    // larger context window may accept what this one refused.
    if (!NOT_A_HEALTH_SIGNAL.has(normalised.code)) {
      this.circuitBreaker.recordFailure(model.modelCode);
    }
    const latencyMs = Date.now() - startedAt;
    this.logAttempt(ctx, model, fallbackAttempt, event, "provider_error", {
      latencyMs,
      errorCode: normalised.code,
    });
    await this.recordAttemptFailure(ctx, model, fallbackAttempt, {
      error: normalised,
      latencyMs,
      startedAt,
      ...(upstreamFromError(error) !== undefined
        ? { upstream: upstreamFromError(error) }
        : {}),
      // Read off the ORIGINAL error, not the normalised one: normalising
      // produces a ModelRuntimeException carrying the runtime vocabulary, and
      // the usage the upstream reported does not survive that translation.
      // Absent for every failure that reported nothing, which is most of them.
      ...(usageFromError(error) !== undefined
        ? { usage: usageFromError(error) }
        : {}),
    });
    return normalised;
  }

  /**
   * TD-049. The chain ran out of candidates.
   *
   * No reqlog row here - every attempt wrote its own. This is the one line that
   * says the REQUEST failed rather than a candidate, and `fallbackAttempt` is
   * the count of candidates rather than an index, which is deliberate: there is
   * no attempt number left to name.
   */
  private logChainExhausted(
    ctx: ChatAttemptContext,
    event: string,
    candidateCount: number,
    lastError: ModelRuntimeException | undefined,
  ): void {
    this.logRuntimeEvent(event, {
      request: ctx.request,
      requestId: ctx.requestId,
      applicationScope: ctx.applicationScope,
      modelCode: ctx.modelCode,
      status: "provider_error",
      errorCode: lastError?.code ?? "PROVIDER_UNAVAILABLE",
      fallbackAttempt: candidateCount,
    });
  }

  private logAttempt(
    ctx: ChatAttemptContext,
    model: AiModelRecord,
    fallbackAttempt: number,
    event: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.logRuntimeEvent(event, {
      request: ctx.request,
      requestId: ctx.requestId,
      applicationScope: ctx.applicationScope,
      modelCode: model.modelCode,
      providerCode: model.provider,
      status,
      fallbackAttempt,
      ...extra,
    });
  }

  private buildUpstreamRequest(
    model: AiModelRecord,
    request: ChatRequest,
    apiKey: string,
    signal?: AbortSignal,
  ): ProviderChatRequest {
    return {
      endpointUrl: model.endpointUrl,
      apiKey,
      modelCode: model.modelCode,
      messages: request.messages,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
      ...(request.topP !== undefined ? { topP: request.topP } : {}),
      ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
      ...(request.tools !== undefined ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined
        ? { toolChoice: request.toolChoice }
        : {}),
      ...(model.config != null ? { config: model.config } : {}),
      ...(model.providerConfig != null
        ? { providerConfig: model.providerConfig }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  private async recordAttemptFailure(
    ctx: ChatAttemptContext,
    model: AiModelRecord,
    attemptIndex: number,
    outcome: {
      error: unknown;
      /** Absent when the attempt never reached the provider - a gate refusal. */
      latencyMs?: number | undefined;
      /**
       * TD-037. What the upstream reported before failing, when it reported
       * anything. Absent stays NULL in the columns: a failure that measured
       * nothing and a failure that cost nothing are different facts.
       */
      usage?: UpstreamUsageSnapshot | undefined;
      /** Usage-record batch 1: what the upstream said, when it answered at all. */
      upstream?: UpstreamCallRecord | undefined;
      /** Usage-record batch 2: epoch ms the attempt began; absent on a gate refusal. */
      startedAt?: number | undefined;
    },
  ): Promise<void> {
    await this.recordFailure(
      ctx.request,
      ctx.requestId,
      model.modelCode,
      model.provider,
      outcome.error,
      outcome.latencyMs,
      ctx.auth,
      ctx.routed.endpointCode,
      attemptIndex,
      outcome.usage,
      outcome.upstream,
      {
        ...requestFacts(ctx.request, ctx.streamed),
        ...(outcome.startedAt !== undefined
          ? { startedAt: new Date(outcome.startedAt) }
          : {}),
        ...keyAliasColumn(model),
      },
    );
  }

  private async recordFailure(
    request: ChatRequest,
    requestId: string,
    modelCode: string | undefined,
    providerCode: string | undefined,
    error: unknown,
    latencyMs: number | undefined,
    auth?: S2sAuthContext,
    routedEndpointCode?: string | null,
    attemptIndex?: number,
    usage?: UpstreamUsageSnapshot,
    upstream?: UpstreamCallRecord,
    facts: Partial<RequestLogEntry> = {},
  ): Promise<void> {
    const applicationScope = resolveApplicationScope(request);
    const errorCode = readRuntimeErrorCode(error);

    await this.requestLog.record({
      requestId,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      // `reqlog.request_records.status` is CHECK-constrained to
      // success|error|timeout. Nothing in this service distinguishes a timeout
      // from any other provider failure today, so everything non-success is
      // "error"; the finer reason (NOT_ENTITLED / QUOTA_EXCEEDED /
      // PROVIDER_UNAVAILABLE / ...) is carried by error_records.error_code
      // rather than being flattened into a status the column cannot hold.
      status: "error",
      ...callerDimensions(request, applicationScope, auth),
      ...(modelCode !== undefined ? { modelCode } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(routedEndpointCode ? { endpointCode: routedEndpointCode } : {}),
      ...(auth?.callerProductCode !== undefined
        ? { productCode: auth.callerProductCode }
        : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      // TD-037. What a failed attempt cost, when the upstream said. Absent for
      // a timeout or a refused connection, which report nothing - and absent is
      // NULL, never 0, because "we did not measure it" and "it was free" are
      // the two answers this table exists to keep apart. No consume is emitted
      // for these: nothing was billed, so `billed_amount` stays NULL and the
      // row is the reconciliation signal rather than a charge.
      ...usageColumns(usage),
      // Usage-record batch 1. `latencyMs` is present exactly when the attempt
      // reached a provider (a gate refusal passes none), so it decides whether
      // "did the upstream report usage" is a question this row can answer.
      ...(latencyMs !== undefined
        ? { usageSource: usage !== undefined ? "reported" : "absent" }
        : {}),
      ...upstreamColumns(upstream, undefined),
      // Usage-record batch 2.
      ...facts,
      ...cancelledByColumn(errorCode),
      // TD-037. Which candidate this row is. Deliberately NOT expressed by
      // setting usage_type to 'retry', which TD-037's own recovery note
      // suggested: that word is already the CALLER's - `ChatRequest.usageType`
      // lets a product say "this is my second call for this task". Atlas's
      // second CANDIDATE for one call is a different fact, and X-4 does not
      // allow one word to carry both. The ordinal says it without ambiguity.
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      // TD-024: the CHECK vocabulary is normal|retry|test; NULL would exclude
      // real traffic from any usage_type filter, so requests default to normal.
      usageType: request.usageType ?? "normal",
      ...(request.businessId !== undefined
        ? { businessId: request.businessId }
        : {}),
    });

    await this.requestLog.recordError({
      requestId,
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(modelCode !== undefined ? { modelCode } : {}),
      ...(routedEndpointCode ? { endpointCode: routedEndpointCode } : {}),
      ...(errorCode ? { errorCode } : {}),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * `usage` is undefined when the stream completed without a usage frame, and
   * carries `usageReported: false` when a non-stream upstream sent no usage
   * object. Both record NULL token columns - "unreported" must never be
   * written as 0, or unmetered traffic becomes indistinguishable from free
   * traffic - and neither calls consume (there is no realized amount).
   */
  private async recordUsage(
    model: AiModelRecord,
    request: ChatRequest,
    requestId: string,
    usage: (TokenUsage & { usageReported?: boolean }) | undefined,
    latencyMs: number,
    auth?: S2sAuthContext,
    routedEndpointCode?: string | null,
    attemptIndex?: number,
    outcome: {
      upstream?: UpstreamCallRecord | undefined;
      finishReason?: FinishReason | undefined;
      /** Usage-record batch 2: timing, selector, key alias, request knobs. */
      facts?: Partial<RequestLogEntry> | undefined;
    } = {},
  ): Promise<void> {
    const applicationScope = resolveApplicationScope(request);
    const reported = usage !== undefined && usage.usageReported !== false;

    // C3 consume is the platform's sole write path into the metering kernel.
    // Called after the fact because the amount is the realized token count;
    // gating already happened on the C2 read. `billed` false => served but
    // not billed, which is the reconciliation signal (billed_amount IS NULL)
    // described in docs/30-design/210-usage-metering-and-history.md.
    const consumed =
      auth?.workspaceId && reported && usage.totalTokens > 0
        ? await this.entitlements.consume({
            workspaceId: auth.workspaceId,
            metric: CHAT_METRIC,
            amount: usage.totalTokens,
            idempotencyKey: requestId,
          })
        : { billed: false };

    // TD-046's exposure, counted where both halves are finally in scope: the
    // request (did it carry `tools`, is it multi-round) and the usage (did the
    // model reason). Neither alone is the shape; the pair is.
    //
    // Metrics only - see `reasoning-tool-exposure.ts` for why this is not a
    // column, and for the sentence in #23 it exists to stop being unfalsifiable.
    const exposure = classifyReasoningToolCall({
      toolsPresent: (request.tools?.length ?? 0) > 0,
      reasoningTokens: reasoningTokensOf(usage),
      messages: request.messages,
      productCode: auth?.callerProductCode,
    });
    if (exposure) {
      metricsRegistry.incCounter(REASONING_TOOL_EXPOSURE_METRIC, {
        product: exposure.product,
        multi_round: exposure.multiRound,
      });
    }

    // Atlas's own per-request history.
    await this.requestLog.record({
      requestId,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      status: "success",
      ...callerDimensions(request, applicationScope, auth),
      modelCode: model.modelCode,
      providerCode: model.provider,
      ...(routedEndpointCode ? { endpointCode: routedEndpointCode } : {}),
      ...(auth?.callerProductCode !== undefined
        ? { productCode: auth.callerProductCode }
        : {}),
      ...(reported
        ? {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            // TD-047. Spread conditionally for the same reason the block above
            // is: an upstream that reports no split must leave the column NULL,
            // not 0.
            ...(usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
            ...(usage.reasoningTokens !== undefined
              ? { reasoningTokens: usage.reasoningTokens }
              : {}),
            ...(usage.cacheWriteInputTokens !== undefined
              ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
              : {}),
            ...(usage.cacheWrite1hInputTokens !== undefined
              ? { cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens }
              : {}),
          }
        : {}),
      // Usage-record batch 1. This row reached an upstream, so whether it
      // reported usage is a fact worth writing: NULL counts on an 'absent'
      // row mean "unknown", which a reader must not total as free.
      usageSource: reported ? "reported" : "absent",
      ...upstreamColumns(outcome.upstream, outcome.finishReason),
      ...(outcome.facts ?? {}),
      latencyMs,
      // TD-037. The candidate that actually served this request - which is not
      // always the one the caller named, and until now was not recorded
      // anywhere durable.
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      // TD-024: default to normal so usage_type filters see real traffic.
      usageType: request.usageType ?? "normal",
      ...(request.businessId !== undefined
        ? { businessId: request.businessId }
        : {}),
      ...(consumed.billed && reported
        ? {
            billedMetricKey: CHAT_METRIC,
            billedAmount: usage.totalTokens,
            // Same derivation as the S2S capabilities - see reqlog/cost-unit.
            ...(costUnitForMetric(CHAT_METRIC) !== undefined
              ? { costUnit: costUnitForMetric(CHAT_METRIC) }
              : {}),
          }
        : {}),
      ...("usageEventId" in consumed && consumed.usageEventId !== undefined
        ? { usageEventId: consumed.usageEventId }
        : {}),
    });
  }
}

function readStringArrayConfig(
  config: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = config?.[key];
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Typed as the VOCABULARY, not as `string`. It used to return `string | null`,
 * which made `code === "GRANT_DENIED"` below survive the code being retired -
 * legal TypeScript, zero warnings, and every entitlement refusal silently
 * reclassified as `provider_error` in reqlog and in
 * `model_requests_total{status=...}`. Production would have read as an upstream
 * outage while actually rejecting on permissions.
 */
function readRuntimeErrorCode(error: unknown): ModelRuntimeErrorCode | null {
  if (error instanceof ModelRuntimeException) {
    return error.code;
  }

  return null;
}

function runtimeStatusFromError(error: unknown): string {
  const code = readRuntimeErrorCode(error);
  // The STATUS stays "denied" while the CODE becomes NOT_ENTITLED. They are
  // different vocabularies: `status` is the reqlog/metric label
  // (model_requests_total{status=...}), and renaming it in the same change
  // would break the one series that spans this deploy, for no gain.
  if (code === "NOT_ENTITLED") return "denied";
  if (code === "QUOTA_EXCEEDED") return "quota_exceeded";
  return "provider_error";
}

/**
 * Usage-record batch 1 (A3, C4, G2, H3): the vendor's facts for the reqlog row.
 * `finish_reason` is the normalized word; a vendor value the mapping does not
 * know becomes 'other' - its own word survives in `native_finish_reason`, so
 * nothing is lost and the CHECK vocabulary stays closed.
 */
function upstreamColumns(
  upstream: UpstreamCallRecord | undefined,
  finishReason: FinishReason | undefined,
): Partial<RequestLogEntry> {
  const normalized: RequestLogEntry["finishReason"] =
    finishReason ?? (upstream?.nativeFinishReason ? "other" : undefined);
  return {
    ...(upstream?.upstreamRequestId !== undefined
      ? { upstreamRequestId: upstream.upstreamRequestId }
      : {}),
    ...(upstream?.upstreamModel !== undefined
      ? { upstreamModel: upstream.upstreamModel }
      : {}),
    ...(upstream?.rawUsage !== undefined
      ? { upstreamUsage: upstream.rawUsage }
      : {}),
    ...(upstream?.nativeFinishReason !== undefined
      ? { nativeFinishReason: upstream.nativeFinishReason }
      : {}),
    ...(normalized !== undefined ? { finishReason: normalized } : {}),
  };
}

/** The done frame as the caller may see it: `upstream` is internal. */
function withoutUpstream(
  event: Extract<StreamEvent, { type: "done" }>,
): Extract<StreamEvent, { type: "done" }> {
  const { upstream: _internal, ...rest } = event;
  return rest;
}

/**
 * Usage-record batch 2 (C1, D1, D3, D4): what the caller asked for, from the
 * request itself. The selector follows `resolveRoute`'s precedence - modelCode,
 * then endpointCode, then taskProfile - so it names the one that was used.
 */
function requestFacts(
  request: ChatRequest,
  streamed: boolean,
): Partial<RequestLogEntry> {
  const selector: Pick<RequestLogEntry, "selectorKind" | "selectorValue"> =
    request.modelCode
      ? { selectorKind: "model", selectorValue: request.modelCode }
      : request.endpointCode
        ? { selectorKind: "endpoint", selectorValue: request.endpointCode }
        : request.taskProfile
          ? { selectorKind: "task_profile", selectorValue: request.taskProfile }
          : {};
  return {
    ...selector,
    ...(request.thinking !== undefined ? { thinkingMode: request.thinking } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    streamed,
  };
}

function keyAliasColumn(model: AiModelRecord): Partial<RequestLogEntry> {
  const alias = managedKeyAliasOf(model);
  return alias !== undefined ? { providerKeyAlias: alias } : {};
}

/** Usage-record batch 2 (H4): a call cut short says who cut it. */
function cancelledByColumn(
  errorCode: string | null | undefined,
): Partial<RequestLogEntry> {
  if (errorCode === "CLIENT_ABORTED") return { cancelledBy: "client" };
  if (errorCode === "DEADLINE_EXCEEDED") return { cancelledBy: "deadline" };
  return {};
}
