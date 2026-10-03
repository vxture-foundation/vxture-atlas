import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpstreamCallFailure } from "../providers/upstream-failure";
import { prisma } from "../prisma";
import { DEGRADED_AFTER_EMPTY, modelSeverity, nextRecord, routeState, type ModelHealthRecord } from "./health-state";
import {
  BASELINE_MIN_CALLS,
  RECENT_CALLS,
  ModelDegradationMonitor,
  judgeLatency,
  type LatencyRow,
} from "./model-degradation";
import { classifyFailure, upstreamHealth } from "./upstream-health";

const T0 = 1_000_000;
const ok: ModelHealthRecord = { state: "ok", since: T0, consecutiveFailures: 0 };

describe("degraded - the model answers, but badly (F3b-B)", () => {
  it("an empty answer is a health signal; a spent budget is not", () => {
    expect(classifyFailure(new UpstreamCallFailure("no content", {}))).toBe("empty");
    expect(classifyFailure(new UpstreamCallFailure("length", {}, { outputBudgetExhausted: true }))).toBeUndefined();
  });

  it(`${DEGRADED_AFTER_EMPTY} empty answers in a row make it degraded; an answer with content clears it`, () => {
    let r = ok;
    for (let i = 1; i < DEGRADED_AFTER_EMPTY; i += 1) {
      r = nextRecord(r, "empty", T0 + i);
      expect(r.state).toBe("ok");
    }
    r = nextRecord(r, "empty", T0 + 10);
    expect(r).toMatchObject({ state: "degraded", since: T0 + 10, detail: expect.stringContaining("empty answers") });
    expect(nextRecord(r, "success", T0 + 11).state).toBe("ok");
  });

  it("slow stays through successes until the evaluator clears it", () => {
    let r = nextRecord(ok, "slow", T0 + 1, { detail: "3.4x" });
    expect(r).toMatchObject({ state: "degraded", detail: "3.4x" });
    r = nextRecord(r, "success", T0 + 2);
    expect(r).toMatchObject({ state: "degraded", slow: true });
    expect(nextRecord(r, "not_slow", T0 + 3).state).toBe("ok");
  });

  it("does not overwrite a refused account, and remembers slow for after the recovery", () => {
    const refused: ModelHealthRecord = { state: "account_refused", since: T0, consecutiveFailures: 0 };
    const r = nextRecord(refused, "slow", T0 + 1, { detail: "slow" });
    expect(r.state).toBe("account_refused");
    expect(nextRecord(r, "success", T0 + 2).state).toBe("degraded");
  });

  it("a degraded model can still fail outright", () => {
    const degraded = nextRecord(ok, "slow", T0 + 1);
    expect(nextRecord(degraded, "account", T0 + 2).state).toBe("account_refused");
  });

  it("is a warning - the platform's watcher notifies on it - and its recovery is info", () => {
    expect(modelSeverity("degraded")).toBe("warning");
    expect(modelSeverity("ok")).toBe("info");
  });

  it("routes still count a degraded model as serving", () => {
    expect(routeState("degraded", undefined, false)).toBe("ok");
  });
});

const row = (o: Partial<LatencyRow>): LatencyRow => ({
  modelCode: "m",
  recentN: RECENT_CALLS,
  recentMs: 1000,
  recentTokN: RECENT_CALLS,
  recentMsPerTok: 10,
  baseN: BASELINE_MIN_CALLS,
  baseMs: 1000,
  baseTokN: BASELINE_MIN_CALLS,
  baseMsPerTok: 10,
  ...o,
});

describe("judgeLatency - against the model's own baseline", () => {
  it("chat is judged per output token, so a long answer is not slow", () => {
    expect(judgeLatency(row({ recentMs: 60_000, recentMsPerTok: 11 }), "chat").kind).toBe("normal");
    expect(judgeLatency(row({ recentMsPerTok: 31 }), "chat")).toMatchObject({
      kind: "slow",
      detail: expect.stringContaining("3.1x its 7-day median"),
    });
  });

  it("embedding and rerank are judged on raw latency", () => {
    expect(judgeLatency(row({ recentMs: 3500 }), "rerank").kind).toBe("slow");
  });

  it("holds between the two ratios, so one borderline pass does not flap", () => {
    expect(judgeLatency(row({ recentMsPerTok: 25 }), "chat").kind).toBe("hold");
    expect(judgeLatency(row({ recentMsPerTok: 19 }), "chat").kind).toBe("normal");
  });

  it("says nothing on too few calls - production has had about 65 a week on its busiest model", () => {
    expect(judgeLatency(row({ recentTokN: RECENT_CALLS - 1 }), "chat").kind).toBe("unknown");
    expect(judgeLatency(row({ baseN: BASELINE_MIN_CALLS - 1 }), "rerank").kind).toBe("unknown");
  });
});

describe("ModelDegradationMonitor.tick", () => {
  beforeEach(() => upstreamHealth.resetForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    upstreamHealth.resetForTests();
  });

  it("marks a slow model degraded without counting it as a fresh result, and clears it when it is normal again", async () => {
    const registry = {
      listActiveModels: vi.fn().mockResolvedValue([{ modelCode: "m", provider: "zhipu", modelType: "chat" }]),
    };
    const query = vi.spyOn(prisma, "$queryRawUnsafe").mockResolvedValue([row({ recentMsPerTok: "40" as never })] as never);
    const monitor = new ModelDegradationMonitor(registry as never);

    expect((await monitor.tick()).judged).toEqual({ m: "slow" });
    expect(upstreamHealth.modelState("m")).toBe("degraded");
    expect(upstreamHealth.lastResultAt("m")).toBeUndefined();

    query.mockResolvedValue([row({ recentMsPerTok: 12 })] as never);
    await monitor.tick();
    expect(upstreamHealth.modelState("m")).toBe("ok");
  });
});
