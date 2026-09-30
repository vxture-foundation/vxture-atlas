/**
 * s2s-provider.shared.ts - shared plumbing for the A1/A2/A3 S2S provider surface
 * (embed/parse/rerank, docs/30-design/200-s2s-provider-surface.md).
 * @package @atlas/service
 * @layer Domain
 * @category Runtime
 *
 * @description
 *   Model resolution + grant/quota gating + api key lookup are real (reused
 *   from the chat path). A capability the routed provider does not implement
 *   (embed/rerank outside zhipu, parse on a model without
 *   `config.supportsVision`) throws BaseProvider's
 *   ProviderCapabilityNotImplementedError, which this file maps to a
 *   501 MODEL_NOT_IMPLEMENTED response rather than a fabricated integration.
 *   Which provider/model backs each capability is a product/cost decision.
 */
import { HttpStatus } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { costUnitForMetric } from "../reqlog/cost-unit";

import { ProviderCapabilityNotImplementedError } from "../providers/base.provider";
import { ModelRegistryService } from "../registry/model-registry.service";
import { ModelRouterService } from "../router/model-router.service";
import {
  QuotaService,
  resolveApplicationScope,
  type QuotaCheckRequest,
} from "../quota/quota.service";
import {
  ModelRateLimiterService,
  rateLimitKey,
} from "../quota/model-rate-limiter.service";
import { ProviderKeyService } from "../provider-keys/provider-key.service";
import { resolveApiKey } from "./resolve-api-key";
import { ModelRuntimeException } from "./runtime.errors";
import { RequestLogService } from "../reqlog/request-log.service";
import {
  PlatformEntitlementClient,
  type ConsumeOutcome,
} from "../platform/platform-entitlement.client";
import type { S2sAuthContext } from "./guards/s2s-auth.guard";
import type {
  AiModelRecord,
  IModelProvider,
  TokenUsage,
  UpstreamCallRecord,
} from "../types/runtime.types";

export interface S2sProviderRequestBase extends QuotaCheckRequest {
  /** Exactly one of modelCode / endpointCode / taskProfile must resolve to a model. */
  modelCode?: string;
  /**
   * Endpoint routing - see `ChatRequest.endpointCode`. Same resolver AND the
   * same failover semantics as the chat path: an endpoint's
   * `fallbackModelCode` is honoured here too (see `runWithS2sFailover`), so a
   * fallback configured on `embedding/default` is never a setting that
   * quietly does nothing.
   *
   * An endpoint may point at any model regardless of the model's declared
   * type - pointing an embedding entry point at a chat model is allowed and
   * is not rejected at write time. Whether that upstream actually implements
   * the capability is answered at call time by a 501, not by a registry
   * constraint guessing intent.
   */
  endpointCode?: string;
  /** Task-profile routing (docs/70-workplan) - see `ChatRequest.taskProfile`. */
  taskProfile?: string;
  requestId?: string;
  /** product_251 X-2 - see `ChatRequest.taskId`. */
  taskId?: string;
}

export interface GatedModel {
  model: AiModelRecord;
  provider: IModelProvider;
  apiKey: string;
  requestId: string;
  /**
   * The endpoint that ACTUALLY routed this call, or null when the caller named
   * a model/taskProfile directly. Carried on the gate result so `withRequestLog`
   * records the same routing decision the failover loop made, instead of
   * re-reading the request and crediting an endpoint that lost precedence.
   */
  routedEndpointCode: string | null;
}

/** What a capability call reports for metering, out of band of its response. */
export interface MeterReading {
  /** Realized billable amount (tokens for embed, candidates for rerank). */
  amount?: number;
  /** Upstream-reported token usage, recorded in reqlog when present. */
  usage?: Partial<TokenUsage>;
  /** Usage-record batch 1: the vendor's id, model and raw usage. */
  upstream?: UpstreamCallRecord;
}

