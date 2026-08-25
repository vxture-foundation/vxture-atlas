import { HttpStatus, Injectable } from "@nestjs/common";

import {
  prisma,
  type AiModelRow,
  type ProductEndpointGrantRecord,
} from "../prisma";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import { isUuid } from "../uuid";
import type { ErrorLogRecord, RequestLogRecord } from "../reqlog/request-log.types";
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
  ModelEndpointRecord,
  ModelPolicyRecord,
  ModelPriceRuleRecord,
  ModelProviderRecord,
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

/**
 * `model.model_grants.tenant_id`/`application_id` are `uuid` columns
 * (`deploy/database/ddl/00_baseline.sql`) with no FK (boundary #1) - nothing
 * validates the shape of these before they hit Postgres, so a non-UUID value
 * (e.g. a caller's own composite tenant identifier instead of the platform's
 * actual UUID) must fail here as a clean 400, not as an unhandled Prisma
 * UUID-cast error surfacing as an opaque 500.
 */
function assertUuid(value: string, code: "INVALID_TENANT_ID" | "INVALID_APPLICATION_ID", label: string): void {
  if (!isUuid(value)) {
    throw new ModelRuntimeException(
      HttpStatus.BAD_REQUEST,
      code,
      `${label} must be a UUID (got a non-UUID value) - use the platform tenant/workspace id from your token context, not an internal composite identifier`,
    );
  }
}

// model.models dropped the `provider` varchar column; provider identity is now the joined
// model_providers.provider_code. Every model read pulls it so AiModelRecord.provider stays populated.
const PROVIDER_INCLUDE = {
  // config comes along for the ride because the provider row is where a
  // provider-wide `wire` descriptor lives (design doc section 6); the model's
  // own config.wire overlays it. Selecting it here means no extra query on the
  // request path.
  // `isActive` rides along because a model under a deactivated provider must
  // not be treated as usable - deriving that needs the provider's state at
  // every place a model is read, and this is the only join that already exists
  // on the request path.
  providerRef: { select: { providerCode: true, config: true, isActive: true } },
} as const;

/**
 * Rollup axis -> the column it groups on. A frozen literal map rather than a
 * derived string: the value reaches raw SQL, so it must be impossible for a
 * caller-supplied dimension to become one. Adding an axis means adding a key
 * here, which TypeScript then requires.
 */
const ROLLUP_COLUMN: Record<Exclude<UsageRollupDimension, "tenant">, string> = {
  provider: "provider_code",
  model: "model_code",
  endpoint: "endpoint_code",
  product: "product_code",
};

@Injectable()
export class ModelRegistryRepository {
  /**
   * A real round-trip, not `$connect()`.
   *
   * `$connect()` is a no-op on an already-connected client: it resolves
   * instantly, without issuing anything, whether or not the database is still
   * there. This check therefore passed against a database that had been
   * stopped outright - measured 2026-08-23 by stopping the dev postgres
   * container, where `/readyz` reported `database=pass` alongside
   * `modelRegistry=fail`, `providerKeys=fail`, `usageSummaryRead=fail` and
   * `reqlogPartitions=fail`.
   *
   * That reading is worse than no check at all. Every check that actually
   * queries failed, and the one named `database` said the database was fine,
   * so the honest conclusion from the page was "the database is up, the
   * registry code is broken" - the exact inverse of the truth, pointing an
   * operator at the wrong system during an outage.
   */
  async checkDatabaseConnectivity(): Promise<void> {
    /* `$queryRawUnsafe` with a constant and no interpolation - exactly the use
       its own doc comment sanctions. `$queryRaw` is not on the narrowed client. */
    await prisma.$queryRawUnsafe("SELECT 1");
  }

  listProviders(includeInactive = false): Promise<ModelProviderRecord[]> {
    return prisma.modelProvider.findMany({
      where: includeInactive
        ? { deletedAt: null }
        : { isActive: true, deletedAt: null },
      orderBy: [
        { isActive: "desc" },
        { providerType: "asc" },
        { providerName: "asc" },
      ],
    });
  }

