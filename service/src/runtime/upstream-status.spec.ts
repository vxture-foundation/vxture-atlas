import { describe, expect, it } from "vitest";

import { ProviderHttpError } from "../providers/base.provider";
import { metricsRegistry } from "./metrics.registry";
import { toS2sProviderError } from "./s2s-provider.shared";
import {
  recordUpstreamHttpStatus,
  upstreamStatusClass,
  upstreamStatusHint,
} from "./upstream-status";
import type { AiModelRecord } from "../types/runtime.types";

// Production 2026-10-01: DeepSeek answered 402 sixteen times, every one filed
// as PROVIDER_UNAVAILABLE and absorbed by failover. These pin that the vendor
// and the status now reach a metric and the error text.

describe("upstreamStatusClass", () => {
  it.each([
    [401, "account"],
    [402, "account"],
    [403, "account"],
    [429, "rate_limit"],
    [400, "request"],
    [422, "request"],
    [500, "server"],
    [503, "server"],
  ] as const)("%i -> %s", (status, cls) => {
    expect(upstreamStatusClass(status)).toBe(cls);
  });
});

describe("recordUpstreamHttpStatus", () => {
  it("counts by the VENDOR, not by the adapter that threw", async () => {
    // openai-compatible serves DeepSeek and Doubao alike; its name says nothing.
    recordUpstreamHttpStatus(new ProviderHttpError("x", 402, "openai-compatible", "{}"), "deepseek");

    expect(await metricsRegistry.scrape()).toContain(
      'upstream_http_errors_total{provider="deepseek",status="402",class="account"}',
    );
  });

  it("ignores anything that is not an HTTP failure", async () => {
    const ours = async () =>
      (await metricsRegistry.scrape())
        .split("\n")
        .filter((l) => l.startsWith("upstream_http_errors_total{"))
        .join("\n");
    const before = await ours();
    recordUpstreamHttpStatus(new Error("ECONNRESET"), "zhipu");
    expect(await ours()).toBe(before);
  });
});

describe("the S2S error names an account failure", () => {
  it("says what a 402 means and counts it", async () => {
    const model = { modelCode: "embedding-3", provider: "zhipu" } as AiModelRecord;
    const err = toS2sProviderError(new ProviderHttpError("x", 402, "zhipu", "{}"), model, "req-1");

    expect(err.code).toBe("PROVIDER_UNAVAILABLE");
    expect(err.message).toContain("zhipu provider returned status 402");
    expect(err.message).toContain("payment required");
    expect(await metricsRegistry.scrape()).toContain(
      'upstream_http_errors_total{provider="zhipu",status="402",class="account"}',
    );
  });
});

describe("upstreamStatusHint", () => {
  it("adds nothing for a status that already says enough", () => {
    expect(upstreamStatusHint(500)).toBe("");
  });
});
