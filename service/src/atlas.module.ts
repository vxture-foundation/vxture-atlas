import { HealthProbeScheduler } from "./health/health-probe.scheduler";
import { HealthSettingsService } from "./health/health-settings.service";
import { VendorBalanceMonitor } from "./health/vendor-balance.monitor";
import { AtlasHealthMonitor } from "./health/atlas-health.monitor";
import { HealthStoreBootstrap } from "./health/health.store";
import { ServiceHealthController } from "./health/service-health.controller";
import { ServiceHealthService } from "./health/service-health.service";
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { ModelRuntimeController } from "./runtime/runtime.controller";
import { RetryAfterFilter } from "./runtime/retry-after.filter";
import { ModelRuntimeService } from "./runtime/runtime.service";
import { HealthController } from "./runtime/health.controller";
import { AtlasHealthService } from "./runtime/health.service";
import { MetricsController } from "./runtime/metrics.controller";
import { ModelAdminController } from "./runtime/model-admin.controller";
import { ModelAdminService } from "./runtime/model-admin.service";
import { RequestLogService } from "./reqlog/request-log.service";
import { PlatformEntitlementClient } from "./platform/platform-entitlement.client";
import { TenancyController } from "./tenancy/tenancy.controller";
import { TenancyService } from "./tenancy/tenancy.service";
import { ClaudeProvider } from "./providers/claude.provider";
import { ZhipuProvider } from "./providers/zhipu.provider";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";
import { ModelRegistryRepository } from "./registry/model-registry.repository";
import { ModelRegistryService } from "./registry/model-registry.service";
import { ModelProbeService } from "./runtime/model-probe.service";
import { ModelCircuitBreakerService } from "./runtime/model-circuit-breaker.service";
import { ModelRateLimiterService } from "./quota/model-rate-limiter.service";
import { ModelRouterService } from "./router/model-router.service";
import { QuotaService } from "./quota/quota.service";
import { EmbeddingController } from "./embedding/embedding.controller";
import { EmbeddingService } from "./embedding/embedding.service";
import { RerankController } from "./rerank/rerank.controller";
import { RerankService } from "./rerank/rerank.service";
import { ParseController } from "./parse/parse.controller";
import { ParseService } from "./parse/parse.service";
import { ProvisioningWebhookController } from "./provisioning/provisioning-webhook.controller";
import { ProvisioningWebhookService } from "./provisioning/provisioning-webhook.service";
import { ProvisioningWebhookRepository } from "./provisioning/provisioning-webhook.repository";
import { ProviderKeyController } from "./provider-keys/provider-key.controller";
import { ProviderKeyService } from "./provider-keys/provider-key.service";
import { ProviderKeyRepository } from "./provider-keys/provider-key.repository";
import { GatewayApiKeyController } from "./gateway-api-keys/gateway-api-key.controller";
import { GatewayApiKeyService } from "./gateway-api-keys/gateway-api-key.service";
import { GatewayApiKeyRepository } from "./gateway-api-keys/gateway-api-key.repository";
import { ContractController } from "./runtime/contract.controller";
import { DiscoveryController } from "./discovery/discovery.controller";
import { MetricsRegistry, metricsRegistry } from "./runtime/metrics.registry";
import { ObservabilityController } from "./observability/observability.controller";
import { ObservabilityService } from "./observability/observability.service";
import { AuditController } from "./audit/audit.controller";
import { AuditService } from "./audit/audit.service";
import { AuditMiddleware } from "./audit/audit.middleware";

@Module({
  controllers: [
    ModelRuntimeController,
    ModelAdminController,
    HealthController,
    MetricsController,
    EmbeddingController,
    RerankController,
    ParseController,
    ProvisioningWebhookController,
    ProviderKeyController,
    GatewayApiKeyController,
    ContractController,
    DiscoveryController,
    TenancyController,
    ObservabilityController,
    AuditController,
    ServiceHealthController,
  ],
  providers: [
    // Adds the `Retry-After` header that 200-s2s-provider-surface.md has
    // promised on 429 since it was written, and rebuilds the identical body -
    // see the filter for why the header matters when the ms are already in it.
    { provide: APP_FILTER, useClass: RetryAfterFilter },
    // The process-wide singleton, not a fresh instance: MetricsController
    // scrapes `metricsRegistry` directly, so a Nest-constructed second
    // instance would collect the router's counters where nothing reads them.
    { provide: MetricsRegistry, useValue: metricsRegistry },
    ModelRuntimeService,
    AtlasHealthService,
    ModelAdminService,
    ModelRegistryRepository,
    ModelRegistryService,
    ModelRouterService,
    ModelProbeService,
    ModelCircuitBreakerService,
    ModelRateLimiterService,
    QuotaService,
    RequestLogService,
    PlatformEntitlementClient,
    TenancyService,
    OpenAiCompatibleProvider,
    ZhipuProvider,
    ClaudeProvider,
    EmbeddingService,
    RerankService,
    ParseService,
    ProvisioningWebhookService,
    ProvisioningWebhookRepository,
    ProviderKeyService,
    ProviderKeyRepository,
    GatewayApiKeyService,
    GatewayApiKeyRepository,
    ObservabilityService,
    AuditService,
    AuditMiddleware,
    ServiceHealthService,
    HealthStoreBootstrap,
    HealthProbeScheduler,
    HealthSettingsService,
    VendorBalanceMonitor,
    AtlasHealthMonitor,
  ],
  exports: [
    ModelRuntimeService,
    ModelAdminService,
    ModelRegistryService,
    ModelRouterService,
    QuotaService,
    RequestLogService,
    EmbeddingService,
    RerankService,
    ParseService,
    ProviderKeyService,
  ],
})
export class AtlasModule implements NestModule {
  /**
   * Applied across every route rather than to the operator controllers by
   * name. The guarantee worth having is that a new write route cannot exist
   * without an audit record, and a per-controller registration hands that back
   * to whoever remembers to update this list. `AuditMiddleware` itself filters
   * out reads and anything outside `/capability`, so the wildcard costs one
   * method check per request and nothing else.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuditMiddleware).forRoutes("*");
  }
}