/**
 * Wraps the capability call so every outcome lands in `reqlog`.
 *
 * C3 consume (Atlas's sole-metering-entry-point obligation): when the caller
 * passes `metering` AND its closure reports a positive `amount` via the
 * `meter` callback, a successful call is consumed against the platform for
 * the token-derived workspace, mirroring the chat path - after the fact,
 * fail-open, `billed*` columns set only when the consume landed. Usage stays
 * NULL rather than invented when the provider reports none.
 */
export async function withRequestLog<T>(
  requestLog: RequestLogService,
  context: {
    gated: GatedModel;
    request: S2sProviderRequestBase;
    auth?: S2sAuthContext | undefined;
    metering?: { entitlements: PlatformEntitlementClient; metric: string };
  },
  call: (meter: (reading: MeterReading) => void) => Promise<T>,
): Promise<T> {
  const { gated, request, auth, metering } = context;
  const applicationScope = resolveApplicationScope(request);
  const startedAt = Date.now();

  const dimensions = {
    requestId: gated.requestId,
    // One injection point covers embed/rerank/parse - they all log through
    // here, so the task dimension cannot be present on one capability and
    // quietly missing on another.
    ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
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
    modelCode: gated.model.modelCode,
    providerCode: gated.model.provider,
    ...(gated.routedEndpointCode
      ? { endpointCode: gated.routedEndpointCode }
      : {}),
    ...(auth?.callerProductCode !== undefined
      ? { productCode: auth.callerProductCode }
      : {}),
    // TD-024: S2S requests carry no usageType field; they are normal traffic.
    usageType: "normal" as const,
  };

  let reading: MeterReading = {};
  const meter = (r: MeterReading): void => {
    reading = r;
  };

  try {
    const result = await call(meter);

    // Consume mirrors the chat path: after the fact (the amount is realized),
    // only for a token-derived workspace, never throwing into the response.
    const consumed: ConsumeOutcome =
      metering && auth?.workspaceId && (reading.amount ?? 0) > 0
        ? await metering.entitlements.consume({
            workspaceId: auth.workspaceId,
            metric: metering.metric,
            amount: reading.amount as number,
            idempotencyKey: gated.requestId,
          })
        : { billed: false };

    await requestLog.record({
      ...dimensions,
      status: "success",
      latencyMs: Date.now() - startedAt,
      ...(reading.usage?.promptTokens !== undefined
        ? { inputTokens: reading.usage.promptTokens }
        : {}),
      ...(reading.usage?.completionTokens !== undefined
        ? { outputTokens: reading.usage.completionTokens }
        : {}),
      ...(reading.usage?.totalTokens !== undefined
        ? { totalTokens: reading.usage.totalTokens }
        : {}),
      // Usage-record batch 1. The call reached the upstream and succeeded,
      // so whether it reported usage is answerable. Zhipu reports it for
      // embed and rerank; parse sums per page and says nothing when no page did.
      usageSource: reading.usage !== undefined ? "reported" : "absent",
      ...(reading.upstream?.upstreamRequestId !== undefined
        ? { upstreamRequestId: reading.upstream.upstreamRequestId }
        : {}),
      ...(reading.upstream?.upstreamModel !== undefined
        ? { upstreamModel: reading.upstream.upstreamModel }
        : {}),
      ...(reading.upstream?.rawUsage !== undefined
        ? { upstreamUsage: reading.upstream.rawUsage }
        : {}),
      ...(consumed.billed && metering
        ? {
            billedMetricKey: metering.metric,
            billedAmount: reading.amount as number,
            // Derived from the metric, never passed in: embed bills tokens
            // while rerank bills candidates and parse bills pages, and a
            // hand-written unit at three call sites is three chances to write
            // the plausible-looking wrong one.
            ...(costUnitForMetric(metering.metric) !== undefined
              ? { costUnit: costUnitForMetric(metering.metric) }
              : {}),
          }
        : {}),
      ...(consumed.usageEventId !== undefined
        ? { usageEventId: consumed.usageEventId }
        : {}),
    });
    return result;
  } catch (error) {
    await requestLog.record({
      ...dimensions,
      status: "error",
      latencyMs: Date.now() - startedAt,
    });
    const code =
      error instanceof ModelRuntimeException
        ? error.code
        : error instanceof ProviderCapabilityNotImplementedError
          ? "MODEL_NOT_IMPLEMENTED"
          : undefined;
    await requestLog.recordError({
      requestId: gated.requestId,
      providerCode: gated.model.provider,
      modelCode: gated.model.modelCode,
      ...(gated.routedEndpointCode
        ? { endpointCode: gated.routedEndpointCode }
        : {}),
      ...(code !== undefined ? { errorCode: code } : {}),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * TD-022: build the request the gate and reqlog both see.
 *
 * A1/A2/A3 address the caller by `workspaceId`, but the two authorization
 * axes are keyed differently and must not be conflated:
 *
 *   grant      `model.model_grants.tenant_id`   - a TENANT holds technical
 *                                                 access to a model
 *   entitlement platform C2 `quota_pools`       - a WORKSPACE holds quota
 *
 * These endpoints previously set `tenantId: request.workspaceId`, which put a
 * workspace uuid in the tenant column, so no ordinary grant could ever match
 * and every A1/A2/A3 call was `403 GRANT_DENIED` (the code that condition
 * carried at the time; it is spelled `NOT_ENTITLED` since product_251 X-1).
 *
 * The tenant comes from the verified token (`tenant_id`), never from a body
 * field - product_210 rule 8, and the same precedence `withRequestLog`
 * already uses for attribution, so the gate and the recorded row now agree
 * for real rather than by coincidence. The request body is the fallback for
 * callers that still send it.
 *
 * `workspaceId` follows the same precedence: the verified `workspace_id`
 * claim wins, and the body field is the fallback for tokens that carry no
 * claim - so the entitlement gate and the recorded reqlog row agree, and a
 * caller that filled in the required body field is never silently
 * unattributed. A body field can narrow nothing and redirect nothing: it is
 * only consulted when the token says nothing.
 */
export function toGateRequest<T extends { tenantId?: string; workspaceId?: string }>(
  request: T,
  auth?: S2sAuthContext,
): T & { tenantId: string } {
  const tenantId = auth?.tenantId ?? request.tenantId;
  if (!tenantId) {
    throw new ModelRuntimeException(
      HttpStatus.BAD_REQUEST,
      "TENANT_ID_REQUIRED",
      "tenantId is required - the token carries no tenant_id claim and the request supplied none",
    );
  }
  return { ...request, tenantId };
}

/**
 * The auth context the gate and the request log both consume: token claims
 * first, body `workspaceId` only when the token carries no `workspace_id`
 * claim (TD-035 - the required body field must not be configurable-but-inert,
 * and must never override a verified claim).
 */
export function withWorkspaceFallback(
  auth: S2sAuthContext | undefined,
  request: { workspaceId?: string },
): S2sAuthContext | undefined {
  const bodyWorkspaceId = request.workspaceId?.trim();
  if (!auth || auth.workspaceId !== undefined || !bodyWorkspaceId) {
    return auth;
  }
  return { ...auth, workspaceId: bodyWorkspaceId };
}

/**
 * Runs `attempt` against the route's models in order, moving to the next only
 * when the CALL fails - a gate refusal (grant/quota/rate limit) is the
 * caller's answer and is never retried against a different model, exactly as
 * the chat path behaves.
 *
 * This exists so endpoint failover means the same thing on every surface. The
 * alternative - resolution here, failover only in chat - would make a
 * fallback configured on `embedding/default` a setting that silently does
 * nothing, which is precisely the failure mode that made `model_endpoints`
 * inert to begin with.
 */
export async function runWithS2sFailover<T>(
  deps: {
    registry: ModelRegistryService;
    router: ModelRouterService;
    quota: QuotaService;
    providerKeys: ProviderKeyService;
    rateLimiter: ModelRateLimiterService;
    requestLog: RequestLogService;
  },
  request: S2sProviderRequestBase,
  auth: S2sAuthContext | undefined,
  attempt: (gated: GatedModel) => Promise<T>,
): Promise<T> {
  const route = await resolveRoute(deps.registry, request);
  const candidates = [route.modelCode, ...route.fallbackModelCodes].filter(
    (code, i, all) => all.indexOf(code) === i,
  );

  let lastError: unknown;
  let lastGated: GatedModel | undefined;

  for (const [index, modelCode] of candidates.entries()) {
    let gated: GatedModel;
    try {
      gated = await gateModel(deps, request, auth, modelCode, route.endpointCode);
    } catch (error) {
      if (index === 0) {
        // A gate refusal on the request itself (grant/quota/rate limit/model
        // lookup) is the caller's answer - but it is still a served request
        // and must be visible in reqlog, exactly as the chat path records it.
        await recordGateRefusal(
          deps.requestLog,
          request,
          auth,
          modelCode,
          route.endpointCode,
          error,
        );
        throw error;
      }
      // A broken FALLBACK candidate (deactivated model, missing key) must not
      // mask the primary's provider failure with its own gate error - skip it
      // and keep exhausting the chain, mirroring resolveCandidateModels on
      // the chat path.
      continue;
    }
    lastGated = gated;
    try {
      return await attempt(gated);
    } catch (error) {
      lastError = error;
      if (index === candidates.length - 1) break;
    } finally {
      // The gate acquired a concurrency slot when a max_concurrent policy
      // matched; releasing without a prior acquire is a safe no-op.
      deps.rateLimiter.releaseConcurrency(
        rateLimitKey(gated.model.id, request.tenantId),
      );
    }
  }

  throw toS2sProviderError(lastError, lastGated!.model, lastGated!.requestId);
}

/**
 * A denied call never reached `withRequestLog`, so it writes its own error
 * row here: quota exhaustion or a revoked grant showing up as a flatline
 * with zero recorded errors is exactly the invisible-failure mode reqlog
 * exists to prevent.
 */
async function recordGateRefusal(
  requestLog: RequestLogService,
  request: S2sProviderRequestBase,
  auth: S2sAuthContext | undefined,
  modelCode: string,
  endpointCode: string | null,
  error: unknown,
): Promise<void> {
  const applicationScope = resolveApplicationScope(request);
  const requestId = request.requestId?.trim() || randomUUID();
  await requestLog.record({
    requestId,
    status: "error",
    ...(auth?.workspaceId !== undefined
      ? { workspaceId: auth.workspaceId }
      : {}),
    ...(auth?.userId !== undefined ? { userId: auth.userId } : {}),
    tenantId: auth?.tenantId ?? request.tenantId,
    applicationId: applicationScope.applicationId,
    applicationType: applicationScope.applicationType,
    agentId: applicationScope.agentId,
    ...(request.featureId !== undefined ? { featureId: request.featureId } : {}),
    modelCode,
    ...(endpointCode ? { endpointCode } : {}),
    ...(auth?.callerProductCode !== undefined
      ? { productCode: auth.callerProductCode }
      : {}),
    usageType: "normal" as const,
  });
  await requestLog.recordError({
    requestId,
    modelCode,
    ...(endpointCode ? { endpointCode } : {}),
    ...(error instanceof ModelRuntimeException
      ? { errorCode: error.code }
      : {}),
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

/** Gate one specific model: entitlement, provider adapter, api key. */
async function gateModel(
  deps: {
    registry: ModelRegistryService;
    router: ModelRouterService;
    quota: QuotaService;
    providerKeys: ProviderKeyService;
    rateLimiter: ModelRateLimiterService;
  },
  request: S2sProviderRequestBase,
  auth: S2sAuthContext | undefined,
  modelCode: string,
  routedEndpointCode: string | null,
): Promise<GatedModel> {
  const requestId = request.requestId?.trim() || randomUUID();
  const model = await deps.registry.getActiveModel(modelCode);

  // `assertAllowed` ENDS by acquiring a concurrency slot, so everything after
  // this line runs holding one. The caller's release lives in a `finally`
  // attached to the attempt, which only runs once this function has RETURNED -
  // so a throw from either step below leaked the slot, permanently:
  // `inFlight` is a plain Map with no expiry.
  //
  // The damage compounds rather than degrading. After `max_concurrent` such
  // failures that (model, tenant) pair answers 429 for the life of the
  // process, and `RATE_LIMITED` is classified retryable - with no
  // `retryAfterMs` on the concurrency dimension - so a correctly written
  // caller retries forever against a counter that can only go up.
  //
  // The release belongs here, with the acquire, rather than one scope out:
  // this function is what takes the slot, so it is what owes it back.
  // `releaseConcurrency` is a documented no-op when nothing was acquired.
  await deps.quota.assertAllowed(model, request, auth);
  try {
    const provider = deps.router.resolve(model);
    const apiKey = await resolveApiKey(
      {
        resolveManagedKey: (providerCode, keyAlias) =>
          deps.providerKeys.resolveKey(providerCode, keyAlias),
      },
      model,
      requestId,
    );
    return { model, provider, apiKey, requestId, routedEndpointCode };
  } catch (error) {
    deps.rateLimiter.releaseConcurrency(
      rateLimitKey(model.id, request.tenantId),
    );
    throw error;
  }
}

async function resolveRoute(
  registry: ModelRegistryService,
  request: S2sProviderRequestBase,
): Promise<{
  modelCode: string;
  fallbackModelCodes: string[];
  endpointCode: string | null;
}> {
  const modelCode = request.modelCode?.trim();
  if (modelCode) {
    return { modelCode, fallbackModelCodes: [], endpointCode: null };
  }

  const endpointCode = request.endpointCode?.trim();
  if (endpointCode) {
    const resolved = await registry.resolveEndpoint(endpointCode);
    return { ...resolved, endpointCode };
  }

  return {
    modelCode: await resolveModelCode(registry, request),
    fallbackModelCodes: [],
    endpointCode: null,
  };
}

async function resolveModelCode(
  registry: ModelRegistryService,
  request: S2sProviderRequestBase,
): Promise<string> {
  const modelCode = request.modelCode?.trim();
  if (modelCode) {
    return modelCode;
  }

  const endpointCode = request.endpointCode?.trim();
  if (endpointCode) {
    const resolved = await registry.resolveEndpoint(endpointCode);
    return resolved.modelCode;
  }

  const taskProfile = request.taskProfile?.trim();
  if (!taskProfile) {
    throw new ModelRuntimeException(
      HttpStatus.BAD_REQUEST,
      "TARGET_SELECTOR_REQUIRED",
      "one of modelCode, endpointCode or taskProfile is required",
    );
  }

  const applicationScope = resolveApplicationScope(request);
  return registry.resolveModelCodeForTaskProfile({
    tenantId: request.tenantId,
    taskProfile,
    applicationId: applicationScope.applicationId,
    applicationType: applicationScope.applicationType,
  });
}

export function toS2sProviderError(
  error: unknown,
  model: AiModelRecord,
  requestId: string,
): ModelRuntimeException {
  if (error instanceof ModelRuntimeException) {
    return error;
  }

  if (error instanceof ProviderCapabilityNotImplementedError) {
    return new ModelRuntimeException(
      HttpStatus.NOT_IMPLEMENTED,
      "MODEL_NOT_IMPLEMENTED",
      error.message,
      { requestId, modelCode: model.modelCode, provider: model.provider },
    );
  }

  const message = error instanceof Error ? error.message : "Provider request failed";
  return new ModelRuntimeException(
    HttpStatus.SERVICE_UNAVAILABLE,
    "PROVIDER_UNAVAILABLE",
    message,
    { requestId, modelCode: model.modelCode, provider: model.provider },
  );
}
