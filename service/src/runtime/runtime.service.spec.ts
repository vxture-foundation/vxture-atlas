import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpStatus, Logger } from "@nestjs/common";

import { ModelRuntimeService } from "./runtime.service";
import { ModelCircuitBreakerService } from "./model-circuit-breaker.service";
import { metricsRegistry } from "./metrics.registry";
import {
  ModelRateLimiterService,
  rateLimitKey,
} from "../quota/model-rate-limiter.service";
import {
  MODEL_RUNTIME_ERROR_CODES,
  ModelRuntimeException,
  isModelRuntimeErrorCode,
  isRetryable,
} from "./runtime.errors";
import { resolveApiKey } from "./resolve-api-key";
import { errorFrame } from "../types/runtime.types";
import type {
  AiModelRecord,
  ChatRequest,
  StreamEvent,
} from "../types/runtime.types";

// ── helpers ───────────────────────────────────────────────────────────────────

let loggerLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  loggerLogSpy = vi
    .spyOn(Logger.prototype, "log")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  loggerLogSpy.mockRestore();
  delete process.env["ATLAS_SECRET_KEY"];
});

// Direct instantiation — constructor deps are unused by the methods under test.
/* eslint-disable @typescript-eslint/no-explicit-any */
const svc = new ModelRuntimeService(
  null as any,
  null as any,
  null as any,
  null as any,
  null as any,
  null as any,
  null as any,
  null as any,
);
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validate = (req: unknown): void => (svc as any).validateChatRequest(req);

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "model-1",
    providerId: null,
    modelCode: "gpt-4o",
    modelName: "GPT-4o",
    provider: "openai",
    endpointUrl: "https://api.openai.com/v1",
    protocol: "openai",
    modelType: "chat",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["chat"],
    supportsStreaming: true,
    sort: 999,
    isActive: true,
    // A model with no key source is now refused before any upstream call
    // (the vault is the only source, ADR-003). A fixture without this is not a
    // servable model, which is why 59 tests failed the moment that hole closed.
    config: { managedKeyAlias: "test-key" },
    providerConfig: null,
    providerActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deprecatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A real UUID, and load-bearing: `tenantId` is refused at the boundary unless
 * it is one (#198 section 4). The old fixture value `"tenant-1"` would now be
 * rejected, which is the point - the attribution column is `uuid`, so anything
 * else was being written NULL and vanishing from every tenant report.
 */
function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
    // product_251 X-2: required on every /v1 call since 2026-08-16.
    taskId: "task-fixture",
    modelCode: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

// ── validateChatRequest ───────────────────────────────────────────────────────

describe("validateChatRequest", () => {
/**
 * product_251 X-2: `taskId` is required. The other tests in this file all send
 * one now, so they prove a request WITH it is not blocked - not that a request
 * without it is refused. That is this test's whole job, and it exists on all
 * four surfaces because the last pre-log fix in this repo covered chat only
 * while claiming to fix the class.
 */
  it("refuses a request with no taskId", () => {
    expect(() => validate({ ...makeRequest(), taskId: undefined })).toThrow(
      ModelRuntimeException,
    );
    expect(() => validate({ ...makeRequest(), taskId: "  " })).toThrow(
      ModelRuntimeException,
    );
  });

  it("throws when tenantId is missing", () => {
    expect(() => validate({ ...makeRequest(), tenantId: "" })).toThrow(
      ModelRuntimeException,
    );
  });

  it("throws when tenantId is whitespace", () => {
    expect(() => validate({ ...makeRequest(), tenantId: "   " })).toThrow(
      ModelRuntimeException,
    );
  });

  it("throws when modelCode is missing", () => {
    expect(() => validate({ ...makeRequest(), modelCode: "" })).toThrow(
      ModelRuntimeException,
    );
  });

  it("throws when modelCode is whitespace", () => {
    expect(() => validate({ ...makeRequest(), modelCode: "  " })).toThrow(
      ModelRuntimeException,
    );
  });

  it("throws when both modelCode and taskProfile are missing", () => {
    expect(() =>
      validate({ ...makeRequest(), modelCode: undefined }),
    ).toThrow(ModelRuntimeException);
  });

  it("accepts a taskProfile in place of modelCode", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        modelCode: undefined,
        taskProfile: "summarization",
      }),
    ).not.toThrow();
  });

  it("throws when applicationId is empty", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        applicationId: "",
        applicationType: "workflow",
      }),
    ).toThrow(ModelRuntimeException);
  });

  it("throws when applicationId is provided without applicationType", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        applicationId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toThrow(ModelRuntimeException);
  });

  it("throws when applicationType is provided without applicationId or legacy agentId", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        applicationType: "workflow",
      }),
    ).toThrow(ModelRuntimeException);
  });

  it("accepts legacy agentId without applicationType", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        agentId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).not.toThrow();
  });

  it("accepts explicit application scope", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        applicationId: "550e8400-e29b-41d4-a716-446655440001",
        applicationType: "api_client",
      }),
    ).not.toThrow();
  });

  it("throws when messages is an empty array", () => {
    expect(() => validate({ ...makeRequest(), messages: [] })).toThrow(
      ModelRuntimeException,
    );
  });

  it("throws when a message has an invalid role", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        messages: [{ role: "bot", content: "hi" }],
      }),
    ).toThrow(ModelRuntimeException);
  });

  it("throws when a user message has empty content", () => {
    expect(() =>
      validate({ ...makeRequest(), messages: [{ role: "user", content: "" }] }),
    ).toThrow(ModelRuntimeException);
  });

  it("throws when a user message has whitespace-only content", () => {
    expect(() =>
      validate({
        ...makeRequest(),
        messages: [{ role: "user", content: "   " }],
      }),
    ).toThrow(ModelRuntimeException);
  });

  it("accepts an assistant message with empty content when toolCalls are present", () => {
    const req = makeRequest({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc-1", name: "get_weather", arguments: {} }],
        },
      ],
    });
    expect(() => validate(req)).not.toThrow();
  });

  it("does not throw for a well-formed request", () => {
    expect(() => validate(makeRequest())).not.toThrow();
  });

  it("does not throw for a multi-turn conversation", () => {
    const req = makeRequest({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "What is 2+2?" },
      ],
    });
    expect(() => validate(req)).not.toThrow();
  });

  it("refuses a non-UUID tenantId at the boundary", () => {
    // Accepting it was never harmless: the attribution column is `uuid`, so it
    // was written NULL and the traffic vanished from every tenant-dimension
    // report with nothing raised (#198 section 4).
    try {
      validate({ ...makeRequest(), tenantId: "org-acme/ws-main" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ModelRuntimeException).getResponse()).toMatchObject({
        code: "INVALID_TENANT_ID",
        retryable: false,
      });
    }
  });

  it("still distinguishes absent from malformed", () => {
    // Two different caller mistakes, two different codes. Collapsing them
    // would send someone who forgot the field looking for a formatting bug.
    const codeFor = (tenantId: string): string => {
      try {
        validate({ ...makeRequest(), tenantId });
        return "none";
      } catch (error) {
        return (
          (error as ModelRuntimeException).getResponse() as { code: string }
        ).code;
      }
    };
    expect(codeFor("")).toBe("TENANT_ID_REQUIRED");
    expect(codeFor("org-acme/ws-main")).toBe("INVALID_TENANT_ID");
  });

  // product_251 X-1. The per-case tests above only assert THAT a request is
  // rejected; this asserts WHAT the caller is told, which is the part they
  // actually branch on. Before X-1 these all came back as Nest's bare
  // `{statusCode, message, error}` - no code at all - and a consumer had to
  // match on message text.
  it.each([
    [{ tenantId: "" }, "TENANT_ID_REQUIRED"],
    [{ modelCode: undefined }, "TARGET_SELECTOR_REQUIRED"],
    [
      { applicationId: "", applicationType: "workflow" as const },
      "APPLICATION_ID_REQUIRED",
    ],
    [
      { applicationId: "550e8400-e29b-41d4-a716-446655440000" },
      "APPLICATION_TYPE_REQUIRED",
    ],
    [{ applicationType: "workflow" as const }, "APPLICATION_ID_REQUIRED"],
    [{ usageType: "test" as const }, "USAGE_TYPE_INVALID"],
    [{ messages: [] }, "CHAT_MESSAGES_REQUIRED"],
    [
      { messages: [{ role: "bot" as unknown as "user", content: "hi" }] },
      "CHAT_MESSAGES_INVALID",
    ],
  ])("rejects %o with a vocabulary code", (patch, expectedCode) => {
    try {
      validate({ ...makeRequest(), ...patch });
      throw new Error(`expected ${expectedCode}, got no rejection`);
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRuntimeException);
      expect((error as ModelRuntimeException).getResponse()).toMatchObject({
        code: expectedCode,
        retryable: false,
      });
    }
  });
});

