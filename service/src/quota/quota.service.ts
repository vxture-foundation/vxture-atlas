import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ModelRegistryRepository } from "../registry/model-registry.repository";
import { PlatformEntitlementClient } from "../platform/platform-entitlement.client";
import { metricsRegistry } from "../runtime/metrics.registry";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import { isUuid } from "../uuid";
import {
  ModelRateLimiterService,
  RateLimitBreach,
  rateLimitKey,
} from "./model-rate-limiter.service";
import type { AiModelRecord, ApplicationType, ChatRequest } from "../types/runtime.types";

export const COMMERCE_SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The subset of ChatRequest that quota/grant gating actually reads. Lets the A1/A2/A3
 * S2S provider endpoints (TD-003) reuse assertAllowed without needing a full chat-shaped
 * request (they have no `messages`/no `modelCode` on the request body itself - modelCode
 * is a separate parameter). ChatRequest still satisfies this structurally, so the chat
 * call sites (runtime.service.ts) are unaffected.
 */
export interface QuotaCheckRequest {
  tenantId: string;
  applicationId?: string;
  applicationType?: ApplicationType;
  agentId?: string;
  featureId?: string;
}

@Injectable()
export class QuotaService {
  constructor(
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
    @Inject(PlatformEntitlementClient)
    private readonly entitlements: PlatformEntitlementClient,
    @Inject(ModelRateLimiterService)
    private readonly rateLimiter: ModelRateLimiterService,
  ) {}

  /**
   * TD-016: consult the platform's C2 entitlement view.
   *
   * Three outcomes, deliberately not collapsed:
   *  - a real pool with nothing left  -> deny. The only case this gate can
   *    actually say no.
   *  - resolved but no coverage       -> allow, and say why. Atlas's plan
   *    catalog is still an unpublished draft on the platform side (confirmed
   *    in vxture-platform's seed-catalog.mjs: "empty features+quota - admin
   *    fills in once Atlas repo-split lands a product definition"), so every
   *    workspace legitimately reads as uncovered today; denying on that would
   *    take down live traffic (karda's included) for a bookkeeping gap.
   *  - unreachable / not configured   -> bounded fail-open, per the platform's
   *    own doctrine (data_model_200_schema.md §3).
   */
  private async checkEntitlement(
    model: AiModelRecord,
    workspaceId: string | undefined,
  ): Promise<void> {
    if (!workspaceId) return;

    const outcome = await this.entitlements.resolve(workspaceId);
    if (outcome.kind !== "resolved") return;

    const pools = outcome.view.quota_pools ?? [];
    if (pools.length === 0) return;

    const exhausted = pools.every((pool) => pool.remaining <= 0);
    if (exhausted) {
      throw new ModelRuntimeException(
        HttpStatus.FORBIDDEN,
        "QUOTA_EXCEEDED",
        "Workspace has no remaining quota for atlas",
        { modelCode: model.modelCode },
      );
    }
  }

  /**
   * Grant check (does this tenant/application have technical access to this
   * model at all) plus the C2 entitlement check above. Returns nothing - no
   * caller reads the result, only whether it throws.
   *
   * A previous version of this method also enforced a per-subscription token
   * quota and a model-allowlist sourced from
   * `ModelRegistryRepository.findCurrentSubscriptionQuota` /
   * `findUsageSummary`. Removed 2026-07-28 (TD-002/TD-005 cleanup): both
   * repository methods were stubs left over from the physical DB split that
   * always returned null/empty (their backing tables never existed in
   * Atlas's own database - they were cross-database reads into commerce
   * tables the platform owns), so that whole path was unreachable on every
   * call and always fell through to the fail-open branch below it. It also
   * modeled `allowedModels`/`allowCustomModel` per-subscription, a v1
   * "capabilities" concept the platform's own docs say is retired
   * (`entitlement-view.ts`: "union/tiered strategy keys ... no longer leave
   * the platform"). There is no real replacement for it to wire up - the C2
   * envelope's `limits` axis is the closest analog, and it carries the same
   * unpublished-plan-catalog gap as `quota_pools` above, so there was nothing
   * live to gate on either way.
   */
  async assertAllowed(
    model: AiModelRecord,
    request: QuotaCheckRequest,
    auth?: {
      workspaceId?: string | undefined;
      callerProductCode?: string | undefined;
    },
  ): Promise<void> {
    const applicationScope = resolveApplicationScope(request);
    await this.assertGranted(model, request, applicationScope, auth);

    await this.checkEntitlement(model, auth?.workspaceId);
    await this.checkRateLimit(model, request.tenantId);
  }

