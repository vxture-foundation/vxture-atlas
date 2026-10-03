import { describe, it, expect, vi } from "vitest";

import { RerankService } from "./rerank.service";
import { V1_REQUEST_CONTRACT } from "../runtime/request-contract";
import { RERANK_CANDIDATE_POOL_LIMIT } from "./rerank.types";
import { ProviderCapabilityNotImplementedError } from "../providers/base.provider";
import { rateLimitKey } from "../quota/model-rate-limiter.service";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import type { AiModelRecord } from "../types/runtime.types";

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "model-1",
    providerId: null,
    modelCode: "rerank-cross-encoder-v1",
    modelName: "Cross Encoder v1",
    provider: "doubao",
    endpointUrl: "https://api.doubao.example/v1",
    protocol: "openai",
    modelType: "rerank",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["rerank"],
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

function makeService(
  model: AiModelRecord,
  providerOverrides: Partial<{ rerank: ReturnType<typeof vi.fn> }> = {},
) {
  const registry = { getActiveModel: vi.fn().mockResolvedValue(model) };
  const quota = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  const provider = {
    rerank:
      providerOverrides.rerank ??
      vi
        .fn()
        .mockRejectedValue(
          new ProviderCapabilityNotImplementedError("doubao", "rerank"),
        ),
  };
  const router = { resolve: vi.fn().mockReturnValue(provider) };
  const providerKeys = { resolveKey: vi.fn().mockResolvedValue("sk-test-vault") };

  const requestLog = {
    record: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
  };

  const entitlements = {
    reportTokens: vi.fn().mockResolvedValue({ billed: false }),
  };

  const rateLimiter = {
    checkRpm: vi.fn(),
    acquireConcurrency: vi.fn(),
    releaseConcurrency: vi.fn(),
  };

  const service = new RerankService(
    registry as never,
    router as never,
    quota as never,
    providerKeys as never,
    requestLog as never,
    entitlements as never,
    rateLimiter as never,
  );

  return {
    service,
    registry,
    quota,
    router,
    provider,
    providerKeys,
    requestLog,
    entitlements,
    rateLimiter,
  };
}

const CANDIDATES = [{ id: "c1", text: "candidate one" }];

/** A verified service-mode token: tenant and workspace are different ids, on
 *  purpose - the grant axis is the tenant, the entitlement axis the workspace. */
const AUTH = {
  callerProductCode: "karda",
  mode: "service" as const,
  scope: "tool:atlas",
  tenantId: "tenant-1",
  workspaceId: "ws-1",
};

