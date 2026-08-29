import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";

import { LegacyDataPlanePathInterceptor } from "../runtime/legacy-data-plane-path";

import { S2sAuthGuard } from "../runtime/guards/s2s-auth.guard";
import type { S2sAuthenticatedRequest } from "../runtime/guards/s2s-auth.guard";
import { rejectUnknownFilters } from "../http-query";
import { TenancyService } from "./tenancy.service";
import type {
  TenancyGrantRow,
  TenancyQuotaResponse,
  TenancyUsageResponse,
} from "./tenancy.types";
import type { AiModelRecord } from "../types/runtime.types";

/**
 * Tenant self-service plane.
 *
 * Three faces, one auth model each - this is the third:
 *   `/v1/*`         "do this work"          product identity  (tool:atlas)
 *   `/tenancy/*`    "what do I have/use"    scope from token  (tool:atlas)
 *   `/capability/*` "change what exists"    operator identity (mgmt:atlas)
 *
 * Named after the tenancy *dimension*, not a level, because it serves both:
 * workspace is the cost-accounting unit and tenant (org) is the rollup, and a
 * tenant operator needs both views. `?scope=` picks the level; both ids come
 * from the token, never the caller.
 *
 * This is what `console-bff` must call instead of `/capability/*`: the
 * capability plane is locked to operator tokens and would 401 the tenant
 * console.
 */
@Controller("tenancy")
@UseGuards(S2sAuthGuard)
@UseInterceptors(LegacyDataPlanePathInterceptor)
export class TenancyController {
  // Explicit @Inject: the deployed artifact is an esbuild bundle, which does
  // not emit `design:paramtypes`, so constructor injection by type alone
  // resolves to undefined at runtime even though tsconfig sets
  // emitDecoratorMetadata and the unit tests (swc) pass.
  constructor(
    @Inject(TenancyService)
    private readonly tenancy: TenancyService,
  ) {}

  @Get("models")
  listModels(@Req() req: S2sAuthenticatedRequest): Promise<AiModelRecord[]> {
    return this.tenancy.listModels(req.s2sAuth);
  }

  /**
   * What this TENANT may call, and under what routing conditions. Keyed on the
   * tenant because `model_grants.tenant_id` is - see the service (TD-022).
   */
  @Get(["tenant-model-grants", "grants"])
  listGrants(@Req() req: S2sAuthenticatedRequest): Promise<TenancyGrantRow[]> {
    return this.tenancy.listGrants(req.s2sAuth);
  }

  /**
   * Entitlement from the platform's C2 envelope. `status` distinguishes
   * "uncovered" (resolved, no coverage - expected while atlas's plan catalog
   * is an unpublished draft) from "unavailable" (could not ask).
   */
  @Get("quotas")
  quotas(@Req() req: S2sAuthenticatedRequest): Promise<TenancyQuotaResponse> {
    return this.tenancy.quotas(req.s2sAuth);
  }

  @Get("usage")
  usage(
    @Req() req: S2sAuthenticatedRequest,
    @Query() all: Record<string, string>,
    @Query("scope") scope?: string,
    @Query("days") days?: string,
  ): Promise<TenancyUsageResponse> {
    rejectUnknownFilters(all, ["scope", "days"], "TENANCY_UNKNOWN_FILTER");
    return this.tenancy.usage(req.s2sAuth, {
      ...(scope !== undefined ? { scope } : {}),
      ...(days !== undefined ? { days } : {}),
    });
  }
}
