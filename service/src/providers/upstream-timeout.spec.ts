import { describe, it, expect, afterEach, vi } from "vitest";

import {
  DEFAULT_TTFB_TIMEOUT_MS,
  describeAbort,
  guardTimeToFirstByte,
  resolveTtfbTimeoutMs,
  UpstreamTimeoutError,
} from "./upstream-timeout";

afterEach(() => {
  delete process.env["PROVIDER_CONNECT_TIMEOUT_MS"];
  vi.useRealTimers();
});

describe("resolveTtfbTimeoutMs", () => {
  it("defaults when unset", () => {
    expect(resolveTtfbTimeoutMs()).toBe(DEFAULT_TTFB_TIMEOUT_MS);
  });

  it("honours a valid override", () => {
    process.env["PROVIDER_CONNECT_TIMEOUT_MS"] = "5000";
    expect(resolveTtfbTimeoutMs()).toBe(5000);
  });

  it.each(["0", "-1", "abc", ""])(
    "falls back to the default for a nonsense value (%s)",
    (value) => {
      process.env["PROVIDER_CONNECT_TIMEOUT_MS"] = value;
      expect(resolveTtfbTimeoutMs()).toBe(DEFAULT_TTFB_TIMEOUT_MS);
    },
  );
});

describe("guardTimeToFirstByte", () => {
  it("aborts once the window elapses", async () => {
    vi.useFakeTimers();
    process.env["PROVIDER_CONNECT_TIMEOUT_MS"] = "100";

    const guard = guardTimeToFirstByte("doubao");
    expect(guard.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(101);

    expect(guard.signal.aborted).toBe(true);
    expect(guard.isTimeout()).toBe(true);
  });

  it("does not abort after settle - headers arrived, the body may take as long as it takes", async () => {
    // 一次几千 token 的生成花上一两分钟是正常的；总超时会把它误杀，
    // 所以计时只到首字节为止。
    vi.useFakeTimers();
    process.env["PROVIDER_CONNECT_TIMEOUT_MS"] = "100";

    const guard = guardTimeToFirstByte("doubao");
    guard.settle();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(guard.signal.aborted).toBe(false);
    expect(guard.isTimeout()).toBe(false);
  });

  it("also aborts when the caller's own signal fires", () => {
    const caller = new AbortController();
    const guard = guardTimeToFirstByte("doubao", caller.signal);

    caller.abort();

    expect(guard.signal.aborted).toBe(true);
    // 调用方取消不是超时 - 两者的成因不同，报告也该不同。
    expect(guard.isTimeout()).toBe(false);
  });

  it("is already aborted when the caller's signal fired beforehand", () => {
    const caller = AbortSignal.abort();
    expect(guardTimeToFirstByte("doubao", caller).signal.aborted).toBe(true);
  });
});

describe("describeAbort", () => {
  it("replaces the opaque AbortError with a stated cause on timeout", async () => {
    vi.useFakeTimers();
    process.env["PROVIDER_CONNECT_TIMEOUT_MS"] = "100";

    const guard = guardTimeToFirstByte("zhipu");
    await vi.advanceTimersByTimeAsync(101);

    const described = describeAbort(new Error("aborted"), guard, "zhipu");

    expect(described).toBeInstanceOf(UpstreamTimeoutError);
    expect((described as Error).message).toContain("zhipu");
    expect((described as Error).message).toContain("response headers");
  });

  it("passes a non-timeout error through untouched", () => {
    const guard = guardTimeToFirstByte("zhipu");
    const original = new Error("ECONNREFUSED");

    expect(describeAbort(original, guard, "zhipu")).toBe(original);
  });
});
