import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ModelRegistryService } from "../registry/model-registry.service";
import { ModelRouterService } from "../router/model-router.service";
import { QuotaService } from "../quota/quota.service";
import { ProviderKeyService } from "../provider-keys/provider-key.service";
import {
  runWithS2sFailover,
  withRequestLog,
  toGateRequest,
  withWorkspaceFallback,
} from "../runtime/s2s-provider.shared";
import type { GatedModel } from "../runtime/s2s-provider.shared";
import { RequestLogService } from "../reqlog/request-log.service";
import { PlatformEntitlementClient } from "../platform/platform-entitlement.client";
import { ModelRateLimiterService } from "../quota/model-rate-limiter.service";
import type { S2sAuthContext } from "../runtime/guards/s2s-auth.guard";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import { requireTaskId } from "../runtime/task-attribution";
import { countingRejectionsSync } from "../runtime/pre-log-rejection";
import {
  RERANK_CANDIDATE_POOL_LIMIT,
  type RerankRequest,
  type RerankResponse,
} from "./rerank.types";

@Injectable()
export class RerankService {
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
    @Inject(ModelRateLimiterService)
    private readonly rateLimiter: ModelRateLimiterService,
  ) {}

  async rerank(
    request: RerankRequest,
    auth?: S2sAuthContext,
  ): Promise<RerankResponse> {
    countingRejectionsSync(auth, request.requestId, () =>
      this.validate(request),
    );

    // Token claims first, body workspaceId as fallback; the gate keys grants
    // by tenant and entitlement by workspace - see toGateRequest.
    const effectiveAuth = withWorkspaceFallback(auth, request);
    const gateRequest = toGateRequest(request, effectiveAuth);

    // Endpoint routing may declare a fallback; run the whole gated
    // attempt per candidate so that chain means the same thing here as
    // it does on the chat path.
    return await runWithS2sFailover(
      {
        registry: this.registry,
        router: this.router,
        quota: this.quota,
        providerKeys: this.providerKeys,
        rateLimiter: this.rateLimiter,
        requestLog: this.requestLog,
      },
      gateRequest,
      effectiveAuth,
      async (gated: GatedModel) =>
        withRequestLog(
        this.requestLog,
        {
          gated,
          request: gateRequest,
          auth: effectiveAuth,
          // C3 consume: the rerank cost driver is the pair count, so the
          // billed amount is the candidate pool size - deterministic and
          // known even when the upstream reports no token usage. Token usage
          // still lands in reqlog when the provider returns it.
          metering: { entitlements: this.entitlements, metric: "atlas.rerank" },
        },
        async (meter) => {
        const result = await gated.provider.rerank({
          endpointUrl: gated.model.endpointUrl,
          apiKey: gated.apiKey,
          modelCode: gated.model.modelCode,
          query: request.query,
          candidates: request.candidates,
          ...(gated.model.config != null ? { config: gated.model.config } : {}),
        });

        meter({
          amount: request.candidates.length,
          ...(result.usage ? { usage: result.usage } : {}),
        });
        return { modelCode: gated.model.modelCode, scores: result.scores };
          },
        ),
    );
  }

  private validate(request: RerankRequest): void {
    requireTaskId(request.taskId);

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

    if (typeof request.workspaceId !== "string" || !request.workspaceId.trim()) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "WORKSPACE_ID_REQUIRED",
        "workspaceId is required",
      );
    }

    if (typeof request.query !== "string" || !request.query.trim()) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "RERANK_QUERY_REQUIRED",
        "query is required",
      );
    }

    if (!Array.isArray(request.candidates) || request.candidates.length === 0) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "RERANK_CANDIDATES_REQUIRED",
        "candidates cannot be empty",
      );
    }

    // A3.2 hard constraint - reject, never silently truncate.
    if (request.candidates.length > RERANK_CANDIDATE_POOL_LIMIT) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "CANDIDATE_POOL_TOO_LARGE",
        `candidates cannot exceed ${RERANK_CANDIDATE_POOL_LIMIT} (got ${request.candidates.length})`,
        request.modelCode ? { modelCode: request.modelCode } : {},
      );
    }

    const invalidCandidate = request.candidates.some(
      (candidate) =>
        typeof candidate.id !== "string" ||
        !candidate.id.trim() ||
        typeof candidate.text !== "string",
    );
    if (invalidCandidate) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "RERANK_CANDIDATES_INVALID",
        "candidates must each have a non-empty id and a text string",
      );
    }
  }
}