// ── error vocabulary (product_251 X-1) ────────────────────────────────────────

describe("the published error vocabulary", () => {
  it("classifies every code, so `retryable` is never undefined on the wire", () => {
    for (const code of MODEL_RUNTIME_ERROR_CODES) {
      expect(typeof isRetryable(code)).toBe("boolean");
    }
  });

  it("puts `retryable` on the response body, not only on the class", () => {
    const error = new ModelRuntimeException(
      HttpStatus.TOO_MANY_REQUESTS,
      "RATE_LIMITED",
      "slow down",
      { retryAfterMs: 1_200 },
    );
    expect(error.getResponse()).toEqual({
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
      retryAfterMs: 1_200,
    });
  });

  it("separates a technical rate gate from a commercial quota ceiling", () => {
    // Both mean "not now", but only one is worth retrying unattended: retrying
    // a spent quota just floods the caller's own queue.
    expect(isRetryable("RATE_LIMITED")).toBe(true);
    expect(isRetryable("QUOTA_EXCEEDED")).toBe(false);
  });

  it("rejects a code that is not in the vocabulary", () => {
    expect(isModelRuntimeErrorCode("QUOTA_EXHAUSTED")).toBe(false);
    expect(isModelRuntimeErrorCode("overloaded_error")).toBe(false);
    expect(isModelRuntimeErrorCode("QUOTA_EXCEEDED")).toBe(true);
  });
});

// ── resolveApiKey ─────────────────────────────────────────────────────────────

