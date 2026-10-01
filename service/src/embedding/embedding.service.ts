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
import { ModelRuntimeException } from "../runtime/runtime.errors";
import { requireTaskId } from "../runtime/task-attribution";
import { countingRejectionsSync } from "../runtime/pre-log-rejection";
import type { GatedModel } from "../runtime/s2s-provider.shared";
import { RequestLogService } from "../reqlog/request-log.service";
import { PlatformEntitlementClient } from "../platform/platform-entitlement.client";
import { ModelRateLimiterService } from "../quota/model-rate-limiter.service";
import type { S2sAuthContext } from "../runtime/guards/s2s-auth.guard";
import type { EmbedRequest, EmbedResponse } from "./embedding.types";

@Injectable()
export class EmbeddingService {
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

  async embed(
    request: EmbedRequest,
    auth?: S2sAuthContext,
  ): Promise<EmbedResponse> {
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
          // C3 consume: embedding bills by upstream-reported tokens, like
          // chat. When the provider reports no usage, amount stays undefined
          // and the row's NULL billed_amount is the reconciliation signal -
          // never invent a number.
          metering: { entitlements: this.entitlements, metric: "atlas.embed" },
        },
        async (meter) => {
        const result = await gated.provider.embed({
          endpointUrl: gated.model.endpointUrl,
          apiKey: gated.apiKey,
          modelCode: gated.model.modelCode,
          texts: request.texts,
          ...(gated.model.config != null ? { config: gated.model.config } : {}),
        });

        meter({
          ...(result.usage?.totalTokens !== undefined
            ? { amount: result.usage.totalTokens }
            : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.upstream ? { upstream: result.upstream } : {}),
          facts: { vectorCount: result.vectors.length, vectorDimension: result.dimension },
        });
        return {
          modelCode: gated.model.modelCode,
          modelVersion: result.modelVersion,
          dimension: result.dimension,
          vectors: result.vectors,
        };
          },
        ),
    );
  }

  private validate(request: EmbedRequest): void {
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

    if (!Array.isArray(request.texts) || request.texts.length === 0) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "EMBED_TEXTS_REQUIRED",
        "texts cannot be empty",
      );
    }

    if (request.texts.some((text) => typeof text !== "string")) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "EMBED_TEXTS_INVALID",
        "texts must be an array of strings",
      );
    }
  }
}
