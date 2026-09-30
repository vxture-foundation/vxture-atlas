import { beforeEach, describe, expect, it, vi } from "vitest";

// Same pattern as usage-rollup-grouping.spec.ts: no database in CI, so tests
// assert either (a) behaviour that rejects before any Prisma call, or (b) the
// exact query arguments / SQL text handed to the client - the closure defers
// the mock-fn dereference until call time, which is what makes the hoisted
// vi.mock factory safe.
const grantFindMany = vi.fn();
const policyFindMany = vi.fn();
const modelFindMany = vi.fn();
const modelFindFirst = vi.fn();
const queryRawUnsafe = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    modelGrant: { findMany: (...args: unknown[]) => grantFindMany(...args) },
    modelPolicy: { findMany: (...args: unknown[]) => policyFindMany(...args) },
    modelDefinition: {
      findMany: (...args: unknown[]) => modelFindMany(...args),
      findFirst: (...args: unknown[]) => modelFindFirst(...args),
    },
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafe(...args),
  },
}));

const { ModelRegistryRepository } = await import("./model-registry.repository");

const repo = new ModelRegistryRepository();

/** Collapses whitespace so assertions do not depend on SQL formatting. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

const MODEL_ID = "00000000-0000-0000-0000-000000000001";
const TENANT_ID = "00000000-0000-0000-0000-000000000002";
const APPLICATION_ID = "00000000-0000-0000-0000-000000000003";

beforeEach(() => {
  grantFindMany.mockReset().mockResolvedValue([]);
  policyFindMany.mockReset().mockResolvedValue([]);
  modelFindMany.mockReset().mockResolvedValue([]);
  modelFindFirst.mockReset().mockResolvedValue(null);
  queryRawUnsafe.mockReset().mockResolvedValue([]);
});

// Bulk tenant quotas have no possible local backing (platform C2 exposes only
// a single-workspace read). The honest expression of that is NO repository
// method plus the caller's explicit 501 (ModelAdminService.listTenantQuotas),
// not a method that resolves an empty array as if it were an answer.

// A non-UUID tenantId/applicationId (e.g. a caller's own composite identifier
// instead of the platform's UUID) must reject as a clean 400 BEFORE any Prisma
// call - model_grants.tenant_id is a `uuid` column with no FK
// (deploy/database/ddl/00_baseline.sql) - so no real database is needed to
// exercise these.
describe("tenantId/applicationId UUID validation (vxture-atlas#47)", () => {
  const MALFORMED_TENANT_ID =
    "2a4271d4-aaaa-bbbb-cccc-dddddddddddd/13306e79-1111-2222-3333-444444444444";

  it("findBestGrant rejects a non-UUID tenantId with a clean 400", async () => {
    await expect(
      repo.findBestGrant(
        MODEL_ID,
        MALFORMED_TENANT_ID,
        "00000000-0000-0000-0000-000000000000",
        "internal_service",
      ),
    ).rejects.toMatchObject({ code: "INVALID_TENANT_ID" });
  });

  it("findBestGrant rejects a non-UUID applicationId with a clean 400", async () => {
    await expect(
      repo.findBestGrant(MODEL_ID, TENANT_ID, "not-a-uuid", "agent"),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ID" });
  });

  it("findModelCodeForTaskProfile rejects a non-UUID tenantId with a clean 400", async () => {
    await expect(
      repo.findModelCodeForTaskProfile(
        "karda.ask",
        MALFORMED_TENANT_ID,
        "00000000-0000-0000-0000-000000000000",
        "internal_service",
      ),
    ).rejects.toMatchObject({ code: "INVALID_TENANT_ID" });
  });

  it("listGrantedModels rejects a non-UUID tenantId with a clean 400", async () => {
    await expect(
      repo.listGrantedModels({ tenantId: MALFORMED_TENANT_ID }),
    ).rejects.toMatchObject({ code: "INVALID_TENANT_ID" });
  });

  it("listGrantedModels rejects a non-UUID applicationId with a clean 400", async () => {
    await expect(
      repo.listGrantedModels({
        tenantId: TENANT_ID,
        applicationId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ID" });
  });

  // The product axis had no guard: a non-UUID reached the uuid column and came
  // back as Postgres's cast error - a codeless 500, three times in production
  // on 2026-09-28 (found by the 2026-09-30 walkthrough).
  it("listProductEndpointGrants rejects a non-UUID applicationId with a clean 400", async () => {
    await expect(
      repo.listProductEndpointGrants("yucer", "not-a-uuid", "agent"),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ID" });
  });
});

// Postgres DESC defaults to NULLS FIRST, so a bare `applicationId: "desc"`
// ranked wildcard (NULL) rows ahead of application-scoped ones; with 2+
// wildcards the take-2 window never contained the exact match and scoped-grant
// precedence silently inverted. The ordering must pin NULLS LAST - asserted on
// the query arguments because the inversion only manifests against a live DB.
describe("scoped rows sort ahead of wildcards (NULLS LAST)", () => {
  it("findBestGrant orders applicationId desc with nulls last", async () => {
    await repo.findBestGrant(MODEL_ID, TENANT_ID, APPLICATION_ID, "agent");

    const args = grantFindMany.mock.calls[0]![0] as {
      orderBy: unknown[];
      take: number;
    };
    expect(args.orderBy[0]).toEqual({
      applicationId: { sort: "desc", nulls: "last" },
    });
    expect(args.take).toBe(2);
  });

  it("findModelCodeForTaskProfile orders applicationId desc with nulls last", async () => {
    await repo.findModelCodeForTaskProfile(
      "karda.ask",
      TENANT_ID,
      APPLICATION_ID,
      "agent",
    );

    const args = grantFindMany.mock.calls[0]![0] as { orderBy: unknown[] };
    expect(args.orderBy[0]).toEqual({
      applicationId: { sort: "desc", nulls: "last" },
    });
  });

  it("findApplicablePolicy sorts tenant-scoped rows into the take-2 window ahead of wildcards", async () => {
    await repo.findApplicablePolicy(MODEL_ID, TENANT_ID);

    const args = policyFindMany.mock.calls[0]![0] as {
      orderBy: unknown[];
      take: number;
    };
    // tenantId must lead the ordering: priority alone let 2+ higher-priority
    // wildcard policies fill the window and hide the tenant-specific row.
    expect(args.orderBy[0]).toEqual({
      tenantId: { sort: "desc", nulls: "last" },
    });
    expect(args.take).toBe(2);
  });
});

// `ai_models.sort` is settable via /capability/models; leaving it out of every
// ORDER BY made it a configured-but-inert knob.
describe("ai_models.sort orders the catalogue", () => {
  it("listActiveModels orders by sort asc, then recency", async () => {
    await repo.listActiveModels();

    const args = modelFindMany.mock.calls[0]![0] as { orderBy: unknown[] };
    expect(args.orderBy).toEqual([{ sort: "asc" }, { createdAt: "desc" }]);
  });

  it("listGrantedModels returns models sort-ascending regardless of grant order", async () => {
    grantFindMany.mockResolvedValue([
      { modelId: "model-late" },
      { modelId: "model-early" },
    ]);
    const rows: Record<string, unknown> = {
      "model-late": {
        id: "model-late",
        modelCode: "late",
        sort: 200,
        providerRef: null,
      },
      "model-early": {
        id: "model-early",
        modelCode: "early",
        sort: 100,
        providerRef: null,
      },
    };
    modelFindFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(rows[args.where.id] ?? null),
    );

    const models = await repo.listGrantedModels({ tenantId: TENANT_ID });

    expect(models.map((model) => model.modelCode)).toEqual(["early", "late"]);
  });
});

// Probe traffic is written with usage_type='test' against the all-zero
// sentinel; the operator aggregations must not count it as usage anyone ran.
// `IS DISTINCT FROM` (not `<>`) keeps NULL-usage_type rows - written before
// the column existed - in the totals.
describe("operator aggregations exclude probe traffic", () => {
  it("listUsageSummaries filters usage_type='test'", async () => {
    await repo.listUsageSummaries({});

    const sql = flat(queryRawUnsafe.mock.calls[0]![0] as string);
    expect(sql).toContain("usage_type IS DISTINCT FROM 'test'");
  });

  it("listUsageRollup filters usage_type='test'", async () => {
    await repo.listUsageRollup({ dimension: "provider" });

    const sql = flat(queryRawUnsafe.mock.calls[0]![0] as string);
    expect(sql).toContain("usage_type IS DISTINCT FROM 'test'");
  });

  it("summarizeRequestLogs filters usage_type='test' in both the overall and grouped query", async () => {
    await repo.summarizeRequestLogs({
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-02T00:00:00Z"),
    });

    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    for (const call of queryRawUnsafe.mock.calls) {
      expect(flat(call[0] as string)).toContain(
        "usage_type IS DISTINCT FROM 'test'",
      );
    }
  });
});

// A rate-limit lookup must never send a non-UUID to the `uuid` column. Unlike
// findBestGrant, findApplicablePolicy has no assertUuid - and it must not grow
// one, because the caller reaching it is legitimately authorized (their PRODUCT
// grant matched, which returns before QuotaService's tenant-axis guard). The
// failure this prevents was not a clean 400: the Prisma cast error is not a
// ModelRuntimeException, so enrichRuntimeError rewrote it to
// 503 PROVIDER_UNAVAILABLE, which carries retryable: true since the X-1 pass.
// Atlas was telling a caller with a malformed payload that the upstream was
// down and to keep retrying.
describe("findApplicablePolicy tenant scoping", () => {
  function scopesOf(call: unknown): unknown {
    const args = call as [{ where: { AND: Array<{ OR?: unknown }> } }];
    return args[0].where.AND[0]?.OR;
  }

  it("matches the tenant row and the wildcard for a real UUID", async () => {
    await repo.findApplicablePolicy(MODEL_ID, TENANT_ID);

    expect(scopesOf(policyFindMany.mock.calls[0])).toEqual([
      { tenantId: TENANT_ID },
      { tenantId: null },
    ]);
  });

  it("matches ONLY the wildcard for a non-UUID tenant, never passing it to the uuid column", async () => {
    await repo.findApplicablePolicy(MODEL_ID, "org-acme/ws-main");

    const scopes = scopesOf(policyFindMany.mock.calls[0]);
    expect(scopes).toEqual([{ tenantId: null }]);
    // The specific regression: the raw value must not appear anywhere in the
    // query that reaches Postgres.
    expect(JSON.stringify(policyFindMany.mock.calls[0])).not.toContain(
      "org-acme/ws-main",
    );
  });

  it("still applies a wildcard policy to a non-UUID tenant", async () => {
    // Skipping the lookup would have been the easy fix and a silent one: a
    // wildcard policy binds everyone, so skipping would let exactly these
    // callers slip the rate limit with nothing reporting it.
    const wildcard = { id: "p-1", tenantId: null, rateLimitRpm: 10 };
    policyFindMany.mockResolvedValue([wildcard]);

    await expect(
      repo.findApplicablePolicy(MODEL_ID, "org-acme/ws-main"),
    ).resolves.toBe(wildcard);
  });
});