describe("resolveApiKey - the vault is the only source", () => {
  /**
   * `config.apiKeyEnvVar` was the pre-vault path (ADR-003 replaced it) and this
   * function kept it as a fallback, leaving a credential with two sources.
   * Removed 2026-08-17; production carried zero models on it.
   *
   * The seven cases that used to live here all asserted the env path, plus the
   * `return ""` fallthrough for a model with no key source at all - which is
   * the more interesting removal: such a model called upstream with an EMPTY
   * key, and the 401 that came back was reported as PROVIDER_UNAVAILABLE. A
   * configuration hole arrived wearing an upstream outage's face.
   */
  const vaultKey = (value: string | null) =>
    vi.fn().mockResolvedValue(value);

  it("resolves through the vault when managedKeyAlias is set", async () => {
    const resolveManagedKey = vaultKey("sk-managed-456");

    const apiKey = await resolveApiKey(
      { resolveManagedKey },
      makeModel({ provider: "doubao", config: { managedKeyAlias: "primary" } }),
    );

    expect(apiKey).toBe("sk-managed-456");
    expect(resolveManagedKey).toHaveBeenCalledWith("doubao", "primary");
  });

  it("refuses a model with no key source instead of calling with an empty key", async () => {
    // The behaviour this change exists for. Previously: "" and a live upstream
    // call. Now: refused here, naming the model, before any request is made.
    await expect(
      resolveApiKey({ resolveManagedKey: vaultKey(null) }, makeModel({ config: null })),
    ).rejects.toMatchObject({ response: { code: "PROVIDER_UNAVAILABLE" } });
  });

  it("says how to fix it, and does not point at the retired env path", async () => {
    let message = "";
    try {
      await resolveApiKey({ resolveManagedKey: vaultKey(null) }, makeModel({ config: null }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("POST /capability/provider-keys");
    expect(message).toContain("only source");
  });

  it("ignores a leftover apiKeyEnvVar rather than honouring it", async () => {
    // A model row may still carry the old key. It must not resolve - two
    // sources for one credential is the thing the vault exists to prevent.
    process.env["LEGACY_KEY"] = "sk-from-env";
    await expect(
      resolveApiKey(
        { resolveManagedKey: vaultKey(null) },
        makeModel({ config: { apiKeyEnvVar: "LEGACY_KEY" } }),
      ),
    ).rejects.toMatchObject({ response: { code: "PROVIDER_UNAVAILABLE" } });
    delete process.env["LEGACY_KEY"];
  });

  it("refuses when the alias resolves to no active key", async () => {
    await expect(
      resolveApiKey(
        { resolveManagedKey: vaultKey(null) },
        makeModel({ provider: "doubao", config: { managedKeyAlias: "gone" } }),
      ),
    ).rejects.toMatchObject({ response: { code: "PROVIDER_UNAVAILABLE" } });
  });

  it('lets an endpoint-local provider serve with no key at all', async () => {
    // P1 regression guard: "private"/"custom"/"self-hosted" bake the credential
    // into the endpoint, so there is no key to resolve and no hole to report.
    for (const provider of ["private", "custom", "self-hosted"]) {
      expect(
        await resolveApiKey(
          { resolveManagedKey: vaultKey(null) },
          makeModel({ provider, config: null }),
        ),
      ).toBe("");
    }
  });
});

// ── runtime flow ─────────────────────────────────────────────────────────────

describe("ModelRuntimeService runtime flow", () => {
  function makeRuntime(
    overrides: {
      registry?: Record<string, unknown>;
      router?: Record<string, unknown>;
      quota?: Record<string, unknown>;
    } = {},
  ): {
    service: ModelRuntimeService;
    provider: {
      chat: ReturnType<typeof vi.fn>;
      chatStream: ReturnType<typeof vi.fn>;
    };
    fallbackProvider: {
      chat: ReturnType<typeof vi.fn>;
      chatStream: ReturnType<typeof vi.fn>;
    };
    quota: { assertAllowed: ReturnType<typeof vi.fn> };
    requestLog: {
      record: ReturnType<typeof vi.fn>;
      recordError: ReturnType<typeof vi.fn>;
    };
    entitlements: {
      resolve: ReturnType<typeof vi.fn>;
      consume: ReturnType<typeof vi.fn>;
    };
    circuitBreaker: ModelCircuitBreakerService;
    rateLimiter: ModelRateLimiterService;
  } {
    const primary = makeModel({
      modelCode: "primary-model",
      provider: "primary",
      endpointUrl: "https://primary.example/v1",
      config: { managedKeyAlias: "test-key", fallbackModelCodes: ["fallback-model"] },
    });
    const fallback = makeModel({
      id: "model-2",
      modelCode: "fallback-model",
      provider: "fallback",
      endpointUrl: "https://fallback.example/v1",
    });
    const provider = {
      chat: vi.fn().mockResolvedValue({
        content: "primary response",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text", delta: "primary stream" };
        yield {
          type: "done",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      }),
    };
    const fallbackProvider = {
      chat: vi.fn().mockResolvedValue({
        content: "fallback response",
        promptTokens: 8,
        completionTokens: 4,
        totalTokens: 12,
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text", delta: "fallback stream" };
        yield {
          type: "done",
          usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        };
      }),
    };
    const registry = {
      getActiveModel: vi.fn((modelCode: string) => {
        if (modelCode === "primary-model") return Promise.resolve(primary);
        if (modelCode === "fallback-model") return Promise.resolve(fallback);
        return Promise.reject(
          new ModelRuntimeException(
            HttpStatus.NOT_FOUND,
            "MODEL_NOT_ROUTABLE",
            "missing model",
            { modelCode },
          ),
        );
      }),
      ...overrides.registry,
    };
    const router = {
      // resolve() 现在收整行模型（protocol 参与分发），不再只收 provider code。
      resolve: vi.fn((model: { provider: string }) =>
        model.provider === "fallback" ? fallbackProvider : provider,
      ),
      ...overrides.router,
    };
    const quota = {
      assertAllowed: vi.fn().mockResolvedValue({}),
      ...overrides.quota,
    };
    const providerKeys = {
      resolveKey: vi.fn().mockResolvedValue("sk-test-vault"),
    };
    // Real writes are covered in request-log.service.spec.ts; here the
    // point is that the runtime calls it, and that a logging failure never
    // propagates into the response.
    const requestLog = {
      record: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
    };
    // Consume is covered in its own cases; default to "not
    // billed" so the pre-existing assertions stay about routing/fallback.
    const entitlements = {
      resolve: vi.fn().mockResolvedValue({ kind: "not-configured" }),
      consume: vi.fn().mockResolvedValue({ billed: false }),
    };
    const circuitBreaker = new ModelCircuitBreakerService();
    const rateLimiter = new ModelRateLimiterService();

    return {
      requestLog,
      entitlements,
      service: new ModelRuntimeService(
        registry as never,
        router as never,
        quota as never,
        providerKeys as never,
        requestLog as never,
        entitlements as never,
        circuitBreaker,
        rateLimiter,
      ),
      provider,
      fallbackProvider,
      quota,
      circuitBreaker,
      rateLimiter,
    };
  }

  // The gap this validation could have created, closed in the same change.
  //
  // validateChatRequest runs before the in-flight gauge and before the first
  // reqlog write, so everything it refuses leaves no row, no error record and
  // no log line. Tightening a rule without this would have traded one silent
  // failure (#198 section 4: the traffic vanishes from tenant reports) for
  // another (the traffic vanishes entirely, and nobody can tell who still
  // needs to migrate).
  it("counts a pre-log rejection against the product that sent it", async () => {
    const { service } = makeRuntime();
    const before = await metricsRegistry.scrape();

    await expect(
      service.chat(makeRequest({ tenantId: "org-acme/ws-main" }), {
        callerProductCode: "vxtpl",
        workspaceId: "ws-1",
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_TENANT_ID" });

    const after = await metricsRegistry.scrape();
    expect(after).toContain("model_request_rejections_total");
    expect(after).toContain('code="INVALID_TENANT_ID"');
    expect(after).toContain('product="vxtpl"');
    expect(after).not.toBe(before);
  });

  it("counts a routing rejection too, not just a validation one", async () => {
    // The blind spot is the position in the request path, not the kind of
    // check: resolveRoute throws before the gauge and before the first log
    // line exactly as validation does. ENDPOINT_NOT_ROUTABLE is also what a
    // caller sees the moment an operator deactivates an endpoint, which is
    // when "who is still calling this" actually gets asked.
    const resolveEndpoint = vi
      .fn()
      .mockRejectedValue(
        new ModelRuntimeException(
          HttpStatus.NOT_FOUND,
          "ENDPOINT_NOT_ROUTABLE",
          "no live endpoint",
        ),
      );
    const { service } = makeRuntime({ registry: { resolveEndpoint } });

    await expect(
      service.chat(
        {
        taskId: "task-fixture",
          ...makeRequest(),
          modelCode: undefined,
          endpointCode: "chat/default",
        } as unknown as ChatRequest,
        { callerProductCode: "karda", workspaceId: "ws-1" } as never,
      ),
    ).rejects.toMatchObject({ code: "ENDPOINT_NOT_ROUTABLE" });

    const scrape = await metricsRegistry.scrape();
    expect(scrape).toContain('code="ENDPOINT_NOT_ROUTABLE"');
    expect(scrape).toContain('product="karda"');
  });

  it("throws grant denied before provider call", async () => {
    const { service, provider, entitlements } = makeRuntime({
      quota: {
        assertAllowed: vi
          .fn()
          .mockRejectedValue(
            new ModelRuntimeException(
              HttpStatus.FORBIDDEN,
              "NOT_ENTITLED",
              "no grant",
            ),
          ),
      },
    });

    await expect(
      service.chat(makeRequest({ modelCode: "primary-model" })),
    ).rejects.toMatchObject({ code: "NOT_ENTITLED" });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(entitlements.consume).not.toHaveBeenCalled();
  });

  // The trap the X-1 rename walked into: `runtimeStatusFromError` compares the
  // error code against a literal. While `readRuntimeErrorCode` returned
  // `string | null`, retiring the old code left that comparison compiling
  // happily and silently reclassified every refusal as `provider_error` - so
  // reqlog and `model_requests_total{status=...}` would have read as an
  // upstream outage while Atlas was in fact rejecting on permissions.
  // Narrowing the return type to the vocabulary makes it a compile error;
  // this states the intent for whoever is tempted to widen it back.
  it("records an entitlement refusal under its own error code, not as a provider failure", async () => {
    const { service, requestLog } = makeRuntime({
      quota: {
        assertAllowed: vi
          .fn()
          .mockRejectedValue(
            new ModelRuntimeException(
              HttpStatus.FORBIDDEN,
              "NOT_ENTITLED",
              "no grant reaches this model",
            ),
          ),
      },
    });

    await expect(
      service.chat(makeRequest({ modelCode: "primary-model" })),
    ).rejects.toMatchObject({ code: "NOT_ENTITLED" });

    expect(requestLog.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "NOT_ENTITLED" }),
    );
  });

  it("throws quota exceeded before provider call", async () => {
    const { service, provider, entitlements } = makeRuntime({
      quota: {
        assertAllowed: vi
          .fn()
          .mockRejectedValue(
            new ModelRuntimeException(
              HttpStatus.FORBIDDEN,
              "QUOTA_EXCEEDED",
              "quota exhausted",
            ),
          ),
      },
    });

    await expect(
      service.chat(makeRequest({ modelCode: "primary-model" })),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(entitlements.consume).not.toHaveBeenCalled();
  });

  it("falls back to configured model when primary provider fails", async () => {
    const { service, provider, fallbackProvider, requestLog } = makeRuntime();
    provider.chat.mockRejectedValueOnce(new Error("primary unavailable"));

    const response = await service.chat(
      makeRequest({
        modelCode: "primary-model",
        requestId: "request-1",
      }),
    );

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(fallbackProvider.chat).toHaveBeenCalledTimes(1);
    expect(response.modelCode).toBe("fallback-model");
    expect(response.message.content).toBe("fallback response");
    expect(requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        status: "success",
        modelCode: "fallback-model",
      }),
    );
  });

  describe("circuit breaker", () => {
    it("skips a tripped primary and goes straight to the fallback, without calling its provider", async () => {
      const { service, provider, fallbackProvider, circuitBreaker } =
        makeRuntime();
      for (let i = 0; i < 5; i += 1) {
        circuitBreaker.recordFailure("primary-model");
      }

      const response = await service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "request-1" }),
      );

      expect(provider.chat).not.toHaveBeenCalled();
      expect(fallbackProvider.chat).toHaveBeenCalledTimes(1);
      expect(response.modelCode).toBe("fallback-model");
    });

    it("still tries a tripped candidate when it is the last one left, rather than failing the request outright", async () => {
      const { service, provider, fallbackProvider, circuitBreaker } =
        makeRuntime();
      for (let i = 0; i < 5; i += 1) {
        circuitBreaker.recordFailure("primary-model");
        circuitBreaker.recordFailure("fallback-model");
      }

      const response = await service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "request-1" }),
      );

      expect(provider.chat).not.toHaveBeenCalled();
      expect(fallbackProvider.chat).toHaveBeenCalledTimes(1);
      expect(response.modelCode).toBe("fallback-model");
    });

    it("records a provider failure against the breaker on every fallback, tripping it after repeated failures", async () => {
      const { service, provider, circuitBreaker } = makeRuntime();
      provider.chat.mockRejectedValue(new Error("primary unavailable"));

      for (let i = 0; i < 5; i += 1) {
        await service.chat(
          makeRequest({ modelCode: "primary-model", requestId: `request-${i}` }),
        );
      }

      expect(circuitBreaker.isTripped("primary-model")).toBe(true);
    });

    it("resets the breaker on a successful call, not just leaving the failure count as-is", async () => {
      const { service, circuitBreaker } = makeRuntime();
      for (let i = 0; i < 4; i += 1) {
        circuitBreaker.recordFailure("primary-model");
      }

      await service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "request-1" }),
      );

      circuitBreaker.recordFailure("primary-model");
      expect(circuitBreaker.isTripped("primary-model")).toBe(false);
    });
  });

  describe("rate-limit concurrency release", () => {
    // Acquiring the slot happens inside QuotaService.assertAllowed (mocked
    // here as a no-op, covered separately in quota.service.spec.ts) -
    // what's under test here is only that ModelRuntimeService releases it
    // afterwards, on every path, using the same key the acquire side would
    // have used.
    it("releases the concurrency slot after a successful call", async () => {
      const { service, rateLimiter } = makeRuntime();
      const releaseSpy = vi.spyOn(rateLimiter, "releaseConcurrency");

      await service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "request-1" }),
      );

      expect(releaseSpy).toHaveBeenCalledWith(
        rateLimitKey("model-1", "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8"),
      );
    });

    it("releases the concurrency slot after a provider failure, not just on success", async () => {
      const { service, provider, rateLimiter } = makeRuntime();
      provider.chat.mockRejectedValueOnce(new Error("primary unavailable"));
      const releaseSpy = vi.spyOn(rateLimiter, "releaseConcurrency");

      await service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "request-1" }),
      );

      // Primary (model-1) failed and released before falling through to the
      // fallback (model-2), which then succeeds and releases too.
      expect(releaseSpy).toHaveBeenCalledWith(
        rateLimitKey("model-1", "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8"),
      );
      expect(releaseSpy).toHaveBeenCalledWith(
        rateLimitKey("model-2", "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8"),
      );
    });
  });

  it("logs structured metadata without prompt or response content", async () => {
    const { service } = makeRuntime();

    await service.chat(
      makeRequest({
        modelCode: "primary-model",
        requestId: "request-observe-1",
        applicationId: "application-1",
        applicationType: "workflow",
        messages: [{ role: "user", content: "sensitive prompt content" }],
      }),
    );

    const serializedLogs = loggerLogSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join("\n");
    expect(serializedLogs).toContain('"request_id":"request-observe-1"');
    expect(serializedLogs).toContain('"tenant_id":"2a4271d4-ac9a-4fa6-b479-4f71d8e996e8"');
    expect(serializedLogs).toContain('"application_id":"application-1"');
    expect(serializedLogs).toContain('"application_type":"workflow"');
    expect(serializedLogs).toContain('"model_code":"primary-model"');
    expect(serializedLogs).not.toContain("sensitive prompt content");
    expect(serializedLogs).not.toContain("primary response");
  });

  it("does not log provider key reference or provider key value", async () => {
    process.env["ATLAS_SECRET_KEY"] = "secret-provider-key-value";
    const secretBackedModel = makeModel({
      modelCode: "primary-model",
      provider: "primary",
      endpointUrl: "https://primary.example/v1",
      config: { managedKeyAlias: "test-key", apiKeyEnvVar: "ATLAS_SECRET_KEY" },
    });
    const { service } = makeRuntime({
      registry: {
        getActiveModel: vi.fn(() => Promise.resolve(secretBackedModel)),
      },
    });

    await service.chat(
      makeRequest({
        modelCode: "primary-model",
        requestId: "request-secret-log-1",
      }),
    );

    const serializedLogs = loggerLogSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join("\n");
    expect(serializedLogs).toContain('"request_id":"request-secret-log-1"');
    expect(serializedLogs).not.toContain("ATLAS_SECRET_KEY");
    expect(serializedLogs).not.toContain("secret-provider-key-value");
  });

  it("resolves modelCode from taskProfile when modelCode is omitted", async () => {
    const resolveModelCodeForTaskProfile = vi
      .fn()
      .mockResolvedValue("primary-model");
    const { service } = makeRuntime({
      registry: { resolveModelCodeForTaskProfile },
    });

    const { modelCode: _omit, ...requestWithoutModelCode } = makeRequest({
      taskProfile: "summarization",
      applicationId: "app-1",
      applicationType: "agent",
    });
    const response = await service.chat(requestWithoutModelCode);

    expect(response.modelCode).toBe("primary-model");
    expect(resolveModelCodeForTaskProfile).toHaveBeenCalledWith({
      tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      taskProfile: "summarization",
      applicationId: "app-1",
      applicationType: "agent",
    });
  });

  it("does not write usage when all provider candidates fail", async () => {
    const { service, provider, fallbackProvider, requestLog, entitlements } =
      makeRuntime();
    provider.chat.mockRejectedValueOnce(new Error("primary unavailable"));
    fallbackProvider.chat.mockRejectedValueOnce(new Error("fallback down"));

    await expect(
      service.chat(makeRequest({ modelCode: "primary-model" })),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(requestLog.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" }),
    );
    expect(entitlements.consume).not.toHaveBeenCalled();
  });

  // ── C3 consume ─────────────────────────────────────────────────────────
  it("bills realized tokens and records that it was billed", async () => {
    const h = makeRuntime();
    h.entitlements.consume.mockResolvedValue({ billed: true });

    await h.service.chat(
      {
        taskId: "task-fixture", modelCode: "primary-model", messages: [{ role: "user", content: "hi" }], tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8" } as never,
      { workspaceId: "ws-1" } as never,
    );

    expect(h.entitlements.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        metric: "atlas.chat",
        // amount is the realized token count, matching the descriptor's
        // per_unit metering declaration - the two must not drift apart.
        amount: expect.any(Number),
      }),
    );
    const logged = h.requestLog.record.mock.calls[0]?.[0] as {
      billedMetricKey?: string;
    };
    expect(logged.billedMetricKey).toBe("atlas.chat");
  });

  it("echoes the platform's usage event id into the request log when returned", async () => {
    // 210 §4: usage_event_id is the platform's usage_events id echoed back.
    // The contract field is pending platform-side; the client parses it
    // defensively, and this asserts the thread-through once it appears.
    const h = makeRuntime();
    h.entitlements.consume.mockResolvedValue({
      billed: true,
      usageEventId: "3a7b1a4e-0000-4000-8000-000000000001",
    });

    await h.service.chat(
      {
        taskId: "task-fixture", modelCode: "primary-model", messages: [{ role: "user", content: "hi" }], tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8" } as never,
      { workspaceId: "ws-1" } as never,
    );

    const logged = h.requestLog.record.mock.calls[0]?.[0] as {
      usageEventId?: string;
    };
    expect(logged.usageEventId).toBe("3a7b1a4e-0000-4000-8000-000000000001");
  });

  it("still serves and records the request when billing fails", async () => {
    // A served inference must not become an error because accounting failed;
    // the absent billedAmount is the reconciliation signal instead.
    const h = makeRuntime();
    h.entitlements.consume.mockResolvedValue({ billed: false });

    await expect(
      h.service.chat(
        {
        taskId: "task-fixture", modelCode: "primary-model", messages: [{ role: "user", content: "hi" }], tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8" } as never,
        { workspaceId: "ws-1" } as never,
      ),
    ).resolves.toBeTruthy();

    const logged = h.requestLog.record.mock.calls[0]?.[0] as {
      billedMetricKey?: string;
    };
    expect(logged.billedMetricKey).toBeUndefined();
  });

  it("does not attempt to bill when the token carries no workspace", async () => {
    const h = makeRuntime();

    await h.service.chat({
        taskId: "task-fixture",
      modelCode: "primary-model",
      messages: [{ role: "user", content: "hi" }],
      tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
    } as never);

    expect(h.entitlements.consume).not.toHaveBeenCalled();
  });

  // Endpoint routing. The registry harness above gives
  // "primary-model" a config.fallbackModelCodes of ["fallback-model"], which
  // is exactly what must NOT apply when the route came from an endpoint.
  describe("endpoint routing", () => {
    it("resolves endpointCode to the endpoint's primary model", async () => {
      const h = makeRuntime({
        registry: {
          resolveEndpoint: vi.fn().mockResolvedValue({
            modelCode: "primary-model",
            fallbackModelCodes: [],
          }),
        },
      });

      const res = await h.service.chat({
        taskId: "task-fixture",
        endpointCode: "chat/default",
        messages: [{ role: "user", content: "hi" }],
        tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      } as never);

      expect(res.modelCode).toBe("primary-model");
      expect(h.provider.chat).toHaveBeenCalledTimes(1);
    });

    it("uses the ENDPOINT's fallback, not the model's config chain", async () => {
      // The endpoint says "no fallback". The model's own config says
      // ["fallback-model"]. If the model's chain leaked through, the failing
      // primary would be retried on the fallback provider and this would
      // resolve instead of throwing - which is the two-authorities bug.
      const h = makeRuntime({
        registry: {
          resolveEndpoint: vi.fn().mockResolvedValue({
            modelCode: "primary-model",
            fallbackModelCodes: [],
          }),
        },
      });
      h.provider.chat.mockRejectedValue(new Error("primary is down"));

      await expect(
        h.service.chat({
        taskId: "task-fixture",
          endpointCode: "chat/default",
          messages: [{ role: "user", content: "hi" }],
          tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
        } as never),
      ).rejects.toMatchObject({ response: { code: "PROVIDER_UNAVAILABLE" } });

      expect(h.fallbackProvider.chat).not.toHaveBeenCalled();
    });

    it("fails over along the endpoint's own chain when it declares one", async () => {
      const h = makeRuntime({
        registry: {
          resolveEndpoint: vi.fn().mockResolvedValue({
            modelCode: "primary-model",
            fallbackModelCodes: ["fallback-model"],
          }),
        },
      });
      h.provider.chat.mockRejectedValue(new Error("primary is down"));

      const res = await h.service.chat({
        taskId: "task-fixture",
        endpointCode: "chat/default",
        messages: [{ role: "user", content: "hi" }],
        tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      } as never);

      expect(res.modelCode).toBe("fallback-model");
      expect(h.fallbackProvider.chat).toHaveBeenCalledTimes(1);
    });

    it("prefers an explicit modelCode over endpointCode", async () => {
      const resolveEndpoint = vi.fn();
      const h = makeRuntime({ registry: { resolveEndpoint } });

      await h.service.chat({
        taskId: "task-fixture",
        modelCode: "primary-model",
        endpointCode: "chat/default",
        messages: [{ role: "user", content: "hi" }],
        tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      } as never);

      expect(resolveEndpoint).not.toHaveBeenCalled();
    });
  });

  // Reqlog attribution of the routing decision.
  describe("endpoint attribution in the request log", () => {
    it("records the endpoint that routed the call", async () => {
      const h = makeRuntime({
        registry: {
          resolveEndpoint: vi.fn().mockResolvedValue({
            modelCode: "primary-model",
            fallbackModelCodes: [],
          }),
        },
      });

      await h.service.chat({
        taskId: "task-fixture",
        endpointCode: "chat/default",
        messages: [{ role: "user", content: "hi" }],
        tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      } as never);

      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ endpointCode: "chat/default" }),
      );
    });

    it("does NOT credit an endpoint that lost precedence to modelCode", async () => {
      // The caller named both. modelCode won, so the endpoint did not route
      // this call - crediting it would inflate that endpoint's metered volume
      // with traffic it never directed.
      const h = makeRuntime({ registry: { resolveEndpoint: vi.fn() } });

      await h.service.chat({
        taskId: "task-fixture",
        modelCode: "primary-model",
        endpointCode: "chat/default",
        messages: [{ role: "user", content: "hi" }],
        tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      } as never);

      const logged = h.requestLog.record.mock.calls[0]?.[0] as {
        endpointCode?: string;
      };
      expect(logged.endpointCode).toBeUndefined();
    });

    it("keeps the endpoint on the row when the call fails", async () => {
      // An endpoint's error rate is only computable if failures carry the
      // same attribution successes do.
      const h = makeRuntime({
        registry: {
          resolveEndpoint: vi.fn().mockResolvedValue({
            modelCode: "primary-model",
            fallbackModelCodes: [],
          }),
        },
      });
      h.provider.chat.mockRejectedValue(new Error("primary is down"));

      await expect(
        h.service.chat({
        taskId: "task-fixture",
          endpointCode: "chat/default",
          messages: [{ role: "user", content: "hi" }],
          tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
        } as never),
      ).rejects.toBeDefined();

      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          endpointCode: "chat/default",
        }),
      );
      expect(h.requestLog.recordError).toHaveBeenCalledWith(
        expect.objectContaining({ endpointCode: "chat/default" }),
      );
    });

    it("attributes a fallback hop to the endpoint that routed it", async () => {
      // Failover stays inside the same entry point - the row must not lose the
      // endpoint just because the primary model did.
      const h = makeRuntime({
        registry: {
          resolveEndpoint: vi.fn().mockResolvedValue({
            modelCode: "primary-model",
            fallbackModelCodes: ["fallback-model"],
          }),
        },
      });
      h.provider.chat.mockRejectedValue(new Error("primary is down"));

      await h.service.chat({
        taskId: "task-fixture",
        endpointCode: "chat/default",
        messages: [{ role: "user", content: "hi" }],
        tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      } as never);

      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          modelCode: "fallback-model",
          endpointCode: "chat/default",
        }),
      );
    });
  });

  // ── chatStream semantics ───────────────────────────────────────────────
  describe("chatStream semantics", () => {
    async function collect(
      gen: AsyncGenerator<StreamEvent>,
    ): Promise<StreamEvent[]> {
      const events: StreamEvent[] = [];
      for await (const event of gen) events.push(event);
      return events;
    }

    it("records a success row with no token fields and skips consume when the stream completes without a usage frame", async () => {
      const h = makeRuntime();
      h.provider.chatStream.mockImplementation(async function* () {
        yield { type: "text", delta: "hello" };
        yield { type: "done" };
      });

      const events = await collect(
        h.service.chatStream(
          makeRequest({ modelCode: "primary-model", requestId: "stream-1" }),
          { workspaceId: "ws-1" } as never,
        ),
      );

      expect(events).toEqual([
        { type: "text", delta: "hello" },
        { type: "done" },
      ]);
      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "stream-1",
          status: "success",
          modelCode: "primary-model",
        }),
      );
      const row = h.requestLog.record.mock.calls[0]?.[0] as {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      expect(row.inputTokens).toBeUndefined();
      expect(row.outputTokens).toBeUndefined();
      expect(row.totalTokens).toBeUndefined();
      // No realized amount -> nothing to consume, even with a workspace.
      expect(h.entitlements.consume).not.toHaveBeenCalled();
    });

    it("fails over on an in-stream error before any output, without leaking the error frame to the client", async () => {
      const h = makeRuntime();
      h.provider.chatStream.mockImplementation(async function* () {
        yield { type: "error", code: "UPSTREAM_ERROR", message: "boom" };
      });

      const events = await collect(
        h.service.chatStream(
          makeRequest({ modelCode: "primary-model", requestId: "stream-2" }),
        ),
      );

      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events).toContainEqual({ type: "text", delta: "fallback stream" });
      expect(h.fallbackProvider.chatStream).toHaveBeenCalledTimes(1);
      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          modelCode: "fallback-model",
        }),
      );
    });

    it("forwards an in-stream error after partial output, records the failure, and does NOT fall back", async () => {
      const h = makeRuntime();
      h.provider.chatStream.mockImplementation(async function* () {
        yield { type: "text", delta: "partial" };
        yield { type: "error", code: "UPSTREAM_ERROR", message: "mid-stream" };
      });

      const events = await collect(
        h.service.chatStream(
          makeRequest({ modelCode: "primary-model", requestId: "stream-3" }),
        ),
      );

      expect(events).toEqual([
        { type: "text", delta: "partial" },
        { type: "error", code: "UPSTREAM_ERROR", message: "mid-stream" },
      ]);
      expect(h.fallbackProvider.chatStream).not.toHaveBeenCalled();
      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          modelCode: "primary-model",
        }),
      );
      expect(h.requestLog.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "success" }),
      );
      expect(h.requestLog.recordError).toHaveBeenCalledWith(
        expect.objectContaining({ modelCode: "primary-model" }),
      );
      expect(h.entitlements.consume).not.toHaveBeenCalled();
    });

    it("does not continue to the fallback when the provider throws after partial output", async () => {
      const h = makeRuntime();
      h.provider.chatStream.mockImplementation(async function* () {
        yield { type: "text", delta: "partial" };
        throw new Error("connection reset");
      });

      const events: StreamEvent[] = [];
      const consumeStream = async (): Promise<void> => {
        for await (const event of h.service.chatStream(
          makeRequest({ modelCode: "primary-model", requestId: "stream-4" }),
        )) {
          events.push(event);
        }
      };

      // Partial output already reached the client - the stream must end with
      // the error, not splice a second answer from the fallback.
      await expect(consumeStream()).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
      });
      expect(events).toEqual([{ type: "text", delta: "partial" }]);
      expect(h.fallbackProvider.chatStream).not.toHaveBeenCalled();
    });

    // product_251 X-2: the same task must be recoverable from BOTH outcomes.
    // Recording it only on success would make a task's failed step invisible -
    // and "where did this task fail" is half the reason the key exists.
    it("carries taskId onto the reqlog row for a successful chat", async () => {
      const h = makeRuntime();
      h.provider.chat.mockResolvedValue({
        content: "ok",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      });

      await h.service.chat(
        makeRequest({
          modelCode: "primary-model",
          requestId: "req-ok",
          taskId: "task_01JQ8Z3M6F",
        }),
        { workspaceId: "ws-1" } as never,
      );

      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task_01JQ8Z3M6F", status: "success" }),
      );
    });

    it("carries taskId onto the reqlog row when the call fails too", async () => {
      const h = makeRuntime();
      h.provider.chat.mockRejectedValue(new Error("upstream down"));
      h.fallbackProvider.chat.mockRejectedValue(new Error("fallback down"));

      await expect(
        h.service.chat(
          makeRequest({
            modelCode: "primary-model",
            requestId: "req-fail",
            taskId: "task_01JQ8Z3M6F",
          }),
          { workspaceId: "ws-1" } as never,
        ),
      ).rejects.toBeDefined();

      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task_01JQ8Z3M6F", status: "error" }),
      );
    });

    it("writes no token fields and skips consume when the upstream reported no usage (usageReported: false)", async () => {
      const h = makeRuntime();
      h.provider.chat.mockResolvedValue({
        content: "ok",
        // Placeholder counts - the flag says the upstream never reported
        // usage, so these must NOT be written as realized tokens.
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        usageReported: false,
      });

      await h.service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "unreported-1" }),
        { workspaceId: "ws-1" } as never,
      );

      expect(h.entitlements.consume).not.toHaveBeenCalled();
      const row = h.requestLog.record.mock.calls[0]?.[0] as {
        status?: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        billedMetricKey?: string;
      };
      expect(row.status).toBe("success");
      expect(row.inputTokens).toBeUndefined();
      expect(row.outputTokens).toBeUndefined();
      expect(row.totalTokens).toBeUndefined();
      expect(row.billedMetricKey).toBeUndefined();
    });

    it('rejects usageType "production" with 400 before any provider call', async () => {
      const h = makeRuntime();

      await expect(
        h.service.chat(makeRequest({ usageType: "production" as never })),
      ).rejects.toThrow(ModelRuntimeException);
      expect(h.provider.chat).not.toHaveBeenCalled();
      expect(h.provider.chatStream).not.toHaveBeenCalled();
    });

    it('rejects usageType "test" - reserved for the operator probe, not callers', async () => {
      const h = makeRuntime();

      await expect(
        h.service.chat(makeRequest({ usageType: "test" })),
      ).rejects.toThrow(ModelRuntimeException);
      expect(h.provider.chat).not.toHaveBeenCalled();
    });

    it("forwards a recoverable UPSTREAM_FRAME_UNPARSEABLE frame and keeps the stream (and its usage) alive", async () => {
      const h = makeRuntime();
      const recordFailure = vi.spyOn(h.circuitBreaker, "recordFailure");
      h.provider.chatStream.mockImplementation(async function* () {
        yield errorFrame("UPSTREAM_FRAME_UNPARSEABLE", "bad chunk");
        yield { type: "text", delta: "recovered" };
        yield {
          type: "done",
          usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        };
      });

      const events = await collect(
        h.service.chatStream(
          makeRequest({ modelCode: "primary-model", requestId: "stream-pf" }),
        ),
      );

      expect(events[0]).toEqual({
        type: "error",
        code: "UPSTREAM_FRAME_UNPARSEABLE",
        message: "bad chunk",
        retryable: true,
      });
      expect(events).toContainEqual({ type: "text", delta: "recovered" });
      expect(h.fallbackProvider.chatStream).not.toHaveBeenCalled();
      expect(recordFailure).not.toHaveBeenCalled();
      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "stream-pf",
          status: "success",
          totalTokens: 7,
        }),
      );
    });

    it("treats a client abort as CLIENT_ABORTED: no breaker failure, no fallback, row recorded", async () => {
      const h = makeRuntime();
      const recordFailure = vi.spyOn(h.circuitBreaker, "recordFailure");
      const abort = new AbortController();
      h.provider.chatStream.mockImplementation(async function* () {
        yield { type: "text", delta: "partial" };
        abort.abort();
        throw new Error("This operation was aborted");
      });

      const events = await collect(
        h.service.chatStream(
          makeRequest({ modelCode: "primary-model", requestId: "stream-ab" }),
          undefined,
          abort.signal,
        ),
      );

      expect(events).toEqual([{ type: "text", delta: "partial" }]);
      expect(recordFailure).not.toHaveBeenCalled();
      expect(h.fallbackProvider.chatStream).not.toHaveBeenCalled();
      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "stream-ab", status: "error" }),
      );
      expect(h.requestLog.recordError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "CLIENT_ABORTED" }),
      );
    });
  });

  describe("cost splits reach the metering row (TD-047)", () => {
    it("writes the cached and reasoning counts the adapter reported", async () => {
      const h = makeRuntime();
      h.provider.chat.mockResolvedValue({
        content: "pong",
        promptTokens: 84,
        completionTokens: 227,
        totalTokens: 311,
        cachedInputTokens: 20,
        reasoningTokens: 211,
      });

      await h.service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "splits-1" }),
        { workspaceId: "ws-1" } as never,
      );

      expect(h.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ cachedInputTokens: 20, reasoningTokens: 211 }),
      );
    });

    it("omits them when the upstream reported no splits", async () => {
      const h = makeRuntime();
      h.provider.chat.mockResolvedValue({
        content: "pong",
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
      });

      await h.service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "splits-2" }),
        { workspaceId: "ws-1" } as never,
      );

      const row = h.requestLog.record.mock.calls[0]?.[0] as {
        cachedInputTokens?: number;
        reasoningTokens?: number;
      };
      expect(row.cachedInputTokens).toBeUndefined();
      expect(row.reasoningTokens).toBeUndefined();
    });

    it("writes no splits when usage itself was never reported", async () => {
      // usageReported:false already blanks the token columns; the splits are
      // subsets of those and must not survive the blanking.
      const h = makeRuntime();
      h.provider.chat.mockResolvedValue({
        content: "pong",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 4,
        reasoningTokens: 2,
        usageReported: false,
      });

      await h.service.chat(
        makeRequest({ modelCode: "primary-model", requestId: "splits-3" }),
        { workspaceId: "ws-1" } as never,
      );

      const row = h.requestLog.record.mock.calls[0]?.[0] as {
        inputTokens?: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
      };
      expect(row.inputTokens).toBeUndefined();
      expect(row.cachedInputTokens).toBeUndefined();
      expect(row.reasoningTokens).toBeUndefined();
    });
  });
});
