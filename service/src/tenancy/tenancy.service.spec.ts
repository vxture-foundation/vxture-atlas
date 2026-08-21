import { describe, expect, it, vi } from "vitest";

import { TenancyService } from "./tenancy.service";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import type { S2sAuthContext } from "../runtime/guards/s2s-auth.guard";

const ORG = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function makeAuth(over: Partial<S2sAuthContext> = {}): S2sAuthContext {
  return {
    callerProductCode: "console",
    mode: "service",
    scope: "tool:atlas",
    tenantId: ORG,
    workspaceId: WS,
    ...over,
  };
}

function makeService(
  over: {
    aggregate?: ReturnType<typeof vi.fn>;
    listGrants?: ReturnType<typeof vi.fn>;
    resolve?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const aggregate = over.aggregate ?? vi.fn(async () => []);
  const listGrants = over.listGrants ?? vi.fn(async () => []);
  const listModelsForTenant = vi.fn(async () => []);
  const resolve =
    over.resolve ?? vi.fn(async () => ({ kind: "not-configured" }));
  const service = new TenancyService(
    { listModelsForTenant } as never,
    { aggregateReqlogUsage: aggregate, listGrants } as never,
    { resolve } as never,
  );
  return { service, aggregate, listModelsForTenant, listGrants, resolve };
}

describe("TenancyService scope resolution", () => {
  // This test used to assert `tenantId: WS` - a workspace uuid in the tenant
  // column - and passed, because the mock does not care which uuid it is given.
  // Production does: `model_grants.tenant_id` holds a TENANT, so that query
  // matched nothing and every caller was told `[]`. TD-022 in reverse, one
  // directory over from where the rule is written down.
  it("keys the model list on the TENANT, because model_grants.tenant_id is a tenant", async () => {
    const { service, listModelsForTenant } = makeService();

    await service.listModels(makeAuth());

    expect(listModelsForTenant).toHaveBeenCalledWith({ tenantId: ORG });
  });

  it("refuses rather than returning an empty list when the token carries no tenant", async () => {
    // The honest answer names the missing claim. `[]` said "this tenant holds
    // nothing", which is a different statement and a false one.
    const { service } = makeService();

    await expect(
      service.listModels({
        callerProductCode: "console",
        mode: "service",
        scope: "tool:atlas",
        workspaceId: WS,
      }),
    ).rejects.toMatchObject({ code: "TENANCY_SCOPE_UNAVAILABLE" });
  });

  it("scopes a tenant-level usage read to the token's org_id", async () => {
    const { service, aggregate } = makeService();

    const result = await service.usage(makeAuth(), { scope: "tenant" });

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ scopeColumn: "tenant_id", scopeId: ORG }),
    );
    expect(result.scope).toBe("tenant");
    expect(result.scopeId).toBe(ORG);
  });

  it("defaults to the workspace level", async () => {
    const { service, aggregate } = makeService();

    const result = await service.usage(makeAuth(), {});

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ scopeColumn: "workspace_id", scopeId: WS }),
    );
    expect(result.scope).toBe("workspace");
  });

  it("refuses a tenant read when the token carries no org_id", async () => {
    // The whole point of the namespace: a caller cannot reach a scope its
    // token does not carry. There is no request field to fall back to.
    const { service } = makeService();
    const auth = makeAuth();
    delete (auth as { tenantId?: string }).tenantId;

    await expect(service.usage(auth, { scope: "tenant" })).rejects.toThrow(
      ModelRuntimeException,
    );
  });

  it("fails closed on a non-UUID claim rather than querying with it", async () => {
    const { service, aggregate } = makeService();

    await expect(
      service.usage(makeAuth({ workspaceId: "org-acme/ws-main" }), {}),
    ).rejects.toThrow(ModelRuntimeException);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range window", async () => {
    const { service } = makeService();

    await expect(service.usage(makeAuth(), { days: "0" })).rejects.toThrow();
    await expect(service.usage(makeAuth(), { days: "400" })).rejects.toThrow();
    await expect(service.usage(makeAuth(), { days: "x" })).rejects.toThrow();
  });
});

describe("TenancyService.usage aggregation", () => {
  it("normalizes bigint counters and labels the source as Atlas's own log", async () => {
    const aggregate = vi.fn(async () => [
      {
        modelCode: "glm-5.2",
        providerCode: "zhipu",
        requests: 3n,
        inputTokens: 100n,
        outputTokens: 50n,
        totalTokens: 150n,
        errors: 1n,
      },
    ]);
    const { service } = makeService({ aggregate });

    const result = await service.usage(makeAuth(), {});

    expect(result.rows).toEqual([
      {
        modelCode: "glm-5.2",
        providerCode: "zhipu",
        requests: 3,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        errors: 1,
      },
    ]);
    // Must never be mistaken for a billing figure - that is the platform's
    // usage_events, not this.
    expect(result.source).toBe("atlas.reqlog");
  });
});

describe("TenancyService.listGrants", () => {
  it("keys the grant list on the TENANT and omits operator-only fields", async () => {
    const listGrants = vi.fn(async () => [
      {
        id: "g1",
        modelId: "m1",
        applicationId: null,
        applicationType: null,
        agentId: null,
        taskProfile: "fast",
        priority: 10,
        expiresAt: null,
        isActive: true,
        reason: "internal operator note",
      },
    ]);
    const { service } = makeService({ listGrants });

    const rows = await service.listGrants(makeAuth());

    // ORG, not WS. The mock accepts either; `model_grants.tenant_id` does not.
    expect(listGrants).toHaveBeenCalledWith({ tenantId: ORG });
    // `reason` is an operator's justification - not tenant-facing.
    expect(rows[0]).not.toHaveProperty("reason");
    expect(rows[0]).toMatchObject({ id: "g1", taskProfile: "fast" });
  });
});

describe("TenancyService.quotas", () => {
  it("reports covered with the platform's pools", async () => {
    const resolve = vi.fn(async () => ({
      kind: "resolved",
      view: {
        tier: "pro",
        bundled: false,
        limits: { "atlas.chat": 1000 },
        quota_pools: [
          { metric: "atlas.chat", limit: 1000, remaining: 400, priority: 1 },
        ],
      },
    }));
    const { service } = makeService({ resolve });

    const result = await service.quotas(makeAuth());

    expect(result.status).toBe("covered");
    expect(result.tier).toBe("pro");
    expect(result.pools).toHaveLength(1);
  });

  it("distinguishes uncovered from unavailable", async () => {
    // The stub this replaces returned [] for both, making "no plan published"
    // indistinguishable from "platform unreachable".
    const uncovered = makeService({
      resolve: vi.fn(async () => ({
        kind: "resolved",
        view: { tier: null, bundled: false, limits: {}, quota_pools: [] },
      })),
    });
    const unavailable = makeService({
      resolve: vi.fn(async () => ({ kind: "unreachable", reason: "ETIMEDOUT" })),
    });

    expect((await uncovered.service.quotas(makeAuth())).status).toBe("uncovered");
    expect((await unavailable.service.quotas(makeAuth())).status).toBe("unavailable");
  });
});
