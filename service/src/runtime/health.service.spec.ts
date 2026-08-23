/**
 * health.service.spec.ts - 模型平台健康检查测试
 * @package @atlas/service
 * @layer Domain
 * @category test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AtlasHealthService } from "./health.service";
import type { ModelRegistryRepository } from "../registry/model-registry.repository";
import type {
  AiModelRecord,
  TenantUsageSummaryRecord,
} from "../types/runtime.types";

function makeRepository(
  overrides: Partial<ModelRegistryRepository> = {},
): ModelRegistryRepository {
  return {
    checkDatabaseConnectivity: vi.fn(async () => undefined),
    listActiveModels: vi.fn(async () => [
      makeModel({ config: { managedKeyAlias: "test-key" } }),
    ]),
    listUsageSummaries: vi.fn(async () => [makeUsageSummary()]),
    readReqlogPartitionRunway: vi.fn(async () => [
      { monthsAhead: 12, defaultPartitionRows: 0 },
    ]),
    readRegistryDrift: vi.fn(async () => [
      {
        activeModelsUnderInactiveProvider: 0n,
        activeEndpointsWithUnusableModel: 0n,
      },
    ]),
    ...overrides,
  } as unknown as ModelRegistryRepository;
}

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  const now = new Date("2026-06-06T00:00:00.000Z");
  return {
    id: "model-1",
    providerId: null,
    modelCode: "doubao-lite",
    modelName: "Doubao Lite",
    provider: "doubao",
    endpointUrl: "https://example.test/v1/chat/completions",
    protocol: "openai-compatible",
    modelType: "chat",
    description: null,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    capabilities: ["text"],
    supportsStreaming: true,
    isActive: true,
    sort: 0,
    config: null,
    providerConfig: null,
    providerActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    deprecatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * Vault stub. `list()` is all readiness needs - it checks that an alias has an
 * active row, never that it decrypts. Default: every alias the fixtures name
 * exists and is active, so a test that cares about a dangling alias has to say
 * so explicitly.
 */
function makeVault(
  rows: Array<{ keyAlias: string; isActive?: boolean }> = [
    { keyAlias: "test-key" },
  ],
) {
  return {
    list: vi.fn().mockResolvedValue(
      rows.map((r) => ({
        keyAlias: r.keyAlias,
        isActive: r.isActive ?? true,
      })),
    ),
  } as never;
}

describe("registry drift check", () => {
  function build(drift: { models: number; endpoints: number }) {
    return {
      readRegistryDrift: async () => [
        {
          activeModelsUnderInactiveProvider: BigInt(drift.models),
          activeEndpointsWithUnusableModel: BigInt(drift.endpoints),
        },
      ],
    };
  }

  it("warns on drift but never drags readiness down", async () => {
    // Atlas is healthy while an operator has a provider switched off and its
    // models still serving. That is a thing to see, not a reason to fall out
    // of the load balancer.
    const drifted = await new AtlasHealthService(
      makeRepository(build({ models: 19, endpoints: 3 })),
      makeVault(),
    ).ready();
    const clean = await new AtlasHealthService(
      makeRepository(build({ models: 0, endpoints: 0 })),
      makeVault(),
    ).ready();

    expect(drifted.checks.registryDrift).toMatchObject({
      status: "warn",
      activeModelsUnderInactiveProvider: 19,
      activeEndpointsWithUnusableModel: 3,
    });
    // The claim is that drift does not MOVE readiness, whatever the other
    // checks make it - asserting an absolute status here would pass or fail
    // for reasons that have nothing to do with drift.
    expect(drifted.status).toBe(clean.status);
  });

  it("passes when the registry is consistent", async () => {
    const svc = new AtlasHealthService(
      makeRepository(build({ models: 0, endpoints: 0 })),
      makeVault(),
    );
    expect((await svc.ready()).checks.registryDrift.status).toBe("pass");
  });
});

