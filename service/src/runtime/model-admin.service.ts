import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ModelRegistryRepository } from "../registry/model-registry.repository";
import {
  MODEL_PROTOCOLS,
  normalizeProtocol,
  PROTOCOL_CATALOG,
} from "../providers/protocol";
import {
  ANTHROPIC_WIRE_DEFAULTS,
  OPENAI_WIRE_DEFAULTS,
  resolveWireFor,
  validateWire,
  WIRE_SCHEMA_VERSION,
} from "../providers/wire";
import type { ResolvedWire } from "../providers/wire";
import { ModelAdminException } from "./model-admin.errors";
import { modelBehaviorVersion } from "../model-behavior-version";
import { metricsRegistry } from "./metrics.registry";
import type { ProductEndpointGrantRecord } from "../prisma";
import type { ProviderTrafficSnapshot } from "./metrics.registry";
import type {
  AiModelGrantRecord,
  AiModelRecord,
  ApplicationType,
  CreateAiModelGrantInput,
  CreateAiModelInput,
  CreateModelEndpointInput,
  CreateModelPolicyInput,
  CreateModelPriceRuleInput,
  CreateModelProviderInput,
  ModelConfig,
  ModelEndpointRecord,
  ModelPolicyRecord,
  ModelPriceRuleRecord,
  ModelProviderRecord,
  EndpointModelRef,
  EndpointResolutionState,
  ModelAvailability,
  TenantUsageSummaryRecord,
  UsageRollupDimension,
  UsageRollupRecord,
  UpdateAiModelGrantInput,
  UpdateAiModelInput,
  UpdateModelEndpointInput,
  UpdateModelPolicyInput,
  UpdateModelPriceRuleInput,
  UpdateModelProviderInput,
} from "../types/runtime.types";
import {
  isActiveState,
  toObjectState,
  toModelState,
  type ModelState,
  type ObjectState,
} from "../object-state";

const APPLICATION_TYPES = new Set<ApplicationType>([
  "agent",
  "workflow",
  "api_client",
  "internal_service",
]);

const SECRET_CONFIG_KEY_PATTERN =
  /^(api[-_]?key|apiKeyEnvVar|managedKeyAlias|secret|token|password|credential|access[-_]?token|refresh[-_]?token|bearer[-_]?token)$/i;

/**
 * source "managed" resolves via the provider-key vault (Phase A envelope
 * encryption, see provider-keys/) by (model.provider, name=keyAlias) - no
 * redeploy needed to add/rotate. source "env" is the legacy path, kept for
 * back-compat with models already configured against it.
 */
export interface ModelKeyReference {
  source: "env" | "managed";
  name: string;
  configured: boolean;
}

export interface ModelKeyReferenceInput {
  source?: "env" | "managed";
  name?: string | null;
}

/**
 * Derived from real chat/stream traffic
 * (`metricsRegistry.snapshotProviderTraffic`), not an active health check -
 * probing costs real upstream calls (see `ModelProbeService`'s per-model
 * cooldown) and nobody asked for that cost on every dashboard load.
 * `status: "unknown"` means no traffic has been observed yet, not that the
 * provider is unreachable.
 */
export interface ModelProviderHealth {
  status: "healthy" | "degraded" | "down" | "unknown";
  successRate: number | null;
  avgLatencyMs: number | null;
  attempts: number;
  lastObservedAt: string | null;
}

