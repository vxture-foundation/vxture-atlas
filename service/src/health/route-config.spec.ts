import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../prisma";
import { PrismaHealthStore } from "./health.store";
import { evaluateRoute, routeConfigIssues, type ModelFacts } from "./route-config";

const ok = (modelType: string): ModelFacts => ({ modelType, active: true, hasKey: true });

describe("routeConfigIssues - can the named models serve the route", () => {
  it("names a model of the wrong type, by role", () => {
    const facts = new Map([
      ["embedding-3", ok("embedding")],
      ["doubao-pro-32k", ok("chat")],
    ]);
    expect(
      routeConfigIssues({ category: "embedding", primary: "embedding-3", fallback: "doubao-pro-32k" }, facts),
    ).toEqual([
      expect.objectContaining({ role: "fallback", modelCode: "doubao-pro-32k", code: "wrong_type" }),
    ]);
  });

  it("names a missing model, an inactive one, and one with no key", () => {
    const facts = new Map([["off", { modelType: "chat", active: false, hasKey: false }]]);
    expect(
      routeConfigIssues({ category: "chat", primary: "off", fallback: "gone" }, facts).map((i) => [i.role, i.code]),
    ).toEqual([
      ["primary", "model_inactive"],
      ["primary", "no_key"],
      ["fallback", "model_missing"],
    ]);
  });

  it("judges no type for a category it has no rule for - chat/vision is not judged by its name", () => {
    expect(routeConfigIssues({ category: "vision", primary: "m", fallback: null }, new Map([["m", ok("chat")]]))).toEqual(
      [],
    );
  });
});

describe("evaluateRoute", () => {
  it("is the plain route state when nothing is wrong with the route", () => {
    expect(evaluateRoute({ primary: "a", fallback: "b", configIssues: [] }, () => "ok")).toBe("ok");
  });
});

describe("PrismaHealthStore.listRoutes - the facts behind a route", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a key counts only when the vault holds that alias for that vendor; a keyless vendor needs none", async () => {
    vi.spyOn(prisma.modelEndpoint, "findMany").mockResolvedValue([
      { code: "chat/a", category: "chat", primaryModelCode: "has-key", fallbackModelCode: "wrong-vendor-key" },
      { code: "chat/b", category: "chat", primaryModelCode: "private-model", fallbackModelCode: "off-vendor" },
    ] as never);
    vi.spyOn(prisma.modelDefinition, "findMany").mockResolvedValue([
      { modelCode: "has-key", modelType: "chat", isActive: true, config: { managedKeyAlias: "primary" }, providerRef: { providerCode: "deepseek", isActive: true } },
      { modelCode: "wrong-vendor-key", modelType: "chat", isActive: true, config: { managedKeyAlias: "primary" }, providerRef: { providerCode: "zhipu", isActive: true } },
      { modelCode: "private-model", modelType: "chat", isActive: true, config: null, providerRef: { providerCode: "private", isActive: true } },
      { modelCode: "off-vendor", modelType: "chat", isActive: true, config: { managedKeyAlias: "primary" }, providerRef: { providerCode: "deepseek", isActive: false } },
    ] as never);
    vi.spyOn(prisma.providerApiKey, "findMany").mockResolvedValue([
      { providerCode: "deepseek", keyAlias: "primary" },
    ] as never);

    const routes = await new PrismaHealthStore().listRoutes();

    expect(routes.find((r) => r.code === "chat/a")?.configIssues?.map((i) => [i.modelCode, i.code])).toEqual([
      ["wrong-vendor-key", "no_key"],
    ]);
    expect(routes.find((r) => r.code === "chat/b")?.configIssues?.map((i) => [i.modelCode, i.code])).toEqual([
      ["off-vendor", "model_inactive"],
    ]);
  });
});
