import { describe, it, expect, vi } from "vitest";

import { ModelRegistryService } from "./model-registry.service";
import { ModelRuntimeException } from "../runtime/runtime.errors";
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
    modelType: "chat",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    supportsStreaming: true,
    isActive: true,
    sort: 0,
    config: null,
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

describe("ModelRegistryService.resolveModelCodeForTaskProfile", () => {
  it("returns the modelCode the repository resolves", async () => {
    const repository = {
      findModelCodeForTaskProfile: vi.fn().mockResolvedValue("chosen-model"),
    };
    const service = new ModelRegistryService(repository as never);

    const modelCode = await service.resolveModelCodeForTaskProfile({
      tenantId: "tenant-1",
      taskProfile: "summarization",
      applicationId: "app-1",
      applicationType: "agent",
    });

    expect(modelCode).toBe("chosen-model");
    expect(repository.findModelCodeForTaskProfile).toHaveBeenCalledWith(
      "summarization",
      "tenant-1",
      "app-1",
      "agent",
    );
  });

  it("throws TASK_PROFILE_NOT_ROUTABLE (404) when no grant matches", async () => {
    const repository = {
      findModelCodeForTaskProfile: vi.fn().mockResolvedValue(null),
    };
    const service = new ModelRegistryService(repository as never);

    await expect(
      service.resolveModelCodeForTaskProfile({
        tenantId: "tenant-1",
        taskProfile: "summarization",
        applicationId: "app-1",
        applicationType: "agent",
      }),
    ).rejects.toMatchObject({ code: "TASK_PROFILE_NOT_ROUTABLE" });

    try {
      await service.resolveModelCodeForTaskProfile({
        tenantId: "tenant-1",
        taskProfile: "summarization",
        applicationId: "app-1",
        applicationType: "agent",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRuntimeException);
      expect((error as ModelRuntimeException).getStatus()).toBe(404);
    }
  });
});

describe("ModelRegistryService.listModelsForTenant", () => {
  it("delegates to the repository's grant-filtered listing", async () => {
    const model = makeModel();
    const repository = {
      listGrantedModels: vi.fn().mockResolvedValue([model]),
    };
    const service = new ModelRegistryService(repository as never);

    const models = await service.listModelsForTenant({
      tenantId: "tenant-1",
      applicationId: "app-1",
      applicationType: "agent",
    });

    expect(models).toEqual([model]);
    expect(repository.listGrantedModels).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      applicationId: "app-1",
      applicationType: "agent",
    });
  });
});

describe("ModelRegistryService.resolveEndpoint", () => {
  function makeEndpoint(overrides = {}) {
    return {
      id: "ep-1",
      code: "chat/default",
      category: "chat",
      primaryModelCode: "primary-model",
      fallbackModelCode: null,
      isActive: true,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      deletedAt: null,
      ...overrides,
    };
  }

  it("resolves an endpoint code to its primary model", async () => {
    const repository = {
      findActiveEndpointByCode: vi.fn().mockResolvedValue(makeEndpoint()),
    };
    const service = new ModelRegistryService(repository as never);

    await expect(service.resolveEndpoint("chat/default")).resolves.toEqual({
      modelCode: "primary-model",
      fallbackModelCodes: [],
    });
    expect(repository.findActiveEndpointByCode).toHaveBeenCalledWith("chat/default");
  });

  it("carries the endpoint's own fallback, so the route owns the chain", async () => {
    // The point of this: a request routed through an endpoint must fail over
    // exactly where the endpoint says, NOT where the resolved model's
    // config.fallbackModelCodes says. Two authorities for one question is
    // what made model_endpoints inert in the first place.
    const repository = {
      findActiveEndpointByCode: vi
        .fn()
        .mockResolvedValue(makeEndpoint({ fallbackModelCode: "backup-model" })),
    };
    const service = new ModelRegistryService(repository as never);

    await expect(service.resolveEndpoint("chat/default")).resolves.toEqual({
      modelCode: "primary-model",
      fallbackModelCodes: ["backup-model"],
    });
  });

  it("rejects an unknown or deactivated endpoint with ENDPOINT_NOT_ROUTABLE", async () => {
    // findActiveEndpointByCode filters isActive/deletedAt, so "deactivated"
    // and "never existed" arrive here identically - deactivating an endpoint
    // has to actually stop serving.
    const repository = {
      findActiveEndpointByCode: vi.fn().mockResolvedValue(null),
    };
    const service = new ModelRegistryService(repository as never);

    await expect(service.resolveEndpoint("chat/gone")).rejects.toMatchObject({
      response: { code: "ENDPOINT_NOT_ROUTABLE" },
    });
  });
});

