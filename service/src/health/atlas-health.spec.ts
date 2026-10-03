import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AtlasHealthMonitor } from "./atlas-health.monitor";
import {
  REQUEST_LOG_WINDOW_MS,
  USAGE_FAILING_AFTER,
  atlasHealth,
  type AtlasHealthStore,
} from "./atlas-health";
import type { Transition } from "./upstream-health";

class FakeStore implements AtlasHealthStore {
  saved: Transition[] = [];
  constructor(private readonly rows: Awaited<ReturnType<AtlasHealthStore["loadAtlas"]>> = []) {}
  async loadAtlas() {
    return this.rows;
  }
  async save(t: Transition) {
    this.saved.push(t);
  }
}

const state = (component: string) => atlasHealth.snapshot().find((c) => c.component === component);

describe("atlasHealth - Atlas's own components", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    atlasHealth.resetForTests(() => clock);
  });
  afterEach(() => atlasHealth.resetForTests());

  it(`usage reporting fails after ${USAGE_FAILING_AFTER} refusals in a row, naming the platform's word - production refuses every report today (TD-056)`, async () => {
    const store = new FakeStore();
    await atlasHealth.attach(store);
    for (let i = 0; i < USAGE_FAILING_AFTER - 1; i += 1) atlasHealth.recordConsume("rejected", "unknown_product");
    expect(state("usage_reporting")?.state).toBe("unknown");

    atlasHealth.recordConsume("rejected", "unknown_product");
    await atlasHealth.flushed();

    expect(state("usage_reporting")).toMatchObject({ state: "failing" });
    expect(store.saved).toEqual([
      expect.objectContaining({
        subjectKind: "atlas",
        subjectKey: "usage_reporting",
        from: "unknown",
        to: "failing",
        severity: "warning",
        event: true,
        detail: expect.stringContaining("unknown_product"),
      }),
    ]);
  });

  it("one accepted report clears it, as an event; a skipped report says nothing", async () => {
    const store = new FakeStore();
    await atlasHealth.attach(store);
    for (let i = 0; i < USAGE_FAILING_AFTER; i += 1) atlasHealth.recordConsume("failed", "unreachable");
    atlasHealth.recordConsume("skipped", "not_configured");
    expect(state("usage_reporting")?.state).toBe("failing");

    atlasHealth.recordConsume("billed", "ok");
    await atlasHealth.flushed();
    expect(store.saved.at(-1)).toMatchObject({ from: "failing", to: "ok", severity: "info", event: true });
  });

  it("a skipped report (platform not configured, nothing to bill) is not a refusal and does not count toward failing", () => {
    for (let i = 0; i < USAGE_FAILING_AFTER - 1; i += 1) atlasHealth.recordConsume("rejected", "unknown_product");
    atlasHealth.recordConsume("skipped", "no_amount");
    expect(state("usage_reporting")?.state).toBe("unknown");
  });

  it("the first sighting of a working part is stored quietly", async () => {
    const store = new FakeStore();
    await atlasHealth.attach(store);
    atlasHealth.recordConsume("billed", "ok");
    await atlasHealth.flushed();
    expect(store.saved).toEqual([expect.objectContaining({ to: "ok", event: false })]);
  });

  it("a lost request record is critical, and the log recovers after a quiet window", async () => {
    const store = new FakeStore();
    await atlasHealth.attach(store);
    atlasHealth.recordRequestLogFailure("request_records", "missing_column");
    expect(state("request_log")).toMatchObject({ state: "failing", detail: expect.stringContaining("missing_column") });

    clock += REQUEST_LOG_WINDOW_MS - 1;
    atlasHealth.evaluate();
    expect(state("request_log")?.state).toBe("failing");
    clock += 1;
    atlasHealth.evaluate();
    await atlasHealth.flushed();

    expect(store.saved.map((t) => `${t.from}->${t.to} ${t.severity}`)).toEqual([
      "unknown->failing critical",
      "failing->ok info",
    ]);
  });

  it("partitions: rows in DEFAULT are failing, under two months is at risk", () => {
    atlasHealth.recordPartitions(12, 0);
    expect(state("partitions")?.state).toBe("ok");
    atlasHealth.recordPartitions(1, 0);
    expect(state("partitions")?.state).toBe("at_risk");
    atlasHealth.recordPartitions(12, 3);
    expect(state("partitions")).toMatchObject({ state: "failing", detail: expect.stringContaining("DEFAULT") });
  });

  it("restores the stored state at start, and every component is listed even before a signal", async () => {
    await atlasHealth.attach(
      new FakeStore([{ component: "usage_reporting", state: "failing", since: new Date(5), detail: "stored" }]),
    );
    expect(atlasHealth.snapshot().map((c) => [c.component, c.state])).toEqual([
      ["usage_reporting", "failing"],
      ["request_log", "unknown"],
      ["partitions", "unknown"],
    ]);
  });
});

describe("AtlasHealthMonitor", () => {
  beforeEach(() => atlasHealth.resetForTests());
  afterEach(() => atlasHealth.resetForTests());

  it("reads the partition runway at most every ten minutes, and an unreadable runway is not a state", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce([{ monthsAhead: 12n, defaultPartitionRows: 0n }])
      .mockRejectedValueOnce(new Error("db gone"));
    const monitor = new AtlasHealthMonitor({ readReqlogPartitionRunway: read } as never);

    await monitor.tick(0);
    await monitor.tick(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(state("partitions")?.state).toBe("ok");

    await monitor.tick(10 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(state("partitions")?.state).toBe("ok");
  });
});
