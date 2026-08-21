import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ModelRegistryRepository } from "../registry/model-registry.repository";
import { ModelRegistryService } from "../registry/model-registry.service";
import { PlatformEntitlementClient } from "../platform/platform-entitlement.client";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import type { S2sAuthContext } from "../runtime/guards/s2s-auth.guard";
import type { AiModelRecord } from "../types/runtime.types";
import { isUuid } from "../uuid";
import type {
  TenancyGrantRow,
  TenancyQuotaResponse,
  TenancyScope,
  TenancyUsageResponse,
  TenancyUsageRow,
} from "./tenancy.types";
import { toObjectState } from "../object-state";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;

@Injectable()
export class TenancyService {
  constructor(
    @Inject(ModelRegistryService)
    private readonly registry: ModelRegistryService,
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
    @Inject(PlatformEntitlementClient)
    private readonly entitlements: PlatformEntitlementClient,
  ) {}

  /**
   * The single choke point for this namespace: turn the verified token into a
   * scope id. Nothing here consults the request. A caller asking for a scope
   * its token does not carry gets a 403, not someone else's data.
   */
  private resolveScopeId(auth: S2sAuthContext | undefined, scope: TenancyScope): string {
    const claim = scope === "tenant" ? auth?.tenantId : auth?.workspaceId;
    const claimName = scope === "tenant" ? "tenant_id/org_id" : "workspace_id";

    if (!claim?.trim()) {
      throw new ModelRuntimeException(
        HttpStatus.FORBIDDEN,
        "TENANCY_SCOPE_UNAVAILABLE",
        // The advice has to be reachable from the route that receives it.
        // `/tenancy/usage` takes a `scope` parameter and can genuinely fall
        // back; `/tenancy/models` and `/tenancy/grants` cannot - they read
        // `model_grants.tenant_id`, which is a tenant, so there is no
        // workspace-scoped equivalent to point at. Telling that caller to
        // "use scope=workspace" would send them looking for a parameter the
        // route does not have.
        scope === "tenant"
          ? "this token carries no tenant identity (no tenant_id/org_id claim), so a tenant-scoped read cannot be authorized. The platform mints org_id only when an organization is active, so personal tenants currently have none. On /tenancy/usage, pass scope=workspace instead; the model and grant lists have no workspace-scoped form, because the grants they read are held by a tenant."
          : `token carries no ${claimName} claim, so a ${scope}-scoped read cannot be authorized`,
      );
    }

    if (!isUuid(claim)) {
      // Not a client error to surface as 400: the caller cannot fix a claim
      // the issuer minted. Fail closed rather than querying with a value the
      // uuid column would reject anyway.
      throw new ModelRuntimeException(
        HttpStatus.FORBIDDEN,
        "TENANCY_SCOPE_INVALID",
        `token ${claimName} claim is not a UUID`,
      );
    }

    return claim;
  }

  /**
   * Models this TENANT is entitled to call (active grants only).
   *
   * Tenant, not workspace, and the distinction is the whole correctness of
   * this method. `model.model_grants.tenant_id` holds a TENANT - that is
   * TD-022, already written up as a rule one directory over
   * (`s2s-provider.shared.ts`) after the S2S endpoints made exactly this
   * mistake: a workspace uuid in the tenant column matches no grant, ever.
   *
   * There it surfaced as `403` on every call, which at least said something
   * was wrong. Here it surfaced as `[]` - a well-formed answer meaning "you
   * hold nothing", returned to a tenant that holds plenty. `/tenancy/usage`
   * escaped it because reqlog carries BOTH columns and picks by scope, which
   * is what made the three reads look verified together.
   *
   * A token with no tenant identity now gets the choke point's 403 rather
   * than an empty list. That is the honest answer: it says which claim is
   * missing, where `[]` said the tenant has no models.
   */
  // `async` so a scope refusal REJECTS rather than throwing synchronously.
  // `listGrants` is async and `listModels` was not, so the same refusal left
  // this namespace by two different mechanisms - a caller writing
  // `.catch(...)` handled one and was hit by the other.
  async listModels(auth: S2sAuthContext | undefined): Promise<AiModelRecord[]> {
    return this.registry.listModelsForTenant({
      tenantId: this.resolveScopeId(auth, "tenant"),
    });
  }

  /**
   * The tenant's own grants - what it may call, and the routing conditions
   * attached. Operator-only fields (`reason`) are not projected.
   *
   * Keyed on the tenant for the same reason as `listModels` above: the column
   * being queried is `model_grants.tenant_id`.
   */
  async listGrants(auth: S2sAuthContext | undefined): Promise<TenancyGrantRow[]> {
    const tenantId = this.resolveScopeId(auth, "tenant");
    const grants = await this.repository.listGrants({ tenantId });
    return grants.map((g) => ({
      id: g.id,
      modelId: g.modelId,
      applicationId: g.applicationId ?? null,
      applicationType: (g.applicationType as string | null) ?? null,
      agentId: g.agentId ?? null,
      taskProfile: (g.taskProfile as string | null) ?? null,
      priority: g.priority,
      expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString() : null,
      state: toObjectState(g.isActive),
    }));
  }

  /**
   * Entitlement, read from the platform's C2 envelope. Distinguishes
   * "uncovered" from "unavailable".
   */
  async quotas(auth: S2sAuthContext | undefined): Promise<TenancyQuotaResponse> {
    const workspaceId = this.resolveScopeId(auth, "workspace");
    const outcome = await this.entitlements.resolve(workspaceId);

    if (outcome.kind !== "resolved") {
      return {
        workspaceId,
        tier: null,
        bundled: false,
        limits: {},
        pools: [],
        status: "unavailable",
      };
    }

    const pools = outcome.view.quota_pools ?? [];
    return {
      workspaceId,
      tier: outcome.view.tier ?? null,
      bundled: outcome.view.bundled ?? false,
      limits: outcome.view.limits ?? {},
      pools: pools.map((p) => ({
        metric: p.metric,
        limit: p.limit,
        remaining: p.remaining,
        priority: p.priority,
      })),
      status: pools.length > 0 ? "covered" : "uncovered",
    };
  }

  /**
   * Usage from Atlas's own request log. Not a billing figure - the billing
   * basis is the platform's `usage_events` summed over the subscription
   * period; this answers "what actually ran".
   */
  async usage(
    auth: S2sAuthContext | undefined,
    query: { scope?: string; days?: string },
  ): Promise<TenancyUsageResponse> {
    const scope: TenancyScope = query.scope === "tenant" ? "tenant" : "workspace";
    const scopeId = this.resolveScopeId(auth, scope);
    const days = this.resolveDays(query.days);

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    const raw = await this.repository.aggregateReqlogUsage({
      scopeColumn: scope === "tenant" ? "tenant_id" : "workspace_id",
      scopeId,
      from,
      to,
    });

    const rows: TenancyUsageRow[] = raw.map((r) => ({
      modelCode: r.modelCode,
      providerCode: r.providerCode,
      requests: Number(r.requests),
      inputTokens: Number(r.inputTokens ?? 0n),
      outputTokens: Number(r.outputTokens ?? 0n),
      totalTokens: Number(r.totalTokens ?? 0n),
      errors: Number(r.errors),
    }));

    return {
      scope,
      scopeId,
      from: from.toISOString(),
      to: to.toISOString(),
      rows,
      source: "atlas.reqlog",
    };
  }

  private resolveDays(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_WINDOW_DAYS;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_DAYS) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "INVALID_WINDOW",
        `days must be an integer between 1 and ${MAX_WINDOW_DAYS}`,
      );
    }
    return parsed;
  }
}