// ── consumer endpoint catalog (product_251 X-4 / vxture-atlas#198) ────────────

describe("ModelRegistryService.listGrantedEndpoints", () => {
  function endpointRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ep-1",
      code: "chat/default",
      category: "chat",
      primaryModelCode: "m",
      fallbackModelCode: null,
      isActive: true,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      deletedAt: null,
      ...overrides,
    };
  }

  function makeService(
    grants: Array<{ endpointCode: string }>,
    endpoints: Array<Record<string, unknown>>,
    usableModels: Array<Record<string, unknown>> = [],
  ) {
    const repository = {
      listProductEndpointGrants: vi.fn().mockResolvedValue(grants),
      findEndpointsByCodes: vi.fn().mockResolvedValue(endpoints),
      findActiveModelsByCodes: vi.fn().mockResolvedValue(usableModels),
    };
    return { service: new ModelRegistryService(repository as never), repository };
  }

  const SCOPE = {
    productCode: "vxtpl",
    applicationId: "00000000-0000-0000-0000-000000000000",
    applicationType: "internal_service" as const,
  };

  it("asks the SAME predicate the call path authorizes with", async () => {
    // The catalog's only value is agreeing with what a call would do. Built on
    // a query of its own it would drift, and a catalog that disagrees with the
    // call path is worse than none, because it is believed.
    const { service, repository } = makeService(
      [{ endpointCode: "chat/default" }],
      [endpointRow()],
    );

    await service.listGrantedEndpoints(SCOPE);

    expect(repository.listProductEndpointGrants).toHaveBeenCalledWith(
      "vxtpl",
      SCOPE.applicationId,
      "internal_service",
    );
  });

  it("reports a granted, live endpoint as active", async () => {
    const { service } = makeService(
      [{ endpointCode: "chat/default" }],
      [endpointRow()],
    );

    expect(await service.listGrantedEndpoints(SCOPE)).toEqual([
      { endpointCode: "chat/default", category: "chat", state: "active", contextWindow: null, maxOutputTokens: null },
    ]);
  });

  it.each([
    ["deactivated by an operator", { isActive: false }],
    ["removed from the catalog", { deletedAt: new Date("2026-08-01T00:00:00Z") }],
  ])(
    "reports a granted endpoint %s as inactive rather than omitting it",
    async (_label, patch) => {
      // Omitting it would read as "you were never granted this". The caller
      // then cannot tell its own mistake from an operator's, and only one of
      // those is theirs to fix.
      const { service } = makeService(
        [{ endpointCode: "chat/default" }],
        [endpointRow(patch)],
      );

      expect(await service.listGrantedEndpoints(SCOPE)).toEqual([
        { endpointCode: "chat/default", category: "chat", state: "inactive", contextWindow: null, maxOutputTokens: null },
      ]);
    },
  );

  it("reports a grant naming a nonexistent code as missing", async () => {
    // A dangling grant, usually an operator typo. At call time it is the same
    // 404 as a deactivated endpoint, but the cause - and the fix - differ.
    const { service } = makeService([{ endpointCode: "chat/typoo" }], []);

    expect(await service.listGrantedEndpoints(SCOPE)).toEqual([
      { endpointCode: "chat/typoo", category: null, state: "missing", contextWindow: null, maxOutputTokens: null },
    ]);
  });

  it("collapses duplicate grants for one code and returns a stable order", async () => {
    // A product-wide grant and an application-scoped one both match; the
    // catalog is about reach, so the code appears once.
    const { service } = makeService(
      [
        { endpointCode: "chat/pro" },
        { endpointCode: "chat/default" },
        { endpointCode: "chat/default" },
      ],
      [endpointRow(), endpointRow({ id: "ep-2", code: "chat/pro" })],
    );

    expect(
      (await service.listGrantedEndpoints(SCOPE)).map((e) => e.endpointCode),
    ).toEqual(["chat/default", "chat/pro"]);
  });

  it("returns an empty catalog rather than the global one when nothing is granted", async () => {
    const { service, repository } = makeService([], []);

    expect(await service.listGrantedEndpoints(SCOPE)).toEqual([]);
    // No grants means no codes to look up - and never a fallback to "show
    // everything", which is how /v1/models' unfiltered mode misleads.
    expect(repository.findEndpointsByCodes).toHaveBeenCalledWith([]);
  });

  // tenderforge letter 40 item 4: a caller budgets its input from these, so
  // the one thing they must never do is overstate.
  describe("route capacity", () => {
    const model = (modelCode: string, contextWindow: number | null, maxOutputTokens: number | null) => ({
      modelCode,
      contextWindow,
      maxOutputTokens,
    });
    const capacityOf = async (
      endpoint: Record<string, unknown>,
      usable: Array<Record<string, unknown>>,
    ) => {
      const { service } = makeService([{ endpointCode: "chat/default" }], [endpointRow(endpoint)], usable);
      const [row] = await service.listGrantedEndpoints(SCOPE);
      return { contextWindow: row?.contextWindow, maxOutputTokens: row?.maxOutputTokens };
    };

    it("is the primary's own capacity when there is no fallback", async () => {
      expect(await capacityOf({ primaryModelCode: "p" }, [model("p", 262144, 32768)])).toEqual({
        contextWindow: 262144,
        maxOutputTokens: 32768,
      });
    });

    it("is the SMALLEST across primary and fallback - a call may land on either", async () => {
      expect(
        await capacityOf({ primaryModelCode: "p", fallbackModelCode: "f" }, [
          model("p", 262144, 32768),
          model("f", 131072, 16384),
        ]),
      ).toEqual({ contextWindow: 131072, maxOutputTokens: 16384 });
    });

    it("is unknown when a model in the chain has no value - never the minimum of the known ones", async () => {
      expect(
        await capacityOf({ primaryModelCode: "p", fallbackModelCode: "f" }, [
          model("p", 262144, 32768),
          model("f", null, 16384),
        ]),
      ).toEqual({ contextWindow: null, maxOutputTokens: 16384 });
    });

    it("ignores an unusable fallback, as the call path skips it", async () => {
      expect(
        await capacityOf({ primaryModelCode: "p", fallbackModelCode: "gone" }, [model("p", 262144, 32768)]),
      ).toEqual({ contextWindow: 262144, maxOutputTokens: 32768 });
    });

    it("is unknown when the primary is unusable, even if the fallback has values - that route serves nothing", async () => {
      expect(
        await capacityOf({ primaryModelCode: "gone", fallbackModelCode: "f" }, [model("f", 131072, 16384)]),
      ).toEqual({ contextWindow: null, maxOutputTokens: null });
    });

    it("looks every chain member up in one query, through the call path's usability rule", async () => {
      const { service, repository } = makeService(
        [{ endpointCode: "chat/a" }, { endpointCode: "chat/b" }],
        [
          endpointRow({ code: "chat/a", primaryModelCode: "p", fallbackModelCode: "f" }),
          endpointRow({ id: "ep-2", code: "chat/b", primaryModelCode: "p" }),
        ],
      );

      await service.listGrantedEndpoints(SCOPE);

      expect(repository.findActiveModelsByCodes).toHaveBeenCalledTimes(1);
      expect(repository.findActiveModelsByCodes).toHaveBeenCalledWith(["p", "f"]);
    });
  });
});
