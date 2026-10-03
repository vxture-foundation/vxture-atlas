import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    const findMany = vi.spyOn(prisma.healthEvent, "findMany").mockResolvedValue([row("e2", "2026-10-01T16:30:00Z")] as never);
    const after = encodeCursor(new Date("2026-10-01T16:00:00Z"), "e1");

    const page = await new ServiceHealthService({ view: async () => [] } as never).events({ after, limit: "10" });

    expect(page.items).toEqual([expect.objectContaining({ id: "e2", from: "ok", to: "account_refused", severity: "warning" })]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: new Date("2026-10-01T16:30:00Z"), id: "e2" });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }));
  });

  it("keeps the caller's cursor when nothing new has happened", async () => {
    vi.spyOn(prisma.healthEvent, "findMany").mockResolvedValue([] as never);
    const after = encodeCursor(new Date("2026-10-01T16:00:00Z"), "e1");
    expect((await new ServiceHealthService({ view: async () => [] } as never).events({ after })).nextCursor).toBe(after);
  });

  it("refuses a cursor it did not issue, and a limit out of range", async () => {
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({ after: "garbage" })).rejects.toMatchObject({
      response: { code: "HEALTH_INVALID_CURSOR" },
    });
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({ limit: "0" })).rejects.toMatchObject({
      response: { code: "HEALTH_INVALID_LIMIT" },
    });
    await expect(new ServiceHealthService({ view: async () => [] } as never).events({ limit: "201" })).rejects.toMatchObject({
      response: { code: "HEALTH_INVALID_LIMIT" },
    });
  });
});
