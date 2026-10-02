import { describe, expect, it } from "vitest";

import {
  initialRecord,
  modelSeverity,
  nextRecord,
  RATE_LIMITED_AFTER_MS,
  routeSeverity,
  routeState,
  UNAVAILABLE_AFTER_FAILURES,
  UNAVAILABLE_AFTER_MS,
  type ModelHealthRecord,
} from "./health-state";

const T0 = 1_000_000;
const ok: ModelHealthRecord = { state: "ok", since: T0, consecutiveFailures: 0 };

describe("nextRecord - a vendor model", () => {
  it("one success is ok, and clears every counter", () => {
    const failing = { ...ok, state: "unavailable" as const, consecutiveFailures: 7, firstFailureAt: T0 };
    expect(nextRecord(failing, "success", T0 + 5)).toEqual({ state: "ok", since: T0 + 5, consecutiveFailures: 0 });
  });

  it("an account refusal is entered on the FIRST occurrence - it does not fix itself", () => {
    const next = nextRecord(ok, "account", T0 + 1, { upstreamStatus: 402, detail: "Insufficient Balance" });
    expect(next).toMatchObject({ state: "account_refused", since: T0 + 1, upstreamStatus: 402, detail: "Insufficient Balance" });
  });

  it("a missing model is entered on the first 404", () => {
    expect(nextRecord(ok, "model_missing", T0 + 1).state).toBe("model_missing");
  });

  it(`an outage needs ${UNAVAILABLE_AFTER_FAILURES} failures in a row`, () => {
    let r = ok;
    for (let i = 1; i < UNAVAILABLE_AFTER_FAILURES; i += 1) {
      r = nextRecord(r, "unavailable", T0 + i);
      expect(r.state).toBe("ok");
    }
    expect(nextRecord(r, "unreachable", T0 + 99).state).toBe("unavailable");
  });

  it("or every call failing for the whole window, however few", () => {
    const once = nextRecord(ok, "unavailable", T0);
    expect(nextRecord(once, "unavailable", T0 + UNAVAILABLE_AFTER_MS).state).toBe("unavailable");
  });

  it("throttling becomes a state only once it has lasted", () => {
    const first = nextRecord(ok, "rate_limited", T0);
    expect(first.state).toBe("ok");
    expect(nextRecord(first, "rate_limited", T0 + RATE_LIMITED_AFTER_MS - 1).state).toBe("ok");
    expect(nextRecord(first, "rate_limited", T0 + RATE_LIMITED_AFTER_MS).state).toBe("rate_limited");
  });

  it("a refused account stays refused through outages and throttling - only a success moves it", () => {
    let r = nextRecord(ok, "account", T0);
    for (let i = 0; i < 10; i += 1) r = nextRecord(r, "unavailable", T0 + i * UNAVAILABLE_AFTER_MS);
    r = nextRecord(r, "rate_limited", T0 + 99 * RATE_LIMITED_AFTER_MS);
    expect(r.state).toBe("account_refused");
    expect(nextRecord(r, "success", T0 + 1e9).state).toBe("ok");
  });

  it("keeps `since` when the state does not change", () => {
    const r = nextRecord(ok, "account", T0 + 1);
    expect(nextRecord(r, "account", T0 + 50).since).toBe(T0 + 1);
  });

  it("starts unknown", () => {
    expect(initialRecord(T0)).toEqual({ state: "unknown", since: T0, consecutiveFailures: 0 });
  });
});

describe("routeState - severity is decided per route", () => {
  it("primary serving: ok", () => {
    expect(routeState("ok", "account_refused", true)).toBe("ok");
    expect(routeState(undefined, undefined, true)).toBe("ok");
    expect(routeState("unknown", undefined, false)).toBe("ok");
  });

  it("primary failing, fallback serving: degraded - callers are still served", () => {
    expect(routeState("account_refused", "ok", true)).toBe("degraded");
    expect(routeState("unavailable", undefined, true)).toBe("degraded");
  });

  it("nothing serving: down - the chat/fast evening of 2026-10-01", () => {
    // primary paused by an account usage cap, fallback out of balance
    expect(routeState("account_refused", "account_refused", true)).toBe("down");
    expect(routeState("unavailable", undefined, false)).toBe("down");
  });

  it("maps to severity", () => {
    expect(routeSeverity("down")).toBe("critical");
    expect(routeSeverity("degraded")).toBe("warning");
    expect(routeSeverity("ok")).toBe("info");
    expect(modelSeverity("account_refused")).toBe("warning");
    expect(modelSeverity("ok")).toBe("info");
  });
});
