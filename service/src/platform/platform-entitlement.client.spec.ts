import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atlasHealth } from "../health/atlas-health";

import { metricsRegistry } from "../runtime/metrics.registry";
import {
  PlatformEntitlementClient,
  splitUsage,
} from "./platform-entitlement.client";

const CACHE_MAX_ENTRIES = 10_000;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** The cache is private on purpose; the tests reach in to observe its size. */
function cacheOf(
  client: PlatformEntitlementClient,
): Map<string, { outcome: unknown; expiresAt: number }> {
  return (
    client as unknown as {
      cache: Map<string, { outcome: unknown; expiresAt: number }>;
    }
  ).cache;
}

describe("PlatformEntitlementClient.resolve", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_API_URL", "http://platform.test");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_TOKEN", "internal-secret");
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports not-configured without touching the network", async () => {
    vi.stubEnv("PLATFORM_API_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().resolve("ws-1", "karda");

    expect(outcome).toEqual({ kind: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a live cache entry instead of asking the platform twice", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ entitled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlatformEntitlementClient();
    const first = await client.resolve("ws-1", "karda");
    const second = await client.resolve("ws-1", "karda");

    expect(first.kind).toBe("resolved");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes an expired entry when it is found, instead of skipping it forever", async () => {
    // Expired entries used to be skipped on read but never removed, so every
    // workspace that ever resolved stayed in the map for the process lifetime.
    vi.stubEnv("PLATFORM_ENTITLEMENT_CACHE_TTL_MS", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ entitled: true }))
      .mockRejectedValueOnce(new Error("platform down"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlatformEntitlementClient();
    await client.resolve("ws-1", "karda");
    expect(cacheOf(client).size).toBe(1);

    // TTL 0 means the entry is already expired. The re-read must delete it,
    // and the unreachable outcome must not be cached in its place.
    const second = await client.resolve("ws-1", "karda");
    expect(second.kind).toBe("unreachable");
    expect(cacheOf(client).size).toBe(0);
  });

  it("keys the entry by caller product as well as workspace - one workspace reads differently under two products (ADR-013 D11)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ entitled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlatformEntitlementClient();
    await client.resolve("ws-1", "karda");
    await client.resolve("ws-1", "arda");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("product=karda");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("product=arda");
    expect([...cacheOf(client).keys()]).toEqual(["karda:ws-1", "arda:ws-1"]);
  });

  it("evicts the oldest entry once the cache is at its cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ entitled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlatformEntitlementClient();
    const cache = cacheOf(client);
    const expiresAt = Date.now() + 60_000;
    for (let i = 0; i < CACHE_MAX_ENTRIES; i += 1) {
      cache.set(`karda:ws-${i}`, { outcome: { kind: "resolved" }, expiresAt });
    }

    await client.resolve("ws-new", "karda");

    // Map iteration order is insertion order: karda:ws-0 is the oldest and goes.
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(cache.has("karda:ws-0")).toBe(false);
    expect(cache.has("karda:ws-new")).toBe(true);
  });
});

