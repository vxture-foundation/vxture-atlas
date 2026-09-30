import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { metricsRegistry } from "../runtime/metrics.registry";
import { PlatformEntitlementClient } from "./platform-entitlement.client";

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

    const outcome = await new PlatformEntitlementClient().resolve("ws-1");

    expect(outcome).toEqual({ kind: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a live cache entry instead of asking the platform twice", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ entitled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlatformEntitlementClient();
    const first = await client.resolve("ws-1");
    const second = await client.resolve("ws-1");

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
    await client.resolve("ws-1");
    expect(cacheOf(client).size).toBe(1);

    // TTL 0 means the entry is already expired. The re-read must delete it,
    // and the unreachable outcome must not be cached in its place.
    const second = await client.resolve("ws-1");
    expect(second.kind).toBe("unreachable");
    expect(cacheOf(client).size).toBe(0);
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
      cache.set(`ws-${i}`, { outcome: { kind: "resolved" }, expiresAt });
    }

    await client.resolve("ws-new");

    // Map iteration order is insertion order: ws-0 is the oldest and goes.
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(cache.has("ws-0")).toBe(false);
    expect(cache.has("ws-new")).toBe(true);
  });
});

// vxture-platform#547: after the platform removed atlas from its product
// catalog, every consume answered `400 {"message":"unknown_product"}`. Atlas
// logged only the status and counted nothing, so the refusal was invisible
// except to someone reading the log line by line.
describe("PlatformEntitlementClient.consume", () => {
  const input = {
    workspaceId: "00000000-0000-4000-a000-000000000210",
    metric: "atlas.chat",
    amount: 11_681,
    idempotencyKey: "req-consume-spec",
  };

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

    const outcome = await new PlatformEntitlementClient().consume(input);

    expect(outcome).toEqual({ billed: false, notBilledBecause: "rejected" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("400 (unknown_product)"),
    );
    const scrape = await metricsRegistry.scrape();
    expect(scrape).toContain(
      'platform_consume_outcomes_total{metric="atlas.chat",outcome="rejected",reason="unknown_product"',
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

    await new PlatformEntitlementClient().consume(input);

    const scrape = await metricsRegistry.scrape();
    expect(scrape).toContain('outcome="rejected",reason="http_403"');
    expect(scrape).not.toContain("Workspace 42");
  });

  it("counts a billed consume", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    const outcome = await new PlatformEntitlementClient().consume(input);

    expect(outcome.billed).toBe(true);
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="billed",reason="ok"',
    );
  });

  it("counts a consume that never left because the platform is not configured", async () => {
    vi.stubEnv("PLATFORM_API_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await new PlatformEntitlementClient().consume(input);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await metricsRegistry.scrape()).toContain(
      'outcome="skipped",reason="not_configured"',
    );
  });
});