export interface ModelProviderAdminRecord {
  /**
   * Models under this provider that are not deleted, active or not. This is
   * exactly the number that blocks `DELETE /capability/providers/:id` - a
   * column that disagreed with the precondition would be worse than no column.
   */
  modelCount: number;
  id: string;
  providerCode: string;
  providerType: string;
  providerName: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  consoleUrl: string | null;
  billingUrl: string | null;
  state: ObjectState;
  config: ModelConfig | null;
  health: ModelProviderHealth;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPerformanceRecord {
  provider: string;
  attempts: number;
  successes: number;
  errors: number;
  errorRate: number | null;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  lastObservedAt: string | null;
}

/**
 * `providers[].attempts/successes/errors` are
 * cumulative counters since `processStartedAt`, mirroring `/metrics`
 * (Prometheus) semantics - compute a rate by polling twice and diffing, the
 * same way any Prometheus counter is turned into a rate.
 */
export interface GatewayPerformanceResponse {
  generatedAt: string;
  processStartedAt: string;
  inFlightRequests: number;
  providers: ProviderPerformanceRecord[];
}

/**
 * A stable capability entry point (e.g.
 * "chat/default") that indirects to a primary/fallback modelCode pair, so
 * callers depend on a name instead of a concrete model. `fallbackModelCode`
 * null = single routing, set = failover routing.
 */
/** A product's hold on an entry point (incr/06). */
export interface ProductGrantAdminRecord {
  id: string;
  productCode: string;
  endpointCode: string;
  applicationId: string | null;
  applicationType: string | null;
  state: ObjectState;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateProductGrantBody = {
  productCode?: string;
  endpointCode?: string;
  applicationId?: string | null;
  applicationType?: string | null;
  reason?: string | null;
  expiresAt?: string | null;
  state?: ObjectState;
};

export type UpdateProductGrantBody = Omit<
  Partial<CreateProductGrantBody>,
  "state"
>;

export interface ModelEndpointAdminRecord {
  id: string;
  code: string;
  category: string;
  primaryModelCode: string;
  fallbackModelCode: string | null;
  state: ObjectState;
  /**
   * What this endpoint is actually doing right now, derived from the state of
   * the models it points at. `isActive` is the operator's intent; this is the
   * consequence. They disagree exactly when something upstream broke, which is
   * the case worth seeing.
   */
  resolution: EndpointResolutionState;
  /** Primary first, then fallback, each with why it can or cannot serve. */
  models: EndpointModelRef[];
  createdAt: string;
  updatedAt: string;
}

export type CreateModelEndpointBody = {
  code?: string;
  category?: string;
  primaryModelCode?: string;
  fallbackModelCode?: string | null;
  state?: ObjectState;
};

export type UpdateModelEndpointBody = Partial<
  Omit<CreateModelEndpointBody, "code" | "state">
>;

export interface AiModelAdminRecord {
  /** Non-deleted grants referencing this model. Blocks delete. */
  grantCount: number;
  /**
   * Non-deleted endpoints referencing this model as primary OR fallback.
   * Blocks delete - severing a failover chain silently is the same class of
   * problem as breaking a primary, only quieter.
   */
  endpointRefCount: number;
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
  sort: number;
  /**
   * `active` / `inactive` / `deprecated`, not the two-value ObjectState the
   * rest of this plane uses.
   *
   * The operator plane is where deprecation is PERFORMED
   * (`POST :id/deprecate`), and until 2026-08-17 it was the one plane that
   * could not read the result: this record reported `toObjectState(isActive)`,
   * which has no third value, so a deprecated model was indistinguishable from
   * a plain active one in the console list. The signal existed on
   * `GET /v1/models` for consumers and nowhere for the person who set it.
   */
  state: ModelState;
  /** When it was deprecated - the console needs WHEN, not just THAT. */
  deprecatedAt: string | null;
  /** Opaque upstream+wire fingerprint; see model-behavior-version.ts. */
  behaviorVersion: string;
  /**
   * What this model actually runs with: protocol defaults, overlaid by the
   * provider's `config.wire`, then by the model's own.
   *
   * Added 2026-08-24 because `behaviorVersion` had a hole next to it. It says
   * THAT the configuration moved - which is its whole job, and it does it well -
   * but the only way to see WHAT it moved to was `POST :id/probe`, and a probe
   * makes a real upstream call and spends tokens. So the cheap signal pointed at
   * an expensive answer, and in practice nobody asked the question.
   *
   * `config` below is the raw overlay this model declares; this is the merged
   * result. Both are here on purpose: the console needs to show which layer set
   * a key, and it must not merge them itself - `applyOverlay` merges per key,
   * so a console-side implementation would be a second source of truth for the
   * same fact.
   */
  resolvedWire: ResolvedWire;
  config: ModelConfig | null;
  keyReference: ModelKeyReference | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelGrantAdminRecord {
  id: string;
  modelId: string;
  tenantId: string;
  applicationId: string | null;
  applicationType: ApplicationType | null;
  agentId: string | null;
  taskProfile: string | null;
  priority: number;
  reason: string | null;
  expiresAt: string | null;
  state: ObjectState;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPriceRuleAdminRecord {
  id: string;
  modelId: string;
  billingMode: string;
  currency: string;
  unitTokens: number;
  inputUnitPrice: string;
  outputUnitPrice: string;
  requestUnitPrice: string;
  /**
   * TD-047. `null` means no cached rate was declared, NOT that cached input is
   * free - a cost calculation falls back to `inputUnitPrice`, which overstates
   * rather than understates.
   */
  cachedInputUnitPrice: string | null;
  /**
   * TD-057. Cache-write rates (5-minute and 1-hour TTL). `null` = not
   * declared: a write costs the input rate, which understates Anthropic's
   * 1.25x / 2x - declare them for any provider that charges for writes.
   */
  cacheWriteUnitPrice: string | null;
  cacheWrite1hUnitPrice: string | null;
  state: ObjectState;
  effectiveAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPolicyAdminRecord {
  id: string;
  modelId: string;
  tenantId: string | null;
  name: string | null;
  priority: number;
  maxConcurrent: number | null;
  rateLimitRpm: number | null;
  rateLimitTpm: string | null;
  rateLimitTpd: string | null;
  maxContextTokens: number | null;
  state: ObjectState;
  effectiveAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantQuotaAdminRecord {
  id: string;
  tenantId: string;
  subscriptionId: string | null;
  maxUsers: number;
  maxApiKeys: number;
  maxWorkflows: number;
  maxConcurrent: number;
  rateLimitPerMinute: number;
  periodTokens: string;
  quotaCycle: string;
  allowedModels: string[];
  allowCustomModel: boolean;
  effectiveAt: string;
  expiresAt: string | null;
}

/**
 * One aggregated row from reqlog. The identity fields not belonging to the
 * grouping axis are `null` - a provider rollup row has no tenant, because it
 * sums across all of them.
 *
 * **Which axis produced these rows is NOT on the row** - it is `dimension` on
 * the enclosing `UsageSummaryPage`. It used to be repeated on every row, and
 * product_251 A-4 forbids that for one concrete reason: `groupBy` defaults to
 * `tenant` server-side, so the axis is something the server *resolved*; carried
 * per row, it vanishes exactly when the result is empty, and a caller holding
 * `[]` cannot tell which axis it just queried. A resolved value that disappears
 * on the empty case is not an answer.
 */
export interface TenantUsageSummaryAdminRecord {
  cycleMonth: string;
  /**
   * The billing subject is the (tenantId, workspaceId) PAIR - grouping by
   * tenant alone hides which workspace burned it, by workspace alone loses
   * which customer to bill. Both are null on the non-tenant axes, which sum
   * across every subject.
   */
  tenantId: string | null;
  workspaceId: string | null;
  applicationId: string | null;
  applicationType: ApplicationType | null;
  providerCode: string | null;
  modelCode: string | null;
  endpointCode: string | null;
  productCode: string | null;
  requests: string;
  inputTokens: string;
  outputTokens: string;
  totalTokens: string;
  errors: string;
}

/**
 * The wire shape of `/capability/usage-summaries` (product_251 A-4).
 *
 * An envelope rather than a bare array because `groupBy` is resolved
 * server-side (absent means `tenant`), and A-4's test is exactly that: if the
 * server decided something the caller did not send, the caller must be told,
 * and the place to tell it is the envelope - the one spot that survives an
 * empty result.
 *
 * `cycleMonth` is deliberately NOT echoed here: it is a pass-through filter
 * with no server-side default (see `normalizeUsageSummaryFilters`), so there is
 * nothing resolved to report. A-4 asks for resolved values, not for a copy of
 * the query string.
 */
export interface UsageSummaryPage {
  dimension: UsageRollupDimension;
  items: TenantUsageSummaryAdminRecord[];
}

/**
 * `state` is settable at CREATE and NOT at update. The named actions
 * (`POST :id/activate` / `:id/deactivate`) are the only way to change it after
 * that, and the reason is the audit trail rather than tidiness: `AuditMiddleware`
 * derives `action` from the path, so a deactivation done through the update
 * route is recorded as `action='update'` while the same real operation through
 * the named route is `action='deactivate'`. An auditor filtering
 * `?action=deactivate` silently misses every one of the former.
 */
export type CreateModelProviderBody = Partial<
  Omit<CreateModelProviderInput, "config" | "isActive">
> & {
  config?: ModelConfig | null;
  state?: ObjectState;
};

export type UpdateModelProviderBody = Partial<
  Omit<UpdateModelProviderInput, "config" | "isActive">
> & {
  config?: ModelConfig | null;
};

export type CreateAiModelBody = Partial<
  Omit<CreateAiModelInput, "config" | "isActive">
> & {
  config?: ModelConfig | null;
  state?: ObjectState;
  keyReference?: ModelKeyReferenceInput | null;
  /** @deprecated P3 控制面输入兼容字段；响应不再暴露该字段。 */
  apiKeyEnvVar?: string | null;
};

export type UpdateAiModelBody = Partial<
  Omit<UpdateAiModelInput, "config" | "isActive">
> & {
  config?: ModelConfig | null;
  keyReference?: ModelKeyReferenceInput | null;
  /** @deprecated P3 控制面输入兼容字段；响应不再暴露该字段。 */
  apiKeyEnvVar?: string | null;
};

export type CreateAiModelGrantBody = {
  modelId?: string;
  tenantId?: string;
  applicationId?: string | null;
  applicationType?: ApplicationType | null;
  agentId?: string | null;
  taskProfile?: string | null;
  priority?: number | null;
  reason?: string | null;
  expiresAt?: string | null;
  state?: ObjectState;
};

export type UpdateAiModelGrantBody = {
  applicationId?: string | null;
  applicationType?: ApplicationType | null;
  agentId?: string | null;
  taskProfile?: string | null;
  priority?: number | null;
  reason?: string | null;
  expiresAt?: string | null;
};

export type CreateModelPriceRuleBody = {
  modelId?: string;
  billingMode?: string;
  currency?: string;
  unitTokens?: number | null;
  inputUnitPrice?: string | number | null;
  outputUnitPrice?: string | number | null;
  requestUnitPrice?: string | number | null;
  cachedInputUnitPrice?: string | number | null;
  cacheWriteUnitPrice?: string | number | null;
  cacheWrite1hUnitPrice?: string | number | null;
  effectiveAt?: string | null;
  expiresAt?: string | null;
  state?: ObjectState;
};

export type UpdateModelPriceRuleBody = Partial<
  Omit<CreateModelPriceRuleBody, "modelId" | "state">
>;

export type CreateModelPolicyBody = {
  modelId?: string;
  tenantId?: string | null;
  name?: string | null;
  priority?: number | null;
  maxConcurrent?: number | null;
  rateLimitRpm?: number | null;
  rateLimitTpm?: string | number | bigint | null;
  rateLimitTpd?: string | number | bigint | null;
  maxContextTokens?: number | null;
  effectiveAt?: string | null;
  expiresAt?: string | null;
  state?: ObjectState;
};

export type UpdateModelPolicyBody = Partial<
  Omit<CreateModelPolicyBody, "modelId" | "state">
>;

export interface ProtocolCatalogEntry {
  protocol: string;
  description: string;
  knownUpstreams: string[];
  aliases: string[];
  wireDefaults: ResolvedWire;
}

export interface ProtocolCatalogResponse {
  wireSchemaVersion: number;
  protocols: ProtocolCatalogEntry[];
}

@Injectable()
export class ModelAdminService {
  constructor(
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
  ) {}

  /**
   * 管理面下拉数据源：可选的 protocol，以及每个 protocol 的 `wire` 默认值。
   *
   * 之所以由服务端出而不是让前端硬编码：这份词表和默认值是**代码里的**事实，
   * 硬编码到 portal 就意味着每次加一个 protocol 要改两个仓库、发两次版，
   * 正是本设计要消除的那种耦合。
   */
  getProtocolCatalog(): ProtocolCatalogResponse {
    return {
      wireSchemaVersion: WIRE_SCHEMA_VERSION,
      protocols: PROTOCOL_CATALOG.map((entry) => ({
        ...entry,
        knownUpstreams: [...entry.knownUpstreams],
        aliases: [...entry.aliases],
        wireDefaults:
          entry.protocol === "anthropic-messages"
            ? ANTHROPIC_WIRE_DEFAULTS
            : OPENAI_WIRE_DEFAULTS,
      })),
    };
  }

  async listProviders(
    includeInactive = true,
  ): Promise<ModelProviderAdminRecord[]> {
    const [providers, traffic, modelCounts] = await Promise.all([
      this.repository.listProviders(includeInactive),
      metricsRegistry.snapshotProviderTraffic(),
      this.repository.countModelsByProvider(),
    ]);
    const trafficByProvider = new Map(
      traffic.map((entry) => [entry.provider, entry]),
    );
    return providers.map((provider) =>
      mapProvider(
        provider,
        trafficByProvider.get(provider.providerCode),
        modelCounts.get(provider.id) ?? 0,
      ),
    );
  }

  /** See `GatewayPerformanceResponse`. */
  async getGatewayPerformance(): Promise<GatewayPerformanceResponse> {
    const [traffic, inFlightRequests] = await Promise.all([
      metricsRegistry.snapshotProviderTraffic(),
      metricsRegistry.getInFlightRequests(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      processStartedAt: metricsRegistry.getProcessStartedAt(),
      inFlightRequests,
      providers: traffic.map((entry) => ({
        provider: entry.provider,
        attempts: entry.attempts,
        successes: entry.successes,
        errors: entry.errors,
        errorRate: entry.attempts > 0 ? entry.errors / entry.attempts : null,
        avgLatencyMs: entry.avgLatencyMs,
        p50LatencyMs: entry.p50LatencyMs,
        p95LatencyMs: entry.p95LatencyMs,
        lastObservedAt: entry.lastObservedAt,
      })),
    };
  }

  /**
   * `provider_code` carries a plain unique index that a soft-deleted row
   * still occupies (`deleteProvider` never hard-deletes), so re-creating
   * under a previously-used code is a foreseeable operator action, not an
   * edge case - check first rather than let Prisma's P2002 surface as an
   * unhandled 500.
   */
  async createProvider(
    body: CreateModelProviderBody,
  ): Promise<ModelProviderAdminRecord> {
    const input = this.normalizeCreateProvider(body);
    const existing = await this.repository.findProviderByCode(
      input.providerCode,
    );

    if (existing && existing.deletedAt === null) {
      throw new ModelAdminException(
        HttpStatus.CONFLICT,
        "MODEL_ADMIN_PROVIDER_CODE_TAKEN",
        `Provider code "${input.providerCode}" is already in use`,
        { providerCode: input.providerCode },
      );
    }

    if (existing) {
      // providerCode/providerType excluded - immutable after creation
      // (db-init column lock, see normalizeUpdateProvider), and providerCode
      // is what we just matched on anyway.
      const { providerCode: _code, providerType: _type, ...revive } = input;
      const provider = await this.repository.restoreProvider(
        existing.id,
        revive,
      );
      return mapProvider(provider);
    }

    const provider = await this.repository.createProvider(input);
    return mapProvider(provider);
  }

  async updateProvider(
    providerId: string,
    body: UpdateModelProviderBody,
  ): Promise<ModelProviderAdminRecord> {
    await this.assertProviderExists(providerId);
    const input = this.normalizeUpdateProvider(body);
    const provider = await this.repository.updateProvider(providerId, input);
    return mapProvider(provider);
  }

  async setProviderActive(
    providerId: string,
    isActive: boolean,
  ): Promise<ModelProviderAdminRecord> {
    await this.assertProviderExists(providerId);
    const provider = await this.repository.updateProvider(providerId, {
      isActive,
    });
    return mapProvider(provider);
  }

  /**
   * Two preconditions, both refusals rather than cascades.
   *
   * A cascade would let a single click silently revoke access the tenants
   * never agreed to give up. Requiring the caller
   * to empty it first makes that sequence explicit and reversible at each
   * step.
   *
   * Requiring deactivation first means nothing goes from serving traffic to
   * gone in one action: deactivate (visible, reversible), see what breaks,
   * then delete.
   */
  async deleteProvider(providerId: string): Promise<ModelProviderAdminRecord> {
    const provider = await this.assertProviderExists(providerId);
    assertDeactivated(provider.isActive, "provider", providerId);

    const modelCount =
      (await this.repository.countModelsByProvider()).get(providerId) ?? 0;
    if (modelCount > 0) {
      const models = await this.repository.listModels(true, { providerId });
      throw new ModelAdminException(
        HttpStatus.CONFLICT,
        "MODEL_ADMIN_HAS_DEPENDENTS",
        `provider still has ${modelCount} model(s) - delete or reassign them first`,
        {
          providerId,
          // The blockers, not just the count: an operator told only "you
          // cannot" has to go hunting for what to remove.
          blockedBy: models.map((model) => ({
            type: "model",
            id: model.id,
            label: model.modelCode,
          })),
        },
      );
    }

    const deleted = await this.repository.deleteProvider(providerId);
    return mapProvider(deleted);
  }

  // ── product_endpoint_grants (incr/06) ───────────────────────────────────

  async listProductGrants(filters: {
    productCode?: string;
    endpointCode?: string;
    includeInactive?: boolean;
  }): Promise<ProductGrantAdminRecord[]> {
    const grants = await this.repository.listProductGrants(filters);
    return grants.map(mapProductGrant);
  }

  async createProductGrant(
    body: CreateProductGrantBody,
  ): Promise<ProductGrantAdminRecord> {
    const productCode = requiredString(body.productCode, "productCode");
    const endpointCode = requiredString(body.endpointCode, "endpointCode");

    // Validated against any non-deleted endpoint, active or not - preparing a
    // grant ahead of activating the entry point it names is a legitimate
    // sequence, the same allowance `assertModelCodeExists` makes.
    const endpoint = await this.repository.findEndpointByCode(endpointCode);
    if (!endpoint || endpoint.deletedAt) {
      throw new ModelAdminException(
        HttpStatus.BAD_REQUEST,
        "MODEL_ADMIN_VALIDATION_FAILED",
        `endpointCode "${endpointCode}" does not match any endpoint`,
        { field: "endpointCode", endpointCode },
      );
    }

    const applicationId = optionalString(body.applicationId);
    const applicationType =
      body.applicationType !== undefined && body.applicationType !== null
        ? normalizeApplicationType(body.applicationType, "applicationType")
        : null;
    validateApplicationScope({ applicationId, applicationType });

    return mapProductGrant(
      await this.repository.createProductGrant({
        productCode,
        endpointCode,
        applicationId,
        applicationType,
        reason: optionalString(body.reason),
        expiresAt: parseDateOrNull(body.expiresAt),
        isActive: body.state === undefined ? true : isActiveState(body.state),
      }),
    );
  }

  async updateProductGrant(
    id: string,
    body: UpdateProductGrantBody,
  ): Promise<ProductGrantAdminRecord> {
    await this.assertProductGrantExists(id);

    // productCode/endpointCode are the grant's identity. Repointing one is a
    // different authorization decision, so it is a new grant plus a revoke of
    // the old - which leaves both visible in the audit trail, where an in-place
    // edit would leave only the destination.
    if (body.productCode !== undefined || body.endpointCode !== undefined) {
      throwValidationError(
        "productCode and endpointCode are immutable - revoke this grant and create the one you want",
        body.productCode !== undefined ? "productCode" : "endpointCode",
      );
    }

    const applicationId = optionalString(body.applicationId);
    const applicationType =
      body.applicationType !== undefined && body.applicationType !== null
        ? normalizeApplicationType(body.applicationType, "applicationType")
        : null;
    validateApplicationScope({ applicationId, applicationType });

    return mapProductGrant(
      await this.repository.updateProductGrant(id, {
        applicationId,
        applicationType,
        ...(body.reason !== undefined
          ? { reason: optionalString(body.reason) }
          : {}),
        ...(body.expiresAt !== undefined
          ? { expiresAt: parseDateOrNull(body.expiresAt) }
          : {}),
      }),
    );
  }

  async setProductGrantActive(
    id: string,
    isActive: boolean,
  ): Promise<ProductGrantAdminRecord> {
    await this.assertProductGrantExists(id);
    return mapProductGrant(
      await this.repository.updateProductGrant(id, { isActive }),
    );
  }

  async deleteProductGrant(id: string): Promise<ProductGrantAdminRecord> {
    const grant = await this.assertProductGrantExists(id);
    // Same two-step as every other resource: nothing goes from authorizing
    // live traffic to gone in one action.
    assertDeactivated(grant.isActive, "product grant", id);
    return mapProductGrant(await this.repository.deleteProductGrant(id));
  }

  private async assertProductGrantExists(
    id: string,
  ): Promise<ProductEndpointGrantRecord> {
    const grant = await this.repository.findProductGrantById(id);
    if (!grant) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_PRODUCT_GRANT_NOT_FOUND",
        `product grant "${id}" was not found`,
      );
    }
    return grant;
  }

  // ── model_endpoints ─────────────────────────────────────────────────────

  async listEndpoints(
    includeInactive = true,
    filters: { modelCode?: string } = {},
  ): Promise<ModelEndpointAdminRecord[]> {
    const [endpoints, availability] = await Promise.all([
      this.repository.listEndpoints(includeInactive, filters),
      this.modelAvailabilityIndex(),
    ]);

    return endpoints.map((endpoint) =>
      mapEndpoint(
        endpoint,
        [endpoint.primaryModelCode, endpoint.fallbackModelCode]
          .filter((code): code is string => Boolean(code))
          .map((modelCode) => ({
            modelCode,
            availability: modelAvailability(availability.get(modelCode)),
          })),
      ),
    );
  }

  /**
   * modelCode -> whether it and its provider are active. Built once per list
   * call rather than per endpoint; the registry is small and bounded, and the
   * alternative is a query per reference.
   */
  private async modelAvailabilityIndex(): Promise<
    Map<string, { isActive: boolean; providerActive: boolean }>
  > {
    const models = await this.repository.listModels(true);
    return new Map(
      models.map((model) => [
        model.modelCode,
        {
          // Internal index, not an API record - stays boolean. The M-B3
          // rename is a contract change and applies at the mapping boundary;
          // pushing it inward would be churn with no reader.
          isActive: model.isActive,
          // A model whose provider row is gone cannot serve either; treating
          // an absent provider as active would hide exactly that case.
          providerActive: model.providerActive ?? false,
        },
      ]),
    );
  }

  /**
   * `code` carries a plain unique index that a soft-deleted row still
   * occupies (`deleteEndpoint` never hard-deletes) - same shape as
   * `createProvider`, revive on conflict rather than 500 on P2002.
   */
  async createEndpoint(
    body: CreateModelEndpointBody,
  ): Promise<ModelEndpointAdminRecord> {
    const input = await this.normalizeCreateEndpoint(body);
    const existing = await this.repository.findEndpointByCode(input.code);

    if (existing && existing.deletedAt === null) {
      throw new ModelAdminException(
        HttpStatus.CONFLICT,
        "MODEL_ADMIN_ENDPOINT_CODE_TAKEN",
        `Endpoint code "${input.code}" is already in use`,
        { endpointCode: input.code },
      );
    }

    if (existing) {
      // code excluded - immutable after creation, and it's what we just
      // matched on anyway.
      const { code: _code, ...revive } = input;
      const endpoint = await this.repository.restoreEndpoint(
        existing.id,
        revive,
      );
      return mapEndpoint(endpoint);
    }

    const endpoint = await this.repository.createEndpoint(input);
    return mapEndpoint(endpoint);
  }

  async updateEndpoint(
    endpointId: string,
    body: UpdateModelEndpointBody,
  ): Promise<ModelEndpointAdminRecord> {
    await this.assertEndpointExists(endpointId);
    const input = await this.normalizeUpdateEndpoint(body);
    const endpoint = await this.repository.updateEndpoint(endpointId, input);
    return mapEndpoint(endpoint);
  }

  async setEndpointActive(
    endpointId: string,
    isActive: boolean,
  ): Promise<ModelEndpointAdminRecord> {
    await this.assertEndpointExists(endpointId);
    const endpoint = await this.repository.updateEndpoint(endpointId, {
      isActive,
    });
    return mapEndpoint(endpoint);
  }

  async deleteEndpoint(
    endpointId: string,
  ): Promise<ModelEndpointAdminRecord> {
    const existing = await this.assertEndpointExists(endpointId);
    // No dependents to check - nothing references an endpoint inside Atlas.
    // But callers hard-code its `code`, so deactivating first is what lets an
    // operator see the 404s before the row is gone.
    assertDeactivated(existing.isActive, "endpoint", endpointId);
    const endpoint = await this.repository.deleteEndpoint(endpointId);
    return mapEndpoint(endpoint);
  }

  async listModels(
    includeInactive = true,
    filters: { providerId?: string } = {},
  ): Promise<AiModelAdminRecord[]> {
    const models = await this.repository.listModels(includeInactive, filters);
    const [grants, endpointRefs] = await Promise.all([
      this.repository.countGrantsByModel(),
      this.repository.countEndpointRefsByModelCode(),
    ]);
    return models.map((model) =>
      mapModel(
        model,
        grants.get(model.id) ?? 0,
        endpointRefs.get(model.modelCode) ?? 0,
      ),
    );
  }

  async createModel(body: CreateAiModelBody): Promise<AiModelAdminRecord> {
    const input = this.normalizeCreateModel(body);
    const model = await this.repository.createModel(input);
    return mapModel(model);
  }

  async updateModel(
    modelId: string,
    body: UpdateAiModelBody,
  ): Promise<AiModelAdminRecord> {
    await this.assertModelExists(modelId);
    const input = this.normalizeUpdateModel(body);
    const model = await this.repository.updateModel(modelId, input);
    return mapModel(model);
  }

  async setModelActive(
    modelId: string,
    isActive: boolean,
  ): Promise<AiModelAdminRecord> {
    await this.assertModelExists(modelId);
    const model = await this.repository.updateModel(modelId, { isActive });
    return mapModel(model);
  }

  /**
   * Retire a model with notice, or take the notice back (product_251 X-4).
   *
   * Deliberately does NOT touch `isActive`: a deprecated model still serves,
   * which is the entire point - "stop building on this" is a different
   * statement from "this stopped working", and collapsing them is what left a
   * consumer with no warning before a 404.
   *
   * A named action rather than a field on update, same as activate/deactivate:
   * the audit `action` is derived from the path, so this way "who deprecated
   * this model" is answerable with `?action=deprecate` instead of being buried
   * among every other edit.
   */
  async setModelDeprecated(
    modelId: string,
    deprecated: boolean,
  ): Promise<AiModelAdminRecord> {
    await this.assertModelExists(modelId);
    const model = await this.repository.updateModel(modelId, {
      deprecatedAt: deprecated ? new Date() : null,
    });
    return mapModel(model);
  }

  async deleteModel(modelId: string): Promise<AiModelAdminRecord> {
    const model = await this.assertModelExists(modelId);
    assertDeactivated(model.isActive, "model", modelId);

    const [grants, endpointRefs] = await Promise.all([
      this.repository.countGrantsByModel(),
      this.repository.countEndpointRefsByModelCode(),
    ]);
    const grantCount = grants.get(modelId) ?? 0;
    const refCount = endpointRefs.get(model.modelCode) ?? 0;

    if (grantCount > 0 || refCount > 0) {
      const endpoints = await this.repository.listEndpoints(true, {
        modelCode: model.modelCode,
      });
      throw new ModelAdminException(
        HttpStatus.CONFLICT,
        "MODEL_ADMIN_HAS_DEPENDENTS",
        `model still has ${grantCount} grant(s) and ${refCount} endpoint reference(s) - remove them first`,
        {
          modelId,
          modelCode: model.modelCode,
          blockedBy: [
            ...(grantCount > 0
              ? [{ type: "grant", id: modelId, label: `${grantCount} grant(s)` }]
              : []),
            ...endpoints.map((endpoint) => ({
              type: "endpoint",
              id: endpoint.id,
              label: endpoint.code,
            })),
          ],
        },
      );
    }

    const deleted = await this.repository.deleteModel(modelId);
    return mapModel(deleted);
  }

  async listGrants(filters: {
    tenantId?: string;
    modelId?: string;
    applicationId?: string;
    applicationType?: ApplicationType;
  }): Promise<AiModelGrantAdminRecord[]> {
    const grants = await this.repository.listGrants(
      normalizeGrantFilters(filters),
    );
    return grants.map(mapGrant);
  }

  async createGrant(
    body: CreateAiModelGrantBody,
  ): Promise<AiModelGrantAdminRecord> {
    const input = await this.normalizeCreateGrant(body);
    const grant = await this.repository.createGrant(input);
    return mapGrant(grant);
  }

  async updateGrant(
    grantId: string,
    body: UpdateAiModelGrantBody,
  ): Promise<AiModelGrantAdminRecord> {
    await this.assertGrantExists(grantId);
    const input = this.normalizeUpdateGrant(body);
    const grant = await this.repository.updateGrant(grantId, input);
    return mapGrant(grant);
  }

  async setGrantActive(
    grantId: string,
    isActive: boolean,
  ): Promise<AiModelGrantAdminRecord> {
    await this.assertGrantExists(grantId);
    const grant = await this.repository.updateGrant(grantId, { isActive });
    return mapGrant(grant);
  }

  /**
   * Model grants were the one delete on this plane with no deactivation
   * precondition - `assertGrantExists` and straight to soft delete - while
   * three documents said otherwise (`docs/20-specs/10-http-surface.md`,
   * `docs/30-design/110-management-plane.md`, and the comment on
   * `assertDeactivated` itself: "nothing on this plane goes from serving
   * traffic to gone in a single action").
   *
   * It is not a formality. A grant is what a tenant's traffic authorizes
   * against, so deleting an active one stops that traffic on the next call,
   * and the deactivate step is where an operator finds out - reversibly.
   */
  async deleteGrant(grantId: string): Promise<AiModelGrantAdminRecord> {
    const existing = await this.assertGrantExists(grantId);
    assertDeactivated(existing.isActive, "grant", grantId);
    const grant = await this.repository.deleteGrant(grantId);
    return mapGrant(grant);
  }

  /**
   * `asOf` answers "which rule was in force at this instant" - the question
   * append-versioning exists to make answerable, and the reason a price rule
   * is expired rather than deleted. Pass `now` for the current rate, or a
   * past timestamp to reconstruct what a historical invoice was priced at.
   */
  async listPriceRules(filters: {
    modelId?: string;
    includeInactive?: string;
    asOf?: string;
  }): Promise<ModelPriceRuleAdminRecord[]> {
    const rules = await this.repository.listPriceRules({
      ...(filters.modelId !== undefined
        ? { modelId: requiredString(filters.modelId, "modelId") }
        : {}),
      includeInactive: filters.includeInactive !== "false",
      ...(filters.asOf !== undefined
        ? { asOf: parseAsOf(filters.asOf) }
        : {}),
    });
    return rules.map(mapPriceRule);
  }

  async createPriceRule(
    body: CreateModelPriceRuleBody,
  ): Promise<ModelPriceRuleAdminRecord> {
    const input = await this.normalizeCreatePriceRule(body);
    const rule = await this.repository.createPriceRule(input);
    return mapPriceRule(rule);
  }

  async updatePriceRule(
    priceRuleId: string,
    body: UpdateModelPriceRuleBody,
  ): Promise<ModelPriceRuleAdminRecord> {
    await this.assertPriceRuleExists(priceRuleId);
    const input = this.normalizeUpdatePriceRule(body);
    const rule = await this.repository.updatePriceRule(priceRuleId, input);
    return mapPriceRule(rule);
  }

/**
   * Deletes here are soft, and history lives in `audit.change_records`, not
   * the row.
   */
  async deletePriceRule(id: string): Promise<ModelPriceRuleAdminRecord> {
    const existing = await this.assertPriceRuleExists(id);
    assertDeactivated(existing.isActive, "price rule", id);
    return mapPriceRule(await this.repository.deletePriceRule(id));
  }

  async deletePolicy(id: string): Promise<ModelPolicyAdminRecord> {
    const existing = await this.assertPolicyExists(id);
    assertDeactivated(existing.isActive, "policy", id);
    return mapPolicy(await this.repository.deletePolicy(id));
  }

    async setPriceRuleActive(
    priceRuleId: string,
    isActive: boolean,
  ): Promise<ModelPriceRuleAdminRecord> {
    await this.assertPriceRuleExists(priceRuleId);
    const rule = await this.repository.updatePriceRule(priceRuleId, {
      isActive,
    });
    return mapPriceRule(rule);
  }

  async listPolicies(filters: {
    modelId?: string;
    tenantId?: string;
    includeInactive?: string;
  }): Promise<ModelPolicyAdminRecord[]> {
    const policies = await this.repository.listPolicies({
      ...(filters.modelId !== undefined
        ? { modelId: requiredString(filters.modelId, "modelId") }
        : {}),
      ...(filters.tenantId !== undefined
        ? { tenantId: requiredString(filters.tenantId, "tenantId") }
        : {}),
      includeInactive: filters.includeInactive !== "false",
    });
    return policies.map(mapPolicy);
  }

  async createPolicy(
    body: CreateModelPolicyBody,
  ): Promise<ModelPolicyAdminRecord> {
    const input = await this.normalizeCreatePolicy(body);
    const policy = await this.repository.createPolicy(input);
    return mapPolicy(policy);
  }

  async updatePolicy(
    policyId: string,
    body: UpdateModelPolicyBody,
  ): Promise<ModelPolicyAdminRecord> {
    await this.assertPolicyExists(policyId);
    const input = this.normalizeUpdatePolicy(body);
    const policy = await this.repository.updatePolicy(policyId, input);
    return mapPolicy(policy);
  }

  async setPolicyActive(
    policyId: string,
    isActive: boolean,
  ): Promise<ModelPolicyAdminRecord> {
    await this.assertPolicyExists(policyId);
    const policy = await this.repository.updatePolicy(policyId, { isActive });
    return mapPolicy(policy);
  }

  /**
   * Honestly not implemented, not silently empty.
   * Per-workspace quota resolves via C2
   * (`PlatformEntitlementClient`) - but the platform exposes only
   * `GET /platform/entitlements?workspace_id=`, no bulk/list endpoint, so
   * there is no way to answer "every tenant's quota" in one call. Returning
   * `[]` here would read as "no tenant has a quota", which is false; 501 says
   * what is actually true.
   */
  listTenantQuotas(_filters: {
    tenantId?: string;
    includeExpired?: string;
  }): Promise<TenantQuotaAdminRecord[]> {
    throw new ModelAdminException(
      HttpStatus.NOT_IMPLEMENTED,
      "MODEL_ADMIN_NOT_IMPLEMENTED",
      "Bulk quota listing across tenants is not available - the platform exposes only a single-workspace entitlement read",
    );
  }

  async listUsageSummaries(filters: {
    tenantId?: string;
    applicationId?: string;
    applicationType?: ApplicationType;
    cycleMonth?: string;
    providerCode?: string;
    modelCode?: string;
    endpointCode?: string;
    productCode?: string;
    groupBy?: string;
  }): Promise<UsageSummaryPage> {
    const dimension = normalizeUsageRollupDimension(filters.groupBy);
    const normalized = normalizeUsageSummaryFilters(filters);

    if (dimension === "tenant") {
      const summaries = await this.repository.listUsageSummaries(normalized);
      return { dimension, items: summaries.map(mapUsageSummary) };
    }

    const rows = await this.repository.listUsageRollup({
      ...normalized,
      dimension,
    });
    return { dimension, items: rows.map((row) => mapUsageRollup(dimension, row)) };
  }

  private normalizeCreateProvider(
    body: CreateModelProviderBody,
  ): CreateModelProviderInput {
    return {
      providerCode: requiredString(body.providerCode, "providerCode"),
      providerType: body.providerType
        ? requiredString(body.providerType, "providerType")
        : "online",
      providerName: requiredString(body.providerName, "providerName"),
      description: optionalString(body.description),
      logoUrl: optionalUrl(body.logoUrl, "logoUrl"),
      homepageUrl: optionalUrl(body.homepageUrl, "homepageUrl"),
      consoleUrl: optionalUrl(body.consoleUrl, "consoleUrl"),
      billingUrl: optionalUrl(body.billingUrl, "billingUrl"),
      config: sanitizeWritableConfig(body.config ?? null),
      isActive: body.state === undefined ? true : isActiveState(body.state),
    };
  }

  private normalizeUpdateProvider(
    body: UpdateModelProviderBody,
  ): UpdateModelProviderInput {
    // providerCode/providerType are immutable after creation - the DB grants
    // (db-init column locks) only give atlas_svc INSERT/SELECT on these two
    // columns, no UPDATE. Reject here with a clean 400 rather than let an
    // attempted change hit Postgres and surface as an unhandled 500 (found
    // live while fixing the sibling P2002-on-create gap).
    if (body.providerCode !== undefined) {
      throw new ModelAdminException(
        HttpStatus.BAD_REQUEST,
        "MODEL_ADMIN_VALIDATION_FAILED",
        "providerCode cannot be changed after creation",
        { field: "providerCode" },
      );
    }
    if (body.providerType !== undefined) {
      throw new ModelAdminException(
        HttpStatus.BAD_REQUEST,
        "MODEL_ADMIN_VALIDATION_FAILED",
        "providerType cannot be changed after creation",
        { field: "providerType" },
      );
    }

    const input: UpdateModelProviderInput = {};

    if (body.providerName !== undefined)
      input.providerName = requiredString(body.providerName, "providerName");
    if (body.description !== undefined)
      input.description = optionalString(body.description);
    if (body.logoUrl !== undefined)
      input.logoUrl = optionalUrl(body.logoUrl, "logoUrl");
    if (body.homepageUrl !== undefined)
      input.homepageUrl = optionalUrl(body.homepageUrl, "homepageUrl");
    if (body.consoleUrl !== undefined)
      input.consoleUrl = optionalUrl(body.consoleUrl, "consoleUrl");
    if (body.billingUrl !== undefined)
      input.billingUrl = optionalUrl(body.billingUrl, "billingUrl");
    if (body.config !== undefined)
      input.config = sanitizeWritableConfig(body.config);

    return input;
  }

  private async normalizeCreateEndpoint(
    body: CreateModelEndpointBody,
  ): Promise<CreateModelEndpointInput> {
    const primaryModelCode = requiredString(
      body.primaryModelCode,
      "primaryModelCode",
    );
    await this.assertModelCodeExists(primaryModelCode, "primaryModelCode");

    const fallbackModelCode = optionalString(body.fallbackModelCode);
    if (fallbackModelCode) {
      await this.assertModelCodeExists(fallbackModelCode, "fallbackModelCode");
    }

    return {
      code: requiredString(body.code, "code"),
      category: body.category
        ? requiredString(body.category, "category")
        : "chat",
      primaryModelCode,
      fallbackModelCode,
      isActive: body.state === undefined ? true : isActiveState(body.state),
    };
  }

  private async normalizeUpdateEndpoint(
    body: UpdateModelEndpointBody,
  ): Promise<UpdateModelEndpointInput> {
    const input: UpdateModelEndpointInput = {};

    if (body.category !== undefined)
      input.category = requiredString(body.category, "category");
    if (body.primaryModelCode !== undefined) {
      const primaryModelCode = requiredString(
        body.primaryModelCode,
        "primaryModelCode",
      );
      await this.assertModelCodeExists(primaryModelCode, "primaryModelCode");
      input.primaryModelCode = primaryModelCode;
    }
    if (body.fallbackModelCode !== undefined) {
      const fallbackModelCode = optionalString(body.fallbackModelCode);
      if (fallbackModelCode) {
        await this.assertModelCodeExists(
          fallbackModelCode,
          "fallbackModelCode",
        );
      }
      input.fallbackModelCode = fallbackModelCode;
    }

    return input;
  }

  /**
   * Validates against `findModelByCode` (any non-deleted model, active or
   * not) rather than `findActiveModelByCode` - an operator preparing an
   * endpoint ahead of activating the model it points to is a legitimate
   * sequence, not an error.
   */
  private async assertModelCodeExists(
    modelCode: string,
    field: "primaryModelCode" | "fallbackModelCode",
  ): Promise<void> {
    const model = await this.repository.findModelByCode(modelCode);
    if (!model) {
      throw new ModelAdminException(
        HttpStatus.BAD_REQUEST,
        "MODEL_ADMIN_VALIDATION_FAILED",
        `${field} "${modelCode}" does not match any model`,
        { field, modelCode },
      );
    }
  }

  private normalizeCreateModel(body: CreateAiModelBody): CreateAiModelInput {
    const capabilities = normalizeCapabilities(body.capabilities);
    const keyReferenceName = normalizeKeyReferenceName(body);

    return {
      modelCode: requiredString(body.modelCode, "modelCode"),
      providerId: optionalString(body.providerId),
      modelName: requiredString(body.modelName, "modelName"),
      provider: requiredString(body.provider, "provider"),
      endpointUrl: requiredUrl(body.endpointUrl, "endpointUrl"),
      protocol: requiredProtocol(body.protocol),
      modelType: body.modelType ?? "chat",
      description: optionalString(body.description),
      contextWindow: optionalInt(body.contextWindow, "contextWindow"),
      maxOutputTokens: optionalInt(body.maxOutputTokens, "maxOutputTokens"),
      capabilities,
      supportsStreaming: body.supportsStreaming ?? true,
      sort: body.sort ?? 999,
      config: mergeModelConfig(
        sanitizeWritableConfig(body.config ?? null),
        keyReferenceName,
      ),
    };
  }

  /**
   * Refuse a field the database will not let `atlas_svc` write.
   *
   * `98_column_locks.sql` revokes table UPDATE and grants it back per column,
   * so a field missing from that list reaches Postgres and comes back as
   * `permission denied for table ...` - a 500 on an operator route, with no
   * type error, no test failure and no lint warning upstream of it. Prisma call
   * arguments are `Record<string, unknown>` throughout this repo, so nothing in
   * the build can see it (TD-039).
   *
   * Found by measuring rather than reading: every `Update*Input` property was
   * resolved through the TypeScript checker, mapped to its column, and the
   * UPDATE was run as `atlas_svc` against a real database. Six came back
   * `permission denied`. `scripts/guardrails/check-column-writes.mjs` now runs
   * that comparison in CI so the next one fails the build instead of a request.
   */
  private refuseUnwritableField(
    body: Record<string, unknown>,
    field: string,
    why: string,
  ): void {
    if (body[field] === undefined) return;
    throw new ModelAdminException(
      HttpStatus.BAD_REQUEST,
      "MODEL_ADMIN_VALIDATION_FAILED",
      `${field} cannot be changed after creation - ${why}`,
    );
  }

  private normalizeUpdateModel(body: UpdateAiModelBody): UpdateAiModelInput {
    const input: UpdateAiModelInput = {};

    // `modelCode` is IDENTITY and is not editable - the rule `providerCode`,
    // endpoint `code` and product-grant `productCode` already carry, and the
    // one of the four that had no guard here.
    //
    // The DATABASE already refuses it: `98_column_locks.sql` grants atlas_svc
    // INSERT/SELECT on `model.models.model_code` and no UPDATE (verified as
    // atlas_svc - the statement answers `permission denied for table models`,
    // while the same statement on `endpoint_url` succeeds). So this is not an
    // integrity hole; it is the wrong REFUSAL. Without this guard the attempt
    // reaches Postgres and surfaces as an unhandled 500, which is exactly the
    // defect `PATCH /capability/price-rules/:id` carried from the day the
    // column locks landed until 2026-08-16.
    //
    // Why the column is locked at all: `modelCode` is the version identifier
    // consumers pin against ("modelCode IS the version", sent to karda
    // 2026-07-27), and `reqlog.request_records.model_code` stores it BY VALUE
    // with no foreign key - so a rename would split the model's own metering
    // history, with nothing joining the rows on either side of it. That is a
    // billing figure.
    //
    // Repointing the model at a different upstream stays allowed on purpose
    // (`endpoint_url`, `provider_id` and `config` all carry UPDATE). What
    // changed is that it is now observable - see model-behavior-version.ts.
    if (body.modelCode !== undefined) {
      throw new ModelAdminException(
        HttpStatus.BAD_REQUEST,
        "MODEL_ADMIN_VALIDATION_FAILED",
        "modelCode cannot be changed after creation - it is the version " +
          "identifier consumers pin against, and reqlog rows reference it by " +
          "value. Register a new model and deprecate this one.",
      );
    }
    // `modelType` selects which contract layer serves this row (chat / embed /
    // rerank). The database grants no UPDATE on it, and changing it under a
    // live `modelCode` would move the model to a different surface without the
    // code changing - the exact thing `behaviorVersion` exists to make visible.
    this.refuseUnwritableField(
      body as unknown as Record<string, unknown>,
      "modelType",
      "it selects the contract layer that serves the model. Register a new " +
        "model and deprecate this one.",
    );
    // `provider` is not a column at all - it is the joined provider's code,
    // derived on read (`model-registry.repository.ts`). Accepting it here sent
    // a field to Prisma that maps to nothing.
    this.refuseUnwritableField(
      body as unknown as Record<string, unknown>,
      "provider",
      "it is derived from the owning provider on read, not stored. Use " +
        "`providerId` to move the model to another provider.",
    );
    if (body.providerId !== undefined)
      input.providerId = optionalString(body.providerId);
    if (body.modelName !== undefined)
      input.modelName = requiredString(body.modelName, "modelName");
    if (body.provider !== undefined)
      input.provider = requiredString(body.provider, "provider");
    if (body.endpointUrl !== undefined)
      input.endpointUrl = requiredUrl(body.endpointUrl, "endpointUrl");
    if (body.protocol !== undefined)
      input.protocol = requiredProtocol(body.protocol);
    if (body.modelType !== undefined)
      input.modelType = requiredString(body.modelType, "modelType");
    if (body.description !== undefined)
      input.description = optionalString(body.description);
    if (body.contextWindow !== undefined)
      input.contextWindow = optionalInt(body.contextWindow, "contextWindow");
    if (body.maxOutputTokens !== undefined)
      input.maxOutputTokens = optionalInt(
        body.maxOutputTokens,
        "maxOutputTokens",
      );
    if (body.capabilities !== undefined)
      input.capabilities = normalizeCapabilities(body.capabilities);
    if (body.supportsStreaming !== undefined)
      input.supportsStreaming = body.supportsStreaming;
    if (body.sort !== undefined) input.sort = body.sort;
    if (body.config !== undefined || hasKeyReferenceInput(body)) {
      input.config = mergeModelConfig(
        sanitizeWritableConfig(body.config ?? null),
        normalizeKeyReferenceName(body),
      );
    }

    return input;
  }

  private async normalizeCreateGrant(
    body: CreateAiModelGrantBody,
  ): Promise<CreateAiModelGrantInput> {
    const modelId = requiredString(body.modelId, "modelId");
    await this.assertModelExists(modelId);
    const agentId = optionalString(body.agentId);
    const applicationId = optionalString(body.applicationId ?? agentId);
    const applicationType =
      body.applicationType !== undefined && body.applicationType !== null
        ? normalizeApplicationType(body.applicationType, "applicationType")
        : agentId
          ? "agent"
          : null;

    validateApplicationScope({ applicationId, applicationType });

    return {
      modelId,
      tenantId: requiredString(body.tenantId, "tenantId"),
      applicationId,
      applicationType,
      agentId,
      taskProfile: optionalString(body.taskProfile),
      priority: parsePriority(body.priority),
      reason: optionalString(body.reason),
      expiresAt: parseDateOrNull(body.expiresAt),
      isActive: body.state === undefined ? true : isActiveState(body.state),
    };
  }

  private normalizeUpdateGrant(
    body: UpdateAiModelGrantBody,
  ): UpdateAiModelGrantInput {
    const input: UpdateAiModelGrantInput = {};

    // The application scope is fixed at create on the TENANT axis. The database
    // grants `atlas_svc` no UPDATE on `application_id`, `application_type` or
    // `agent_id`, so these three reached Postgres and came back
    // `permission denied for table model_grants` - a 500 (TD-039, measured
    // 2026-08-17 as atlas_svc).
    //
    // Note the asymmetry, which is NOT resolved here: the sibling
    // `product_endpoint_grants` DOES carry UPDATE on `application_id` and
    // `application_type`. Two grant resources, two rules. Whether the tenant
    // axis should match its sibling is a design question with a DDL increment
    // behind it - TD-043. Until that is decided, refusing with a 400 that says
    // what to do instead is strictly better than the 500 this was.
    for (const field of ["agentId", "applicationId", "applicationType"]) {
      this.refuseUnwritableField(
        body as unknown as Record<string, unknown>,
        field,
        "the application scope of a tenant grant is fixed at create. " +
          "Deactivate this grant and create the one you want - which also " +
          "leaves both in the audit trail.",
      );
    }

    const updatesApplicationId =
      body.applicationId !== undefined || body.agentId !== undefined;
    const updatesApplicationType =
      body.applicationType !== undefined || body.agentId !== undefined;

    if (body.agentId !== undefined) {
      const agentId = optionalString(body.agentId);
      input.agentId = agentId;
      if (body.applicationId === undefined) {
        input.applicationId = agentId;
        input.applicationType = agentId ? "agent" : null;
      }
    }
    if (body.applicationId !== undefined)
      input.applicationId = optionalString(body.applicationId);
    if (body.applicationType !== undefined)
      input.applicationType =
        body.applicationType === null
          ? null
          : normalizeApplicationType(body.applicationType, "applicationType");
    if (body.taskProfile !== undefined)
      input.taskProfile = optionalString(body.taskProfile);
    if (body.priority !== undefined)
      input.priority = parsePriority(body.priority);
    if (body.reason !== undefined) input.reason = optionalString(body.reason);
    if (body.expiresAt !== undefined)
      input.expiresAt = parseDateOrNull(body.expiresAt);

    if (updatesApplicationId || updatesApplicationType) {
      const applicationId = updatesApplicationId
        ? (input.applicationId ?? null)
        : null;
      const applicationType = updatesApplicationType
        ? (input.applicationType ?? null)
        : null;

      validateApplicationScope({
        applicationId,
        applicationType,
      });
    }

    return input;
  }

  private async normalizeCreatePriceRule(
    body: CreateModelPriceRuleBody,
  ): Promise<CreateModelPriceRuleInput> {
    const modelId = requiredString(body.modelId, "modelId");
    await this.assertModelExists(modelId);

    return {
      modelId,
      billingMode: body.billingMode
        ? requiredString(body.billingMode, "billingMode")
        : "token",
      currency: body.currency
        ? requiredString(body.currency, "currency").toUpperCase()
        : "CNY",
      unitTokens: parsePositiveInt(body.unitTokens, "unitTokens", 1000000),
      inputUnitPrice: parseDecimalText(
        body.inputUnitPrice,
        "inputUnitPrice",
        "0",
      ),
      outputUnitPrice: parseDecimalText(
        body.outputUnitPrice,
        "outputUnitPrice",
        "0",
      ),
      requestUnitPrice: parseDecimalText(
        body.requestUnitPrice,
        "requestUnitPrice",
        "0",
      ),
      // No "0" fallback, unlike the three above: absent must leave the column
      // NULL. A 0 would claim cached input is free, which is false for every
      // provider - see incr/02.
      ...(body.cachedInputUnitPrice === undefined
        ? {}
        : {
            cachedInputUnitPrice:
              body.cachedInputUnitPrice === null ||
              body.cachedInputUnitPrice === ""
                ? null
                : parseDecimalText(
                    body.cachedInputUnitPrice,
                    "cachedInputUnitPrice",
                  ),
          }),
      // TD-057. Same rule as the cached rate: absent or empty stays NULL.
      ...optionalRate(body.cacheWriteUnitPrice, "cacheWriteUnitPrice"),
      ...optionalRate(body.cacheWrite1hUnitPrice, "cacheWrite1hUnitPrice"),
      effectiveAt: parseDateOrNow(body.effectiveAt, "effectiveAt"),
      expiresAt: parseDateOrNull(body.expiresAt),
      isActive: body.state === undefined ? true : isActiveState(body.state),
    };
  }

  /**
   * A price rule is versioned by APPEND: a new row supersedes the old one, and
   * `?asOf=` reads whichever was in force at a given moment. That is not a
   * convention - `98_column_locks.sql` revokes UPDATE on the table and grants
   * back only `is_active`, `expires_at`, `deleted_at`, `updated_by`,
   * `updated_at`, so the value columns are not writable by `atlas_svc` at all.
   *
   * This route accepted all of them anyway. Every one of billingMode /
   * currency / unitTokens / inputUnitPrice / outputUnitPrice /
   * requestUnitPrice / effectiveAt reached Postgres as an UPDATE on a column
   * the service role cannot write, so the operator got `permission denied for
   * table model_price_rules` as a 500 - verified against postgres:18 with the
   * full DDL sequence applied, 2026-08-16.
   *
   * So this is not a capability being taken away. It is a form that never
   * worked being replaced by the refusal it should always have given, naming
   * the two-call path that does work and is already implemented:
   * `POST /capability/price-rules` for the new version, then `PATCH` the old
   * one's `expiresAt`.
   *
   * Rewriting a price in place would also be wrong on its own terms: every
   * reqlog row already billed under the old rule cites it, and `?asOf=` would
   * start answering with numbers that were never charged.
   */
  private normalizeUpdatePriceRule(
    body: UpdateModelPriceRuleBody,
  ): UpdateModelPriceRuleInput {
    const APPEND_ONLY_FIELDS = [
      "billingMode",
      "currency",
      "unitTokens",
      "inputUnitPrice",
      "outputUnitPrice",
      "requestUnitPrice",
      // TD-047. A value column like the three above: the database grants no
      // UPDATE on it, so accepting it here would produce `permission denied
      // for table model_price_rules` as a 500 - exactly the failure this
      // refusal list was written for.
      "cachedInputUnitPrice",
      // TD-057. Value columns too; same refusal.
      "cacheWriteUnitPrice",
      "cacheWrite1hUnitPrice",
      "effectiveAt",
    ] as const;

    const attempted = APPEND_ONLY_FIELDS.filter(
      (field) => body[field] !== undefined,
    );
    if (attempted.length > 0) {
      throwValidationError(
        `${attempted.join(", ")} cannot be edited in place - a price rule is ` +
          `versioned by append, and the database does not grant UPDATE on ` +
          `these columns. Create the new version with POST /capability/price-rules, ` +
          `then set expiresAt on this one. Only expiresAt is editable here.`,
        attempted[0] as string,
      );
    }

    const input: UpdateModelPriceRuleInput = {};
    if (body.expiresAt !== undefined)
      input.expiresAt = parseDateOrNull(body.expiresAt);

    return input;
  }

  private async normalizeCreatePolicy(
    body: CreateModelPolicyBody,
  ): Promise<CreateModelPolicyInput> {
    const modelId = requiredString(body.modelId, "modelId");
    await this.assertModelExists(modelId);

    return {
      modelId,
      tenantId: optionalString(body.tenantId),
      name: optionalString(body.name),
      priority: parsePriority(body.priority),
      maxConcurrent: optionalInt(body.maxConcurrent, "maxConcurrent"),
      rateLimitRpm: optionalInt(body.rateLimitRpm, "rateLimitRpm"),
      rateLimitTpm: optionalBigInt(body.rateLimitTpm, "rateLimitTpm"),
      rateLimitTpd: optionalBigInt(body.rateLimitTpd, "rateLimitTpd"),
      maxContextTokens: optionalInt(body.maxContextTokens, "maxContextTokens"),
      effectiveAt: parseDateOrNow(body.effectiveAt, "effectiveAt"),
      expiresAt: parseDateOrNull(body.expiresAt),
      isActive: body.state === undefined ? true : isActiveState(body.state),
    };
  }

  private normalizeUpdatePolicy(
    body: UpdateModelPolicyBody,
  ): UpdateModelPolicyInput {
    const input: UpdateModelPolicyInput = {};

    // `tenantId` is WHO the policy applies to and `effectiveAt` is WHEN it
    // starts - both fixed at create, and the database grants no UPDATE on
    // either. They reached Postgres and came back `permission denied for table
    // model_policies` (TD-039, measured 2026-08-17 as atlas_svc).
    //
    // Retargeting a policy at another tenant is not an edit, it is a different
    // policy: the rate limits the old tenant was running under would silently
    // stop applying, with one row changed and nothing in the audit trail saying
    // whose limits moved.
    this.refuseUnwritableField(
      body as unknown as Record<string, unknown>,
      "tenantId",
      "a policy belongs to the tenant it was created for. Deactivate this " +
        "one and create the policy you want for the other tenant.",
    );
    this.refuseUnwritableField(
      body as unknown as Record<string, unknown>,
      "effectiveAt",
      "when a policy starts is fixed at create. Use `expiresAt` to end it, " +
        "and create a new policy for the new window.",
    );
    if (body.name !== undefined) input.name = optionalString(body.name);
    if (body.priority !== undefined)
      input.priority = parsePriority(body.priority);
    if (body.maxConcurrent !== undefined)
      input.maxConcurrent = optionalInt(body.maxConcurrent, "maxConcurrent");
    if (body.rateLimitRpm !== undefined)
      input.rateLimitRpm = optionalInt(body.rateLimitRpm, "rateLimitRpm");
    if (body.rateLimitTpm !== undefined)
      input.rateLimitTpm = optionalBigInt(body.rateLimitTpm, "rateLimitTpm");
    if (body.rateLimitTpd !== undefined)
      input.rateLimitTpd = optionalBigInt(body.rateLimitTpd, "rateLimitTpd");
    if (body.maxContextTokens !== undefined)
      input.maxContextTokens = optionalInt(
        body.maxContextTokens,
        "maxContextTokens",
      );
    if (body.effectiveAt !== undefined)
      input.effectiveAt = parseDateOrNow(body.effectiveAt, "effectiveAt");
    if (body.expiresAt !== undefined)
      input.expiresAt = parseDateOrNull(body.expiresAt);

    return input;
  }

  private async assertModelExists(modelId: string): Promise<AiModelRecord> {
    const model = await this.repository.findModelById(modelId);

    if (!model) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_MODEL_NOT_FOUND",
        `AI model "${modelId}" was not found`,
        { modelId },
      );
    }

    return model;
  }

  private async assertProviderExists(
    providerId: string,
  ): Promise<ModelProviderRecord> {
    const provider = await this.repository.findProviderById(providerId);

    if (!provider) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_PROVIDER_NOT_FOUND",
        `Model provider "${providerId}" was not found`,
        { providerId },
      );
    }

    return provider;
  }

