import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../prisma";
import type { AiModelRecord } from "../types/runtime.types";
import { VendorBalanceMonitor } from "./vendor-balance.monitor";

const MIN = 60_000;
const NOW = 10_000_000_000;

function model(modelCode: string, provider: string, endpointUrl: string): AiModelRecord {
  return {
    modelCode,
    provider,
    endpointUrl,
    providerActive: true,
    config: { managedKeyAlias: "default" },
  } as unknown as AiModelRecord;
}

const DEEPSEEK = model("deepseek-v4-flash", "deepseek", "https://api.deepseek.com/v1");
const DOUBAO = model("doubao-seed-2-0-lite", "doubao", "https://ark.cn-beijing.volces.com/api/v3");

function balanceResponse(total: string, isAvailable = true): Response {
  return new Response(
    JSON.stringify({ is_available: isAvailable, balance_infos: [{ currency: "CNY", total_balance: total }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function build(options: { settings?: object[]; samples?: object[] } = {}) {
  vi.spyOn(prisma.healthProbeSetting, "findMany").mockResolvedValue((options.settings ?? []) as never);
  vi.spyOn(prisma.healthBalanceSample, "findMany").mockResolvedValue((options.samples ?? []) as never);
  const create = vi.spyOn(prisma.healthBalanceSample, "create").mockResolvedValue({} as never);
  const save = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(prisma, "$transaction").mockImplementation((async (fn: (tx: unknown) => Promise<void>) =>
    fn({
      healthSubjectState: { upsert: vi.fn().mockResolvedValue({}) },
      healthEvent: { create: save },
    })) as never);
  const registry = { listActiveModels: vi.fn().mockResolvedValue([DEEPSEEK, DOUBAO]) };
  const providerKeys = { resolveKey: vi.fn().mockResolvedValue("sk-test") };
  const monitor = new VendorBalanceMonitor(registry as never, providerKeys as never);
  const fetchImpl = vi.fn();
  monitor.fetchImpl = fetchImpl as never;
  return { monitor, fetchImpl, create, events: save };
}

describe("VendorBalanceMonitor.tick", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("reads DeepSeek with the vendor's own key, stores the sample, and records a healthy first sighting quietly", async () => {
    const { monitor, fetchImpl, create, events } = build();
    fetchImpl.mockResolvedValue(balanceResponse("500.00"));

    expect(await monitor.tick(NOW)).toEqual({ read: ["deepseek"] });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk-test" }) }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerCode: "deepseek", currency: "CNY", totalBalance: 500 }),
    });
    const view = await monitor.view();
    expect(view.find((v) => v.providerCode === "deepseek")).toMatchObject({ state: "ok", balance: 500, currency: "CNY" });
    expect(events).not.toHaveBeenCalled();
  });

  it("reads through a model that has a key, not merely the first model of the vendor", async () => {
    const { monitor, fetchImpl } = build();
    const keyless = { ...DEEPSEEK, modelCode: "deepseek-a-keyless", config: null } as unknown as AiModelRecord;
    (monitor as unknown as { registry: { listActiveModels: () => Promise<AiModelRecord[]> } }).registry = {
      listActiveModels: async () => [keyless, DEEPSEEK],
    };
    fetchImpl.mockResolvedValue(balanceResponse("500.00"));
    await monitor.tick(NOW);
    expect((await monitor.view()).find((v) => v.providerCode === "deepseek")).toMatchObject({ state: "ok" });
  });

  it("states that Volcengine cannot be read, with the reason - not_supported, no event", async () => {
    const { monitor, fetchImpl, events } = build();
    fetchImpl.mockResolvedValue(balanceResponse("500.00"));
    await monitor.tick(NOW);
    const doubao = (await monitor.view()).find((v) => v.providerCode === "doubao");
    expect(doubao).toMatchObject({ state: "not_supported" });
    expect(doubao?.detail).toContain("AK/SK");
    expect(events).not.toHaveBeenCalled();
  });

  it("warns when the balance drops below the minimum, and reads again only after the poll interval", async () => {
    const { monitor, fetchImpl, events } = build();
    fetchImpl.mockResolvedValueOnce(balanceResponse("500.00")).mockResolvedValueOnce(balanceResponse("80.00"));
    await monitor.tick(NOW);
    expect((await monitor.tick(NOW + 30 * MIN)).read).toEqual([]);
    expect((await monitor.tick(NOW + 60 * MIN)).read).toEqual(["deepseek"]);

    expect((await monitor.view()).find((v) => v.providerCode === "deepseek")?.state).toBe("balance_low");
    expect(events).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectKind: "vendor",
        subjectKey: "deepseek",
        fromState: "ok",
        toState: "balance_low",
        severity: "warning",
      }),
    });
  });

  it("a threshold edited in opera takes effect at the next tick, without another read", async () => {
    const { monitor, fetchImpl } = build();
    fetchImpl.mockResolvedValue(balanceResponse("150.00"));
    await monitor.tick(NOW);
    expect((await monitor.view()).find((v) => v.providerCode === "deepseek")?.state).toBe("ok");

    vi.spyOn(prisma.healthProbeSetting, "findMany").mockResolvedValue([
      {
        subjectKind: "provider",
        subjectKey: "deepseek",
        balanceMinAmount: { toString: () => "200.00" },
        balanceMinDays: null,
        balancePollMinutes: null,
      },
    ] as never);
    expect((await monitor.tick(NOW + MIN)).read).toEqual([]);
    expect((await monitor.view()).find((v) => v.providerCode === "deepseek")?.state).toBe("balance_low");
  });

  it("a read that keeps failing for two intervals makes the state unknown, with the error - a stale ok is not vouched for", async () => {
    const { monitor, fetchImpl, events } = build();
    fetchImpl
      .mockResolvedValueOnce(balanceResponse("500.00"))
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await monitor.tick(NOW);
    await monitor.tick(NOW + 60 * MIN);
    let deepseek = (await monitor.view()).find((v) => v.providerCode === "deepseek");
    expect(deepseek).toMatchObject({ state: "ok", lastReadError: "HTTP 401: unauthorized" });
    await monitor.tick(NOW + 120 * MIN);
    await monitor.tick(NOW + 180 * MIN);
    deepseek = (await monitor.view()).find((v) => v.providerCode === "deepseek");
    expect(deepseek?.state).toBe("unknown");
    expect(events).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectKind: "vendor", fromState: "ok", toState: "unknown", severity: "warning" }),
    });
  });
});
