import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";

import { LegacyDataPlanePathInterceptor } from "./legacy-data-plane-path";
import { ModelRuntimeService } from "./runtime.service";
import { ModelRegistryService } from "../registry/model-registry.service";
import type { GrantedEndpoint } from "../registry/model-registry.service";
import { resolveApplicationScope } from "../quota/quota.service";
import { S2sAuthGuard } from "./guards/s2s-auth.guard";
import { unknownFilters, unknownFilterMessage } from "../http-query";
import type {
  S2sAuthContext,
  S2sAuthenticatedRequest,
} from "./guards/s2s-auth.guard";
import { errorFrame } from "../types/runtime.types";
import { toModelState, type ModelState } from "../object-state";
import type {
  AiModelRecord,
  ApplicationType,
  ChatRequest,
  ChatResponse,
  StreamEvent,
} from "../types/runtime.types";
import { ModelRuntimeException, isModelRuntimeErrorCode } from "./runtime.errors";
import type { ModelRuntimeErrorCode } from "./runtime.errors";
import { resolveMaxRequestBodyBytes } from "./request-body";
import { modelBehaviorVersion } from "../model-behavior-version";

interface ModelSummary {
  modelCode: string;
  modelName: string;
  provider: string;
  protocol: string;
  capabilities: string[];
  /**
   * product_251 X-4. This list carried no state at all, so the only signal a
   * consumer ever got about a model going away was its absence - which arrives
   * as a 404 at call time, after they have already built on it.
   *
   * `deprecated` is the state that did not exist before: still resolvable,
   * no longer recommended. A caller polling this list can now see a model
   * leaving before it leaves.
   */
  state: ModelState;
  /** When it was deprecated, so a caller has something to plan against. */
  deprecatedAt: string | null;
  /**
   * Opaque fingerprint of the upstream + wire configuration behind this
   * `modelCode`.
   *
   * `modelCode` is the version identifier and does not drift - but the thing it
   * points AT can be repointed, and until now that was invisible: same prompt,
   * different answer, nothing to attribute it to. Compare this to the last
   * value seen for the same code; different means re-run your golden outputs.
   *
   * Not ordered, not a semver, and it makes no claim about how big the change
   * was. Derived, never stored - see model-behavior-version.ts.
   */
  behaviorVersion: string;
}

interface ModelRuntimeResponse {
  status(code: number): this;
  json(body: unknown): this;
  setHeader(name: string, value: string): this;
  write(chunk: string): boolean;
  end(): void;
  flushHeaders?: () => void;
  on?(event: "close", listener: () => void): void;
}

const V1_MODEL_FILTERS = ["tenantId", "applicationId", "applicationType"];
const V1_ENDPOINT_FILTERS = ["applicationId", "applicationType"];

/**
 * The consumption plane's form of the operator plane's `rejectUnknownFilters`.
 * It cannot reuse that one: product_251 X-1 requires every `/v1` error to carry
 * a code from the runtime vocabulary and a `retryable` flag derived from it, so
 * the two planes share the message and nothing else.
 */
function rejectUnknownV1Filters(
  query: Record<string, string>,
  allowed: readonly string[],
): void {
  const unknown = unknownFilters(query, allowed);
  if (unknown.length === 0) return;
  throw new ModelRuntimeException(
    HttpStatus.BAD_REQUEST,
    "UNKNOWN_FILTER",
    unknownFilterMessage(unknown, allowed),
  );
}

// /v1 is the only path - no aliases. (Route-level aliases exist: TD-042 serves
// the retired `endpoints` spelling alongside `model-routes`. The controller
// PREFIX still has none, which is what this line has always meant.)
@Controller("v1")
@UseGuards(S2sAuthGuard)
@UseInterceptors(LegacyDataPlanePathInterceptor)
export class ModelRuntimeController {
  constructor(
    @Inject(ModelRuntimeService)
    private readonly runtime: ModelRuntimeService,
    @Inject(ModelRegistryService)
    private readonly registry: ModelRegistryService,
  ) {}

  // Attribution comes from `req.s2sAuth` (the verified token), never
  // from the body - product_210 rule 8 forbids trusting caller-supplied
  // org/workspace context, and a body field would be trivially spoofable.
  @Post("chat")
  async chat(
    @Body() body: ChatRequest,
    @Res() res: ModelRuntimeResponse,
    @Req() req: S2sAuthenticatedRequest,
  ): Promise<void> {
    if (body.stream) {
      await this.streamChat(body, res, req.s2sAuth);
      return;
    }
    const response = await this.runtime.chat(body, req.s2sAuth);
    res.json(response satisfies ChatResponse);
  }

  /**
   * Unfiltered when called without `tenantId` (existing behavior, unchanged -
   * ops/admin tooling). With `tenantId`, returns only the models that tenant/
   * application actually has an active grant for (docs/70-workplan tenant-
   * filtered "available models" list) instead of the full global catalog.
   */
  @Get("models")
  async listModels(
    @Query() all: Record<string, string>,
    @Query("tenantId") tenantId?: string,
    @Query("applicationId") applicationId?: string,
    @Query("applicationType") applicationType?: ApplicationType,
  ): Promise<ModelSummary[]> {
    rejectUnknownV1Filters(all, V1_MODEL_FILTERS);
    const models = tenantId?.trim()
      ? await this.registry.listModelsForTenant({
          tenantId: tenantId.trim(),
          ...(applicationId?.trim()
            ? { applicationId: applicationId.trim() }
            : {}),
          ...(applicationType ? { applicationType } : {}),
        })
      : await this.registry.listActiveModels();
    return models.map(toModelSummary);
  }