  private async assertEndpointExists(
    endpointId: string,
  ): Promise<ModelEndpointRecord> {
    const endpoint = await this.repository.findEndpointById(endpointId);

    if (!endpoint) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_ENDPOINT_NOT_FOUND",
        `Model endpoint "${endpointId}" was not found`,
        { endpointId },
      );
    }

    return endpoint;
  }

  private async assertGrantExists(
    grantId: string,
  ): Promise<AiModelGrantRecord> {
    const grant = await this.repository.findGrantById(grantId);

    if (!grant) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_GRANT_NOT_FOUND",
        `AI model grant "${grantId}" was not found`,
        { grantId },
      );
    }

    return grant;
  }

  private async assertPriceRuleExists(
    priceRuleId: string,
  ): Promise<ModelPriceRuleRecord> {
    const rule = await this.repository.findPriceRuleById(priceRuleId);

    if (!rule) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_PRICE_RULE_NOT_FOUND",
        `Model price rule "${priceRuleId}" was not found`,
        { priceRuleId },
      );
    }

    return rule;
  }

  private async assertPolicyExists(
    policyId: string,
  ): Promise<ModelPolicyRecord> {
    const policy = await this.repository.findPolicyById(policyId);

    if (!policy) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_POLICY_NOT_FOUND",
        `Model policy "${policyId}" was not found`,
        { policyId },
      );
    }

    return policy;
  }
}

