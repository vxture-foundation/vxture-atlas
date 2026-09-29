import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ModelRegistryRepository } from "./model-registry.repository";
import type { AiModelRecord, ApplicationType } from "../types/runtime.types";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import { toObjectState, type GrantedEndpointState } from "../object-state";

export interface ResolveModelCodeForTaskProfileInput {
  tenantId: string;
  taskProfile: string;
  applicationId: string;
  applicationType: ApplicationType;
}

/** What an endpoint code resolves to - see `resolveEndpoint`. */
export interface ResolvedEndpoint {
  modelCode: string;
  /** The endpoint's own chain; empty means "no fallback", not "use the model's". */
  fallbackModelCodes: string[];
}

@Injectable()
export class ModelRegistryService {
  constructor(
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
  ) {}

  async getActiveModel(modelCode: string): Promise<AiModelRecord> {
    const model = await this.repository.findActiveModelByCode(modelCode);

    if (!model) {
      throw new ModelRuntimeException(
        HttpStatus.NOT_FOUND,
        "MODEL_NOT_ROUTABLE",
        `AI model "${modelCode}" is not registered or inactive`,
        { modelCode },
      );
    }

    return model;
  }

  listActiveModels(): Promise<AiModelRecord[]> {
    return this.repository.listActiveModels();
  }

  /**
   * Task-profile routing on the LEGACY TENANT AXIS - see `ChatRequest.taskProfile`
   * for why a product integrating today should name an `endpointCode` instead,
   * and TD-052 for why this is not extended.
   *
   * Resolves a modelCode from the tenant's active `model_grants.task_profile`
   * match. Picks the highest-priority (lowest `priority` number) active,
   * non-expired grant scoped to the exact application (or the tenant-wide
   * wildcard grant), same precedence as `QuotaService.assertAllowed`'s
   * entitlement lookup.
   *
   * Kept working, deliberately: `model_grant_authorizations_total{axis}` decides
   * when this goes, and that decision is made by observing zero traffic rather
   * than by assuming the migration finished.
   */
  async resolveModelCodeForTaskProfile(
    input: ResolveModelCodeForTaskProfileInput,
  ): Promise<string> {
    const modelCode = await this.repository.findModelCodeForTaskProfile(
      input.taskProfile,
      input.tenantId,
      input.applicationId,
      input.applicationType,
    );

    if (!modelCode) {
      throw new ModelRuntimeException(
        HttpStatus.NOT_FOUND,
        "TASK_PROFILE_NOT_ROUTABLE",
        `No active model grant matches taskProfile "${input.taskProfile}" for this tenant/application`,
      );
    }

    return modelCode;
  }

  /**
   * Endpoint routing: the caller names a stable capability entry point
   * (`chat/default`) instead of a concrete model, which is the whole reason
   * `model.model_endpoints` exists - business systems hard-code the name and
   * operators repoint it without a caller-side change.
   *
   * Returns the endpoint's OWN fallback rather than letting the resolved
   * model's `config.fallbackModelCodes` apply. Routing via an endpoint means
   * the endpoint is the authority on what happens when its primary fails; if
   * the model's own chain also applied, the same question would have two
   * answers depending on which one you read.
   *
   * Unlike `taskProfile`, this is a GLOBAL name resolved from a single string -
   * no tenant, no application scope. That is the whole reason a PRODUCT should
   * name an endpoint: authorization for it lives on the product axis
   * (`product_endpoint_grants`), so there is no tenant to supply, and
   * repointing costs nothing - every product holding the code follows.
   *
   * "Not a per-tenant preference" was the previous wording, and it framed the
   * difference as scope when the difference is which AXIS the selector lives
   * on. That framing is how a product was steered onto the retiring one
   * (TD-052).
   *
   * Entitlement is still enforced downstream against the resolved model, so
   * naming an endpoint never grants access to a model the caller lacks.
   */
  async resolveEndpoint(code: string): Promise<ResolvedEndpoint> {
    const endpoint = await this.repository.findActiveEndpointByCode(code);

    if (!endpoint) {
      throw new ModelRuntimeException(
        HttpStatus.NOT_FOUND,
        "ENDPOINT_NOT_ROUTABLE",
        `No active endpoint matches "${code}" - it does not exist, or it has been deactivated`,
      );
    }

    return {
      modelCode: endpoint.primaryModelCode,
      fallbackModelCodes: endpoint.fallbackModelCode
        ? [endpoint.fallbackModelCode]
        : [],
    };
  }

  /**
   * Tenant-filtered "available models" list (docs/70-workplan): the models a
   * tenant/application is actually entitled to call today, derived from
   * active non-expired `model_grants` - not the full unfiltered catalog
   * `listActiveModels()` returns.
   */
  listModelsForTenant(filters: {
    tenantId: string;
    applicationId?: string;
    applicationType?: ApplicationType;
  }): Promise<AiModelRecord[]> {
    return this.repository.listGrantedModels(filters);
  }