  /**
   * Dependent counts for the management plane, one grouped query per level
   * rather than a count per row.
   *
   * These are the SAME numbers that block a delete. That equality is the
   * point: a column showing 0 while the delete returns 409 is worse than no
   * column at all, so both read from this and nothing recomputes it
   * independently.
   *
   * "Dependent" means NOT DELETED, regardless of active state - a deactivated
   * endpoint still references its model, and deleting the model would leave a
   * dangling route the moment someone reactivates the endpoint.
   */
  async countModelsByProvider(): Promise<Map<string, number>> {
    const rows = await prisma.modelDefinition.groupBy({
      by: ["providerId"],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return new Map(
      rows
        .filter((row) => typeof row["providerId"] === "string")
        .map((row) => [row["providerId"] as string, row._count._all]),
    );
  }

  async countGrantsByModel(): Promise<Map<string, number>> {
    const rows = await prisma.modelGrant.groupBy({
      by: ["modelId"],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return new Map(
      rows.map((row) => [row["modelId"] as string, row._count._all]),
    );
  }

  /**
   * Endpoint references per model CODE, counting primary and fallback alike.
   * A fallback-only reference blocks deletion just as hard: removing that
   * model silently severs a failover chain, which is the same class of
   * "configured but does nothing" as a broken primary, only quieter.
   */
  async countEndpointRefsByModelCode(): Promise<Map<string, number>> {
    const rows = await prisma.modelEndpoint.findMany({
      where: { deletedAt: null },
      select: { primaryModelCode: true, fallbackModelCode: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const code of [row.primaryModelCode, row.fallbackModelCode]) {
        if (!code) continue;
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return counts;
  }

  findProviderById(providerId: string): Promise<ModelProviderRecord | null> {
    return prisma.modelProvider.findFirst({
      where: { id: providerId, deletedAt: null },
    });
  }

  /**
   * Unlike `findProviderById`, deliberately does NOT filter `deletedAt` -
   * `provider_code` carries a plain (non-partial) unique index
   * (`uq_model_providers_provider_code`), so a soft-deleted row still holds
   * its code. Callers use this to tell "code truly free" apart from "code
   * belongs to a soft-deleted row" before writing, instead of letting the
   * DB's unique-constraint error surface as an unhandled 500 (found live,
   * vxture-atlas write-path smoke test).
   */
  findProviderByCode(providerCode: string): Promise<ModelProviderRecord | null> {
    return prisma.modelProvider.findFirst({ where: { providerCode } });
  }

  createProvider(
    input: CreateModelProviderInput,
  ): Promise<ModelProviderRecord> {
    return prisma.modelProvider.create({ data: input });
  }

  updateProvider(
    providerId: string,
    input: UpdateModelProviderInput,
  ): Promise<ModelProviderRecord> {
    return prisma.modelProvider.update({
      where: { id: providerId },
      data: input,
    });
  }

  /**
   * Revives a soft-deleted provider row in place under the same `id` (rather
   * than inserting a new row, which `provider_code`'s unique index would
   * reject anyway) - so anything that still references the old `providerId`
   * (models, price rules, policies, all left untouched by `deleteProvider`'s
   * own cascade) resolves again instead of pointing at a dangling id.
   *
   * Takes `UpdateModelProviderInput`, not the create input - providerCode is
   * what the caller matched on to find this row (unchanged by definition),
   * and providerType is immutable after creation same as on `updateProvider`
   * (db-init column lock: atlas_svc has no UPDATE grant on either column).
   */
  restoreProvider(
    providerId: string,
    input: UpdateModelProviderInput,
  ): Promise<ModelProviderRecord> {
    return prisma.modelProvider.update({
      where: { id: providerId },
      data: { ...input, deletedAt: null },
    });
  }

  /**
   * Cascades to the provider's own models (and, through them, their grants)
   * the same way `deleteModel` cascades to its grants - without this, a
   * deleted provider left its still-`isActive` models pointing at a
   * nonexistent-in-spirit provider (found live alongside the P2002 gap
   * above).
   */
  async deleteProvider(providerId: string): Promise<ModelProviderRecord> {
    const deletedAt = new Date();

    return prisma.$transaction(async (tx) => {
      const models = await tx.modelDefinition.findMany({
        where: { providerId, deletedAt: null },
        select: { id: true },
      });
      const modelIds = models.map((model) => model.id);

      if (modelIds.length > 0) {
        await tx.modelGrant.updateMany({
          where: { modelId: { in: modelIds }, deletedAt: null },
          data: { isActive: false, deletedAt },
        });

        await tx.modelDefinition.updateMany({
          where: { id: { in: modelIds } },
          data: { isActive: false, deletedAt },
        });
      }

      return tx.modelProvider.update({
        where: { id: providerId },
        data: { isActive: false, deletedAt },
      });
    });
  }

  // ── model_endpoints ──────────────────────────────────────────────────────

  listEndpoints(
    includeInactive = false,
    filters: { modelCode?: string } = {},
  ): Promise<ModelEndpointRecord[]> {
    return prisma.modelEndpoint.findMany({
      where: {
        ...(includeInactive
          ? { deletedAt: null }
          : { isActive: true, deletedAt: null }),
        // Either slot - "which entry points depend on this model" has to
        // include the ones depending on it only as a fallback.
        ...(filters.modelCode
          ? {
              OR: [
                { primaryModelCode: filters.modelCode },
                { fallbackModelCode: filters.modelCode },
              ],
            }
          : {}),
      },
      orderBy: [{ isActive: "desc" }, { code: "asc" }],
    });
  }

  findEndpointById(endpointId: string): Promise<ModelEndpointRecord | null> {
    return prisma.modelEndpoint.findFirst({
      where: { id: endpointId, deletedAt: null },
    });
  }

  /**
   * Data-plane resolution: the caller passed an endpoint code, so only a
   * live entry point may answer. Deactivated and soft-deleted rows are
   * invisible here on purpose - deactivating an endpoint is how an operator
   * takes a capability name out of service, and it has to actually stop
   * serving, not quietly keep routing.
   */
  findActiveEndpointByCode(code: string): Promise<ModelEndpointRecord | null> {
    return prisma.modelEndpoint.findFirst({
      where: { code, isActive: true, deletedAt: null },
    });
  }

  /**
   * Deliberately does NOT filter `deletedAt` - `code` carries a plain
   * (non-partial) unique index (`uq_model_endpoints_code`), same shape as
   * `findProviderByCode`, so a soft-deleted row still holds its code and
   * `createEndpoint` needs to tell "free" apart from "soft-deleted" before
   * writing.
   */
  findEndpointByCode(code: string): Promise<ModelEndpointRecord | null> {
    return prisma.modelEndpoint.findFirst({ where: { code } });
  }

  /**
   * Bulk form of `findEndpointByCode`, for the consumer catalog. Also
   * unfiltered on state, and for the same kind of reason: the catalog has to
   * distinguish "you hold a grant and it routes" from "you hold a grant and
   * the endpoint is switched off" from "you hold a grant for a code that does
   * not exist". Filtering to live rows here would collapse the last two into
   * an absence, which is exactly the shape a caller cannot act on.
   */
  findEndpointsByCodes(codes: string[]): Promise<ModelEndpointRecord[]> {
    if (codes.length === 0) return Promise.resolve([]);
    return prisma.modelEndpoint.findMany({ where: { code: { in: codes } } });
  }

  createEndpoint(
    input: CreateModelEndpointInput,
  ): Promise<ModelEndpointRecord> {
    return prisma.modelEndpoint.create({ data: input });
  }

  updateEndpoint(
    endpointId: string,
    input: UpdateModelEndpointInput,
  ): Promise<ModelEndpointRecord> {
    return prisma.modelEndpoint.update({
      where: { id: endpointId },
      data: input,
    });
  }

  /** Revives a soft-deleted endpoint row in place under the same `id`, same reasoning as `restoreProvider`. */
  restoreEndpoint(
    endpointId: string,
    input: UpdateModelEndpointInput,
  ): Promise<ModelEndpointRecord> {
    return prisma.modelEndpoint.update({
      where: { id: endpointId },
      data: { ...input, deletedAt: null },
    });
  }

  deleteEndpoint(endpointId: string): Promise<ModelEndpointRecord> {
    return prisma.modelEndpoint.update({
      where: { id: endpointId },
      data: { isActive: false, deletedAt: new Date() },
    });
  }

  /**
   * Unlike `findActiveModelByCode`, does not require `isActive` - used to
   * validate an endpoint's `primaryModelCode`/`fallbackModelCode` reference a
   * real (if currently deactivated) model, without blocking an operator from
   * preparing an endpoint ahead of activating the model it points to.
   */
  async findModelByCode(modelCode: string): Promise<AiModelRecord | null> {
    const row = await prisma.modelDefinition.findFirst({
      where: { modelCode, deletedAt: null },
      include: PROVIDER_INCLUDE,
    });

    return row ? mapAiModel(row) : null;
  }

  /**
   * "Usable" means the model AND its provider are active.
   *
   * A model with no provider row is excluded for the same reason - it cannot
   * resolve an upstream, so treating it as usable would hide the breakage
   * until the call failed.
   */
  async findActiveModelByCode(
    modelCode: string,
  ): Promise<AiModelRecord | null> {
    const row = await prisma.modelDefinition.findFirst({
      where: {
        modelCode,
        isActive: true,
        deletedAt: null,
        providerRef: { isActive: true },
      },
      include: PROVIDER_INCLUDE,
    });

    return row ? mapAiModel(row) : null;
  }

  /**
   * Same rule as `findActiveModelByCode`: a model under a deactivated provider
   * is not usable, so listing it in the catalogue would advertise something
   * that 503s on call.
   */
  async listActiveModels(): Promise<AiModelRecord[]> {
    const rows = await prisma.modelDefinition.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        providerRef: { isActive: true },
      },
      orderBy: [
        // `sort` is the operator's catalogue ordering (settable via
        // /capability/models, default 999); recency only breaks ties.
        { sort: "asc" },
        { createdAt: "desc" },
      ],
      include: PROVIDER_INCLUDE,
    });

    return rows.map(mapAiModel);
  }

  async listModels(
    includeInactive = false,
    filters: { providerId?: string } = {},
  ): Promise<AiModelRecord[]> {
    const rows = await prisma.modelDefinition.findMany({
      where: {
        ...(includeInactive
          ? { deletedAt: null }
          : { isActive: true, deletedAt: null }),
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
      },
      orderBy: [
        { isActive: "desc" },
        // provider column retired → order by the joined provider_code (was `provider` asc).
        { providerRef: { providerCode: "asc" } },
        { createdAt: "desc" },
      ],
      include: PROVIDER_INCLUDE,
    });

    return rows.map(mapAiModel);
  }

  /**
   * The model a provider-level connectivity probe runs through.
   *
   * A provider has no wire of its own - every upstream call is made *as* some
   * model, so probing a provider means probing one of its models. The pick is
   * deterministic (`modelCode` ascending) rather than arbitrary so that
   * repeated probes hit the same model: that keeps `ModelProbeService`'s
   * per-model cooldown meaningful, which a rotating pick would defeat.
   *
   * Returns `null` when the provider has no active model - a real state for a
   * freshly onboarded provider, and the caller reports it rather than
   * inventing a probe target.
   */
  async findProbeableModelForProvider(
    providerId: string,
  ): Promise<AiModelRecord | null> {
    const row = await prisma.modelDefinition.findFirst({
      where: { providerId, isActive: true, deletedAt: null },
      orderBy: [{ modelCode: "asc" }],
      include: PROVIDER_INCLUDE,
    });

    return row ? mapAiModel(row) : null;
  }

  async findModelById(modelId: string): Promise<AiModelRecord | null> {
    const row = await prisma.modelDefinition.findFirst({
      where: {
        id: modelId,
        deletedAt: null,
      },
      include: PROVIDER_INCLUDE,
    });

    return row ? mapAiModel(row) : null;
  }

  async createModel(input: CreateAiModelInput): Promise<AiModelRecord> {
    const row = await prisma.modelDefinition.create({
      data: stripRetiredProvider(input),
      include: PROVIDER_INCLUDE,
    });

    return mapAiModel(row);
  }

  async updateModel(
    modelId: string,
    input: UpdateAiModelInput,
  ): Promise<AiModelRecord> {
    const row = await prisma.modelDefinition.update({
      where: {
        id: modelId,
      },
      data: stripRetiredProvider(input),
      include: PROVIDER_INCLUDE,
    });

    return mapAiModel(row);
  }

  deleteGrant(grantId: string): Promise<AiModelGrantRecord> {
    return prisma.modelGrant.update({
      where: { id: grantId },
      data: {
        isActive: false,
        deletedAt: new Date(),
      },
    });
  }

  async deleteModel(modelId: string): Promise<AiModelRecord> {
    const deletedAt = new Date();

    return prisma.$transaction(async (tx) => {
      await tx.modelGrant.updateMany({
        where: {
          modelId,
          deletedAt: null,
        },
        data: {
          isActive: false,
          deletedAt,
        },
      });

      const row = await tx.modelDefinition.update({
        where: {
          id: modelId,
        },
        data: {
          isActive: false,
          deletedAt,
        },
        include: PROVIDER_INCLUDE,
      });

      return mapAiModel(row);
    });
  }

// ── product_endpoint_grants: management (incr/06, incr/07) ──────────────

  listProductGrants(filters: {
    productCode?: string;
    endpointCode?: string;
    includeInactive?: boolean;
  }): Promise<ProductEndpointGrantRecord[]> {
    return prisma.productEndpointGrant.findMany({
      where: {
        deletedAt: null,
        ...(filters.includeInactive === false ? { isActive: true } : {}),
        ...(filters.productCode ? { productCode: filters.productCode } : {}),
        ...(filters.endpointCode ? { endpointCode: filters.endpointCode } : {}),
      },
      orderBy: [
        { isActive: "desc" },
        { productCode: "asc" },
        { endpointCode: "asc" },
      ],
    });
  }

  findProductGrantById(id: string): Promise<ProductEndpointGrantRecord | null> {
    return prisma.productEndpointGrant.findFirst({
      where: { id, deletedAt: null },
    });
  }

  /**
   * A plain insert, not a revive-on-conflict: `uq_product_endpoint_grants_scope`
   * is partial on `deleted_at IS NULL`, so a revoked grant does not occupy the
   * scope. That is the right shape - reissuing access is a new decision, and
   * keeping the deleted row preserves the record that it was once removed.
   */
  createProductGrant(input: {
    productCode: string;
    endpointCode: string;
    applicationId?: string | null;
    applicationType?: string | null;
    reason?: string | null;
    expiresAt?: Date | null;
    isActive?: boolean;
  }): Promise<ProductEndpointGrantRecord> {
    return prisma.productEndpointGrant.create({ data: input });
  }

  updateProductGrant(
    id: string,
    input: {
      applicationId?: string | null;
      applicationType?: string | null;
      reason?: string | null;
      expiresAt?: Date | null;
      isActive?: boolean;
    },
  ): Promise<ProductEndpointGrantRecord> {
    return prisma.productEndpointGrant.update({ where: { id }, data: input });
  }

  deleteProductGrant(id: string): Promise<ProductEndpointGrantRecord> {
    return prisma.productEndpointGrant.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
  }

  /**
   * Product-axis authorization: which ENTRY POINTS this product holds.
   *
   * Endpoints, not models. Repointing an endpoint is supposed to be invisible
   * to callers - that is what an endpoint is - so authorizing models would
   * break the abstraction at exactly the layer that must not break it, and
   * would make an endpoint's fallback need its own grant to ever fire.
   *
   * `productCode` is `act.sub` on the verified token: unlike `tenantId`, which
   * partly arrives in the request body, a caller cannot forge it.
   *
   * Application scope narrows a grant to one of the PRODUCT's own agents or
   * workflows - the product subdividing itself, which is what replaces
   * per-tenant scoping.
   */
  async listProductEndpointGrants(
    productCode: string,
    applicationId: string,
    applicationType: ApplicationType,
  ): Promise<ProductEndpointGrantRecord[]> {
    return prisma.productEndpointGrant.findMany({
      where: {
        productCode,
        deletedAt: null,
        isActive: true,
        OR: [
          { applicationId, applicationType },
          { applicationId: null, applicationType: null },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
    });
  }

  /**
   * The models a set of endpoints can reach - primary and fallback alike.
   *
   * This is what authorizes a direct `modelCode` call: a product's reach is
   * the endpoints it holds, and the models it may name fall out of them. That
   * is "the caller may pick a cheaper model, within what the product is
   * authorized for" expressed without a second grant table.
   */
  async reachableModelCodes(endpointCodes: string[]): Promise<Set<string>> {
    if (endpointCodes.length === 0) return new Set();
    const rows = await prisma.modelEndpoint.findMany({
      where: { code: { in: endpointCodes }, deletedAt: null, isActive: true },
      select: { primaryModelCode: true, fallbackModelCode: true },
    });
    const codes = new Set<string>();
    for (const row of rows) {
      codes.add(row.primaryModelCode);
      if (row.fallbackModelCode) codes.add(row.fallbackModelCode);
    }
    return codes;
  }

    async findBestGrant(
    modelId: string,
    tenantId: string,
    applicationId: string,
    applicationType: ApplicationType,
  ): Promise<AiModelGrantRecord | null> {
    assertUuid(tenantId, "INVALID_TENANT_ID", "tenantId");
    assertUuid(applicationId, "INVALID_APPLICATION_ID", "applicationId");

    const grants = await prisma.modelGrant.findMany({
      where: {
        modelId,
        tenantId,
        deletedAt: null,
        isActive: true,
        OR: [
          {
            applicationId,
            applicationType,
          },
          { applicationId: null, applicationType: null },
        ],
        AND: [
          {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        ],
      },
      orderBy: [
        // Postgres DESC defaults to NULLS FIRST, which would rank the wildcard
        // (NULL applicationId) rows ahead of the application-scoped ones and,
        // with 2+ wildcards, push the exact match out of the take-2 window.
        { applicationId: { sort: "desc", nulls: "last" } },
        { priority: "asc" },
        { createdAt: "desc" },
      ],
      take: 2,
    });

    return (
      grants.find(
        (grant) =>
          grant.applicationId === applicationId &&
          grant.applicationType === applicationType,
      ) ??
      grants.find(
        (grant) =>
          grant.applicationId === null && grant.applicationType === null,
      ) ??
      null
    );
  }

  /**
   * Task-profile routing (docs/70-workplan): pick the modelCode for the
   * highest-priority active, non-expired grant matching `taskProfile` for
   * this tenant - preferring an exact application-scope match over the
   * tenant-wide wildcard (application_id/type both null), same precedence
   * `findBestGrant` uses for entitlement.
   */
  async findModelCodeForTaskProfile(
    taskProfile: string,
    tenantId: string,
    applicationId: string,
    applicationType: ApplicationType,
  ): Promise<string | null> {
    assertUuid(tenantId, "INVALID_TENANT_ID", "tenantId");
    assertUuid(applicationId, "INVALID_APPLICATION_ID", "applicationId");

    const grants = await prisma.modelGrant.findMany({
      where: {
        tenantId,
        taskProfile,
        deletedAt: null,
        isActive: true,
        modelDef: { isActive: true, deletedAt: null },
        OR: [
          { applicationId, applicationType },
          { applicationId: null, applicationType: null },
        ],
        AND: [
          {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        ],
      },
      orderBy: [
        // NULLS LAST for the same reason as `findBestGrant`: DESC alone would
        // let wildcard rows crowd the scoped match out of the take-2 window.
        { applicationId: { sort: "desc", nulls: "last" } },
        { priority: "asc" },
        { createdAt: "desc" },
      ],
      take: 2,
    });

    const picked =
      grants.find(
        (grant) =>
          grant.applicationId === applicationId &&
          grant.applicationType === applicationType,
      ) ??
      grants.find(
        (grant) =>
          grant.applicationId === null && grant.applicationType === null,
      ) ??
      null;

    if (!picked) {
      return null;
    }

    const model = await this.findModelById(picked.modelId);
    return model?.modelCode ?? null;
  }

  /**
   * Tenant-filtered "available models" list (docs/70-workplan): distinct
   * active models the tenant/application has an active, non-expired grant
   * for - not the global unfiltered catalog.
   */
  async listGrantedModels(filters: {
    tenantId: string;
    applicationId?: string;
    applicationType?: ApplicationType;
  }): Promise<AiModelRecord[]> {
    assertUuid(filters.tenantId, "INVALID_TENANT_ID", "tenantId");
    if (filters.applicationId) {
      assertUuid(filters.applicationId, "INVALID_APPLICATION_ID", "applicationId");
    }

    const grants = await prisma.modelGrant.findMany({
      where: {
        tenantId: filters.tenantId,
        deletedAt: null,
        isActive: true,
        modelDef: { isActive: true, deletedAt: null },
        OR: [
          filters.applicationId
            ? {
                applicationId: filters.applicationId,
                ...(filters.applicationType
                  ? { applicationType: filters.applicationType }
                  : {}),
              }
            : {},
          { applicationId: null, applicationType: null },
        ],
        AND: [
          {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        ],
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    const modelIds = [...new Set(grants.map((grant) => grant.modelId))];
    const models = await Promise.all(
      modelIds.map((modelId) => this.findModelById(modelId)),
    );

    return (
      models
        .filter((model): model is AiModelRecord => model !== null)
        // Same catalogue ordering as `listActiveModels`; Array#sort is stable,
        // so grant order (priority asc, createdAt desc) breaks ties.
        .sort((a, b) => a.sort - b.sort)
    );
  }

  listGrants(filters: {
    tenantId?: string;
    modelId?: string;
    applicationId?: string;
    applicationType?: ApplicationType;
  }): Promise<AiModelGrantRecord[]> {
    return prisma.modelGrant.findMany({
      where: {
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.modelId ? { modelId: filters.modelId } : {}),
        ...(filters.applicationId
          ? { applicationId: filters.applicationId }
          : {}),
        ...(filters.applicationType
          ? { applicationType: filters.applicationType }
          : {}),
        deletedAt: null,
      },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    });
  }

  findGrantById(grantId: string): Promise<AiModelGrantRecord | null> {
    return prisma.modelGrant.findFirst({
      where: {
        id: grantId,
        deletedAt: null,
      },
    });
  }

  createGrant(input: CreateAiModelGrantInput): Promise<AiModelGrantRecord> {
    return prisma.modelGrant.create({
      data: {
        modelId: input.modelId,
        tenantId: input.tenantId,
        applicationId: input.applicationId ?? input.agentId ?? null,
        applicationType:
          input.applicationType ?? (input.agentId ? "agent" : null),
        agentId: input.agentId ?? null,
        taskProfile: input.taskProfile ?? null,
        priority: input.priority ?? 100,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        isActive: input.isActive ?? true,
      },
    });
  }

  updateGrant(
    grantId: string,
    input: UpdateAiModelGrantInput,
  ): Promise<AiModelGrantRecord> {
    return prisma.modelGrant.update({
      where: {
        id: grantId,
      },
      data: input,
    });
  }

  /**
   * `asOf` makes the append-versioning actually answerable: which rule was in
   * force for a model at a given instant. Without it the table kept history
   * that nothing could query - `isActive` alone cannot say it, because
   * nothing flips a rule to inactive when its `expiresAt` passes, so an
   * expired-but-still-active row read exactly like a current one.
   *
   * Same predicate `findApplicablePolicy` already uses for policies:
   * effective_at <= asOf AND (expires_at IS NULL OR expires_at > asOf).
   * Omitting `asOf` keeps the previous behaviour - the full ledger, history
   * included - because that is what an operator editing pricing wants to see.
   */
/**
   * Soft delete. The row stays and stops being served; the record that it
   * existed and was removed lives in `audit.change_records`, which is
   * append-only and unaffected by this.
   */
  deletePriceRule(id: string): Promise<ModelPriceRuleRecord> {
    return prisma.modelPriceRule.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
  }

  deletePolicy(id: string): Promise<ModelPolicyRecord> {
    return prisma.modelPolicy.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
  }

    listPriceRules(filters: {
    modelId?: string;
    includeInactive?: boolean;
    asOf?: Date;
  }): Promise<ModelPriceRuleRecord[]> {
    return prisma.modelPriceRule.findMany({
      where: {
        deletedAt: null,
        ...(filters.modelId ? { modelId: filters.modelId } : {}),
        ...(filters.includeInactive ? {} : { isActive: true }),
        ...(filters.asOf
          ? {
              effectiveAt: { lte: filters.asOf },
              OR: [{ expiresAt: null }, { expiresAt: { gt: filters.asOf } }],
            }
          : {}),
      },
      orderBy: [
        { isActive: "desc" },
        { effectiveAt: "desc" },
        { createdAt: "desc" },
      ],
    });
  }

  findPriceRuleById(priceRuleId: string): Promise<ModelPriceRuleRecord | null> {
    return prisma.modelPriceRule.findFirst({
      where: { id: priceRuleId },
    });
  }

  createPriceRule(
    input: CreateModelPriceRuleInput,
  ): Promise<ModelPriceRuleRecord> {
    return prisma.modelPriceRule.create({ data: input });
  }

  updatePriceRule(
    priceRuleId: string,
    input: UpdateModelPriceRuleInput,
  ): Promise<ModelPriceRuleRecord> {
    return prisma.modelPriceRule.update({
      where: { id: priceRuleId },
      data: input,
    });
  }

  listPolicies(filters: {
    modelId?: string;
    tenantId?: string;
    includeInactive?: boolean;
  }): Promise<ModelPolicyRecord[]> {
    return prisma.modelPolicy.findMany({
      where: {
        deletedAt: null,
        ...(filters.modelId ? { modelId: filters.modelId } : {}),
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [
        { isActive: "desc" },
        { priority: "asc" },
        { effectiveAt: "desc" },
      ],
    });
  }

  findPolicyById(policyId: string): Promise<ModelPolicyRecord | null> {
    return prisma.modelPolicy.findFirst({
      where: { id: policyId },
    });
  }

  createPolicy(input: CreateModelPolicyInput): Promise<ModelPolicyRecord> {
    return prisma.modelPolicy.create({ data: input });
  }

  updatePolicy(
    policyId: string,
    input: UpdateModelPolicyInput,
  ): Promise<ModelPolicyRecord> {
    return prisma.modelPolicy.update({
      where: { id: policyId },
      data: input,
    });
  }

  /**
   * Same precedence shape as `findBestGrant` above: prefer the tenant-specific
   * row over the wildcard (`tenant_id IS NULL`) row when both exist. No
   * `deletedAt` filter - `model_policies` has no soft-delete column, `isActive`
   * is the only lifecycle flag.
   */
  async findApplicablePolicy(
    modelId: string,
    tenantId: string,
  ): Promise<ModelPolicyRecord | null> {
    const now = new Date();
    // A non-UUID tenantId matches the WILDCARD row only, and is never sent to
    // the `uuid` column.
    //
    // Unlike `findBestGrant`, this had no `assertUuid`, so a non-UUID reached
    // Postgres and raised a cast error. That error is not a
    // ModelRuntimeException, so `enrichRuntimeError` rewrote it to
    // `503 PROVIDER_UNAVAILABLE` - which since the X-1 pass carries
    // `retryable: true`. Atlas was telling a caller whose payload was
    // malformed that the upstream was down and to keep retrying.
    //
    // It is reachable exactly when a caller's PRODUCT grant matches, because
    // that path returns before the tenant-axis guard in `QuotaService`, and it
    // then runs straight into the rate-limit lookup.
    //
    // Throwing INVALID_TENANT_ID instead would be honest but wrong here: the
    // caller is legitimately authorized and this is a rate-limit lookup, not
    // an authorization one. Skipping the lookup entirely would be worse still
    // - a wildcard policy (`tenant_id IS NULL`) applies to everyone, so
    // skipping would let exactly these callers escape the rate limit with
    // nothing reporting it. Matching only the wildcard is what the query
    // already means for a tenant that cannot have a row of its own.
    const tenantScopes: Array<{ tenantId: string | null }> = isUuid(tenantId)
      ? [{ tenantId }, { tenantId: null }]
      : [{ tenantId: null }];
    const policies = await prisma.modelPolicy.findMany({
      where: {
        deletedAt: null,
        modelId,
        isActive: true,
        effectiveAt: { lte: now },
        AND: [
          { OR: tenantScopes },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
      orderBy: [
        // Scope precedence is decided by the .find() chain below, not by
        // priority - so tenant-scoped rows must sort ahead of wildcards or the
        // take-2 window can fill with wildcards and never surface the
        // tenant-specific row. NULLS LAST because DESC defaults to NULLS FIRST.
        { tenantId: { sort: "desc", nulls: "last" } },
        { priority: "asc" },
        { effectiveAt: "desc" },
      ],
      take: 2,
    });

    return (
      policies.find((policy) => policy.tenantId === tenantId) ??
      policies.find((policy) => policy.tenantId === null) ??
      null
    );
  }

  /**
   * Tenant self-service usage, aggregated from Atlas's own request log.
   * Single-scope version of `listUsageSummaries` below - same underlying
   * table, this one pre-scoped to one tenant/workspace for `/tenancy/usage`.
   *
   * `scopeColumn` is chosen by the caller from a fixed pair - never
   * interpolated from request input - and `scopeId` is bound as a parameter.
   */
  aggregateReqlogUsage(params: {
    scopeColumn: "tenant_id" | "workspace_id";
    scopeId: string;
    from: Date;
    to: Date;
  }): Promise<
    Array<{
      modelCode: string | null;
      providerCode: string | null;
      requests: bigint;
      inputTokens: bigint | null;
      outputTokens: bigint | null;
      totalTokens: bigint | null;
      errors: bigint;
    }>
  > {
    const column = params.scopeColumn === "tenant_id" ? "tenant_id" : "workspace_id";
    return prisma.$queryRawUnsafe(
      `
      SELECT
        model_code                                   AS "modelCode",
        provider_code                                AS "providerCode",
        count(*)                                     AS "requests",
        coalesce(sum(input_tokens), 0)               AS "inputTokens",
        coalesce(sum(output_tokens), 0)              AS "outputTokens",
        coalesce(sum(total_tokens), 0)               AS "totalTokens",
        count(*) FILTER (WHERE status <> 'success')  AS "errors"
      FROM reqlog.request_records
      WHERE ${column} = $1::uuid
        AND created_at >= $2 AND created_at < $3
      GROUP BY model_code, provider_code
      ORDER BY "totalTokens" DESC, model_code
      `,
      params.scopeId,
      params.from,
      params.to,
    );
  }

  /**
   * Registry drift the lifecycle rules exist to prevent, counted so every
   * environment self-reports it.
   *
   * Both states are reachable through legitimate operator actions: a model
   * row can sit active under a deactivated provider, and an active endpoint
   * can point at a model that cannot serve. Surfacing the counts here means
   * an environment can be checked without database access.
   */
  readRegistryDrift(): Promise<
    Array<{
      activeModelsUnderInactiveProvider: bigint | number;
      activeEndpointsWithUnusableModel: bigint | number;
    }>
  > {
    return prisma.$queryRawUnsafe(`
      SELECT
        (SELECT count(*)
           FROM model.models m
           JOIN model.model_providers p ON p.id = m.provider_id
          WHERE m.is_active AND m.deleted_at IS NULL
            AND NOT p.is_active
        ) AS "activeModelsUnderInactiveProvider",
        (SELECT count(*)
           FROM model.model_endpoints e
           LEFT JOIN model.models m
             ON m.model_code = e.primary_model_code AND m.deleted_at IS NULL
           LEFT JOIN model.model_providers p ON p.id = m.provider_id
          WHERE e.deleted_at IS NULL AND e.is_active
            AND (m.id IS NULL OR NOT m.is_active OR NOT p.is_active)
        ) AS "activeEndpointsWithUnusableModel"
    `);
  }

  /**
   * Reqlog partition runway + DEFAULT-partition occupancy, for the
   * readiness check. Reads `pg_inherits` because partitions have no Prisma
   * model. The query is a constant - nothing here is caller-derived.
   *
   * The partition month is recovered from the child's own name suffix, which
   * `reqlog.ensure_partitions` generates (see
   * `deploy/database/ddl/incr/02_reqlog_partition_maintenance.sql`), so naming
   * and parsing stay a closed loop.
   */
  readReqlogPartitionRunway(): Promise<
    Array<{ monthsAhead: bigint | number; defaultPartitionRows: bigint | number }>
  > {
    return prisma.$queryRawUnsafe(`
      SELECT
        (SELECT count(*)
           FROM pg_inherits inh
           JOIN pg_class c      ON c.oid = inh.inhrelid
           JOIN pg_class parent ON parent.oid = inh.inhparent
           JOIN pg_namespace n  ON n.oid = c.relnamespace
          WHERE n.nspname = 'reqlog'
            AND parent.relname = 'request_records'
            AND c.relname ~ '_y[0-9]{4}m[0-9]{2}$'
            AND to_date(right(c.relname, 8), '"y"YYYY"m"MM')
                >= date_trunc('month', now())::date
        ) AS "monthsAhead",
        (SELECT count(*) FROM ONLY reqlog.request_records_default)
          AS "defaultPartitionRows"
    `);
  }

  /**
   * `GET /capability/logs` (operator log search). Cursor pagination on
   * `(createdAt, id)` DESC - `reqlog` volume is unbounded, unlike every other
   * `/capability/*` list endpoint (finite providers/models/policies), which
   * is why this is the first paginated read in the repository. `createdAt`
   * is the partition key, so a `from`/`to` range prunes to the covering
   * partition(s) for free - no partition-aware logic needed here.
   */
  async searchRequestLogs(filters: {
    tenantId?: string;
    modelCode?: string;
    providerCode?: string;
    endpointCode?: string;
    status?: string;
    requestId?: string;
    taskId?: string;
    from?: Date;
    to?: Date;
    cursor?: { createdAt: Date; id: string };
    limit: number;
  }): Promise<RequestLogRecord[]> {
    return prisma.requestRecord.findMany({
      where: {
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.modelCode ? { modelCode: filters.modelCode } : {}),
        ...(filters.providerCode ? { providerCode: filters.providerCode } : {}),
        ...(filters.endpointCode ? { endpointCode: filters.endpointCode } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.requestId ? { requestId: filters.requestId } : {}),
        // product_251 X-2: the reason the column exists. Filtering by taskId
        // is "show me everything this agent task did", which is the Atlas half
        // of a total that spans Atlas and runos.
        ...(filters.taskId ? { taskId: filters.taskId } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
        ...(filters.cursor
          ? {
              OR: [
                { createdAt: { lt: filters.cursor.createdAt } },
                {
                  createdAt: filters.cursor.createdAt,
                  id: { lt: filters.cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filters.limit,
    });
  }

  /**
   * Error detail for a page of `searchRequestLogs` results - `error_records`
   * has no FK to `request_records` (both keyed loosely by the app-level
   * `requestId` string, per `request-log.service.ts`'s write path), so this
   * is a second indexed lookup rather than a join.
   */
  findErrorRecordsByRequestIds(
    requestIds: string[],
  ): Promise<ErrorLogRecord[]> {
    if (requestIds.length === 0) return Promise.resolve([]);
    return prisma.errorRecord.findMany({
      where: { requestId: { in: requestIds } },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * `GET /capability/logs/summary` (operator dashboard: QPS/error-rate/
   * latency). Same `$queryRawUnsafe` shape as `aggregateReqlogUsage` above -
   * an established, reviewed pattern for aggregation this repository already
   * uses when Prisma's query builder can't express it (no p95 support).
   * `modelCode`/`providerCode` are optional filters bound as parameters
   * either way (`$3::text IS NULL OR model_code = $3`) rather than
   * conditionally interpolated, so the query text never varies with input.
   * Probe traffic is excluded (`usage_type IS DISTINCT FROM 'test'`) - see
   * `listUsageSummaries`.
   */
  async summarizeRequestLogs(params: {
    from: Date;
    to: Date;
    modelCode?: string;
    providerCode?: string;
    endpointCode?: string;
  }): Promise<{
    overall: {
      requests: bigint;
      errors: bigint;
      avgLatencyMs: number | null;
      p95LatencyMs: number | null;
    };
    byGroup: Array<{
      modelCode: string | null;
      providerCode: string | null;
      endpointCode: string | null;
      requests: bigint;
      errors: bigint;
      totalTokens: bigint;
      avgLatencyMs: number | null;
      p95LatencyMs: number | null;
    }>;
  }> {
    const modelCode = params.modelCode ?? null;
    const providerCode = params.providerCode ?? null;
    const endpointCode = params.endpointCode ?? null;

    const [overallRows, byGroup] = await Promise.all([
      prisma.$queryRawUnsafe<
        Array<{
          requests: bigint;
          errors: bigint;
          avgLatencyMs: number | null;
          p95LatencyMs: number | null;
        }>
      >(
        `
        SELECT
          count(*)                                             AS "requests",
          count(*) FILTER (WHERE status <> 'success')          AS "errors",
          avg(latency_ms)                                      AS "avgLatencyMs",
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS "p95LatencyMs"
        FROM reqlog.request_records
        WHERE created_at >= $1 AND created_at < $2
          AND (usage_type IS DISTINCT FROM 'test')
          AND ($3::varchar IS NULL OR model_code = $3)
          AND ($4::varchar IS NULL OR provider_code = $4)
          AND ($5::varchar IS NULL OR endpoint_code = $5)
        `,
        params.from,
        params.to,
        modelCode,
        providerCode,
        endpointCode,
      ),
      prisma.$queryRawUnsafe<
        Array<{
          modelCode: string | null;
          providerCode: string | null;
          endpointCode: string | null;
          requests: bigint;
          errors: bigint;
          totalTokens: bigint;
          avgLatencyMs: number | null;
          p95LatencyMs: number | null;
        }>
      >(
        `
        SELECT
          model_code                                           AS "modelCode",
          provider_code                                        AS "providerCode",
          endpoint_code                                        AS "endpointCode",
          count(*)                                             AS "requests",
          count(*) FILTER (WHERE status <> 'success')          AS "errors",
          coalesce(sum(total_tokens), 0)                       AS "totalTokens",
          avg(latency_ms)                                      AS "avgLatencyMs",
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS "p95LatencyMs"
        FROM reqlog.request_records
        WHERE created_at >= $1 AND created_at < $2
          AND (usage_type IS DISTINCT FROM 'test')
          AND ($3::varchar IS NULL OR model_code = $3)
          AND ($4::varchar IS NULL OR provider_code = $4)
          AND ($5::varchar IS NULL OR endpoint_code = $5)
        GROUP BY model_code, provider_code, endpoint_code
        ORDER BY "requests" DESC
        `,
        params.from,
        params.to,
        modelCode,
        providerCode,
        endpointCode,
      ),
    ]);

    return {
      overall: overallRows[0] ?? {
        requests: 0n,
        errors: 0n,
        avgLatencyMs: null,
        p95LatencyMs: null,
      },
      byGroup,
    };
  }

  /**
   * TD-047. Token quantities grouped by the price rule that was in force when
   * each request was written - the temporal join, and deliberately nothing else.
   *
   * The arithmetic is NOT here, and that is a decision rather than an omission.
   * Money maths inside a `$queryRawUnsafe` string is money maths no test in this
   * repo can reach, because vitest mocks Prisma: a fully green suite would say
   * nothing about it. What SQL is uniquely good at - "the rule whose window
   * contains this row's created_at" - stays; the multiplication moves to
   * `computeCostRollup`, where each of its three failure modes is an assertion.
   *
   * Three choices worth naming, because each has a defensible opposite:
   *
   *   - `is_active` is NOT part of rule selection. It is a present-tense switch
   *     on a table versioned by append, and letting it decide history would make
   *     last month's cost change when someone flips it today. The temporal truth
   *     is `effective_at` / `expires_at`; `deleted_at` is honoured because a
   *     soft-deleted rule is retracted, not merely retired.
   *   - `m.deleted_at` is NOT filtered. The request happened and the price
   *     applied; deleting the model afterwards must not erase what it cost.
   *   - a row with no rule in force comes back with `priceRuleId: null` and its
   *     own group. That is not an empty result to drop - it is the count of
   *     traffic nobody has priced, and the caller has to report it rather than
   *     let it read as free.
   *
   * Probe traffic (`usage_type='test'`) is excluded for the same reason
   * `summarizeRequestLogs` excludes it: synthetic connectivity checks are not
   * usage anyone ran. `IS DISTINCT FROM` so rows predating the column still count.
   */
  async summarizeRequestCost(params: {
    from: Date;
    to: Date;
    modelCode?: string;
    providerCode?: string;
  }): Promise<
    Array<{
      modelCode: string | null;
      providerCode: string | null;
      priceRuleId: string | null;
      currency: string | null;
      unitTokens: number | null;
      inputUnitPrice: string | null;
      outputUnitPrice: string | null;
      requestUnitPrice: string | null;
      cachedInputUnitPrice: string | null;
      requests: bigint;
      requestsMissingInput: bigint;
      requestsMissingOutput: bigint;
      inputTokens: bigint;
      cachedInputTokens: bigint;
      outputTokens: bigint;
      reasoningTokens: bigint;
    }>
  > {
    const modelCode = params.modelCode ?? null;
    const providerCode = params.providerCode ?? null;

    return prisma.$queryRawUnsafe(
      `
      SELECT
        r.model_code                                       AS "modelCode",
        r.provider_code                                    AS "providerCode",
        p.id::text                                         AS "priceRuleId",
        p.currency                                         AS "currency",
        p.unit_tokens                                      AS "unitTokens",
        p.input_unit_price::text                           AS "inputUnitPrice",
        p.output_unit_price::text                          AS "outputUnitPrice",
        p.request_unit_price::text                         AS "requestUnitPrice",
        p.cached_input_unit_price::text                    AS "cachedInputUnitPrice",
        count(*)                                           AS "requests",
        count(*) FILTER (WHERE r.input_tokens IS NULL)     AS "requestsMissingInput",
        count(*) FILTER (WHERE r.output_tokens IS NULL)    AS "requestsMissingOutput",
        coalesce(sum(r.input_tokens), 0)                   AS "inputTokens",
        coalesce(sum(r.cached_input_tokens), 0)            AS "cachedInputTokens",
        coalesce(sum(r.output_tokens), 0)                  AS "outputTokens",
        coalesce(sum(r.reasoning_tokens), 0)               AS "reasoningTokens"
      FROM reqlog.request_records r
      LEFT JOIN model.models m
        ON m.model_code = r.model_code
      LEFT JOIN LATERAL (
        SELECT pr.id, pr.currency, pr.unit_tokens, pr.input_unit_price,
               pr.output_unit_price, pr.request_unit_price,
               pr.cached_input_unit_price
        FROM model.model_price_rules pr
        WHERE pr.model_id = m.id
          AND pr.billing_mode = 'token'
          AND pr.deleted_at IS NULL
          AND pr.effective_at <= r.created_at
          AND (pr.expires_at IS NULL OR pr.expires_at > r.created_at)
        ORDER BY pr.effective_at DESC, pr.created_at DESC
        LIMIT 1
      ) p ON TRUE
      WHERE r.created_at >= $1 AND r.created_at < $2
        AND (r.usage_type IS DISTINCT FROM 'test')
        AND ($3::varchar IS NULL OR r.model_code = $3)
        AND ($4::varchar IS NULL OR r.provider_code = $4)
      GROUP BY r.model_code, r.provider_code, p.id, p.currency, p.unit_tokens,
               p.input_unit_price, p.output_unit_price, p.request_unit_price,
               p.cached_input_unit_price
      ORDER BY "requests" DESC
      `,
      params.from,
      params.to,
      modelCode,
      providerCode,
    );
  }

  /**
   * Operator-facing, cross-tenant usage rollup - aggregated from
   * `reqlog.request_records`, grouped by (tenant, month, application). The
   * same table `aggregateReqlogUsage` reads for the tenant-scoped version.
   *
   * Optional filters are bound as parameters (`$N::type IS NULL OR ...`),
   * never conditionally interpolated - same pattern as `summarizeRequestLogs`.
   *
   * Probe traffic (`usage_type='test'`, ModelProbeService) is excluded: it is
   * synthetic connectivity checking against the all-zero sentinel, not usage
   * anyone ran. `IS DISTINCT FROM` rather than `<>` so rows written before
   * the column existed (NULL usage_type) still count.
   */
  listUsageSummaries(filters: {
    tenantId?: string;
    applicationId?: string;
    applicationType?: ApplicationType;
    cycleMonth?: string;
    providerCode?: string;
    modelCode?: string;
    productCode?: string;
  }): Promise<TenantUsageSummaryRecord[]> {
    return prisma.$queryRawUnsafe<TenantUsageSummaryRecord[]>(
      `
      SELECT
        tenant_id::text                                        AS "tenantId",
        workspace_id::text                                     AS "workspaceId",
        product_code                                            AS "productCode",
        to_char(date_trunc('month', created_at), 'YYYY-MM')     AS "cycleMonth",
        application_id::text                                    AS "applicationId",
        application_type                                        AS "applicationType",
        count(*)                                                AS "requests",
        coalesce(sum(input_tokens), 0)                          AS "inputTokens",
        coalesce(sum(output_tokens), 0)                         AS "outputTokens",
        coalesce(sum(total_tokens), 0)                          AS "totalTokens",
        count(*) FILTER (WHERE status <> 'success')             AS "errors"
      FROM reqlog.request_records
      WHERE tenant_id IS NOT NULL
        AND (usage_type IS DISTINCT FROM 'test')
        AND ($1::uuid IS NULL OR tenant_id = $1)
        AND ($2::uuid IS NULL OR application_id = $2)
        AND ($3::varchar IS NULL OR application_type = $3)
        AND ($4::varchar IS NULL OR to_char(date_trunc('month', created_at), 'YYYY-MM') = $4)
        AND ($5::varchar IS NULL OR provider_code = $5)
        AND ($6::varchar IS NULL OR model_code = $6)
        AND ($7::varchar IS NULL OR product_code = $7)
      GROUP BY tenant_id, workspace_id, product_code, date_trunc('month', created_at), application_id, application_type
      ORDER BY date_trunc('month', created_at) DESC, tenant_id, product_code
      `,
      filters.tenantId ?? null,
      filters.applicationId ?? null,
      filters.applicationType ?? null,
      filters.cycleMonth ?? null,
      filters.providerCode ?? null,
      filters.modelCode ?? null,
      filters.productCode ?? null,
    );
  }

  /**
   * The provider/model axes of the same reqlog rollup.
   *
   * Kept separate from `listUsageSummaries` rather than folded into it with a
   * dynamic GROUP BY, for two reasons. The tenant rollup's response shape is
   * already consumed by opera and must not shift; and these axes deliberately
   * do *not* group by application (see `UsageRollupRecord`), so they are a
   * different question, not a parameterisation of the same one.
   *
   * `dimension` selects a **constant** column name through an exhaustive
   * switch - it is re-derived here, never interpolated from caller input, the
   * same discipline `aggregateReqlogUsage` uses for its scope column. Every
   * filter is a bound parameter. Probe traffic is excluded
   * (`usage_type IS DISTINCT FROM 'test'`) - see `listUsageSummaries`.
   */
  listUsageRollup(params: {
    dimension: Exclude<UsageRollupDimension, "tenant">;
    tenantId?: string;
    applicationId?: string;
    applicationType?: ApplicationType;
    cycleMonth?: string;
    providerCode?: string;
    modelCode?: string;
    productCode?: string;
  }): Promise<UsageRollupRecord[]> {
    const column = ROLLUP_COLUMN[params.dimension];

    return prisma.$queryRawUnsafe<UsageRollupRecord[]>(
      `
      SELECT
        ${column}                                               AS "groupKey",
        to_char(date_trunc('month', created_at), 'YYYY-MM')     AS "cycleMonth",
        count(*)                                                AS "requests",
        coalesce(sum(input_tokens), 0)                          AS "inputTokens",
        coalesce(sum(output_tokens), 0)                         AS "outputTokens",
        coalesce(sum(total_tokens), 0)                          AS "totalTokens",
        count(*) FILTER (WHERE status <> 'success')             AS "errors"
      FROM reqlog.request_records
      WHERE ${column} IS NOT NULL
        AND (usage_type IS DISTINCT FROM 'test')
        AND ($1::uuid IS NULL OR tenant_id = $1)
        AND ($2::uuid IS NULL OR application_id = $2)
        AND ($3::varchar IS NULL OR application_type = $3)
        AND ($4::varchar IS NULL OR to_char(date_trunc('month', created_at), 'YYYY-MM') = $4)
        AND ($5::varchar IS NULL OR provider_code = $5)
        AND ($6::varchar IS NULL OR model_code = $6)
        AND ($7::varchar IS NULL OR product_code = $7)
      GROUP BY ${column}, date_trunc('month', created_at)
      ORDER BY date_trunc('month', created_at) DESC, "totalTokens" DESC, ${column}
      `,
      params.tenantId ?? null,
      params.applicationId ?? null,
      params.applicationType ?? null,
      params.cycleMonth ?? null,
      params.providerCode ?? null,
      params.modelCode ?? null,
      params.productCode ?? null,
    );
  }

}

/**
 * model.models row → AiModelRecord, deriving `provider` and `providerConfig`
 * from the joined provider row.
 */
function mapAiModel(row: AiModelRow): AiModelRecord {
  const { providerRef, ...rest } = row;
  return {
    ...rest,
    provider: providerRef?.providerCode ?? "",
    providerConfig: providerRef?.config ?? null,
    // No provider row means the model cannot serve; defaulting to true would
    // hide exactly the case this field exists to expose.
    providerActive: providerRef?.isActive ?? false,
  };
}

/** Drop the retired `provider` column before writing model.models. */
function stripRetiredProvider(
  input: CreateAiModelInput | UpdateAiModelInput,
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...input };
  delete data["provider"];
  return data;
}
