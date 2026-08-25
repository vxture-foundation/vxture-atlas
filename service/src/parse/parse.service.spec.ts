import { describe, it, expect, vi } from "vitest";

import { ParseService } from "./parse.service";
import { V1_REQUEST_CONTRACT } from "../runtime/request-contract";
import { ProviderCapabilityNotImplementedError } from "../providers/base.provider";
import type { AiModelRecord } from "../types/runtime.types";

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "model-1",
    providerId: null,
    modelCode: "parse-layout-v1",
    modelName: "Layout Parser v1",
    provider: "doubao",
    endpointUrl: "https://api.doubao.example/v1",
    protocol: "openai",
    modelType: "parse",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["parse"],
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
  providerOverrides: Partial<{ parseDocument: ReturnType<typeof vi.fn> }> = {},
) {
  const registry = { getActiveModel: vi.fn().mockResolvedValue(model) };
  const quota = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  const provider = {
    parseDocument:
      providerOverrides.parseDocument ??
      vi
        .fn()
        .mockRejectedValue(
          new ProviderCapabilityNotImplementedError("doubao", "parseDocument"),
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

  const service = new ParseService(
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

const PAGES = [{ pageIndex: 0, imageRef: "ref-1" }];

/** A verified service-mode token: tenant and workspace are different ids, on
 *  purpose - the grant axis is the tenant, the entitlement axis the workspace. */
const AUTH = {
  callerProductCode: "karda",
  mode: "service" as const,
  scope: "tool:atlas",
  tenantId: "tenant-1",
  workspaceId: "ws-1",
};

describe("ParseService.parse", () => {
/**
 * product_251 X-2: `taskId` is required. The other tests in this file all send
 * one now, so they prove a request WITH it is not blocked - not that a request
 * without it is refused. That is this test's whole job, and it exists on all
 * four surfaces because the last pre-log fix in this repo covered chat only
 * while claiming to fix the class.
 */
  it("refuses a request with no taskId", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.parse(
        {
          modelCode: "m",
          task: "ocr",
          pages: PAGES,
          workspaceId: "ws-1",
        },
        AUTH,
      ),
    ).rejects.toMatchObject({
      response: { code: "TASK_ID_REQUIRED", retryable: false },
    });
  });

  it("rejects when modelCode is missing", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.parse({
        taskId: "task-fixture",
        modelCode: "",
        task: "ocr",
        pages: PAGES,
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "TARGET_SELECTOR_REQUIRED", retryable: false },
    });
  });

  it("rejects an invalid task", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.parse({
        taskId: "task-fixture",
        modelCode: "m",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        task: "unknown-task" as any,
        pages: PAGES,
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "PARSE_TASK_INVALID", retryable: false },
    });
  });

  it("rejects empty pages", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.parse({
        taskId: "task-fixture",
        modelCode: "m",
        task: "ocr",
        pages: [],
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "PARSE_PAGES_REQUIRED", retryable: false },
    });
  });

  it("rejects a page missing both imageRef and imageBase64", async () => {
    const { service } = makeService(makeModel());
    await expect(
      service.parse({
        taskId: "task-fixture",
        modelCode: "m",
        task: "ocr",
        pages: [{ pageIndex: 0 }],
        workspaceId: "ws-1",
      }, AUTH),
    ).rejects.toMatchObject({
      response: { code: "PARSE_PAGES_INVALID", retryable: false },
    });
  });

  it("maps a not-implemented provider to a 501 MODEL_NOT_IMPLEMENTED error", async () => {
    const model = makeModel();
    const { service } = makeService(model);

    try {
      await service.parse({
        taskId: "task-fixture",
        modelCode: model.modelCode,
        task: "ocr",
        pages: PAGES,
        workspaceId: "ws-1",
      }, AUTH);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_NOT_IMPLEMENTED" });
      expect((error as { getStatus(): number }).getStatus()).toBe(501);
    }
  });

  it("returns the provider's parse result with modelCode attached", async () => {
    const model = makeModel();
    const parseDocument = vi
      .fn()
      .mockResolvedValue({ task: "ocr", spans: [{ bbox: [0, 0, 1, 1], text: "hi" }] });
    const { service } = makeService(model, { parseDocument });

    const result = await service.parse({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      task: "ocr",
      pages: PAGES,
      workspaceId: "ws-1",
    }, AUTH);

    expect(result).toEqual({
      task: "ocr",
      spans: [{ bbox: [0, 0, 1, 1], text: "hi" }],
      modelCode: model.modelCode,
    });
  });

  it("consumes atlas.parse for the page count - the deterministic cost driver", async () => {
    const model = makeModel();
    const parseDocument = vi
      .fn()
      .mockResolvedValue({ task: "ocr", spans: [] });
    const { service, entitlements } = makeService(model, { parseDocument });

    await service.parse({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      task: "ocr",
      pages: [
        { pageIndex: 0, imageRef: "ref-1" },
        { pageIndex: 1, imageRef: "ref-2" },
        { pageIndex: 2, imageRef: "ref-3" },
      ],
      workspaceId: "ws-1",
    }, AUTH);

    expect(entitlements.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: AUTH.workspaceId,
        metric: "atlas.parse",
        amount: 3,
      }),
    );
  });

  it("records upstream usage in reqlog but strips it from the public response", async () => {
    const model = makeModel();
    const parseDocument = vi.fn().mockResolvedValue({
      task: "ocr",
      spans: [{ bbox: [0, 0, 1, 1], text: "hi" }],
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    const { service, requestLog } = makeService(model, { parseDocument });

    const result = await service.parse({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      task: "ocr",
      pages: PAGES,
      workspaceId: "ws-1",
    }, AUTH);

    expect(result).not.toHaveProperty("usage");
    expect(result).toEqual({
      task: "ocr",
      spans: [{ bbox: [0, 0, 1, 1], text: "hi" }],
      modelCode: model.modelCode,
    });
    expect(requestLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      }),
    );
  });

  it("leaves the reqlog token columns unset when the provider reports no usage", async () => {
    const model = makeModel();
    const parseDocument = vi
      .fn()
      .mockResolvedValue({ task: "ocr", spans: [] });
    const { service, requestLog } = makeService(model, { parseDocument });

    await service.parse({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      task: "ocr",
      pages: PAGES,
      workspaceId: "ws-1",
    }, AUTH);

    const row = requestLog.record.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.status).toBe("success");
    expect(row).not.toHaveProperty("inputTokens");
    expect(row).not.toHaveProperty("outputTokens");
    expect(row).not.toHaveProperty("totalTokens");
  });

  it("the token workspace_id claim wins over the body workspaceId", async () => {
    const model = makeModel();
    const parseDocument = vi
      .fn()
      .mockResolvedValue({ task: "ocr", spans: [] });
    const { service, entitlements } = makeService(model, { parseDocument });

    await service.parse({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      task: "ocr",
      pages: PAGES,
      workspaceId: "ws-body",
    }, AUTH);

    expect(entitlements.consume).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: AUTH.workspaceId }),
    );
  });

  it("falls back to the body workspaceId when the token carries no claim", async () => {
    const model = makeModel();
    const parseDocument = vi
      .fn()
      .mockResolvedValue({ task: "ocr", spans: [] });
    const { service, entitlements } = makeService(model, { parseDocument });

    const authWithoutWorkspace = {
      callerProductCode: "karda",
      mode: "service" as const,
      scope: "tool:atlas",
      tenantId: "tenant-1",
    };

    await service.parse({
        taskId: "task-fixture",
      modelCode: model.modelCode,
      task: "ocr",
      pages: PAGES,
      workspaceId: "ws-body",
    }, authWithoutWorkspace);

    expect(entitlements.consume).toHaveBeenCalledWith(
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
describe("/v1/parse matches its published request rules", () => {
  const RULES = V1_REQUEST_CONTRACT["/v1/parse"] ?? [];

  const complete = (): Record<string, unknown> => ({
    taskId: "task-fixture",
    workspaceId: "ws-1",
    modelCode: "m",
    task: "ocr",
    pages: PAGES,
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

    await expect(service.parse(body as never, AUTH)).rejects.toMatchObject({
      response: { code },
    });
  });
});