  /**
   * The entry points THIS CALLER holds (product_251 X-4 / vxture-atlas#198).
   *
   * The product comes from `act.sub` on the verified token, never from a query
   * parameter - a caller must not be able to enumerate another product's
   * grants by asking nicely.
   *
   * Why this exists: a consumer that routes by `endpointCode` had no way to
   * discover which codes it may use. `/v1/models` covers models, not entry
   * points; `/capability/model-routes` is the operator plane and answers a
   * `tool:atlas` token with 401; `.well-known` publishes tool shape, not
   * endpoint codes. So the catalog was hard-coded on the caller's side with
   * nothing to check it against, and the only signal for a wrong code was an
   * end user clicking a model and getting `404 ENDPOINT_NOT_ROUTABLE` in
   * production. vxtpl invented three codes that way and shipped them (#198).
   * With this, a caller can self-check at startup and reconcile in CI.
   */
  @Get(["model-routes", "endpoints"])
  async listEndpoints(
    @Req() req: S2sAuthenticatedRequest,
    @Query() all: Record<string, string>,
    @Query("applicationId") applicationId?: string,
    @Query("applicationType") applicationType?: ApplicationType,
  ): Promise<{ endpoints: GrantedEndpoint[]; maxRequestBytes: number }> {
    rejectUnknownV1Filters(all, V1_ENDPOINT_FILTERS);
    const productCode = req.s2sAuth?.callerProductCode;
    if (!productCode) {
      throw new ModelRuntimeException(
        HttpStatus.UNAUTHORIZED,
        "S2S_TOKEN_MISSING_ACT",
        "S2S token is missing act.sub (caller product identity)",
      );
    }

    // Same scope resolution the call path uses, so the catalog answers for
    // exactly the scope a call from this caller would be authorized under.
    const scope = resolveApplicationScope({
      ...(applicationId !== undefined ? { applicationId } : {}),
      ...(applicationType !== undefined ? { applicationType } : {}),
    });

    return {
      endpoints: await this.registry.listGrantedEndpoints({
        productCode,
        applicationId: scope.applicationId,
        applicationType: scope.applicationType,
      }),
      // One number for every route - the body is refused before routing, so
      // it cannot vary per route. Read through the same resolver the parser
      // was built from, so the published ceiling is the enforced one.
      maxRequestBytes: resolveMaxRequestBodyBytes(),
    };
  }

  private async streamChat(
    body: ChatRequest,
    res: ModelRuntimeResponse,
    auth?: S2sAuthContext,
  ): Promise<void> {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no"); // 提示 Nginx 关闭缓冲
    // Upstream error text flows into error frames below; nosniff pins the
    // event-stream content type so no client ever reinterprets it as HTML.
    res.setHeader("x-content-type-options", "nosniff");
    res.flushHeaders?.();

    const writeEvent = (event: StreamEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // A client that disconnects mid-stream must not keep the upstream
    // generating (and Atlas paying) for output nobody reads: the abort signal
    // reaches the provider fetch, which surfaces as a recorded failure.
    const abort = new AbortController();
    res.on?.("close", () => abort.abort());

    try {
      for await (const event of this.runtime.chatStream(
        body,
        auth,
        abort.signal,
      )) {
        writeEvent(event);
      }
      res.write("data: [DONE]\n\n");
    } catch (error) {
      const structuredError = readStructuredError(error);
      writeEvent(errorFrame(structuredError.code, structuredError.message));
    } finally {
      res.end();
    }
  }
}

/**
 * The code is checked against the vocabulary, not merely against `typeof
 * "string"`: an exception raised deeper in the stack can carry any `code` at
 * all, and forwarding it would put a value on the wire that no consumer can
 * find in the published list. An unrecognised one degrades to the generic
 * stream failure instead.
 */
function readStructuredError(error: unknown): {
  code: ModelRuntimeErrorCode;
  message: string;
} {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === "object" && response !== null) {
      const payload = response as { code?: unknown; message?: unknown };
      return {
        code: isModelRuntimeErrorCode(payload.code)
          ? payload.code
          : "MODEL_RUNTIME_STREAM_FAILED",
        message:
          typeof payload.message === "string" ? payload.message : error.message,
      };
    }
  }

  return {
    code: "MODEL_RUNTIME_STREAM_FAILED",
    message:
      error instanceof Error ? error.message : "Model runtime streaming failed",
  };
}

function toModelSummary(model: AiModelRecord): ModelSummary {
  return {
    modelCode: model.modelCode,
    modelName: model.modelName,
    provider: model.provider,
    protocol: model.protocol,
    capabilities: model.capabilities,
    state: toModelState(model),
    deprecatedAt: model.deprecatedAt?.toISOString() ?? null,
    behaviorVersion: modelBehaviorVersion(model),
  };
}
