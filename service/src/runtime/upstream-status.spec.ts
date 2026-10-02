import { describe, expect, it } from "vitest";

import { parseRetryAfterMs, ProviderHttpError } from "../providers/base.provider";
import { metricsRegistry } from "./metrics.registry";
import { toS2sProviderError } from "./s2s-provider.shared";
import {
  recordUpstreamHttpStatus,
  upstreamFailureClass,
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

    expect(err.code).toBe("UPSTREAM_ACCOUNT_REFUSED");
    expect(err.getResponse()).toMatchObject({ retryable: false });
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

describe("the upstream's Retry-After", () => {
  it("reads delta-seconds and HTTP-dates, and guesses nothing", () => {
    expect(parseRetryAfterMs("7")).toBe(7_000);
    expect(parseRetryAfterMs("Wed, 01 Oct 2026 10:00:30 GMT", Date.parse("Wed, 01 Oct 2026 10:00:00 GMT"))).toBe(30_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("the S2S path classifies an upstream 429", () => {
  it("as RATE_LIMITED, carrying the vendor's wait", () => {
    const model = { modelCode: "rerank", provider: "zhipu" } as AiModelRecord;
    const err = toS2sProviderError(new ProviderHttpError("x", 429, "zhipu", "", 3_000), model, "req-2");

    expect(err.code).toBe("RATE_LIMITED");
    expect(err.getResponse()).toMatchObject({ retryable: true, retryAfterMs: 3_000 });
  });
});

// Observed 2026-10-02: Doubao's 429 was not throttling but an account usage cap
// that paused the model. Same status, opposite handling.
describe("a 429 that is an account limit", () => {
  const DOUBAO_SET_LIMIT =
    '{"error":{"code":"SetLimitExceeded","message":"Your account [2101304184] has reached the set usage limit for the [doubao-seed-2-0-lite] model, and the model service has been paused. To continue using this model, please visit the Model Activation page to adjust or close the \\"Safe Experience Mode\\".","param":"","type":"TooManyRequests"}}';

  it("is UPSTREAM_ACCOUNT_REFUSED, not retryable, and carries the vendor's own instructions", () => {
    const model = { modelCode: "doubao-seed-2-0-lite-260428", provider: "doubao" } as AiModelRecord;
    const err = toS2sProviderError(new ProviderHttpError("x", 429, "openai-compatible", DOUBAO_SET_LIMIT), model, "r");

    expect(err.code).toBe("UPSTREAM_ACCOUNT_REFUSED");
    expect(err.getResponse()).toMatchObject({ retryable: false });
    expect(err.message).toContain("Safe Experience Mode");
  });

  it("is counted as class=account", async () => {
    recordUpstreamHttpStatus(new ProviderHttpError("x", 429, "openai-compatible", DOUBAO_SET_LIMIT), "doubao");
    expect(await metricsRegistry.scrape()).toContain(
      'upstream_http_errors_total{provider="doubao",status="429",class="account"}',
    );
  });

  it("leaves a plain 429 as throttling", () => {
    expect(
      upstreamFailureClass(new ProviderHttpError("x", 429, "p", '{"error":{"code":"RateLimitExceeded.EndpointRPMExceeded"}}')),
    ).toBe("rate_limit");
  });
});

// Zhipu answers arrears with HTTP 429 and a business code in the body; only
// the code tells an empty account from a busy one.
describe("Zhipu's 429 business codes", () => {
  const zhipu = (code: string) =>
    new ProviderHttpError("x", 429, "zhipu", `{"error":{"code":"${code}","message":"m"}}`);

  it.each(["1113", "1308", "1309", "1310", "1311", "1314", "1315", "1316", "1321"])(
    "%s is the account, not throttling",
    (code) => {
      expect(upstreamFailureClass(zhipu(code))).toBe("account");
    },
  );

  it.each(["1302", "1305", "1313"])("%s stays throttling", (code) => {
    expect(upstreamFailureClass(zhipu(code))).toBe("rate_limit");
  });
});