// vxture-platform#547: after the platform removed atlas from its product
// catalog, every consume answered `400 {"message":"unknown_product"}`. Atlas
// logged only the status and counted nothing, so the refusal was invisible
// except to someone reading the log line by line. The report now travels as
// raw tokens under the CALLER's product (ADR-010 / platform ADR-013); the
// refusal word, the log line and the outcome counters are the same contract.
describe("PlatformEntitlementClient.reportTokens", () => {
  const input = {
    workspaceId: "00000000-0000-4000-a000-000000000210",
    callerProductCode: "karda",
    requestId: "req-consume-spec",
    occurredAt: new Date("2026-10-03T08:00:00.000Z"),
    modelCode: "deepseek-chat",
    providerCode: "deepseek",
    tokens: { input: 9_000, output: 2_681, cacheWrite: 0, cacheRead: 0 },
  };

  function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.stubEnv("PLATFORM_API_URL", "http://platform.test");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_TOKEN", "internal-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the platform's refusal in the log line and counts it by that word", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { statusCode: 400, message: "unknown_product", error: "Bad Request" },
          false,
          400,
        ),
      ),
    );

    const outcome = await new PlatformEntitlementClient().reportTokens(input);

    expect(outcome).toEqual({ billed: false, notBilledBecause: "rejected" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("400 (unknown_product)"),
    );
    const scrape = await metricsRegistry.scrape();
    expect(scrape).toContain(
      'platform_consume_outcomes_total{metric="ai.tokens",outcome="rejected",reason="unknown_product"',
    );
  });

  it("labels free-text refusals by status, so another service cannot mint label values", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ message: "Workspace 42 is not allowed here" }, false, 403),
      ),
    );

    await new PlatformEntitlementClient().reportTokens(input);

    const scrape = await metricsRegistry.scrape();
    expect(scrape).toContain('outcome="rejected",reason="http_403"');
    expect(scrape).not.toContain("Workspace 42");
  });

  it("tells atlasHealth what happened to the report, the refusal word included (F3b-A)", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const record = vi.spyOn(atlasHealth, "recordConsume");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "unknown_product" }, false, 400)));

    await new PlatformEntitlementClient().reportTokens(input);

    expect(record).toHaveBeenCalledWith("rejected", "unknown_product");
  });

  it("sends the raw fact under the caller's product in the platform's four dimensions, and reads back what it became", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        event_id: "ue-1",
        token_event_id: "te-1",
        credits_micro: 5_840_500,
        credits_deducted: 6,
        gated: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens({
      ...input,
      attemptIndex: 0,
      outcome: "served",
      reasoningTokens: 100,
    });

    expect(outcome).toEqual({
      billed: true,
      usageEventId: "ue-1",
      tokenEventId: "te-1",
      creditsMicro: 5_840_500,
      creditsDeducted: 6,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://platform.test/usage/consume");
    expect((init.headers as Record<string, string>)["x-vxture-internal-auth"]).toBe("internal-secret");
    expect(sentBody(fetchMock)).toEqual({
      workspace_id: input.workspaceId,
      product: "karda",
      request_id: "req-consume-spec",
      attempt_index: 0,
      outcome: "served",
      occurred_at: "2026-10-03T08:00:00.000Z",
      model_code: "deepseek-chat",
      provider_code: "deepseek",
      tokens: { input: 9_000, output: 2_681, cache_write: 0, cache_read: 0 },
      reasoning_tokens: 100,
    });
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="billed",reason="ok"',
    );
  });

  it("never sends the old amount shape - the platform refuses a body carrying both", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await new PlatformEntitlementClient().reportTokens(input);

    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty("metric");
    expect(body).not.toHaveProperty("amount");
    expect(body).not.toHaveProperty("idempotency_key");
    expect(body).not.toHaveProperty("backfill");
  });

  it("a recorded-but-not-charged report is still billed, carrying the platform's skip reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ token_event_id: "te-2", credit_skip_reason: "pre_cutover" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens({
      ...input,
      backfill: true,
    });

    expect(outcome).toEqual({
      billed: true,
      tokenEventId: "te-2",
      creditSkipReason: "pre_cutover",
    });
    expect(sentBody(fetchMock).backfill).toBe(true);
  });

  it("does not adopt a skip reason it does not know - the row's dimension_status has a fixed vocabulary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ token_event_id: "te-3", credit_skip_reason: "mystery" }),
      ),
    );

    const outcome = await new PlatformEntitlementClient().reportTokens(input);

    expect(outcome).toEqual({ billed: true, tokenEventId: "te-3" });
  });

  it("a gated deduction is information, not a refusal - the call was already served", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ token_event_id: "te-4", credits_micro: 0, credits_deducted: 0, gated: true }),
      ),
    );

    const outcome = await new PlatformEntitlementClient().reportTokens(input);

    expect(outcome).toEqual({
      billed: true,
      tokenEventId: "te-4",
      creditsMicro: 0,
      creditsDeducted: 0,
      gated: true,
    });
  });

  it("counts a report with nothing in it as no_amount, without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens({
      ...input,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    });

    expect(outcome).toEqual({ billed: false, notBilledBecause: "no_amount" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="skipped",reason="no_amount"',
    );
  });

  it("still reports when only the unit counts carry the amount (rerank, parse)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens({
      ...input,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      parsePages: 3,
    });

    expect(outcome).toEqual({ billed: true });
    expect(sentBody(fetchMock).parse_pages).toBe(3);
  });

  it("refuses a negative count locally - the platform's CHECK would refuse the whole row, facts included", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens({
      ...input,
      tokens: { input: -1, output: 10, cacheWrite: 0, cacheRead: 0 },
    });

    expect(outcome).toEqual({ billed: false, notBilledBecause: "no_amount" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a report with no caller product as no_caller, without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens({
      ...input,
      callerProductCode: "",
    });

    expect(outcome).toEqual({ billed: false, notBilledBecause: "no_caller" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="skipped",reason="no_caller"',
    );
  });

  it("counts a report that never left because the platform is not configured", async () => {
    vi.stubEnv("PLATFORM_API_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens(input);

    expect(outcome).toEqual({ billed: false, notBilledBecause: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="skipped",reason="not_configured"',
    );
  });

  it("counts an unreachable platform as failed - the request was served, the fact is for the backfill", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const outcome = await new PlatformEntitlementClient().reportTokens(input);

    expect(outcome).toEqual({ billed: false, notBilledBecause: "failed" });
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="failed",reason="unreachable"',
    );
  });
});

