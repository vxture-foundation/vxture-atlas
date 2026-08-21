import { HttpStatus } from "@nestjs/common";
import { describe, it, expect, vi } from "vitest";

import {
  runWithS2sFailover,
  toGateRequest,
  toS2sProviderError,
  withWorkspaceFallback,
  type GatedModel,
} from "./s2s-provider.shared";
import { ProviderCapabilityNotImplementedError } from "../providers/base.provider";
import { rateLimitKey } from "../quota/model-rate-limiter.service";
import { ModelRuntimeException } from "./runtime.errors";
import type { S2sAuthContext } from "./guards/s2s-auth.guard";
import type { AiModelRecord } from "../types/runtime.types";

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "model-1",
    providerId: null,
    modelCode: "m",
    modelName: "M",
    provider: "doubao",
    endpointUrl: "https://api.example.com",
    protocol: "openai",
    modelType: "embedding",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    supportsStreaming: false,
    isActive: true,
    sort: 0,
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

describe("toS2sProviderError", () => {
  it("passes an existing ModelRuntimeException through unchanged", () => {
    const original = new ModelRuntimeException(
      HttpStatus.FORBIDDEN,
      "NOT_ENTITLED",
      "denied",
    );
    expect(toS2sProviderError(original, makeModel(), "req-1")).toBe(original);
  });

  it("maps ProviderCapabilityNotImplementedError to 501 MODEL_NOT_IMPLEMENTED", () => {
    const error = toS2sProviderError(
      new ProviderCapabilityNotImplementedError("doubao", "embed"),
      makeModel(),
      "req-1",
    );
    expect(error.code).toBe("MODEL_NOT_IMPLEMENTED");
    expect(error.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
  });

  it("maps an unknown error to 503 PROVIDER_UNAVAILABLE", () => {
    const error = toS2sProviderError(new Error("boom"), makeModel(), "req-1");
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});

/**
 * A registry whose models derive their id from the model code, so the
 * concurrency-slot key (`rateLimitKey(model.id, tenantId)`) is predictable
 * per candidate.
 */
function makeFailoverDeps(options: { fallbackModelCodes?: string[] } = {}) {
  const registry = {
    getActiveModel: vi
      .fn()
      .mockImplementation(async (code: string) =>
        makeModel({ id: `id-${code}`, modelCode: code }),
      ),
    resolveModelCodeForTaskProfile: vi.fn().mockResolvedValue("profile-model"),
    resolveEndpoint: vi.fn().mockImplementation(async (code: string) => ({
      modelCode: "m1",
      fallbackModelCodes: options.fallbackModelCodes ?? [],
      endpointCode: code,
    })),
  };
  const quota = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  const provider = {};
  const router = { resolve: vi.fn().mockReturnValue(provider) };
  const providerKeys = { resolveKey: vi.fn().mockResolvedValue("sk-test-vault") };
  const rateLimiter = { releaseConcurrency: vi.fn() };
  const requestLog = {
    record: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
  };

  return { registry, quota, router, providerKeys, rateLimiter, requestLog };
}

describe("runWithS2sFailover", () => {
  it("tries candidates in route order and releases the concurrency slot per candidate", async () => {
    const deps = makeFailoverDeps({ fallbackModelCodes: ["m2"] });
    const attempted: GatedModel[] = [];
    const attempt = vi.fn().mockImplementation(async (gated: GatedModel) => {
      attempted.push(gated);
      if (gated.model.modelCode === "m1") {
        throw new Error("primary upstream down");
      }
      return "fallback-answer";
    });

    const result = await runWithS2sFailover(
      deps as never,
      { endpointCode: "embedding/default", tenantId: "tenant-1" },
      undefined,
      attempt,
    );

    expect(result).toBe("fallback-answer");
    expect(attempted.map((g) => g.model.modelCode)).toEqual(["m1", "m2"]);
    // Both carry the endpoint that actually routed the call.
    expect(attempted.map((g) => g.routedEndpointCode)).toEqual([
      "embedding/default",
      "embedding/default",
    ]);
    // The slot is released once per attempted candidate - including the
    // successful one - keyed by that candidate's model id.
    expect(deps.rateLimiter.releaseConcurrency.mock.calls).toEqual([
      [rateLimitKey("id-m1", "tenant-1")],
      [rateLimitKey("id-m2", "tenant-1")],
    ]);
  });

  // `assertAllowed` ENDS by acquiring a concurrency slot, so anything that
  // throws after it runs holding one. The release used to live in a `finally`
  // attached to the attempt, which only runs once the gate has RETURNED - so
  // these two paths leaked a slot permanently (`inFlight` is a Map with no
  // expiry). After `max_concurrent` of them that (model, tenant) pair answers
  // 429 for the life of the process, and RATE_LIMITED is retryable with no
  // retryAfterMs on the concurrency dimension, so a correct caller retries
  // forever against a counter that can only go up.
  it.each([
    [
      "the provider adapter cannot be resolved",
      (deps: ReturnType<typeof makeFailoverDeps>) => {
        deps.router.resolve.mockImplementation(() => {
          throw new ModelRuntimeException(
            HttpStatus.SERVICE_UNAVAILABLE,
            "MODEL_NOT_ROUTABLE",
            "no adapter",
          );
        });
      },
    ],
    [
      "the api key cannot be resolved",
      (deps: ReturnType<typeof makeFailoverDeps>) => {
        deps.registry.getActiveModel.mockImplementation(async (code: string) =>
          makeModel({
            id: `id-${code}`,
            modelCode: code,
            // doubao is not in API_KEY_OPTIONAL_PROVIDERS, so an unresolvable
            // managed alias is a hard failure - which is the realistic case:
            // a key rotated out, or a vault entry deactivated.
            config: { managedKeyAlias: "rotated-out" },
          }),
        );
        deps.providerKeys.resolveKey.mockResolvedValue(null);
      },
    ],
  ])(
    "releases the concurrency slot when %s after the gate acquired one",
    async (_label, breakIt) => {
      const deps = makeFailoverDeps();
      breakIt(deps);

      await expect(
        runWithS2sFailover(
          deps as never,
          { modelCode: "m1", tenantId: "tenant-1", requestId: "req-leak" },
          {
            callerProductCode: "karda",
            mode: "service",
            scope: "tool:atlas",
            tenantId: "tenant-1",
            workspaceId: "ws-1",
          },
          vi.fn(),
        ),
      ).rejects.toBeDefined();

      // The slot must come back, keyed exactly as it was taken.
      expect(deps.rateLimiter.releaseConcurrency).toHaveBeenCalledWith(
        rateLimitKey("id-m1", "tenant-1"),
      );
    },
  );

  it("records a PRIMARY gate refusal in reqlog and rethrows the original error", async () => {
    const deps = makeFailoverDeps();
    const refusal = new ModelRuntimeException(
      HttpStatus.TOO_MANY_REQUESTS,
      "QUOTA_EXCEEDED",
      "quota exhausted",
    );
    deps.quota.assertAllowed.mockRejectedValue(refusal);
    const attempt = vi.fn();

    await expect(
      runWithS2sFailover(
        deps as never,
        { modelCode: "m1", tenantId: "tenant-1", requestId: "req-9" },
        {
          callerProductCode: "karda",
          mode: "service",
          scope: "tool:atlas",
          tenantId: "tenant-1",
          workspaceId: "ws-1",
        },
        attempt,
      ),
    ).rejects.toBe(refusal);

    expect(attempt).not.toHaveBeenCalled();
    // Nothing to release HERE specifically because `assertAllowed` itself
    // refused - the acquire is its last step, so a refusal from it never took
    // a slot. That is narrower than "a refused candidate never holds a slot",
    // which is false and was the bug: see the two cases below.
    expect(deps.rateLimiter.releaseConcurrency).not.toHaveBeenCalled();
    // The refusal is still a served request: one error row + one error record.
    expect(deps.requestLog.record).toHaveBeenCalledTimes(1);
    expect(deps.requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-9",
        status: "error",
        tenantId: "tenant-1",
        workspaceId: "ws-1",
        modelCode: "m1",
        productCode: "karda",
      }),
    );
    expect(deps.requestLog.recordError).toHaveBeenCalledTimes(1);
    expect(deps.requestLog.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-9",
        modelCode: "m1",
        errorCode: "QUOTA_EXCEEDED",
        errorMessage: "quota exhausted",
      }),
    );
  });

  it("skips a FALLBACK candidate whose gate throws and surfaces the primary's provider error", async () => {
    const deps = makeFailoverDeps({ fallbackModelCodes: ["m2"] });
    // The fallback model was deactivated - its gate fails at lookup.
    deps.registry.getActiveModel.mockImplementation(async (code: string) => {
      if (code === "m2") {
        throw new ModelRuntimeException(
          HttpStatus.NOT_FOUND,
          "MODEL_NOT_ROUTABLE",
          "m2 is gone",
        );
      }
      return makeModel({ id: `id-${code}`, modelCode: code });
    });
    const attempt = vi.fn().mockRejectedValue(new Error("primary boom"));

    let thrown: unknown;
    try {
      await runWithS2sFailover(
        deps as never,
        { endpointCode: "embedding/default", tenantId: "tenant-1" },
        undefined,
        attempt,
      );
    } catch (error) {
      thrown = error;
    }

    // The fallback's own gate error must not mask the primary's failure.
    const error = thrown as ModelRuntimeException;
    expect(error).toBeInstanceOf(ModelRuntimeException);
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toContain("primary boom");
    // Only the primary was attempted, and only its slot released.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(deps.rateLimiter.releaseConcurrency.mock.calls).toEqual([
      [rateLimitKey("id-m1", "tenant-1")],
    ]);
    // A skipped fallback is not a served request - no gate-refusal rows.
    expect(deps.requestLog.record).not.toHaveBeenCalled();
    expect(deps.requestLog.recordError).not.toHaveBeenCalled();
  });

  it("uses modelCode directly when given, without consulting taskProfile resolution", async () => {
    const deps = makeFailoverDeps();
    const attempt = vi.fn(async (gated: GatedModel) => gated);

    const gated = await runWithS2sFailover(
      deps as never,
      { modelCode: "explicit-model", tenantId: "tenant-1" },
      undefined,
      attempt,
    );

    expect(gated.model.modelCode).toBe("explicit-model");
    expect(deps.registry.resolveModelCodeForTaskProfile).not.toHaveBeenCalled();
    expect(deps.registry.getActiveModel).toHaveBeenCalledWith("explicit-model");
  });

  it("resolves modelCode from taskProfile when modelCode is omitted", async () => {
    const deps = makeFailoverDeps();
    const attempt = vi.fn(async (gated: GatedModel) => gated);

    const gated = await runWithS2sFailover(
      deps as never,
      {
        taskProfile: "summarization",
        tenantId: "tenant-1",
        applicationId: "app-1",
        applicationType: "agent",
      },
      undefined,
      attempt,
    );

    expect(deps.registry.resolveModelCodeForTaskProfile).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      taskProfile: "summarization",
      applicationId: "app-1",
      applicationType: "agent",
    });
    expect(gated.model.modelCode).toBe("profile-model");
  });

  it("rejects when neither modelCode, endpointCode nor taskProfile is given", async () => {
    const deps = makeFailoverDeps();
    const attempt = vi.fn();

    await expect(
      runWithS2sFailover(
        deps as never,
        { tenantId: "tenant-1" },
        undefined,
        attempt,
      ),
    ).rejects.toBeInstanceOf(ModelRuntimeException);
    expect(deps.registry.getActiveModel).not.toHaveBeenCalled();
    expect(attempt).not.toHaveBeenCalled();
  });

  // #159 §4/§5: what the gate hands `withRequestLog` for endpoint attribution.
  it("does not carry an endpoint that lost precedence to modelCode", async () => {
    // Same rule as the chat path: the endpoint did not route this call, so it
    // must not be credited for it in metering.
    const deps = makeFailoverDeps();
    const attempt = vi.fn(async (gated: GatedModel) => gated);

    const gated = await runWithS2sFailover(
      deps as never,
      {
        modelCode: "explicit-model",
        endpointCode: "embedding/default",
        tenantId: "tenant-1",
      },
      undefined,
      attempt,
    );

    expect(gated.routedEndpointCode).toBeNull();
    expect(deps.registry.resolveEndpoint).not.toHaveBeenCalled();
  });
});

