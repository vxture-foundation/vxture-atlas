import { describe, it, expect, vi } from "vitest";

import { EmbeddingService } from "./embedding.service";
import { V1_REQUEST_CONTRACT } from "../runtime/request-contract";
import { ProviderCapabilityNotImplementedError } from "../providers/base.provider";
import { rateLimitKey } from "../quota/model-rate-limiter.service";
import type { AiModelRecord } from "../types/runtime.types";

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "model-1",
    providerId: null,
    modelCode: "embed-bge-m3-v2",
    modelName: "BGE M3 v2",
    provider: "doubao",
    endpointUrl: "https://api.doubao.example/v1",
    protocol: "openai",
    modelType: "embedding",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["embedding"],
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

function makeService(model: AiModelRecord, providerOverrides: Partial<{
  embed: ReturnType<typeof vi.fn>;
}> = {}) {
  const registry = { getActiveModel: vi.fn().mockResolvedValue(model) };
  const quota = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  const provider = {
    embed:
      providerOverrides.embed ??
      vi.fn().mockRejectedValue(
        new ProviderCapabilityNotImplementedError("doubao", "embed"),
      ),
  };
  const router = { resolve: vi.fn().mockReturnValue(provider) };
  const providerKeys = { resolveKey: vi.fn().mockResolvedValue("sk-test-vault") };

  const requestLog = {
    record: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
  };

  const entitlements = {
    consume: vi.fn().mockResolvedValue({ billed: false }),
  };

  const rateLimiter = { releaseConcurrency: vi.fn() };

  const service = new EmbeddingService(
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

/** A verified service-mode token: tenant and workspace are different ids, on
 *  purpose - the grant axis is the tenant, the entitlement axis the workspace. */
const AUTH = {
  callerProductCode: "karda",
  mode: "service" as const,
  scope: "tool:atlas",
  tenantId: "tenant-1",
  workspaceId: "ws-1",
};

describe("EmbeddingService.embed", () => {
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
      service.embed(
        { modelCode: "m", texts: ["hi"], workspaceId: "ws-1" },
        AUTH,
      ),
    ).rejects.toMatchObject({
      response: { code: "TASK_ID_REQUIRED", retryable: false },
    });
  });

  it("rejects when modelCode is missing", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.embed({
        taskId: "task-fixture",
        modelCode: "",
        texts: ["hi"],
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "TARGET_SELECTOR_REQUIRED", retryable: false },
    });
  });

  it("rejects when workspaceId is missing", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.embed({
        taskId: "task-fixture", modelCode: "m", texts: ["hi"], workspaceId: "" }),
    ).rejects.toMatchObject({
      response: { code: "WORKSPACE_ID_REQUIRED", retryable: false },
    });
  });

  it("rejects empty texts", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.embed({
        taskId: "task-fixture", modelCode: "m", texts: [], workspaceId: "ws-1" }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "EMBED_TEXTS_REQUIRED", retryable: false },
    });
  });

  it("gates through the model registry and quota before calling the provider", async () => {
    const model = makeModel();
    const { service, registry, quota } = makeService(model);

    await expect(
      service.embed({
        taskId: "task-fixture", modelCode: model.modelCode, texts: ["hi"], workspaceId: "ws-1" }, AUTH),
    ).rejects.toMatchObject({ code: "MODEL_NOT_IMPLEMENTED" });

    expect(registry.getActiveModel).toHaveBeenCalledWith(model.modelCode);
    // Asserts the gating contract - the model, and the TENANT the grant lookup
    // must use.
    const [gatedModel, gatedRequest] = quota.assertAllowed.mock.calls[0] as [
      unknown,
      { tenantId: string },
    ];
    expect(gatedModel).toEqual(model);
    expect(gatedRequest).toMatchObject({ tenantId: "tenant-1" });
  });

  it("maps a not-implemented provider to a 501 MODEL_NOT_IMPLEMENTED error", async () => {
    const model = makeModel();
    const { service } = makeService(model);

    try {
      await service.embed({
        taskId: "task-fixture",
        modelCode: model.modelCode,
        texts: ["hi"],
        workspaceId: "ws-1",
      }, AUTH);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_NOT_IMPLEMENTED" });
      expect((error as { getStatus(): number }).getStatus()).toBe(501);
    }
  });

  it("returns the provider's embedding result on success", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
    });
    const { service } = makeService(model, { embed });

    const result = await service.embed({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      texts: ["hi"],
      workspaceId: "ws-1",
    }, AUTH);

    expect(result).toEqual({
      modelCode: model.modelCode,
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
    });
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ["hi"], modelCode: model.modelCode }),
    );
  });

  it("consumes atlas.embed for the upstream-reported token count", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
      usage: { promptTokens: 7, totalTokens: 7 },
    });
    const { service, entitlements } = makeService(model, { embed });

    await service.embed({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      texts: ["hi"],
      workspaceId: "ws-1",
    }, AUTH);

    expect(entitlements.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: AUTH.workspaceId,
        metric: "atlas.embed",
        amount: 7,
      }),
    );
  });

  it("does not consume when the provider reports no usage - never invent a number", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
    });
    const { service, entitlements } = makeService(model, { embed });

    await service.embed({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      texts: ["hi"],
      workspaceId: "ws-1",
    }, AUTH);

    expect(entitlements.consume).not.toHaveBeenCalled();
  });

  it("records a reqlog error row and an error record on a gate refusal", async () => {
    const model = makeModel();
    const { service, quota, requestLog, provider } = makeService(model);
    const refusal = new Error("NOT_ENTITLED: tenant-1 holds no grant");
    quota.assertAllowed.mockRejectedValue(refusal);

    await expect(
      service.embed(
        {
        taskId: "task-fixture", modelCode: model.modelCode, texts: ["hi"], workspaceId: "ws-1" },
        AUTH,
      ),
    ).rejects.toBe(refusal);

    // Refused at the gate: the provider is never called, but the served
    // request is still visible in reqlog (error row + error record).
    expect(provider.embed).not.toHaveBeenCalled();
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
        errorMessage: "NOT_ENTITLED: tenant-1 holds no grant",
      }),
    );
  });

  it("releases the concurrency slot after a successful attempt", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
    });
    const { service, rateLimiter } = makeService(model, { embed });

    await service.embed(
      {
        taskId: "task-fixture", modelCode: model.modelCode, texts: ["hi"], workspaceId: "ws-1" },
      AUTH,
    );

    expect(rateLimiter.releaseConcurrency).toHaveBeenCalledTimes(1);
    expect(rateLimiter.releaseConcurrency).toHaveBeenCalledWith(
      rateLimitKey(model.id, AUTH.tenantId),
    );
  });

  it("releases the concurrency slot after a failed attempt", async () => {
    const model = makeModel();
    // Default provider mock rejects (capability not implemented).
    const { service, rateLimiter } = makeService(model);

    await expect(
      service.embed(
        {
        taskId: "task-fixture", modelCode: model.modelCode, texts: ["hi"], workspaceId: "ws-1" },
        AUTH,
      ),
    ).rejects.toMatchObject({ code: "MODEL_NOT_IMPLEMENTED" });

    expect(rateLimiter.releaseConcurrency).toHaveBeenCalledTimes(1);
    expect(rateLimiter.releaseConcurrency).toHaveBeenCalledWith(
      rateLimitKey(model.id, AUTH.tenantId),
    );
  });

  it("falls back to the body workspaceId when the token has no workspace_id claim", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
      usage: { promptTokens: 7, totalTokens: 7 },
    });
    const { service, entitlements, requestLog } = makeService(model, { embed });
    const authWithoutWorkspaceClaim = {
      callerProductCode: "karda",
      mode: "service" as const,
      scope: "tool:atlas",
      tenantId: "tenant-1",
    };

    await service.embed(
      {
        taskId: "task-fixture", modelCode: model.modelCode, texts: ["hi"], workspaceId: "ws-body" },
      authWithoutWorkspaceClaim,
    );

    expect(entitlements.consume).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-body" }),
    );
    expect(requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", workspaceId: "ws-body" }),
    );
  });

  // product_251 X-2. embed/rerank/parse all log through withRequestLog's single
  // `dimensions` object, so covering one capability covers the injection point
  // all three share - the dimension cannot be present on one and missing on
  // another.
  it("carries taskId onto the reqlog row for an S2S capability call", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
      usage: { promptTokens: 7, totalTokens: 7 },
    });
    const { service, requestLog } = makeService(model, { embed });

    await service.embed(
      {
        modelCode: model.modelCode,
        texts: ["hi"],
        workspaceId: "ws-1",
        taskId: "task_01JQ8Z3M6F",
      },
      AUTH,
    );

    expect(requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_01JQ8Z3M6F", status: "success" }),
    );
  });

  it("a token workspace_id claim wins over a differing body workspaceId", async () => {
    const model = makeModel();
    const embed = vi.fn().mockResolvedValue({
      modelVersion: "v2",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
      usage: { promptTokens: 7, totalTokens: 7 },
    });
    const { service, entitlements, requestLog } = makeService(model, { embed });

    await service.embed(
      {
        taskId: "task-fixture", modelCode: model.modelCode, texts: ["hi"], workspaceId: "ws-body" },
      AUTH, // carries workspaceId "ws-1"
    );

    expect(entitlements.consume).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: AUTH.workspaceId }),
    );
    expect(requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", workspaceId: AUTH.workspaceId }),
    );
  });
});

// ── the published request contract names THIS surface ─────────────────────────
//
// `check-request-contract.mjs` proves every "missing input" code is published
// somewhere. It cannot prove the rule was filed under the right path, and a
// rule on the wrong surface is exactly as useless to a consumer as a missing
// one. This is that half: drive the real service, omit what the contract says
// is required for /v1/embed, and assert the code it publishes comes back.
describe("/v1/embed matches its published request rules", () => {
  const RULES = V1_REQUEST_CONTRACT["/v1/embed"] ?? [];

  const complete = (): Record<string, unknown> => ({
    taskId: "task-fixture",
    workspaceId: "ws-1",
    modelCode: "m",
    texts: ["hi"],
  });

  it("publishes at least one rule for this surface", () => {
    // Guards against the loop below passing vacuously if the table loses the key.
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

    await expect(service.embed(body as never, AUTH)).rejects.toMatchObject({
      response: { code },
    });
  });
});