function makeUsageSummary(): TenantUsageSummaryRecord {
  return {
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    productCode: "karda",
    applicationId: "00000000-0000-0000-0000-000000000000",
    applicationType: "internal_service",
    cycleMonth: "2026-06",
    requests: 1n,
    inputTokens: 40n,
    outputTokens: 60n,
    totalTokens: 100n,
    errors: 0n,
  };
}

describe("AtlasHealthService", () => {
  afterEach(() => {
    delete process.env["ATLAS_TEST_KEY"];
  });

  it("returns liveness without dependency checks", () => {
    const service = new AtlasHealthService(makeRepository(), makeVault());

    expect(service.live()).toMatchObject({
      status: "ok",
      service: "atlas",
    });
  });

  it("returns ready when all dependency checks pass", async () => {
    process.env["ATLAS_TEST_KEY"] = "configured";
    const service = new AtlasHealthService(makeRepository(), makeVault());

    const result = await service.ready();

    expect(result.status).toBe("ready");
    expect(result.checks.database.status).toBe("pass");
    expect(result.checks.modelRegistry).toMatchObject({
      status: "pass",
      activeModels: 1,
    });
    expect(result.checks.providerKeys).toMatchObject({
      status: "pass",
      checkedAliases: 1,
      dangling: [],
      keylessModels: [],
    });
  });

  it("names a model whose vault alias has no active key behind it", async () => {
    // A dangling alias refuses that model's own calls with
    // PROVIDER_UNAVAILABLE. Worth naming here so an operator finds it once,
    // rather than one 503 at a time.
    const service = new AtlasHealthService(
      makeRepository({
        listActiveModels: vi.fn(async () => [
          makeModel({ config: { managedKeyAlias: "revoked-alias" } }),
        ]) as unknown as ModelRegistryRepository["listActiveModels"],
      }),
      makeVault([{ keyAlias: "some-other-key" }]),
    );

    const result = await service.ready();

    expect(result.checks.providerKeys).toMatchObject({
      status: "pass",
      dangling: ["revoked-alias"],
    });
    expect(String(result.checks.providerKeys["message"])).toContain(
      "no active vault key",
    );
  });

  it("does not drag readiness down for one misconfigured model", async () => {
    // Four healthy models plus one dangling alias must not take the service
    // out of the load balancer. Same reasoning as registryDrift.
    const service = new AtlasHealthService(
      makeRepository({
        listActiveModels: vi.fn(async () => [
          makeModel({ config: { managedKeyAlias: "gone" } }),
        ]) as unknown as ModelRegistryRepository["listActiveModels"],
      }),
      makeVault([]),
    );

    const result = await service.ready();

    expect(result.checks.providerKeys.status).toBe("pass");
  });

  it("names a model with no key source at all", async () => {
    // Since the vault became the only source, such a model refuses EVERY call.
    // That is a configuration hole, and it used to be invisible: the model
    // resolved to "" and called upstream, so the 401 came back looking like an
    // upstream outage.
    const service = new AtlasHealthService(
      makeRepository({
        listActiveModels: vi.fn(async () => [
          makeModel({ config: null }),
        ]) as unknown as ModelRegistryRepository["listActiveModels"],
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.checks.providerKeys).toMatchObject({
      keylessModels: ["doubao-lite"],
    });
    expect(String(result.checks.providerKeys["message"])).toContain(
      "refuse every call",
    );
  });

  it("reports clean counts when every model has an active vault key", async () => {
    // The target state. An empty `dangling` has to be distinguishable from the
    // field being absent, or "everything is fine" and "the check stopped
    // looking" read identically.
    const service = new AtlasHealthService(
      makeRepository({
        listActiveModels: vi.fn(async () => [
          makeModel({ config: { managedKeyAlias: "primary" } }),
        ]) as unknown as ModelRegistryRepository["listActiveModels"],
      }),
      makeVault([{ keyAlias: "primary" }]),
    );

    const result = await service.ready();

    expect(result.checks.providerKeys).toMatchObject({
      status: "pass",
      checkedAliases: 1,
      dangling: [],
      keylessModels: [],
    });
  });

  it("returns blocked when database connectivity fails", async () => {
    const service = new AtlasHealthService(
      makeRepository({
        checkDatabaseConnectivity: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.status).toBe("blocked");
    expect(result.checks.database.status).toBe("fail");
  });

  it("returns blocked when model registry is empty", async () => {
    const service = new AtlasHealthService(
      makeRepository({
        listActiveModels: vi.fn(async () => []),
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.status).toBe("blocked");
    expect(result.checks.modelRegistry).toMatchObject({
      status: "fail",
      activeModels: 0,
    });
  });
});

/**
 * Readiness must answer under a deadline, and a timed-out check must be a
 * FAILING check rather than an unknown one.
 *
 * Measured 2026-08-23 by stopping the dev postgres container: `/readyz` took
 * **19.8s and 23.0s** while each check sat on a connection it would never get.
 * The console probes readiness with a 4s timeout, so it recorded
 * "unreachable / probe timed out" every time and the `blocked` body this
 * service computes was **never once observed in practice** - a different
 * diagnosis, and one that throws away which dependency actually failed.
 */
describe("AtlasHealthService readiness deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env["ATLAS_TEST_KEY"];
  });

  it("a check that never settles becomes a failing check, and the roll-up says blocked", async () => {
    process.env["ATLAS_TEST_KEY"] = "configured";
    const service = new AtlasHealthService(
      makeRepository({
        /* Never resolves - a dependency that has gone quiet rather than
           refused, which is what a stopped database looks like from here. */
        checkDatabaseConnectivity: vi.fn(() => new Promise<void>(() => {})),
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.checks.database.status).toBe("fail");
    expect(String(result.checks.database.message)).toContain("did not answer");
    /* The point of the deadline: still `blocked`, still naming the dependency.
       A prober that gave up first would have had neither. */
    expect(result.status).toBe("blocked");
  });

  it("answers well inside a prober's timeout even when a dependency is gone", async () => {
    process.env["ATLAS_TEST_KEY"] = "configured";
    const service = new AtlasHealthService(
      makeRepository({
        checkDatabaseConnectivity: vi.fn(() => new Promise<void>(() => {})),
        listActiveModels: vi.fn(() => new Promise<AiModelRecord[]>(() => {})),
      }),
      makeVault(),
    );

    const startedAt = Date.now();
    await service.ready();
    const elapsed = Date.now() - startedAt;

    /* The console's probe timeout is 4s. This asserts the endpoint stays well
       under it - the whole reason the deadline exists. */
    expect(elapsed).toBeLessThan(3_000);
  });

  it("a check that throws is reported, not propagated - /readyz 500 tells a prober nothing", async () => {
    process.env["ATLAS_TEST_KEY"] = "configured";
    const service = new AtlasHealthService(
      makeRepository({
        checkDatabaseConnectivity: vi.fn(() => {
          throw new Error("pool destroyed");
        }),
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.checks.database.status).toBe("fail");
    expect(result.status).toBe("blocked");
  });
});

describe("AtlasHealthService reqlog partition runway (TD-018)", () => {
  it("degrades readiness when the partition runway is nearly exhausted", async () => {
    process.env["ATLAS_TEST_KEY"] = "x";
    const service = new AtlasHealthService(
      makeRepository({
        readReqlogPartitionRunway: vi.fn(async () => [
          { monthsAhead: 1, defaultPartitionRows: 0 },
        ]),
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.checks.reqlogPartitions.status).toBe("warn");
    expect(result.status).toBe("degraded");
    delete process.env["ATLAS_TEST_KEY"];
  });

  it("blocks readiness once rows have landed in the DEFAULT partition", async () => {
    // The dangerous state: writes keep succeeding, nothing errors, and
    // drop-based retention silently stops being possible.
    process.env["ATLAS_TEST_KEY"] = "x";
    const service = new AtlasHealthService(
      makeRepository({
        readReqlogPartitionRunway: vi.fn(async () => [
          { monthsAhead: 0, defaultPartitionRows: 4210 },
        ]),
      }),
      makeVault(),
    );

    const result = await service.ready();

    expect(result.checks.reqlogPartitions.status).toBe("fail");
    expect(result.checks.reqlogPartitions["defaultPartitionRows"]).toBe(4210);
    expect(result.status).toBe("blocked");
    delete process.env["ATLAS_TEST_KEY"];
  });

  it("passes with healthy runway", async () => {
    process.env["ATLAS_TEST_KEY"] = "x";
    const service = new AtlasHealthService(makeRepository(), makeVault());

    const result = await service.ready();

    expect(result.checks.reqlogPartitions.status).toBe("pass");
    expect(result.checks.reqlogPartitions["monthsAhead"]).toBe(12);
    delete process.env["ATLAS_TEST_KEY"];
  });
});

describe("AtlasHealthService public vs diagnostic detail", () => {
  // A real Prisma/pg connection error, verbatim in shape: it names the
  // internal host, port, user and database.
  const DRIVER_ERROR =
    "Can't reach database server at `vx-atlas-postgres-db-prod:5432` " +
    "(user `atlas_svc`, database `vx_atlas_db`)";

  beforeEach(() => {
    delete process.env["ATLAS_TEST_KEY"];
  });

  function brokenDatabase() {
    return new AtlasHealthService(
      makeRepository({
        checkDatabaseConnectivity: vi.fn(async () => {
          throw new Error(DRIVER_ERROR);
        }),
      }),
      makeVault(),
    );
  }

  it("keeps the driver's words off the unguarded /readyz surface", async () => {
    const result = await brokenDatabase().ready();

    expect(JSON.stringify(result)).not.toContain("vx-atlas-postgres-db-prod");
    expect(JSON.stringify(result)).not.toContain("atlas_svc");
    expect(result.checks.database).toMatchObject({
      status: "fail",
      message: "dependency check failed",
    });
  });

  it("gives the guarded diagnostics surface the cause", async () => {
    const result = await brokenDatabase().diagnostics();

    expect(result.checks.database).toMatchObject({
      status: "fail",
      message: DRIVER_ERROR,
    });
  });

  it("rolls readiness up identically on both surfaces", async () => {
    // The redaction is about words, not verdicts: a caller of /readyz must
    // still see the same blocked/degraded/ready as an operator does.
    const service = brokenDatabase();

    const [publicView, diagnosticView] = await Promise.all([
      service.ready(),
      service.diagnostics(),
    ]);

    expect(publicView.status).toBe("blocked");
    expect(diagnosticView.status).toBe(publicView.status);
  });

  it("keeps Atlas's own static messages and counters on both surfaces", async () => {
    // Only the caught exception text is withheld. Static wording Atlas
    // authored, and every structured counter, describe Atlas's own
    // configuration - redacting those would cost the signal and protect
    // nothing.
    const service = new AtlasHealthService(makeRepository(), makeVault());

    const result = await service.ready();

    expect(result.checks.providerKeys).toMatchObject({
      status: "pass",
      checkedAliases: 1,
      dangling: [],
    });
    expect(result.checks.modelRegistry).toMatchObject({
      status: "pass",
      activeModels: 1,
    });
    expect(result.checks.reqlogPartitions).toMatchObject({
      monthsAhead: 12,
      defaultPartitionRows: 0,
    });
    expect(result.checks.usageSummaryRead).toMatchObject({ summaries: 1 });
    expect(result.checks.registryDrift).toMatchObject({
      activeModelsUnderInactiveProvider: 0,
      activeEndpointsWithUnusableModel: 0,
    });
  });
});