/**
 * TD-035: the required body `workspaceId` must neither override a verified
 * claim nor be configurable-but-inert.
 */
describe("withWorkspaceFallback", () => {
  const AUTH: S2sAuthContext = {
    callerProductCode: "karda",
    mode: "service",
    scope: "tool:atlas",
    tenantId: "tenant-1",
  };

  it("returns undefined when there is no auth context at all", () => {
    expect(withWorkspaceFallback(undefined, { workspaceId: "ws-1" })).toBeUndefined();
  });

  it("never lets the body override a verified workspace_id claim", () => {
    const auth = { ...AUTH, workspaceId: "ws-claim" };
    const result = withWorkspaceFallback(auth, { workspaceId: "ws-body" });
    expect(result).toBe(auth);
    expect(result?.workspaceId).toBe("ws-claim");
  });

  it("falls back to the body workspaceId when the token carries no claim", () => {
    const result = withWorkspaceFallback(AUTH, { workspaceId: "ws-body" });
    expect(result?.workspaceId).toBe("ws-body");
    // The original context is not mutated.
    expect(AUTH.workspaceId).toBeUndefined();
  });

  it("ignores a blank body workspaceId rather than storing whitespace", () => {
    const result = withWorkspaceFallback(AUTH, { workspaceId: "   " });
    expect(result).toBe(AUTH);
    expect(result?.workspaceId).toBeUndefined();
  });
});