describe("RerankService.rerank", () => {
  /**
   * product_251 X-2: `taskId` is required. Every other test here sends one now,
   * so they prove a request WITH it is not blocked - not that one without it is
   * refused. That is this test's job, and it exists on all four surfaces
   * because the last pre-log fix in this repo covered chat only while claiming
   * to fix the class.
   */
  it("refuses a request with no taskId", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.rerank(
        { modelCode: "m", query: "q", candidates: CANDIDATES, workspaceId: "ws-1" },
        AUTH,
      ),
    ).rejects.toMatchObject({
      response: { code: "TASK_ID_REQUIRED", retryable: false },
    });
  });

  it("rejects when modelCode is missing", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: "",
        query: "q",
        candidates: CANDIDATES,
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "TARGET_SELECTOR_REQUIRED", retryable: false },
    });
  });

  it("rejects empty candidates", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: "m",
        query: "q",
        candidates: [],
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "RERANK_CANDIDATES_REQUIRED", retryable: false },
    });
  });

  it("rejects candidate pools over the A3.2 limit with CANDIDATE_POOL_TOO_LARGE, not a silent truncation", async () => {
    const { service } = makeService(makeModel());
    const tooMany = Array.from(
      { length: RERANK_CANDIDATE_POOL_LIMIT + 1 },
      (_, i) => ({ id: `c${i}`, text: `candidate ${i}` }),
    );

    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: "m",
        query: "q",
        candidates: tooMany,
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({ code: "CANDIDATE_POOL_TOO_LARGE" });
  });

  it("accepts exactly the pool limit", async () => {
    const model = makeModel();
    const rerank = vi.fn().mockResolvedValue({ scores: [{ id: "c0", score: 0.9 }] });
    const { service } = makeService(model, { rerank });
    const exactly100 = Array.from({ length: RERANK_CANDIDATE_POOL_LIMIT }, (_, i) => ({
      id: `c${i}`,
      text: `candidate ${i}`,
    }));

    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: model.modelCode,
        query: "q",
        candidates: exactly100,
        workspaceId: "ws-1",
      }, AUTH),
    ).resolves.toBeDefined();
  });

  it("rejects candidates missing id or text", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: "m",
        query: "q",
        candidates: [{ id: "", text: "a" }],
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "RERANK_CANDIDATES_INVALID", retryable: false },
    });
  });

  it("maps a not-implemented provider to a 501 MODEL_NOT_IMPLEMENTED error", async () => {
    const model = makeModel();
    const { service } = makeService(model);

    try {
      await service.rerank({
        taskId: "task-fixture",
        modelCode: model.modelCode,
        query: "q",
        candidates: CANDIDATES,
        workspaceId: "ws-1",
      }, AUTH);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_NOT_IMPLEMENTED" });
      expect((error as { getStatus(): number }).getStatus()).toBe(501);
    }
  });

  it("returns the provider's scores on success", async () => {
    const model = makeModel();
    const rerank = vi
      .fn()
      .mockResolvedValue({ scores: [{ id: "c1", score: 0.42 }] });
    const { service } = makeService(model, { rerank });

    const result = await service.rerank({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      query: "q",
      candidates: CANDIDATES,
      workspaceId: "ws-1",
    }, AUTH);

    expect(result).toEqual({
      modelCode: model.modelCode,
      scores: [{ id: "c1", score: 0.42 }],
    });
  });

  it("consumes atlas.rerank for the candidate pool size on success", async () => {
    // C3: rerank bills by pair count - deterministic even when the upstream
    // reports no token usage. The workspace comes from the token claim first;
    // the body field is only a fallback when the token carries no claim.
    const model = makeModel();
    const rerank = vi
      .fn()
      .mockResolvedValue({ scores: [{ id: "c1", score: 0.42 }] });
    const { service, entitlements } = makeService(model, { rerank });

    await service.rerank({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      query: "q",
      candidates: CANDIDATES,
      workspaceId: "ws-1",
    }, AUTH);

    // ADR-013: the candidate pool travels as its own unit field under the
    // caller's product; the platform's rate table prices it.
    expect(entitlements.reportTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: AUTH.workspaceId,
        callerProductCode: "karda",
        rerankCandidates: CANDIDATES.length,
      }),
    );
  });

  it("does not consume when the token carries no workspace", async () => {
    const model = makeModel();
    const rerank = vi
      .fn()
      .mockResolvedValue({ scores: [{ id: "c1", score: 0.42 }] });
    const { service, entitlements } = makeService(model, { rerank });

    await service.rerank({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      query: "q",
      candidates: CANDIDATES,
      workspaceId: "ws-1",
      tenantId: "tenant-1",
    });

    expect(entitlements.reportTokens).not.toHaveBeenCalled();
  });

  it("records a gate refusal in reqlog and rethrows the refusal untouched", async () => {
    // A denied call never reaches withRequestLog, so the failover loop writes
    // its own error row - quota exhaustion or a revoked grant must not be a
    // flatline with zero recorded errors.
    const model = makeModel();
    const { service, quota, provider, requestLog } = makeService(model);
    quota.assertAllowed.mockRejectedValue(
      new ModelRuntimeException(403, "NOT_ENTITLED", "no grant for tenant"),
    );

    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: model.modelCode,
        query: "q",
        candidates: CANDIDATES,
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({ code: "NOT_ENTITLED" });

    expect(provider.rerank).not.toHaveBeenCalled();
    expect(requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        modelCode: model.modelCode,
        tenantId: AUTH.tenantId,
        workspaceId: AUTH.workspaceId,
      }),
    );
    expect(requestLog.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        modelCode: model.modelCode,
        errorCode: "NOT_ENTITLED",
      }),
    );
  });

  it("releases the concurrency slot after a successful call", async () => {
    const model = makeModel();
    const rerank = vi
      .fn()
      .mockResolvedValue({ scores: [{ id: "c1", score: 0.42 }] });
    const { service, rateLimiter } = makeService(model, { rerank });

    await service.rerank({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      query: "q",
      candidates: CANDIDATES,
      workspaceId: "ws-1",
    }, AUTH);

    expect(rateLimiter.releaseConcurrency).toHaveBeenCalledWith(
      rateLimitKey(model.id, AUTH.tenantId),
    );
  });

  it("releases the concurrency slot when the provider call fails", async () => {
    // The gate may have acquired a max_concurrent slot; a provider failure
    // must not leak it or the model wedges shut at its concurrency limit.
    const model = makeModel();
    const { service, rateLimiter } = makeService(model);

    await expect(
      service.rerank({
        taskId: "task-fixture",
        modelCode: model.modelCode,
        query: "q",
        candidates: CANDIDATES,
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({ code: "MODEL_NOT_IMPLEMENTED" });

    expect(rateLimiter.releaseConcurrency).toHaveBeenCalledWith(
      rateLimitKey(model.id, AUTH.tenantId),
    );
  });

  it("prefers the token workspace claim over the body workspaceId", async () => {
    // TD-035: a body field must never override a verified claim.
    const model = makeModel();
    const rerank = vi
      .fn()
      .mockResolvedValue({ scores: [{ id: "c1", score: 0.42 }] });
    const { service, entitlements } = makeService(model, { rerank });

    await service.rerank({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      query: "q",
      candidates: CANDIDATES,
      workspaceId: "ws-body",
    }, AUTH);

    expect(entitlements.reportTokens).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: AUTH.workspaceId }),
    );
  });

  it("falls back to the body workspaceId when the token carries no claim", async () => {
    // TD-035: the required body field must not be configurable-but-inert - a
    // claimless service token still gets its call attributed and consumed.
    const model = makeModel();
    const rerank = vi
      .fn()
      .mockResolvedValue({ scores: [{ id: "c1", score: 0.42 }] });
    const { service, entitlements } = makeService(model, { rerank });
    const { workspaceId: _omitted, ...authWithoutWorkspace } = AUTH;

    await service.rerank({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      query: "q",
      candidates: CANDIDATES,
      workspaceId: "ws-body",
    }, authWithoutWorkspace);

    expect(entitlements.reportTokens).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-body" }),
    );
  });
});

// ── the published request contract names THIS surface ─────────────────────────
//
// `check-request-contract.mjs` proves every "missing input" code is published
// somewhere. It cannot prove the rule was filed under the right path, and a rule
// on the wrong surface is exactly as useless to a consumer as a missing one.
// This is that half.
describe("/v1/rerank matches its published request rules", () => {
  const RULES = V1_REQUEST_CONTRACT["/v1/rerank"] ?? [];

  const complete = (): Record<string, unknown> => ({
    taskId: "task-fixture",
    workspaceId: "ws-1",
    modelCode: "m",
    query: "q",
    candidates: CANDIDATES,
  });

  it("publishes at least one rule for this surface", () => {
    expect(RULES.length).toBeGreaterThan(0);
  });

  it.each(
    RULES.filter((rule) => rule.kind !== "requiredWith").map((rule) => [
      rule.code,
      rule.fields,
    ]),
  )("answers %s when the published fields are absent", async (code, fields) => {
    const { service } = makeService(makeModel());
    const body = complete();
    for (const field of fields as string[]) delete body[field];

    await expect(service.rerank(body as never, AUTH)).rejects.toMatchObject({
      response: { code },
    });
  });
});