/**
 * Delete is a two-step: deactivate, then remove. Nothing on this plane goes
 * from serving traffic to gone in a single action - the deactivated state is
 * observable, reversible, and gives whatever depends on the resource a chance
 * to surface before it is unrecoverable.
 */
function assertDeactivated(
  isActive: boolean,
  kind:
    | "provider"
    | "model"
    | "endpoint"
    | "product grant"
    | "price rule"
    | "policy"
    | "provider key"
    | "grant",
  id: string,
): void {
  if (!isActive) return;
  throw new ModelAdminException(
    HttpStatus.CONFLICT,
    "MODEL_ADMIN_MUST_DEACTIVATE_FIRST",
    `${kind} ${id} is still active - deactivate it before deleting`,
  );
}

/**
 * The operator's intent (`isActive`) beats everything: an endpoint the
 * operator switched off is `disabled` no matter how healthy its models are.
 * Below that, the primary decides, and the fallback is what separates
 * `degraded` from `unresolvable` - an endpoint running on its fallback is
 * still serving, and reporting it as broken would be as wrong as reporting it
 * as fine.
 */
function resolveEndpointState(
  isActive: boolean,
  models: EndpointModelRef[],
): EndpointResolutionState {
  if (!isActive) return "inactive";
  const [primary, ...rest] = models;
  if (primary?.availability === "available") return "serving";
  if (rest.some((m) => m.availability === "available")) return "degraded";
  return "unresolvable";
}