  /**
   * The entry points the CALLING PRODUCT holds, for the consumer catalog
   * behind `GET /v1/endpoints`.
   *
   * Built on `listProductEndpointGrants` - the same call `QuotaService`
   * authorizes with - rather than a query of its own. That is the whole point:
   * a catalog assembled from a second, parallel predicate would drift from what
   * the call path actually permits, and a catalog that disagrees with the call
   * path is worse than no catalog, because it is believed.
   *
   * `state` reflects what a call would DO, which is not the same as whether a
   * grant exists:
   *   - `active`   the grant is live and the endpoint routes
   *   - `inactive` the grant is live but an operator switched the endpoint off,
   *                or removed it from the catalog (soft delete)
   *   - `missing`  the grant names a code no endpoint has - a dangling grant,
   *                usually an operator typo
   * The last two both produce `404 ENDPOINT_NOT_ROUTABLE` at call time. Folding
   * them into an absence would leave the caller unable to tell "I was never
   * granted this" from "this was granted and is broken" - and only one of those
   * is theirs to fix.
   */
  async listGrantedEndpoints(scope: {
    productCode: string;
    applicationId: string;
    applicationType: ApplicationType;
  }): Promise<GrantedEndpoint[]> {
    const grants = await this.repository.listProductEndpointGrants(
      scope.productCode,
      scope.applicationId,
      scope.applicationType,
    );
    const codes = [...new Set(grants.map((grant) => grant.endpointCode))];
    const endpoints = await this.repository.findEndpointsByCodes(codes);
    const byCode = new Map(endpoints.map((row) => [row.code, row]));
    const modelCodes = [
      ...new Set(
        endpoints.flatMap((row) =>
          row.fallbackModelCode === null
            ? [row.primaryModelCode]
            : [row.primaryModelCode, row.fallbackModelCode],
        ),
      ),
    ];
    const usable = new Map(
      (await this.repository.findActiveModelsByCodes(modelCodes)).map(
        (model) => [model.modelCode, model],
      ),
    );

    return codes
      .sort((left, right) => left.localeCompare(right))
      .map((endpointCode) => {
        const row = byCode.get(endpointCode);
        if (!row) {
          return {
            endpointCode,
            category: null,
            state: "missing" as const,
            contextWindow: null,
            maxOutputTokens: null,
          };
        }
        return {
          endpointCode,
          category: row.category,
          state: toObjectState(row.isActive && row.deletedAt === null),
          ...routeCapacity(
            usable.get(row.primaryModelCode),
            row.fallbackModelCode === null
              ? undefined
              : usable.get(row.fallbackModelCode),
          ),
        };
      });
  }
}

/**
 * `state` as a string enum rather than an `isActive` boolean: product_251 B-3,
 * which applies here without a grace period because this is a NEW interface
 * (D-2). A boolean could not carry `missing` at all.
 */
export interface GrantedEndpoint {
  endpointCode: string;
  /** NULL only when `state` is `missing` - there is no row to read it from. */
  category: string | null;
  /**
   * The shared vocabulary plus this surface's one extension. Typed off
   * `GrantedEndpointState` rather than spelled out again, so the relationship
   * to the operator plane's `state` is a fact the compiler holds instead of a
   * coincidence two files happen to share.
   */
  state: GrantedEndpointState;
  /**
   * Tokens the route can take in one call, input and output together - the
   * SMALLEST context window across the models a call on this route can land
   * on. `null` means unknown: no usable primary, or a model in the chain with
   * no window recorded. Never the minimum of only the known values - that can
   * overstate, and overstating is the one error a budget field must not make
   * (tenderforge letter 40 item 4).
   */
  contextWindow: number | null;
  /** Same rule, for the largest output a call may request. */
  maxOutputTokens: number | null;
}

type CapacityModel = Pick<AiModelRecord, "contextWindow" | "maxOutputTokens">;

/**
 * A route's capacity, following the call path exactly
 * (`ModelRuntimeService.resolveCandidateModels`): an unusable primary fails
 * the whole request, so the route serves nothing and its capacity is unknown;
 * an unusable fallback is skipped, so it does not count.
 */
export function routeCapacity(
  primary: CapacityModel | undefined,
  fallback: CapacityModel | undefined,
): { contextWindow: number | null; maxOutputTokens: number | null } {
  if (primary === undefined) return { contextWindow: null, maxOutputTokens: null };
  const chain = fallback === undefined ? [primary] : [primary, fallback];
  const smallest = (values: (number | null)[]): number | null =>
    values.some((value) => value === null)
      ? null
      : Math.min(...(values as number[]));
  return {
    contextWindow: smallest(chain.map((model) => model.contextWindow)),
    maxOutputTokens: smallest(chain.map((model) => model.maxOutputTokens)),
  };
}
