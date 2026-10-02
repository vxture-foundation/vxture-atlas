import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderHttpError } from "../providers/base.provider";
import { prisma } from "../prisma";
import type { AiModelRecord } from "../types/runtime.types";
import { HealthProbeScheduler } from "./health-probe.scheduler";
import { upstreamHealth } from "./upstream-health";

const MIN = 60_000;
const NOW = 10_000_000_000;

function model(modelCode: string, provider = "deepseek"): AiModelRecord {
  return { modelCode, provider, modelType: "chat" } as AiModelRecord;
}

function build(options: {
  active: AiModelRecord[];
  routes: { code: string; primaryModelCode: string; fallbackModelCode: string | null }[];
  settings?: object[];
  probe?: (m: AiModelRecord) => Promise<{ ok: boolean; error?: unknown }>;
}) {
  vi.spyOn(prisma.modelEndpoint, "findMany").mockResolvedValue(options.routes as never);
  vi.spyOn(prisma.healthProbeSetting, "findMany").mockResolvedValue((options.settings ?? []) as never);
  const registry = { listActiveModels: vi.fn().mockResolvedValue(options.active) };
  const prober = { probeForHealth: vi.fn(options.probe ?? (async () => ({ ok: true }))) };
  const scheduler = new HealthProbeScheduler(registry as never, prober as never);
  return { scheduler, prober };
}

describe("HealthProbeScheduler.tick", () => {
  let clock = NOW;
  beforeEach(() => {
    clock = NOW;
    upstreamHealth.resetForTests(() => clock);
    delete process.env["HEALTH_PROBE_INTERVAL_MINUTES"];
    delete process.env["HEALTH_PROBES_ENABLED"];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    upstreamHealth.resetForTests();
  });

  const routes = [{ code: "chat/fast", primaryModelCode: "doubao-lite", fallbackModelCode: "deepseek-flash" }];
  const active = [model("doubao-lite", "doubao"), model("deepseek-flash"), model("unrouted")];

  it("probes the models a route names, not every registered one", async () => {
    const { scheduler, prober } = build({ active, routes });
    const { probed } = await scheduler.tick(clock);

    expect(probed.sort()).toEqual(["deepseek-flash", "doubao-lite"]);
    expect(prober.probeForHealth).toHaveBeenCalledTimes(2);
  });

  it("skips a model with a fresh result - real traffic is the probe", async () => {
    const { scheduler } = build({ active, routes });
    upstreamHealth.recordSuccess("doubao-lite", "doubao"); // a real call just now
    clock += 3 * MIN;

    expect((await scheduler.tick(clock)).probed).toEqual(["deepseek-flash"]);
  });

  it("probes again once the interval has passed, and honours a per-model override", async () => {
    const { scheduler } = build({
      active,
      routes,
      settings: [{ subjectKind: "model", subjectKey: "deepseek-flash", probeIntervalMinutes: 30, probeEnabled: null }],
    });
    await scheduler.tick(clock);
    clock += 10 * MIN;

    // doubao-lite is due at the default 10 minutes; deepseek-flash waits for its 30.
    expect((await scheduler.tick(clock)).probed).toEqual(["doubao-lite"]);
  });

  it("does not probe a model switched off, at any level", async () => {
    const { scheduler } = build({
      active,
      routes,
      settings: [{ subjectKind: "provider", subjectKey: "deepseek", probeIntervalMinutes: null, probeEnabled: false }],
    });
    expect((await scheduler.tick(clock)).probed).toEqual(["doubao-lite"]);
  });

  it("feeds the result into health: a 402 from the probe is an account refusal", async () => {
    const { scheduler } = build({
      active,
      routes,
      probe: async (m) =>
        m.modelCode === "deepseek-flash"
          ? { ok: false, error: new ProviderHttpError("x", 402, "p", "Insufficient Balance") }
          : { ok: true },
    });
    await scheduler.tick(clock);

    expect(upstreamHealth.modelState("deepseek-flash")).toBe("account_refused");
    expect(upstreamHealth.modelState("doubao-lite")).toBe("ok");
  });

  it("does not start a pass while one is still running", async () => {
    const pending: (() => void)[] = [];
    const { scheduler } = build({
      active,
      routes,
      probe: () => new Promise((resolve) => pending.push(() => resolve({ ok: true }))),
    });
    const first = scheduler.tick(clock);
    await new Promise((r) => setTimeout(r, 0));
    expect((await scheduler.tick(clock)).probed).toEqual([]);
    for (const release of pending) release();
    expect((await first).probed.sort()).toEqual(["deepseek-flash", "doubao-lite"]);
  });
});

describe("upstreamHealth.markUnknownIfSilent", () => {
  let clock = NOW;
  beforeEach(() => upstreamHealth.resetForTests(() => clock));
  afterEach(() => upstreamHealth.resetForTests());

  it("an ok model silent for the window becomes unknown; a failing one does not", () => {
    upstreamHealth.recordSuccess("idle", "doubao");
    upstreamHealth.recordFailure("broke", "deepseek", new ProviderHttpError("x", 402, "p", ""));
    clock += 21 * MIN;

    upstreamHealth.markUnknownIfSilent("idle", 20 * MIN);
    upstreamHealth.markUnknownIfSilent("broke", 20 * MIN);

    expect(upstreamHealth.modelState("idle")).toBe("unknown");
    expect(upstreamHealth.modelState("broke")).toBe("account_refused");
  });

  it("a recently heard model stays ok", () => {
    upstreamHealth.recordSuccess("busy", "doubao");
    clock += 5 * MIN;
    upstreamHealth.markUnknownIfSilent("busy", 20 * MIN);
    expect(upstreamHealth.modelState("busy")).toBe("ok");
  });
});
