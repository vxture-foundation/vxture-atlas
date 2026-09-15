import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Patch,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";

import type { AuditRequestIdCarrier } from "../audit/audit.middleware";

import { OperatorAuthGuard } from "./guards/operator-auth.guard";
import { LegacyCapabilityPathInterceptor } from "./legacy-capability-path";
import { rejectUnknownFilters } from "../http-query";
import {
  ModelAdminService,
  type AiModelAdminRecord,
  type AiModelGrantAdminRecord,
  type CreateAiModelBody,
  type CreateAiModelGrantBody,
  type CreateModelEndpointBody,
  type CreateModelPolicyBody,
  type CreateModelPriceRuleBody,
  type CreateModelProviderBody,
  type GatewayPerformanceResponse,
  type ModelEndpointAdminRecord,
  type ModelPolicyAdminRecord,
  type ModelPriceRuleAdminRecord,
  type ModelProviderAdminRecord,
  type ProtocolCatalogResponse,
  type TenantQuotaAdminRecord,
  type UsageSummaryPage,
  type UpdateAiModelBody,
  type UpdateAiModelGrantBody,
  type UpdateModelEndpointBody,
  type UpdateModelPolicyBody,
  type UpdateModelPriceRuleBody,
  type CreateProductGrantBody,
  type ProductGrantAdminRecord,
  type UpdateModelProviderBody,
  type UpdateProductGrantBody,
} from "./model-admin.service";
import { ModelProbeService } from "./model-probe.service";
import type {
  ModelProbeResult,
  ProviderProbeResult,
} from "./model-probe.service";
import type { ApplicationType } from "../types/runtime.types";

// Operator-only namespace (mgmt token); tenant-facing reads live on
// /tenancy/* - do not point a service-identity (tool:atlas) caller here.
// product_251 X-4 (#206): three resources were renamed to say WHAT they
// grant or route. Both spellings are served for a window - an addition, not
// a cutover, so neither side moves on the other's deploy. The retired name
// answers with Deprecation/Sunset headers and feeds
// `capability_legacy_path_requests_total`, which gates its removal; the audit
// middleware folds it back to the canonical name so the trail stays
// single-valued. Vocabulary: ../capability-route-names.ts
@Controller("capability")
@UseGuards(OperatorAuthGuard)
@UseInterceptors(LegacyCapabilityPathInterceptor)
export class ModelAdminController {
  constructor(
    @Inject(ModelAdminService) private readonly admin: ModelAdminService,
    @Inject(ModelProbeService) private readonly probe: ModelProbeService,
  ) {}

  /**
   * 可选的线协议及其 `wire` 默认值 —— 管理页面新增/编辑模型时的下拉数据源。
   * 纯静态、无租户数据，但仍在 operator 面下，因为它暴露的是内部适配器能力。
   */
  @Get("protocols")
  listProtocols(): ProtocolCatalogResponse {
    return this.admin.getProtocolCatalog();
  }

