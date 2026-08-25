import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { costUnitForMetric } from "../reqlog/cost-unit";
import { isUuid } from "../uuid";
import { countingRejections } from "./pre-log-rejection";

/** The C3 metric the chat plane consumes against; also keys its cost unit. */
const CHAT_METRIC = "atlas.chat";
import { metricsRegistry } from "./metrics.registry";
import { randomUUID } from "node:crypto";

import { ProviderHttpError } from "../providers/base.provider";
import { RequestLogService } from "../reqlog/request-log.service";
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
import { resolveApiKey } from "./resolve-api-key";
import { ProviderKeyService } from "../provider-keys/provider-key.service";
import type {
  AiModelRecord,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  TokenUsage,
} from "../types/runtime.types";

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
    this.logRuntimeEvent("model_runtime_request_start", {
      request,
      requestId,
      applicationScope,
      modelCode,
      status: "started",
      fallbackAttempt: 0,
    });

    try {
      let models: AiModelRecord[];
      try {
        models = await this.resolveCandidateModels(
          modelCode,
          routed.fallbackModelCodes,
        );
      } catch (error) {
        this.logRuntimeEvent("model_runtime_request_failed", {
          request,
          requestId,
          applicationScope,
          modelCode,
          status: "provider_error",
          errorCode: readRuntimeErrorCode(error),
          fallbackAttempt: 0,
        });
        throw this.enrichRuntimeError(error, requestId, {
          modelCode,
        });
      }
      let lastProviderError: ModelRuntimeException | undefined;

      for (const [fallbackAttempt, model] of models.entries()) {
        // 熔断跳过：已知在挂就别再付一次超时代价，直接试下一个 candidate -
        // 除非这已经是最后一个，那种情况下"跳过"只会把一个本可重试的请求
        // 变成必然失败，所以最后一个 candidate 无论如何都要真的试一次。
        if (
          fallbackAttempt < models.length - 1 &&
          this.circuitBreaker.isTripped(model.modelCode)
        ) {
          this.logRuntimeEvent("model_runtime_circuit_open", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "circuit_open",
            fallbackAttempt,
          });
          continue;
        }

        try {
          await this.quota.assertAllowed(model, request, auth);
        } catch (error) {
          this.logRuntimeEvent("model_runtime_request_failed", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: runtimeStatusFromError(error),
            errorCode: readRuntimeErrorCode(error),
            fallbackAttempt,
          });
          await this.recordFailure(
            request,
            requestId,
            model.modelCode,
            model.provider,
            error,
            undefined,
            auth,
            routed.endpointCode,
          );
          throw this.enrichRuntimeError(error, requestId, {
            modelCode: model.modelCode,
            provider: model.provider,
          });
        }

        const startedAt = Date.now();

        try {
          const provider = this.router.resolve(model);
          const apiKey = await resolveApiKey({ resolveManagedKey: this.resolveManagedKey }, model, requestId);
          this.logRuntimeEvent("model_runtime_provider_start", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "started",
            fallbackAttempt,
          });
          const providerResponse = await provider.chat({
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
            ...(request.tools !== undefined ? { tools: request.tools } : {}),
            ...(request.toolChoice !== undefined
              ? { toolChoice: request.toolChoice }
              : {}),
            ...(model.config != null ? { config: model.config } : {}),
            ...(model.providerConfig != null
              ? { providerConfig: model.providerConfig }
              : {}),
          });
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
          );

          this.logRuntimeEvent("model_runtime_request_success", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "success",
            latencyMs,
            fallbackAttempt,
            totalTokens: providerResponse.totalTokens,
          });

          return {
            id: requestId,
            modelCode: model.modelCode,
            message: {
              role: "assistant",
              content: providerResponse.content,
              ...(providerResponse.toolCalls !== undefined
                ? { toolCalls: providerResponse.toolCalls }
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
          lastProviderError = this.toProviderUnavailableError(
            error,
            model,
            requestId,
          );
          this.circuitBreaker.recordFailure(model.modelCode);
          this.logRuntimeEvent("model_runtime_provider_failed", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "provider_error",
            latencyMs: Date.now() - startedAt,
            errorCode: lastProviderError.code,
            fallbackAttempt,
          });
        } finally {
          // 无论这个 candidate 有没有配限流策略、有没有真的 acquire 过,
          // release 都是安全的空操作 - 见 ModelRateLimiterService.releaseConcurrency。
          this.rateLimiter.releaseConcurrency(
            rateLimitKey(model.id, request.tenantId),
          );
        }
      }

      this.logRuntimeEvent("model_runtime_request_failed", {
        request,
        requestId,
        applicationScope,
        modelCode,
        status: "provider_error",
        errorCode: lastProviderError?.code ?? "PROVIDER_UNAVAILABLE",
        fallbackAttempt: models.length,
      });

      await this.recordFailure(
        request,
        requestId,
        modelCode,
        models[models.length - 1]?.provider,
        lastProviderError,
        undefined,
        auth,
        routed.endpointCode,
      );

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
    this.logRuntimeEvent("model_runtime_stream_start", {
      request,
      requestId,
      applicationScope,
      modelCode,
      status: "started",
      fallbackAttempt: 0,
    });

    try {
      let candidateModels: AiModelRecord[];
      try {
        candidateModels = await this.resolveCandidateModels(
          modelCode,
          routed.fallbackModelCodes,
        );
      } catch (error) {
        this.logRuntimeEvent("model_runtime_stream_failed", {
          request,
          requestId,
          applicationScope,
          modelCode,
          status: "provider_error",
          errorCode: readRuntimeErrorCode(error),
          fallbackAttempt: 0,
        });
        throw this.enrichRuntimeError(error, requestId, {
          modelCode,
        });
      }

      const models = candidateModels.filter((model) => model.supportsStreaming);

      if (models.length === 0) {
        this.logRuntimeEvent("model_runtime_stream_failed", {
          request,
          requestId,
          applicationScope,
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
      let lastProviderError: ModelRuntimeException | undefined;

      for (const [fallbackAttempt, model] of models.entries()) {
        // The caller is gone - no candidate may be attempted on its behalf.
        // The abort-during-attempt case below records the in-flight row; here
        // nothing was in flight, so there is nothing to record.
        if (signal?.aborted) return;

        // 熔断跳过：语义同 chat()，见那边的注释。
        if (
          fallbackAttempt < models.length - 1 &&
          this.circuitBreaker.isTripped(model.modelCode)
        ) {
          this.logRuntimeEvent("model_runtime_circuit_open", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "circuit_open",
            fallbackAttempt,
          });
          continue;
        }

        try {
          await this.quota.assertAllowed(model, request, auth);
        } catch (error) {
          this.logRuntimeEvent("model_runtime_stream_failed", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: runtimeStatusFromError(error),
            errorCode: readRuntimeErrorCode(error),
            fallbackAttempt,
          });
          await this.recordFailure(
            request,
            requestId,
            model.modelCode,
            model.provider,
            error,
            undefined,
            auth,
            routed.endpointCode,
          );
          throw this.enrichRuntimeError(error, requestId, {
            modelCode: model.modelCode,
            provider: model.provider,
          });
        }

        const startedAt = Date.now();
        lastUsage = undefined;
        // Once any event reached the client, failing over would concatenate a
        // second answer into the same SSE stream - after first yield, the only
        // honest outcomes are completion or an explicit error frame.
        let yieldedThisAttempt = false;
        let upstreamErrorFrame = false;

        try {
          const provider = this.router.resolve(model);
          const apiKey = await resolveApiKey({ resolveManagedKey: this.resolveManagedKey }, model, requestId);
          this.logRuntimeEvent("model_runtime_provider_stream_start", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "started",
            fallbackAttempt,
          });
          for await (const event of provider.chatStream({
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
            ...(request.tools !== undefined ? { tools: request.tools } : {}),
            ...(request.toolChoice !== undefined
              ? { toolChoice: request.toolChoice }
              : {}),
            ...(model.config != null ? { config: model.config } : {}),
            ...(model.providerConfig != null
              ? { providerConfig: model.providerConfig }
              : {}),
            ...(signal !== undefined ? { signal } : {}),
          })) {
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
            yieldedThisAttempt = true;
            // The one place a stream can say WHO answered. The adapter cannot:
            // it knows the vendor's upstream name, not the registry code. After
            // a failover this is the candidate that actually served, which is
            // the fact worth reporting - not the one that was tried first.
            yield event.type === "done"
              ? { ...event, modelCode: model.modelCode }
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
            this.logRuntimeEvent("model_runtime_provider_stream_failed", {
              request,
              requestId,
              applicationScope,
              modelCode: model.modelCode,
              providerCode: model.provider,
              status: "provider_error",
              latencyMs,
              errorCode: streamError.code,
              fallbackAttempt,
            });
            await this.recordFailure(
              request,
              requestId,
              model.modelCode,
              model.provider,
              streamError,
              latencyMs,
              auth,
              routed.endpointCode,
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
          );
          this.logRuntimeEvent("model_runtime_stream_success", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "success",
            latencyMs,
            fallbackAttempt,
            ...(lastUsage !== undefined
              ? { totalTokens: lastUsage.totalTokens }
              : {}),
          });

          return;
        } catch (error) {
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
            this.logRuntimeEvent("model_runtime_stream_failed", {
              request,
              requestId,
              applicationScope,
              modelCode: model.modelCode,
              providerCode: model.provider,
              status: "client_aborted",
              latencyMs: Date.now() - startedAt,
              errorCode: abortError.code,
              fallbackAttempt,
            });
            await this.recordFailure(
              request,
              requestId,
              model.modelCode,
              model.provider,
              abortError,
              Date.now() - startedAt,
              auth,
              routed.endpointCode,
            );
            return;
          }
          lastProviderError = this.toProviderUnavailableError(
            error,
            model,
            requestId,
          );
          this.circuitBreaker.recordFailure(model.modelCode);
          this.logRuntimeEvent("model_runtime_provider_stream_failed", {
            request,
            requestId,
            applicationScope,
            modelCode: model.modelCode,
            providerCode: model.provider,
            status: "provider_error",
            latencyMs: Date.now() - startedAt,
            errorCode: lastProviderError.code,
            fallbackAttempt,
          });
          // Partial output already reached the client - do not let a fallback
          // stream a second answer into the same response.
          if (yieldedThisAttempt) break;
        } finally {
          this.rateLimiter.releaseConcurrency(
            rateLimitKey(model.id, request.tenantId),
          );
        }
      }

      this.logRuntimeEvent("model_runtime_stream_failed", {
        request,
        requestId,
        applicationScope,
        modelCode,
        status: "provider_error",
        errorCode: lastProviderError?.code ?? "PROVIDER_UNAVAILABLE",
        fallbackAttempt: models.length,
      });

      await this.recordFailure(
        request,
        requestId,
        modelCode,
        models[models.length - 1]?.provider,
        lastProviderError,
        undefined,
        auth,
        routed.endpointCode,
      );

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
  ): Promise<AiModelRecord[]> {
    const primary = await this.registry.getActiveModel(modelCode);
    const fallbackCodes = (
      routeFallbacks ??
      readStringArrayConfig(primary.config, "fallbackModelCodes")
    ).filter((candidateCode) => candidateCode !== primary.modelCode);

    const fallbacks: AiModelRecord[] = [];
    for (const fallbackCode of fallbackCodes) {
      try {
        fallbacks.push(await this.registry.getActiveModel(fallbackCode));
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
  private async recordFailure(
    request: ChatRequest,
    requestId: string,
    modelCode: string | undefined,
    providerCode: string | undefined,
    error: unknown,
    latencyMs: number | undefined,
    auth?: S2sAuthContext,
    routedEndpointCode?: string | null,
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
      ...(auth?.workspaceId !== undefined
        ? { workspaceId: auth.workspaceId }
        : {}),
      ...(auth?.userId !== undefined ? { userId: auth.userId } : {}),
      tenantId: auth?.tenantId ?? request.tenantId,
      applicationId: applicationScope.applicationId,
      applicationType: applicationScope.applicationType,
      agentId: applicationScope.agentId,
      ...(request.featureId !== undefined
        ? { featureId: request.featureId }
        : {}),
      ...(modelCode !== undefined ? { modelCode } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(routedEndpointCode ? { endpointCode: routedEndpointCode } : {}),
      ...(auth?.callerProductCode !== undefined
        ? { productCode: auth.callerProductCode }
        : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
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

    // Atlas's own per-request history.
    await this.requestLog.record({
      requestId,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      status: "success",
      ...(auth?.workspaceId !== undefined
        ? { workspaceId: auth.workspaceId }
        : {}),
      ...(auth?.userId !== undefined ? { userId: auth.userId } : {}),
      tenantId: auth?.tenantId ?? request.tenantId,
      applicationId: applicationScope.applicationId,
      applicationType: applicationScope.applicationType,
      agentId: applicationScope.agentId,
      ...(request.featureId !== undefined
        ? { featureId: request.featureId }
        : {}),
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
          }
        : {}),
      latencyMs,
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