/** Why a model can or cannot serve, in the order the operator can act on. */
function modelAvailability(
  model: { isActive: boolean; providerActive: boolean } | undefined,
): ModelAvailability {
  if (!model) return "missing";
  if (!model.providerActive) return "provider_inactive";
  if (!model.isActive) return "model_inactive";
  return "available";
}

function mapProvider(
  provider: ModelProviderRecord,
  traffic?: ProviderTrafficSnapshot,
  modelCount = 0,
): ModelProviderAdminRecord {
  return {
    modelCount,
    id: provider.id,
    providerCode: provider.providerCode,
    providerType: provider.providerType,
    providerName: provider.providerName,
    description: provider.description,
    logoUrl: provider.logoUrl,
    homepageUrl: provider.homepageUrl,
    consoleUrl: provider.consoleUrl,
    billingUrl: provider.billingUrl,
    state: toObjectState(provider.isActive),
    config: sanitizeModelConfig(provider.config),
    health: computeProviderHealth(traffic),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

/** Thresholds are Atlas's own call (CLAUDE.md blank zone) - no SLA backs them yet. */
const PROVIDER_HEALTHY_SUCCESS_RATE = 0.98;
const PROVIDER_DEGRADED_SUCCESS_RATE = 0.8;

function computeProviderHealth(
  traffic: ProviderTrafficSnapshot | undefined,
): ModelProviderHealth {
  if (!traffic || traffic.attempts === 0) {
    return {
      status: "unknown",
      successRate: null,
      avgLatencyMs: null,
      attempts: 0,
      lastObservedAt: null,
    };
  }

  const successRate = traffic.successes / traffic.attempts;
  const status =
    successRate >= PROVIDER_HEALTHY_SUCCESS_RATE
      ? "healthy"
      : successRate >= PROVIDER_DEGRADED_SUCCESS_RATE
        ? "degraded"
        : "down";

  return {
    status,
    successRate,
    avgLatencyMs: traffic.avgLatencyMs,
    attempts: traffic.attempts,
    lastObservedAt: traffic.lastObservedAt,
  };
}

function mapProductGrant(
  grant: ProductEndpointGrantRecord,
): ProductGrantAdminRecord {
  return {
    id: grant.id,
    productCode: grant.productCode,
    endpointCode: grant.endpointCode,
    applicationId: grant.applicationId,
    applicationType: grant.applicationType,
    state: toObjectState(grant.isActive),
    reason: grant.reason,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

function mapEndpoint(
  endpoint: ModelEndpointRecord,
  models: EndpointModelRef[] = [],
): ModelEndpointAdminRecord {
  return {
    id: endpoint.id,
    code: endpoint.code,
    category: endpoint.category,
    primaryModelCode: endpoint.primaryModelCode,
    fallbackModelCode: endpoint.fallbackModelCode,
    state: toObjectState(endpoint.isActive),
    resolution: resolveEndpointState(endpoint.isActive, models),
    models,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

function mapModel(
  model: AiModelRecord,
  grantCount = 0,
  endpointRefCount = 0,
): AiModelAdminRecord {
  return {
    grantCount,
    endpointRefCount,
    id: model.id,
    providerId: model.providerId,
    modelCode: model.modelCode,
    modelName: model.modelName,
    provider: model.provider,
    endpointUrl: model.endpointUrl,
    protocol: model.protocol,
    modelType: model.modelType,
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    supportsStreaming: model.supportsStreaming,
    sort: model.sort,
    state: toModelState(model),
    deprecatedAt: model.deprecatedAt?.toISOString() ?? null,
    // Same value `/v1/models` reports. On the operator plane it is the
    // feedback loop: repoint the upstream, reload, see the fingerprint move.
    // Without it here, the only person who can verify the signal works is the
    // consumer watching for it - which is the wrong way round, and is how
    // `deprecatedAt` ended up settable-but-invisible (#236).
    behaviorVersion: modelBehaviorVersion(model),
    /* Same three inputs the runtime uses, same function - not a re-derivation.
       Pure config merge, no upstream call, so it is free to compute per row. */
    resolvedWire: resolveWireFor(model),
    config: sanitizeModelConfig(model.config),
    keyReference: readKeyReference(model.config),
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function mapGrant(grant: AiModelGrantRecord): AiModelGrantAdminRecord {
  return {
    id: grant.id,
    modelId: grant.modelId,
    tenantId: grant.tenantId,
    applicationId: grant.applicationId,
    applicationType: grant.applicationType,
    agentId: grant.agentId,
    taskProfile: grant.taskProfile,
    priority: grant.priority,
    reason: grant.reason,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    state: toObjectState(grant.isActive),
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

function mapPriceRule(rule: ModelPriceRuleRecord): ModelPriceRuleAdminRecord {
  return {
    id: rule.id,
    modelId: rule.modelId,
    billingMode: rule.billingMode,
    currency: rule.currency,
    unitTokens: rule.unitTokens,
    inputUnitPrice: rule.inputUnitPrice.toString(),
    outputUnitPrice: rule.outputUnitPrice.toString(),
    requestUnitPrice: rule.requestUnitPrice.toString(),
    cachedInputUnitPrice: rule.cachedInputUnitPrice?.toString() ?? null,
    cacheWriteUnitPrice: rule.cacheWriteUnitPrice?.toString() ?? null,
    cacheWrite1hUnitPrice: rule.cacheWrite1hUnitPrice?.toString() ?? null,
    state: toObjectState(rule.isActive),
    effectiveAt: rule.effectiveAt.toISOString(),
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function mapPolicy(policy: ModelPolicyRecord): ModelPolicyAdminRecord {
  return {
    id: policy.id,
    modelId: policy.modelId,
    tenantId: policy.tenantId,
    name: policy.name,
    priority: policy.priority,
    maxConcurrent: policy.maxConcurrent,
    rateLimitRpm: policy.rateLimitRpm,
    rateLimitTpm: policy.rateLimitTpm?.toString() ?? null,
    rateLimitTpd: policy.rateLimitTpd?.toString() ?? null,
    maxContextTokens: policy.maxContextTokens,
    state: toObjectState(policy.isActive),
    effectiveAt: policy.effectiveAt.toISOString(),
    expiresAt: policy.expiresAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function mapUsageSummary(
  summary: TenantUsageSummaryRecord,
): TenantUsageSummaryAdminRecord {
  return {
    /* No `dimension` here — it rides on the envelope (A-4). */
    cycleMonth: summary.cycleMonth,
    tenantId: summary.tenantId,
    workspaceId: summary.workspaceId,
    applicationId: summary.applicationId,
    applicationType: summary.applicationType,
    providerCode: null,
    modelCode: null,
    endpointCode: null,
    // The other three stay null because the tenant rollup does not group by
    // them. `productCode` DOES group by it - passing null here split every
    // row one level finer and then discarded the value that explains the
    // split, which is worse than not grouping at all: a reader would see the
    // same tenant and workspace repeated with no way to tell the rows apart.
    productCode: summary.productCode,
    requests: summary.requests.toString(),
    inputTokens: summary.inputTokens.toString(),
    outputTokens: summary.outputTokens.toString(),
    totalTokens: summary.totalTokens.toString(),
    errors: summary.errors.toString(),
  };
}

/**
 * The rollup's `groupKey` lands in whichever identity field the dimension
 * names; the rest stay null. Tenant/application are null here because these
 * rows sum across every tenant - reporting one would be a lie about what was
 * counted.
 */
function mapUsageRollup(
  dimension: Exclude<UsageRollupDimension, "tenant">,
  row: UsageRollupRecord,
): TenantUsageSummaryAdminRecord {
  return {
    /* `dimension` still selects which identity field `groupKey` fills, but it is
       no longer copied onto the row — see `UsageSummaryPage`. */
    cycleMonth: row.cycleMonth,
    tenantId: null,
    workspaceId: null,
    applicationId: null,
    applicationType: null,
    providerCode: dimension === "provider" ? row.groupKey : null,
    modelCode: dimension === "model" ? row.groupKey : null,
    endpointCode: dimension === "endpoint" ? row.groupKey : null,
    productCode: dimension === "product" ? row.groupKey : null,
    requests: row.requests.toString(),
    inputTokens: row.inputTokens.toString(),
    outputTokens: row.outputTokens.toString(),
    totalTokens: row.totalTokens.toString(),
    errors: row.errors.toString(),
  };
}

/**
 * `groupBy` defaults to `tenant`, keeping the original tenant-rollup response
 * shape for callers that pass no groupBy.
 */
function normalizeUsageRollupDimension(raw?: string): UsageRollupDimension {
  if (raw === undefined) return "tenant";

  const value = requiredString(raw, "groupBy");
  if (
    value === "tenant" ||
    value === "provider" ||
    value === "model" ||
    value === "endpoint" ||
    value === "product"
  ) {
    return value;
  }

  throwValidationError(
    'groupBy must be one of "tenant", "provider", "model", "endpoint", "product"',
    "groupBy",
  );
}

/** `asOf=now` is accepted as a convenience so a caller need not clock-sync. */
function parseAsOf(raw: string): Date {
  const trimmed = requiredString(raw, "asOf");
  if (trimmed === "now") return new Date();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throwValidationError('asOf must be an ISO 8601 timestamp or "now"', "asOf");
  }
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throwValidationError(`${field} is required`, field);
  }

  return value.trim();
}

/**
 * protocol 是分发键，不是自由文本 - 它决定用哪个适配器
 * (docs/30-design/100-model-onboarding-and-protocol-adapters.md section 5)。
 *
 * 接受别名并归一化后落库：现网存量就是 `openai` / `anthropic` 这两个别名，
 * 拒绝它们会让运营改一个无关字段时被绊住；归一化则让数据自己慢慢收敛。
 */
function requiredProtocol(value: unknown): string {
  const raw = requiredString(value, "protocol");
  const normalized = normalizeProtocol(raw);

  if (!normalized) {
    throwValidationError(
      `protocol must be one of: ${MODEL_PROTOCOLS.join(", ")} (got "${raw}")`,
      "protocol",
    );
  }

  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalInt(
  value: number | null | undefined,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throwValidationError(`${field} must be a non-negative integer`, field);
  }
  return value;
}

function parsePositiveInt(
  value: number | null | undefined,
  field: string,
  fallback?: number,
): number {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throwValidationError(`${field} is required`, field);
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throwValidationError(`${field} must be a positive integer`, field);
  }

  return value;
}

function optionalBigInt(
  value: string | number | bigint | null | undefined,
  field: string,
): bigint | null {
  if (value === null || value === undefined || value === "") return null;

  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new Error("negative bigint");
    }
    return parsed;
  } catch {
    throwValidationError(`${field} must be a non-negative integer`, field);
  }
}

function requiredUrl(value: unknown, field: string): string {
  const text = requiredString(value, field);

  try {
    new URL(text);
  } catch {
    throwValidationError(`${field} must be a valid URL`, field);
  }

  return text;
}

function optionalUrl(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredUrl(value, field);
}

function parseDecimalText(
  value: string | number | null | undefined,
  field: string,
  fallback?: string,
): string {
  if (value === null || value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throwValidationError(`${field} is required`, field);
  }

  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throwValidationError(`${field} must be a non-negative decimal`, field);
  }

  return text;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throwValidationError("capabilities must be an array", "capabilities");
  }

  const capabilities = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (capabilities.length === 0) {
    throwValidationError("capabilities cannot be empty", "capabilities");
  }

  return [...new Set(capabilities)];
}

function parsePriority(value: number | null | undefined): number {
  if (value === null || value === undefined) {
    return 100;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throwValidationError("priority must be a positive integer", "priority");
  }

  return value;
}

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throwValidationError("expiresAt must be a valid date", "expiresAt");
  }

  return date;
}

function parseDateOrNow(value: string | null | undefined, field: string): Date {
  if (!value) return new Date();

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throwValidationError(`${field} must be a valid date`, field);
  }

  return date;
}

function normalizeGrantFilters(filters: {
  tenantId?: string;
  modelId?: string;
  applicationId?: string;
  applicationType?: ApplicationType;
}): {
  tenantId?: string;
  modelId?: string;
  applicationId?: string;
  applicationType?: ApplicationType;
} {
  const normalized: {
    tenantId?: string;
    modelId?: string;
    applicationId?: string;
    applicationType?: ApplicationType;
  } = {};

  if (filters.tenantId !== undefined)
    normalized.tenantId = requiredString(filters.tenantId, "tenantId");
  if (filters.modelId !== undefined)
    normalized.modelId = requiredString(filters.modelId, "modelId");
  if (filters.applicationId !== undefined)
    normalized.applicationId = requiredString(
      filters.applicationId,
      "applicationId",
    );
  if (filters.applicationType !== undefined)
    normalized.applicationType = normalizeApplicationType(
      filters.applicationType,
      "applicationType",
    );

  if (
    normalized.applicationId !== undefined &&
    normalized.applicationType === undefined
  ) {
    throwScopeError(
      "applicationType is required when applicationId is provided",
    );
  }

  if (
    normalized.applicationType !== undefined &&
    normalized.applicationId === undefined
  ) {
    throwScopeError(
      "applicationId is required when applicationType is provided",
    );
  }

  return normalized;
}

const CYCLE_MONTH_PATTERN = /^\d{4}-\d{2}$/;

interface UsageSummaryFilters {
  tenantId?: string;
  applicationId?: string;
  applicationType?: ApplicationType;
  cycleMonth?: string;
  providerCode?: string;
  modelCode?: string;
  productCode?: string;
}

function normalizeUsageSummaryFilters(filters: {
  tenantId?: string;
  applicationId?: string;
  applicationType?: ApplicationType;
  cycleMonth?: string;
  providerCode?: string;
  modelCode?: string;
  productCode?: string;
}): UsageSummaryFilters {
  const normalized: UsageSummaryFilters = {};

  if (filters.providerCode !== undefined)
    normalized.providerCode = requiredString(
      filters.providerCode,
      "providerCode",
    );
  if (filters.modelCode !== undefined)
    normalized.modelCode = requiredString(filters.modelCode, "modelCode");
  if (filters.productCode !== undefined)
    normalized.productCode = requiredString(filters.productCode, "productCode");

  if (filters.tenantId !== undefined)
    normalized.tenantId = requiredString(filters.tenantId, "tenantId");
  if (filters.applicationId !== undefined)
    normalized.applicationId = requiredString(
      filters.applicationId,
      "applicationId",
    );
  if (filters.applicationType !== undefined)
    normalized.applicationType = normalizeApplicationType(
      filters.applicationType,
      "applicationType",
    );
  if (filters.cycleMonth !== undefined) {
    const cycleMonth = requiredString(filters.cycleMonth, "cycleMonth");
    if (!CYCLE_MONTH_PATTERN.test(cycleMonth)) {
      throwValidationError('cycleMonth must be "YYYY-MM"', "cycleMonth");
    }
    normalized.cycleMonth = cycleMonth;
  }

  if (
    normalized.applicationId !== undefined &&
    normalized.applicationType === undefined
  ) {
    throwScopeError(
      "applicationType is required when applicationId is provided",
    );
  }

  if (
    normalized.applicationType !== undefined &&
    normalized.applicationId === undefined
  ) {
    throwScopeError(
      "applicationId is required when applicationType is provided",
    );
  }

  return normalized;
}

function sanitizeModelConfig(config: ModelConfig | null): ModelConfig | null {
  if (config === null) return null;

  return sanitizeConfigRecord(config);
}

function sanitizeWritableConfig(
  config: ModelConfig | null,
): ModelConfig | null {
  const sanitized = sanitizeModelConfig(config);
  if (sanitized === null) return null;

  // 写入严格：`wire` 描述符的未知键在这里就被拒，运行时因此不会遇到它们
  // (docs/30-design/100-model-onboarding-and-protocol-adapters.md section 6).
  const problems = validateWire(sanitized["wire"]);
  if (problems.length > 0) {
    throwValidationError(problems.join("; "), "config.wire");
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function mergeModelConfig(
  config: ModelConfig | null,
  keyReference: NormalizedKeyReference | null | undefined,
): ModelConfig | null {
  if (keyReference === undefined) return config;

  const nextConfig = { ...(config ?? {}) };
  delete nextConfig["apiKeyEnvVar"];
  delete nextConfig["managedKeyAlias"];

  if (keyReference) {
    if (keyReference.source === "managed") {
      nextConfig["managedKeyAlias"] = keyReference.name;
    } else {
      nextConfig["apiKeyEnvVar"] = keyReference.name;
    }
  }

  return Object.keys(nextConfig).length > 0 ? nextConfig : null;
}

function sanitizeConfigRecord(config: ModelConfig): ModelConfig {
  return Object.entries(config).reduce<ModelConfig>((result, [key, value]) => {
    if (SECRET_CONFIG_KEY_PATTERN.test(key)) return result;
    result[key] = sanitizeConfigValue(value);
    return result;
  }, {});
}

function sanitizeConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigValue(item));
  }

  if (isPlainRecord(value)) {
    return sanitizeConfigRecord(value);
  }

  return value;
}

function readKeyReference(
  config: ModelConfig | null,
): ModelKeyReference | null {
  const managedKeyAlias = config?.["managedKeyAlias"];
  if (typeof managedKeyAlias === "string" && managedKeyAlias.trim()) {
    return {
      source: "managed",
      name: managedKeyAlias.trim(),
      // Existence is verified at request time against the provider-key vault,
      // not synchronously here - a managed reference is presumed configured.
      configured: true,
    };
  }

  const apiKeyEnvVar = config?.["apiKeyEnvVar"];
  if (typeof apiKeyEnvVar !== "string" || !apiKeyEnvVar.trim()) return null;

  const name = apiKeyEnvVar.trim();
  return {
    source: "env",
    name,
    configured: Boolean(process.env[name]),
  };
}

function hasKeyReferenceInput(
  body: Pick<UpdateAiModelBody, "apiKeyEnvVar" | "keyReference">,
): boolean {
  return body.apiKeyEnvVar !== undefined || body.keyReference !== undefined;
}

interface NormalizedKeyReference {
  source: "env" | "managed";
  name: string;
}

function normalizeKeyReferenceName(
  body: Pick<CreateAiModelBody, "apiKeyEnvVar" | "keyReference">,
): NormalizedKeyReference | null | undefined {
  if (body.keyReference !== undefined) {
    if (body.keyReference === null) return null;

    // `managed` is the only source the runtime reads (ADR-003; the env path was
    // removed 2026-08-17). It also stopped being the DEFAULT here: an operator
    // who omitted `source` used to get `env`, i.e. a key reference the call
    // path cannot resolve - configured, saved, and inert.
    const requestedSource: string = body.keyReference.source ?? "managed";
    if (requestedSource !== "managed") {
      throwValidationError(
        `keyReference.source must be "managed" - the environment-variable key ` +
          `path was retired with ADR-003, and the vault is the only source. ` +
          `Create the key with POST /capability/provider-keys and reference ` +
          `its alias here.`,
        "keyReference",
      );
    }

    const name = optionalString(body.keyReference.name);
    if (!name) return null;

    return { source: "managed", name };
  }

  if (body.apiKeyEnvVar !== undefined) {
    // Accepted as INPUT only to say no. Silently ignoring it would leave an
    // operator believing the key was set; a 400 names the replacement.
    throwValidationError(
      `apiKeyEnvVar is retired (ADR-003): a model's key comes from the vault. ` +
        `Create it with POST /capability/provider-keys and reference its ` +
        `alias as keyReference: { source: "managed", name: "<alias>" }.`,
      "apiKeyEnvVar",
    );
  }

  return undefined;
}

function isPlainRecord(value: unknown): value is ModelConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApplicationType(
  value: unknown,
  field: string,
): ApplicationType {
  const text = requiredString(value, field);
  if (!APPLICATION_TYPES.has(text as ApplicationType)) {
    throwValidationError(`${field} is invalid`, field);
  }

  return text as ApplicationType;
}

function validateApplicationScope(input: {
  applicationId?: string | null;
  applicationType?: ApplicationType | null;
  fieldPrefix?: string;
}): void {
  const hasApplicationId = Boolean(input.applicationId);
  const hasApplicationType = Boolean(input.applicationType);
  const prefix = input.fieldPrefix ? `${input.fieldPrefix}.` : "";

  if (hasApplicationId && !hasApplicationType) {
    throwScopeError(
      `${prefix}applicationType is required when applicationId is provided`,
    );
  }

  if (hasApplicationType && !hasApplicationId) {
    throwScopeError(
      `${prefix}applicationId is required when applicationType is provided`,
    );
  }
}

function throwValidationError(message: string, field: string): never {
  throw new ModelAdminException(
    HttpStatus.BAD_REQUEST,
    "MODEL_ADMIN_VALIDATION_FAILED",
    message,
    { field },
  );
}

function throwScopeError(message: string): never {
  throw new ModelAdminException(
    HttpStatus.BAD_REQUEST,
    "MODEL_ADMIN_SCOPE_INVALID",
    message,
  );
}

/** TD-057: an optional rate - absent/null/empty leaves the column NULL, never 0. */
function optionalRate(
  value: string | number | null | undefined,
  field: string,
): Record<string, string | null> {
  if (value === undefined) return {};
  if (value === null || value === "") return { [field]: null };
  return { [field]: parseDecimalText(value, field) };
}
