import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderHttpError } from "../providers/base.provider";
import { prisma } from "../prisma";
import { decodeCursor, encodeCursor, ServiceHealthService } from "./service-health.service";
import { mockRouteModelFacts } from "./route-facts.fixtures";
import { upstreamHealth } from "./upstream-health";

describe("ServiceHealthService.current - a route naming a model that cannot serve the route, design 120 section 4.4", () => {
  beforeEach(() => {
    upstreamHealth.resetForTests();
    vi.spyOn(prisma.modelEndpoint, "findMany").mockResolvedValue([
      { code: "rerank/default", category: "rerank", primaryModelCode: "rerank", fallbackModelCode: "glm-5.2" },
      { code: "rerank/quality", category: "rerank", primaryModelCode: "glm-5.2", fallbackModelCode: "rerank" },
    ] as never);
    mockRouteModelFacts({ rerank: { modelType: "rerank" } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    upstreamHealth.resetForTests();
  });

  it("does not count a chat model as a rerank fallback: primary down means the route is down", async () => {
    upstreamHealth.recordFailure("rerank", "zhipu", new ProviderHttpError("x", 402, "p", ""));
    upstreamHealth.recordSuccess("glm-5.2", "zhipu");

    const view = await new ServiceHealthService({ view: async () => [] } as never).current();
    const route = view.routes.find((r) => r.code === "rerank/default");

    expect(route).toMatchObject({ state: "down", severity: "critical" });
    expect(route?.configIssues).toEqual([
      expect.objectContaining({ role: "fallback", modelCode: "glm-5.2", code: "wrong_type" }),
    ]);
  });

  it("a chat model as the PRIMARY leaves the route served only by its fallback: degraded, whatever the chat model's health", async () => {
    upstreamHealth.recordSuccess("glm-5.2", "zhipu");
    upstreamHealth.recordSuccess("rerank", "zhipu");

    const view = await new ServiceHealthService({ view: async () => [] } as never).current();
    expect(view.routes.find((r) => r.code === "rerank/quality")).toMatchObject({ state: "degraded", severity: "warning" });
  });
});

describe("ServiceHealthService.current - what the platform's watcher reads", () => {
  beforeEach(() => {
    upstreamHealth.resetForTests();
    mockRouteModelFacts();
    vi.spyOn(prisma.modelEndpoint, "findMany").mockResolvedValue([
      { code: "chat/default", primaryModelCode: "deepseek-flash", fallbackModelCode: "doubao-turbo" },
      { code: "chat/fast", primaryModelCode: "doubao-lite", fallbackModelCode: "deepseek-flash" },
      { code: "rerank/default", primaryModelCode: "rerank", fallbackModelCode: null },
    ] as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    upstreamHealth.resetForTests();
  });

  it("lists every configured route, evaluated now, with severity", async () => {
    upstreamHealth.recordFailure("deepseek-flash", "deepseek", new ProviderHttpError("x", 402, "p", "Insufficient Balance"));
    upstreamHealth.recordFailure("doubao-lite", "doubao", new ProviderHttpError("x", 402, "p", ""));
    upstreamHealth.recordSuccess("doubao-turbo", "doubao");

    const view = await new ServiceHealthService({ view: async () => [] } as never).current();

    expect(view.routes.map((r) => [r.code, r.state, r.severity])).toEqual([
      ["chat/default", "degraded", "warning"],
      ["chat/fast", "down", "critical"],
      ["rerank/default", "ok", null], // never seen: not counted as failing
    ]);
    expect(view.routes[2]?.primary).toEqual({ modelCode: "rerank", state: "unknown" });
    // F3b-A: Atlas's own components are always listed, unknown until a signal arrives.
    expect(view.atlas.map((c) => c.component)).toEqual(["usage_reporting", "request_log", "partitions"]);
    expect(view.models.find((m) => m.modelCode === "deepseek-flash")).toMatchObject({
      state: "account_refused",
      upstreamStatus: 402,
      detail: "Insufficient Balance",
    });
  });
});

describe("ServiceHealthService.events - transitions by cursor", () => {
  afterEach(() => vi.restoreAllMocks());

  const first = "10000000-0000-4000-8000-000000000001";
  const second = "10000000-0000-4000-8000-000000000002";
  beforeEach(() => {
    vi.spyOn(prisma.healthEvent, "findFirst").mockResolvedValue(row(first, "2026-10-01T16:00:00Z"));
  });

  const row = (id: string, at: string) => ({
    id,
    createdAt: new Date(at),
    subjectKind: "model",
    subjectKey: "deepseek-flash",
    providerCode: "deepseek",
    fromState: "ok",
    toState: "account_refused",
    severity: "warning",
    upstreamStatus: 402,
    detail: "Insufficient Balance",
    affectedRoutes: ["chat/fast"],
  });

  it("returns events after the cursor, oldest first, and a cursor for the last one", async () => {
    const findMany = vi.spyOn(prisma.healthEvent, "findMany").mockResolvedValue([row(second, "2026-10-01T16:30:00Z")] as never);
    const after = encodeCursor(new Date("2026-10-01T16:00:00Z"), first);

    const page = await new ServiceHealthService({ view: async () => [] } as never).events({ after, limit: "10" });

    expect(page.items).toEqual([expect.objectContaining({ id: second, from: "ok", to: "account_refused", severity: "warning" })]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: new Date("2026-10-01T16:30:00Z"), id: second });
    expect(findMany).toHaveBeenCalledWith({ cursor: { id: first }, skip: 1, take: 10, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  });

  it("keeps the caller's cursor when nothing new has happened", async () => {
    vi.spyOn(prisma.healthEvent, "findMany").mockResolvedValue([] as never);
    const after = encodeCursor(new Date("2026-10-01T16:00:00Z"), first);
    expect((await new ServiceHealthService({ view: async () => [] } as never).events({ after })).nextCursor).toBe(after);
  });

  it("reads the first page without an anchor", async () => {
    const findMany = vi.spyOn(prisma.healthEvent, "findMany").mockResolvedValue([row(first, "2026-10-01T16:00:00Z")]);
    expect((await new ServiceHealthService({ view: async () => [] } as never).events({})).items[0]?.id).toBe(first);
    expect(findMany).toHaveBeenCalledWith({ take: 50, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  });

  it("rejects a missing anchor or mismatched timestamp instead of silently skipping events", async () => {
    const service = new ServiceHealthService({ view: async () => [] } as never);
    const after = encodeCursor(new Date("2026-10-01T16:00:00Z"), first);
    vi.mocked(prisma.healthEvent.findFirst).mockResolvedValueOnce(null);
    await expect(service.events({ after })).rejects.toMatchObject({ response: { code: "HEALTH_INVALID_CURSOR" } });
    await expect(service.events({ after: encodeCursor(new Date("2026-10-01T17:00:00Z"), first) }))
      .rejects.toMatchObject({ response: { code: "HEALTH_INVALID_CURSOR" } });
  });

  it("refuses a cursor it did not issue, and a limit out of range", async () => {
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({ after: "garbage" })).rejects.toMatchObject({
      response: { code: "HEALTH_INVALID_CURSOR" },
    });
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({
      after: encodeCursor(new Date("2026-10-01T16:00:00Z"), "not-a-uuid"),
    })).rejects.toMatchObject({ response: { code: "HEALTH_INVALID_CURSOR" } });
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({ limit: "0" })).rejects.toMatchObject({
      response: { code: "HEALTH_INVALID_LIMIT" },
    });
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({ limit: "201" })).rejects.toMatchObject({
      response: { code: "HEALTH_INVALID_LIMIT" },
    });
  });
});

// ============================================================================
// PostgreSQL cursor precision regression (dedicated disposable database only)
// ============================================================================

describe.runIf(process.env.HEALTH_EVENTS_ITEST === "1")("ServiceHealthService.events - PostgreSQL microseconds", () => {
  const service = new ServiceHealthService({ view: async () => [] } as never);
  const anchor = "56200000-0000-4000-8000-000000000560";
  const first = "56200000-0000-4000-8000-000000000562";
  const second = "56200000-0000-4000-8000-000000000563";
  const third = "56200000-0000-4000-8000-000000000561";
  let fixturesCreated = false;

  beforeAll(async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.pathname !== "/codex_atlas_562" || !["127.0.0.1", "localhost"].includes(database.hostname)) {
      throw new Error("Health event integration tests require the dedicated local codex_atlas_562 database");
    }
    // Fixed fixture IDs and a distant timestamp keep the existing smoke data intact.
    await prisma.$queryRawUnsafe(`
      INSERT INTO health.events
        (id, created_at, subject_kind, subject_key, from_state, to_state, severity, affected_routes)
      VALUES
        ('56200000-0000-4000-8000-000000000560', '2099-11-20T00:00:00.122000Z', 'model', 'codex-health-562-cursor', 'ok', 'unavailable', 'warning', '{}'),
        ('56200000-0000-4000-8000-000000000562', '2099-11-20T00:00:00.123456Z', 'model', 'codex-health-562-cursor', 'ok', 'unavailable', 'warning', '{}'),
        ('56200000-0000-4000-8000-000000000563', '2099-11-20T00:00:00.123456Z', 'model', 'codex-health-562-cursor', 'ok', 'unavailable', 'warning', '{}'),
        ('56200000-0000-4000-8000-000000000561', '2099-11-20T00:00:00.123789Z', 'model', 'codex-health-562-cursor', 'ok', 'unavailable', 'warning', '{}')
    `);
    fixturesCreated = true;
  });

  afterAll(async () => {
    if (!fixturesCreated) return;
    await prisma.$queryRawUnsafe(`
      DELETE FROM health.events WHERE subject_key = 'codex-health-562-cursor'
        AND id IN ('56200000-0000-4000-8000-000000000560', '56200000-0000-4000-8000-000000000561',
                   '56200000-0000-4000-8000-000000000562', '56200000-0000-4000-8000-000000000563')
    `);
    await prisma.$disconnect();
  });

  it("drains microsecond-separated and equal-timestamp rows once, in database order", async () => {
    let after = encodeCursor(new Date("2099-11-20T00:00:00.122Z"), anchor);
    const seen: string[] = [];
    for (let index = 0; index < 3; index++) {
      const page = await service.events({ after, limit: "1" });
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0]!.id);
      expect(page.nextCursor).not.toBe(after);
      after = page.nextCursor!;
    }
    expect(seen).toEqual([first, second, third]);
    expect(await service.events({ after, limit: "1" })).toEqual({ items: [], nextCursor: after });
  });

  it("continues an already-issued millisecond cursor without replaying its anchor", async () => {
    const after = encodeCursor(new Date("2099-11-20T00:00:00.123Z"), first);
    const page = await service.events({ after, limit: "200" });
    expect(page.items.map((item) => item.id)).toEqual([second, third]);
  });
});