describe("splitUsage", () => {
  it("takes the two cache kinds out of Atlas's all-inclusive prompt count", () => {
    expect(
      splitUsage({
        promptTokens: 1_000,
        completionTokens: 50,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 100,
      }),
    ).toEqual({ input: 300, output: 50, cacheWrite: 100, cacheRead: 600 });
  });

  it("clamps at zero when an upstream reports more cache than prompt", () => {
    expect(
      splitUsage({ promptTokens: 100, completionTokens: 1, cachedInputTokens: 150 }),
    ).toEqual({ input: 0, output: 1, cacheWrite: 0, cacheRead: 150 });
  });

  it("treats absent cache figures as zero and truncates fractions", () => {
    expect(splitUsage({ promptTokens: 10.9, completionTokens: 2.2 })).toEqual({
      input: 10,
      output: 2,
      cacheWrite: 0,
      cacheRead: 0,
    });
  });
});

describe("PlatformEntitlementClient bearer mode (delegated reporter)", () => {
  const report = {
    workspaceId: "ws-9",
    callerProductCode: "tenderforge",
    requestId: "req-9",
    occurredAt: new Date("2026-10-05T00:00:00.000Z"),
    tokens: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
  };

  beforeEach(() => {
    vi.stubEnv("PLATFORM_API_URL", "http://platform.test");
    vi.stubEnv("PLATFORM_S2S_AUTH_MODE", "bearer");
    vi.stubEnv("OIDC_CLIENT_ID", "atlas");
    vi.stubEnv("OIDC_CLIENT_SECRET", "s3cr3t");
    vi.stubEnv("PLATFORM_OIDC_TOKEN_URL", "http://idp.test/oidc/token");
    vi.stubEnv("OIDC_ISSUER", "");
    vi.stubEnv("OIDC_BACKCHANNEL_ISSUER", "");
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** fetch that answers the token endpoint with a ticket and everything else with `rest`. */
  function fetchWithToken(rest: Response, ticket = "tkt"): ReturnType<typeof vi.fn> {
    return vi.fn((url: string) =>
      Promise.resolve(
        String(url).endsWith("/oidc/token")
          ? (jsonResponse({ access_token: ticket, expires_in: 300 }) as Response)
          : rest,
      ),
    );
  }

  it("resolve presents a Bearer ticket, not the shared header", async () => {
    const fetchMock = fetchWithToken(jsonResponse({ entitled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().resolve("ws-9", "tenderforge");

    expect(outcome.kind).toBe("resolved");
    const c2 = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/platform/entitlements"),
    );
    const headers = (c2?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tkt");
    expect(headers["x-vxture-internal-auth"]).toBeUndefined();
  });

  it("resolve degrades (unreachable) when the token exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          String(url).endsWith("/oidc/token")
            ? (jsonResponse({ message: "invalid_client" }, false, 401) as Response)
            : (jsonResponse({ entitled: true }) as Response),
        ),
      ),
    );

    const outcome = await new PlatformEntitlementClient().resolve("ws-9", "tenderforge");

    expect(outcome.kind).toBe("unreachable");
  });

  it("resolve is not-configured when bearer mode lacks a client secret", async () => {
    vi.stubEnv("OIDC_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().resolve("ws-9", "tenderforge");

    expect(outcome).toEqual({ kind: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reportTokens presents a Bearer ticket and bills on 200", async () => {
    const fetchMock = fetchWithToken(jsonResponse({ token_event_id: "ev-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens(report);

    expect(outcome.billed).toBe(true);
    const consume = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith("/usage/consume"),
    );
    const headers = (consume?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tkt");
    expect(headers["x-vxture-internal-auth"]).toBeUndefined();
  });

  it("reportTokens is not billed (failed) when the token exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          String(url).endsWith("/oidc/token")
            ? (jsonResponse({ message: "invalid_client" }, false, 401) as Response)
            : (jsonResponse({}) as Response),
        ),
      ),
    );

    const outcome = await new PlatformEntitlementClient().reportTokens(report);

    expect(outcome).toEqual({ billed: false, notBilledBecause: "failed" });
  });

  it("reportTokens is not_configured when bearer mode lacks a client secret", async () => {
    vi.stubEnv("OIDC_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PlatformEntitlementClient().reportTokens(report);

    expect(outcome).toEqual({ billed: false, notBilledBecause: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