/**
 * TD-022. The two authorization axes are keyed differently - grants by tenant,
 * entitlement by workspace - and the A1/A2/A3 endpoints used to collapse them
 * by assigning workspaceId into tenantId, so no grant could ever match.
 */
describe("toGateRequest", () => {
  const AUTH = {
    callerProductCode: "karda",
    mode: "service" as const,
    scope: "tool:atlas",
    tenantId: "tenant-1",
    workspaceId: "ws-1",
  };

  it("takes the tenant from the verified token, never from workspaceId", () => {
    const gate = toGateRequest({ workspaceId: "ws-1" }, AUTH);
    expect(gate.tenantId).toBe("tenant-1");
    expect(gate.tenantId).not.toBe(gate.workspaceId);
  });

  it("keeps workspaceId intact for the entitlement check", () => {
    expect(toGateRequest({ workspaceId: "ws-1" }, AUTH).workspaceId).toBe("ws-1");
  });

  it("prefers the token over a caller-supplied tenantId", () => {
    const gate = toGateRequest({ tenantId: "spoofed", workspaceId: "ws-1" }, AUTH);
    expect(gate.tenantId).toBe("tenant-1");
  });

  it("falls back to the request body when the token carries no tenant claim", () => {
    // Omit the key rather than set it undefined - exactOptionalPropertyTypes
    // treats those as different, and a personal tenant really does arrive
    // with no tenancy claim at all (see 10-http-surface.md).
    const { tenantId: _absent, ...noTenant } = AUTH;
    expect(toGateRequest({ tenantId: "tenant-9" }, noTenant).tenantId).toBe("tenant-9");
  });

  it("rejects rather than guessing when neither source has a tenant", () => {
    expect(() => toGateRequest({ workspaceId: "ws-1" })).toThrow(ModelRuntimeException);
  });
});