  /**
   * TRANSITIONAL, both axes live.
   *
   * Authorization is moving from (tenant, model) to (product, ENDPOINT). What
   * is sold is a product service, so which capabilities a product needs is
   * engineering, not per-customer commerce - and `act.sub` is verified on the
   * token, while `tenantId` partly arrives in the request body.
   *
   * The grant names an entry point, not a model, because repointing an
   * endpoint is supposed to be invisible to callers. Model-scoped grants would
   * have broken that at the authorization layer, and would have left an
   * endpoint's fallback needing its own grant before it could fire.
   *
   * A call is allowed if EITHER axis grants it. That is strictly no less
   * restrictive than before, so nothing that worked stops working, and it lets
   * the registry migrate model by model instead of in one cut.
   *
   * Which axis actually authorized is counted, because the tenant axis is only
   * removed once traffic shows nothing still depends on it - the same
   * discipline that removed the step-up guard only after its replacement
   * landed, rather than leaving a window where neither held.
   */
  private async assertGranted(
    model: AiModelRecord,
    request: QuotaCheckRequest,
    applicationScope: {
      applicationId: string;
      applicationType: ApplicationType;
    },
    auth?: { callerProductCode?: string | undefined },
  ): Promise<void> {
    if (auth?.callerProductCode) {
      const grants = await this.repository.listProductEndpointGrants(
        auth.callerProductCode,
        applicationScope.applicationId,
        applicationScope.applicationType,
      );
      // The product holds ENDPOINTS; the models it may name are whatever those
      // endpoints reach. Checking the derived set rather than a second grant
      // table is what keeps a repoint invisible: change what `chat/default`
      // points at and every product holding it follows, with no grant to
      // update and no failover that silently cannot fire.
      const reachable = await this.repository.reachableModelCodes(
        grants.map((grant) => grant.endpointCode),
      );
      if (reachable.has(model.modelCode)) {
        metricsRegistry.recordGrantAuthorization("product");
        return;
      }
    }

    // A product-authorized caller that reaches here has already failed the
    // axis it was actually authorized on. Trying the tenant axis anyway is not
    // free: `findBestGrant` asserts the tenantId is a UUID, and a product
    // caller's tenantId frequently is not one - so the answer came back as
    // `400 INVALID_TENANT_ID`, which reads "your payload is malformed" when
    // what actually happened is "your grant stopped matching".
    //
    // That is worse than a wrong status code. The caller had been succeeding
    // with that exact same tenantId for as long as the product grant held, so
    // the error points at the one thing that did NOT change, and points away
    // from the thing that did. vxtpl lost real time to it (#198 §4). The
    // tenant axis was never their authorization path; say what is true.
    if (auth?.callerProductCode && !isUuid(request.tenantId)) {
      metricsRegistry.recordGrantAuthorization("denied");
      throw new ModelRuntimeException(
        HttpStatus.FORBIDDEN,
        "NOT_ENTITLED",
        `Product "${auth.callerProductCode}" holds no endpoint that reaches this model. ` +
          `The tenant grant axis was not tried: this request's tenantId is not a UUID, ` +
          `so it cannot match a tenant grant either way.`,
        { modelCode: model.modelCode },
      );
    }

    const tenantGrant = await this.repository.findBestGrant(
      model.id,
      request.tenantId,
      applicationScope.applicationId,
      applicationScope.applicationType,
    );
    if (tenantGrant) {
      metricsRegistry.recordGrantAuthorization("tenant");
      return;
    }

    metricsRegistry.recordGrantAuthorization("denied");
    throw new ModelRuntimeException(
      HttpStatus.FORBIDDEN,
      "NOT_ENTITLED",
      auth?.callerProductCode
        ? `Product "${auth.callerProductCode}" holds no endpoint that reaches this model, and no tenant grant matched either`
        : "Current tenant or application has no technical grant for this model",
      { modelCode: model.modelCode },
    );
  }

  /**
   * RPM + concurrency gate, driven by `model_policies` (ADR-004:
   * `RATE_LIMITED` was specified from the start, never enforced until now).
   * Same abort-the-whole-request semantics as the grant/entitlement checks
   * above, deliberately - a rate limit is a policy gate on this (model,
   * tenant) pair, not a health signal like the circuit breaker, so a breach
   * here does not fall through to the next fallback candidate.
   *
   * Concurrency is *acquired* here but *released* by the caller
   * (`runtime.service.ts`, around the actual provider call) - this method
   * only knows when a request starts, not when it finishes.
   */
  private async checkRateLimit(
    model: AiModelRecord,
    tenantId: string,
  ): Promise<void> {
    const policy = await this.repository.findApplicablePolicy(
      model.id,
      tenantId,
    );
    if (!policy) return;

    const key = rateLimitKey(model.id, tenantId);
    try {
      this.rateLimiter.checkRpm(key, policy.rateLimitRpm);
      this.rateLimiter.acquireConcurrency(key, policy.maxConcurrent);
    } catch (error) {
      if (error instanceof RateLimitBreach) {
        throw new ModelRuntimeException(
          HttpStatus.TOO_MANY_REQUESTS,
          "RATE_LIMITED",
          `Rate limit exceeded for model "${model.modelCode}" (${error.dimension})`,
          {
            modelCode: model.modelCode,
            ...(error.retryAfterMs !== undefined
              ? { retryAfterMs: error.retryAfterMs }
              : {}),
          },
        );
      }
      throw error;
    }
  }
}

export function normalizeUuidScope(value: string | undefined): string {
  return value?.trim() || COMMERCE_SENTINEL_UUID;
}

export function resolveApplicationScope(
  request: Pick<ChatRequest, "applicationId" | "applicationType" | "agentId">,
): {
  applicationId: string;
  applicationType: ApplicationType;
  agentId: string;
} {
  const applicationId = request.applicationId?.trim();
  const agentId = request.agentId?.trim();

  if (applicationId) {
    return {
      applicationId,
      applicationType: request.applicationType ?? "agent",
      agentId:
        request.applicationType === "agent"
          ? normalizeUuidScope(agentId ?? applicationId)
          : COMMERCE_SENTINEL_UUID,
    };
  }

  if (agentId) {
    return {
      applicationId: agentId,
      applicationType: "agent",
      agentId,
    };
  }

  return {
    applicationId: COMMERCE_SENTINEL_UUID,
    applicationType: "internal_service",
    agentId: COMMERCE_SENTINEL_UUID,
  };
}

export function toCycleMonth(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}
