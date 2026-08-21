import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ProviderKeyCache } from "./provider-key-cache";

/**
 * The cache exists because making the vault the only key source put a database
 * round trip plus an AES decrypt on every `/v1` call. The thing that makes it
 * SAFE is not the TTL - it is that every operator mutation drops the entry
 * before returning. So most of what is worth testing here is invalidation.
 */
describe("ProviderKeyCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves a stored key without going back to the source", () => {
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "default", "sk-1");

    expect(cache.get("zhipu", "default")).toBe("sk-1");
    expect(cache.stats()).toMatchObject({ size: 1, hits: 1 });
  });

  it("keeps providers and aliases apart", () => {
    // The composite key is (provider, alias). Collapsing them would hand one
    // provider's secret to another - the worst available bug in this file.
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "default", "sk-zhipu");
    cache.set("doubao", "default", "sk-doubao");

    expect(cache.get("zhipu", "default")).toBe("sk-zhipu");
    expect(cache.get("doubao", "default")).toBe("sk-doubao");
  });

  it("cannot be confused by a separator inside an alias", () => {
    const cache = new ProviderKeyCache();
    cache.set("a", "b\nc", "sk-1");

    // If the key were `${provider}:${alias}`, ("a:b", "c") would collide here.
    expect(cache.get("a:b", "c")).toBeUndefined();
  });

  it("drops an invalidated alias immediately, not on a timer", () => {
    // This is the security property. A revoked key that answers one more
    // request because a timer has not fired is a defect, not a trade-off.
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "default", "sk-old");

    cache.invalidate("zhipu", "default");

    expect(cache.get("zhipu", "default")).toBeUndefined();
  });

  it("invalidates a whole provider without touching the others", () => {
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "a", "1");
    cache.set("zhipu", "b", "2");
    cache.set("doubao", "a", "3");

    cache.invalidateProvider("zhipu");

    expect(cache.get("zhipu", "a")).toBeUndefined();
    expect(cache.get("zhipu", "b")).toBeUndefined();
    expect(cache.get("doubao", "a")).toBe("3");
  });

  it("expires an entry after the backstop TTL", () => {
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "default", "sk-1");

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(cache.get("zhipu", "default")).toBeUndefined();
  });

  it("still serves just before the TTL boundary", () => {
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "default", "sk-1");

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);

    expect(cache.get("zhipu", "default")).toBe("sk-1");
  });

  it("caps entries so a runaway cannot grow it without bound", () => {
    const cache = new ProviderKeyCache();
    for (let i = 0; i < 600; i += 1) cache.set("p", `alias-${i}`, `sk-${i}`);

    expect(cache.stats().size).toBeLessThanOrEqual(512);
    // The newest survives; the cap evicts from the front.
    expect(cache.get("p", "alias-599")).toBe("sk-599");
  });

  it("reports counts and never a key", () => {
    const cache = new ProviderKeyCache();
    cache.set("zhipu", "default", "sk-secret");
    cache.get("zhipu", "default");
    cache.get("zhipu", "missing");

    const stats = cache.stats();
    expect(stats).toEqual({ size: 1, hits: 1, misses: 1 });
    expect(JSON.stringify(stats)).not.toContain("sk-secret");
  });
});