  @Get("providers")
  listProviders(
    @Query() all: Record<string, string>,
    @Query("includeInactive") includeInactive?: string,
  ): Promise<ModelProviderAdminRecord[]> {
    rejectUnknownFilters(all, ["includeInactive"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listProviders(includeInactive !== "false");
  }

  /** Near-real-time provider traffic/latency. */
  @Get("providers/performance")
  getGatewayPerformance(): Promise<GatewayPerformanceResponse> {
    return this.admin.getGatewayPerformance();
  }

  @Post("providers")
  createProvider(
    @Body() body: CreateModelProviderBody,
  ): Promise<ModelProviderAdminRecord> {
    return this.admin.createProvider(body);
  }

  @Patch("providers/:providerId")
  updateProvider(
    @Param("providerId") providerId: string,
    @Body() body: UpdateModelProviderBody,
  ): Promise<ModelProviderAdminRecord> {
    return this.admin.updateProvider(providerId, body);
  }

  /**
   * Provider 连通性自检。与模型自检同样**会发起真实上游调用并消耗
   * token**，并共用同一个按模型的冷却窗口。
   *
   * 存在的理由是 `GET /capability/providers` 的 `health` 由真实流量派生：
   * 从未承载流量的 provider 永远是 `unknown`，运营在接入后、放量前无从验证。
   * 仅按需触发，不做周期性主动探活。
   */
  @Post("providers/:providerId/probe")
  async probeProvider(
    @Param("providerId") providerId: string,
    @Req() req: AuditRequestIdCarrier,
  ): Promise<ProviderProbeResult> {
    const result = await this.probe.probeProvider(providerId);
    // The audit record of this call and the reqlog row the probe wrote share
    // this id - see `AuditRequestIdCarrier`.
    req.auditRequestId = result.probe.requestId;
    return result;
  }

  @Post("providers/:providerId/activate")
  activateProvider(
    @Param("providerId") providerId: string,
  ): Promise<ModelProviderAdminRecord> {
    return this.admin.setProviderActive(providerId, true);
  }

  @Post("providers/:providerId/deactivate")
  deactivateProvider(
    @Param("providerId") providerId: string,
  ): Promise<ModelProviderAdminRecord> {
    return this.admin.setProviderActive(providerId, false);
  }

  @Delete("providers/:providerId")
  deleteProvider(
    @Param("providerId") providerId: string,
  ): Promise<ModelProviderAdminRecord> {
    return this.admin.deleteProvider(providerId);
  }

  /** Logical Endpoint directory. */
  @Get(["model-routes", "endpoints"])
  listEndpoints(
    @Query() all: Record<string, string>,
    @Query("includeInactive") includeInactive?: string,
    @Query("modelCode") modelCode?: string,
  ): Promise<ModelEndpointAdminRecord[]> {
    rejectUnknownFilters(all, ["includeInactive", "modelCode"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listEndpoints(includeInactive !== "false", {
      ...(modelCode !== undefined ? { modelCode } : {}),
    });
  }

  @Post(["model-routes", "endpoints"])
  createEndpoint(
    @Body() body: CreateModelEndpointBody,
  ): Promise<ModelEndpointAdminRecord> {
    return this.admin.createEndpoint(body);
  }

  @Patch(["model-routes/:endpointId", "endpoints/:endpointId"])
  updateEndpoint(
    @Param("endpointId") endpointId: string,
    @Body() body: UpdateModelEndpointBody,
  ): Promise<ModelEndpointAdminRecord> {
    return this.admin.updateEndpoint(endpointId, body);
  }

  @Post(["model-routes/:endpointId/activate", "endpoints/:endpointId/activate"])
  activateEndpoint(
    @Param("endpointId") endpointId: string,
  ): Promise<ModelEndpointAdminRecord> {
    return this.admin.setEndpointActive(endpointId, true);
  }

  @Post(["model-routes/:endpointId/deactivate", "endpoints/:endpointId/deactivate"])
  deactivateEndpoint(
    @Param("endpointId") endpointId: string,
  ): Promise<ModelEndpointAdminRecord> {
    return this.admin.setEndpointActive(endpointId, false);
  }

  @Delete(["model-routes/:endpointId", "endpoints/:endpointId"])
  deleteEndpoint(
    @Param("endpointId") endpointId: string,
  ): Promise<ModelEndpointAdminRecord> {
    return this.admin.deleteEndpoint(endpointId);
  }

  @Get("models")
  listModels(
    @Query() all: Record<string, string>,
    @Query("includeInactive") includeInactive?: string,
    @Query("providerId") providerId?: string,
  ): Promise<AiModelAdminRecord[]> {
    rejectUnknownFilters(all, ["includeInactive", "providerId"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listModels(includeInactive !== "false", {
      ...(providerId !== undefined ? { providerId } : {}),
    });
  }

  @Post("models")
  createModel(@Body() body: CreateAiModelBody): Promise<AiModelAdminRecord> {
    return this.admin.createModel(body);
  }

  @Patch("models/:modelId")
  updateModel(
    @Param("modelId") modelId: string,
    @Body() body: UpdateAiModelBody,
  ): Promise<AiModelAdminRecord> {
    return this.admin.updateModel(modelId, body);
  }

  /**
   * 连通性自检。**会发起真实的上游调用并消耗 token**（上限 16），用量归平台
   * 哨兵、不扣任何租户配额（设计文档 §12.2）。
   */
  @Post("models/:modelId/probe")
  async probeModel(
    @Param("modelId") modelId: string,
    @Req() req: AuditRequestIdCarrier,
  ): Promise<ModelProbeResult> {
    const result = await this.probe.probe(modelId);
    req.auditRequestId = result.requestId;
    return result;
  }

  @Post("models/:modelId/activate")
  activateModel(
    @Param("modelId") modelId: string,
  ): Promise<AiModelAdminRecord> {
    return this.admin.setModelActive(modelId, true);
  }

  @Post("models/:modelId/deactivate")
  deactivateModel(
    @Param("modelId") modelId: string,
  ): Promise<AiModelAdminRecord> {
    return this.admin.setModelActive(modelId, false);
  }

  /**
   * "Stop building on this, it still works." The signal that did not exist
   * before - a model could only be switched off, which reaches the caller as
   * a 404 with no warning ahead of it (product_251 X-4, vxture-atlas#205).
   */
  @Post("models/:modelId/deprecate")
  deprecateModel(
    @Param("modelId") modelId: string,
  ): Promise<AiModelAdminRecord> {
    return this.admin.setModelDeprecated(modelId, true);
  }

  /** Reversible: a deprecation can be a mistake, and un-saying it is cheap. */
  @Post("models/:modelId/undeprecate")
  undeprecateModel(
    @Param("modelId") modelId: string,
  ): Promise<AiModelAdminRecord> {
    return this.admin.setModelDeprecated(modelId, false);
  }

  @Delete("models/:modelId")
  deleteModel(@Param("modelId") modelId: string): Promise<AiModelAdminRecord> {
    return this.admin.deleteModel(modelId);
  }

/**
   * Product-scoped authorization (incr/06). A product holds ENTRY POINTS; the
   * models it may name follow from what those entry points reach, so there is
   * nothing here keyed on a model.
   */
  @Get(["product-endpoint-grants", "product-grants"])
  listProductGrants(
    @Query() all: Record<string, string>,
    @Query("productCode") productCode?: string,
    @Query("endpointCode") endpointCode?: string,
    @Query("includeInactive") includeInactive?: string,
  ): Promise<ProductGrantAdminRecord[]> {
    rejectUnknownFilters(all, ["productCode", "endpointCode", "includeInactive"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listProductGrants({
      ...(productCode !== undefined ? { productCode } : {}),
      ...(endpointCode !== undefined ? { endpointCode } : {}),
      includeInactive: includeInactive !== "false",
    });
  }

  @Post(["product-endpoint-grants", "product-grants"])
  createProductGrant(
    @Body() body: CreateProductGrantBody,
  ): Promise<ProductGrantAdminRecord> {
    return this.admin.createProductGrant(body);
  }

  @Patch(["product-endpoint-grants/:id", "product-grants/:id"])
  updateProductGrant(
    @Param("id") id: string,
    @Body() body: UpdateProductGrantBody,
  ): Promise<ProductGrantAdminRecord> {
    return this.admin.updateProductGrant(id, body);
  }

  @Post(["product-endpoint-grants/:id/activate", "product-grants/:id/activate"])
  activateProductGrant(
    @Param("id") id: string,
  ): Promise<ProductGrantAdminRecord> {
    return this.admin.setProductGrantActive(id, true);
  }

  @Post(["product-endpoint-grants/:id/deactivate", "product-grants/:id/deactivate"])
  deactivateProductGrant(
    @Param("id") id: string,
  ): Promise<ProductGrantAdminRecord> {
    return this.admin.setProductGrantActive(id, false);
  }

  @Delete(["product-endpoint-grants/:id", "product-grants/:id"])
  deleteProductGrant(
    @Param("id") id: string,
  ): Promise<ProductGrantAdminRecord> {
    return this.admin.deleteProductGrant(id);
  }

  @Get(["tenant-model-grants", "grants"])
  listGrants(
    @Query() all: Record<string, string>,
    @Query("tenantId") tenantId?: string,
    @Query("modelId") modelId?: string,
    @Query("applicationId") applicationId?: string,
    @Query("applicationType") applicationType?: string,
  ): Promise<AiModelGrantAdminRecord[]> {
    rejectUnknownFilters(all, ["tenantId", "modelId", "applicationId", "applicationType"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listGrants({
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(applicationId !== undefined ? { applicationId } : {}),
      ...(applicationType !== undefined
        ? { applicationType: applicationType as ApplicationType }
        : {}),
    });
  }

  @Post(["tenant-model-grants", "grants"])
  createGrant(
    @Body() body: CreateAiModelGrantBody,
  ): Promise<AiModelGrantAdminRecord> {
    return this.admin.createGrant(body);
  }

  @Patch(["tenant-model-grants/:grantId", "grants/:grantId"])
  updateGrant(
    @Param("grantId") grantId: string,
    @Body() body: UpdateAiModelGrantBody,
  ): Promise<AiModelGrantAdminRecord> {
    return this.admin.updateGrant(grantId, body);
  }

  @Post(["tenant-model-grants/:grantId/activate", "grants/:grantId/activate"])
  activateGrant(
    @Param("grantId") grantId: string,
  ): Promise<AiModelGrantAdminRecord> {
    return this.admin.setGrantActive(grantId, true);
  }

  // Every other resource exposes activate AND deactivate; grants shipped with
  // only activate, so suspending one meant either PUT {isActive:false} or a
  // DELETE that soft-deletes. The service layer always supported both.
  @Post(["tenant-model-grants/:grantId/deactivate", "grants/:grantId/deactivate"])
  deactivateGrant(
    @Param("grantId") grantId: string,
  ): Promise<AiModelGrantAdminRecord> {
    return this.admin.setGrantActive(grantId, false);
  }

  @Delete(["tenant-model-grants/:grantId", "grants/:grantId"])
  deleteGrant(
    @Param("grantId") grantId: string,
  ): Promise<AiModelGrantAdminRecord> {
    return this.admin.deleteGrant(grantId);
  }

  @Get("price-rules")
  /** `asOf=<ISO>|now` narrows to the rule in force at that instant. */
  listPriceRules(
    @Query() all: Record<string, string>,
    @Query("modelId") modelId?: string,
    @Query("includeInactive") includeInactive?: string,
    @Query("asOf") asOf?: string,
  ): Promise<ModelPriceRuleAdminRecord[]> {
    rejectUnknownFilters(all, ["modelId", "includeInactive", "asOf"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listPriceRules({
      ...(modelId !== undefined ? { modelId } : {}),
      ...(includeInactive !== undefined ? { includeInactive } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
    });
  }

  @Post("price-rules")
  createPriceRule(
    @Body() body: CreateModelPriceRuleBody,
  ): Promise<ModelPriceRuleAdminRecord> {
    return this.admin.createPriceRule(body);
  }

  @Patch("price-rules/:priceRuleId")
  updatePriceRule(
    @Param("priceRuleId") priceRuleId: string,
    @Body() body: UpdateModelPriceRuleBody,
  ): Promise<ModelPriceRuleAdminRecord> {
    return this.admin.updatePriceRule(priceRuleId, body);
  }

  @Delete("price-rules/:priceRuleId")
  deletePriceRule(
    @Param("priceRuleId") priceRuleId: string,
  ): Promise<ModelPriceRuleAdminRecord> {
    return this.admin.deletePriceRule(priceRuleId);
  }

  @Post("price-rules/:priceRuleId/activate")
  activatePriceRule(
    @Param("priceRuleId") priceRuleId: string,
  ): Promise<ModelPriceRuleAdminRecord> {
    return this.admin.setPriceRuleActive(priceRuleId, true);
  }

  @Post("price-rules/:priceRuleId/deactivate")
  deactivatePriceRule(
    @Param("priceRuleId") priceRuleId: string,
  ): Promise<ModelPriceRuleAdminRecord> {
    return this.admin.setPriceRuleActive(priceRuleId, false);
  }

  @Get("policies")
  listPolicies(
    @Query() all: Record<string, string>,
    @Query("modelId") modelId?: string,
    @Query("tenantId") tenantId?: string,
    @Query("includeInactive") includeInactive?: string,
  ): Promise<ModelPolicyAdminRecord[]> {
    rejectUnknownFilters(all, ["modelId", "tenantId", "includeInactive"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listPolicies({
      ...(modelId !== undefined ? { modelId } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(includeInactive !== undefined ? { includeInactive } : {}),
    });
  }

  @Post("policies")
  createPolicy(
    @Body() body: CreateModelPolicyBody,
  ): Promise<ModelPolicyAdminRecord> {
    return this.admin.createPolicy(body);
  }

  @Patch("policies/:policyId")
  updatePolicy(
    @Param("policyId") policyId: string,
    @Body() body: UpdateModelPolicyBody,
  ): Promise<ModelPolicyAdminRecord> {
    return this.admin.updatePolicy(policyId, body);
  }

  @Delete("policies/:policyId")
  deletePolicy(
    @Param("policyId") policyId: string,
  ): Promise<ModelPolicyAdminRecord> {
    return this.admin.deletePolicy(policyId);
  }

  @Post("policies/:policyId/activate")
  activatePolicy(
    @Param("policyId") policyId: string,
  ): Promise<ModelPolicyAdminRecord> {
    return this.admin.setPolicyActive(policyId, true);
  }

  @Post("policies/:policyId/deactivate")
  deactivatePolicy(
    @Param("policyId") policyId: string,
  ): Promise<ModelPolicyAdminRecord> {
    return this.admin.setPolicyActive(policyId, false);
  }

  @Get("quotas")
  listTenantQuotas(
    @Query() all: Record<string, string>,
    @Query("tenantId") tenantId?: string,
    @Query("includeExpired") includeExpired?: string,
  ): Promise<TenantQuotaAdminRecord[]> {
    rejectUnknownFilters(all, ["tenantId", "includeExpired"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listTenantQuotas({
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(includeExpired !== undefined ? { includeExpired } : {}),
    });
  }

  /**
   * 用量汇总。`groupBy` 选择聚合轴：`tenant`（默认，保持原响应形状）
   * / `provider` / `model` / `endpoint` / `product`。
   */
  @Get("usage-summaries")
  listUsageSummaries(
    @Query() all: Record<string, string>,
    @Query("tenantId") tenantId?: string,
    @Query("applicationId") applicationId?: string,
    @Query("applicationType") applicationType?: string,
    @Query("cycleMonth") cycleMonth?: string,
    @Query("providerCode") providerCode?: string,
    @Query("modelCode") modelCode?: string,
    @Query("productCode") productCode?: string,
    @Query("groupBy") groupBy?: string,
  ): Promise<UsageSummaryPage> {
    rejectUnknownFilters(all, ["tenantId", "applicationId", "applicationType", "cycleMonth", "providerCode", "modelCode", "productCode", "groupBy"], "CAPABILITY_UNKNOWN_FILTER");
    return this.admin.listUsageSummaries({
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(applicationId !== undefined ? { applicationId } : {}),
      ...(applicationType !== undefined
        ? { applicationType: applicationType as ApplicationType }
        : {}),
      ...(cycleMonth !== undefined ? { cycleMonth } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      ...(modelCode !== undefined ? { modelCode } : {}),
      ...(productCode !== undefined ? { productCode } : {}),
      ...(groupBy !== undefined ? { groupBy } : {}),
    });
  }
}
