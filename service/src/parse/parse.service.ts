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
import type { ProviderParseResponse } from "../types/runtime.types";
import type { ParseRequest } from "./parse.types";

const VALID_TASKS = new Set(["layout", "ocr", "table", "formula"]);

export type ParseResponse = ProviderParseResponse & { modelCode: string };

@Injectable()
export class ParseService {
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

  async parse(
    request: ParseRequest,
    auth?: S2sAuthContext,
  ): Promise<ParseResponse> {
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
          // C3 consume: the parse cost driver is the page count (one upstream
          // vision call per page) - deterministic and known even when the
          // upstream reports no token usage. Token usage still lands in
          // reqlog when the provider returns it.
          metering: { entitlements: this.entitlements, metric: "atlas.parse" },
        },
        async (meter) => {
        const { usage, ...result } = await gated.provider.parseDocument({
          endpointUrl: gated.model.endpointUrl,
          apiKey: gated.apiKey,
          modelCode: gated.model.modelCode,
          task: request.task,
          pages: request.pages,
          ...(gated.model.config != null ? { config: gated.model.config } : {}),
          ...(gated.model.providerConfig != null
            ? { providerConfig: gated.model.providerConfig }
            : {}),
        });

        meter({
          amount: request.pages.length,
          ...(usage ? { usage } : {}),
          // Usage-record batch 4 (D7): the input is page images, one per page.
          facts: { inputImageCount: request.pages.length },
        });
        return { ...(result as ProviderParseResponse), modelCode: gated.model.modelCode };
          },
        ),
    );
  }

  private validate(request: ParseRequest): void {
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

    // Absent and wrong are different refusals, and only the first belongs in
    // the published request contract. Until 2026-08-26 both answered
    // PARSE_TASK_INVALID, so `task` was enforced at runtime and declared
    // nowhere: a consumer building from `contract/atlas-contract.json` sent
    // {taskId, workspaceId, selector, pages} and got a 400 the artifact could
    // not have predicted - while that artifact exists precisely to be the one
    // source worth trusting (#21).
    //
    // `check-request-contract` did not catch it because its census was the
    // vocabulary's `*_REQUIRED` codes, and this one was named `*_INVALID`. The
    // naming convention was what made it invisible; the guardrail now reads
    // the throw sites instead.
    if (request.task === undefined || request.task === null) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "PARSE_TASK_REQUIRED",
        "task is required",
      );
    }

    if (!VALID_TASKS.has(request.task)) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "PARSE_TASK_INVALID",
        `task must be one of ${[...VALID_TASKS].join(", ")}`,
      );
    }

    if (!Array.isArray(request.pages) || request.pages.length === 0) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "PARSE_PAGES_REQUIRED",
        "pages cannot be empty",
      );
    }

    const invalidPage = request.pages.some(
      (page) =>
        typeof page.pageIndex !== "number" ||
        (!page.imageRef && !page.imageBase64),
    );
    if (invalidPage) {
      throw new ModelRuntimeException(
        HttpStatus.BAD_REQUEST,
        "PARSE_PAGES_INVALID",
        "each page requires a numeric pageIndex and either imageRef or imageBase64",
      );
    }
  }
}
