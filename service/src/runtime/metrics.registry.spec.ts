/**
 * metrics.registry.spec.ts - 模型平台轻量指标注册表测试
 * @package @atlas/service
 * @layer Domain
 * @category test
 */

import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "./metrics.registry";

describe("MetricsRegistry", () => {
  it("scrapes counters with labels", async () => {
    const registry = new MetricsRegistry();

    registry.incCounter("model_requests_total", {
      status: "success",
      operation: "chat",
    });
    registry.incCounter(
      "model_requests_total",
      { status: "success", operation: "chat" },
      2,
    );

    await expect(registry.scrape()).resolves.toContain(
      'model_requests_total{operation="chat",status="success",provider="unknown"} 3',
    );
  });

  it("scrapes histogram sum and count", async () => {
    const registry = new MetricsRegistry();

    registry.observeHistogram("model_request_latency_ms", 10, {
      operation: "chat",
    });
    registry.observeHistogram("model_request_latency_ms", 15, {
      operation: "chat",
    });

    const output = await registry.scrape();
    expect(output).toContain(
      'model_request_latency_ms_sum{operation="chat",provider="unknown"} 25',
    );
    expect(output).toContain(
      'model_request_latency_ms_count{operation="chat",provider="unknown"} 2',
    );
  });

  it("escapes label values", async () => {
    const registry = new MetricsRegistry();

    registry.incCounter("model_request_errors_total", {
      code: 'PROVIDER_"DOWN"',
    });

    await expect(registry.scrape()).resolves.toContain(
      'model_request_errors_total{code="PROVIDER_\\\"DOWN\\\"",provider="unknown"} 1',
    );
  });
});

describe("MetricsRegistry.snapshotProviderTraffic (TD-030)", () => {
  it("derives attempts/successes/errors/latency per provider from the runtime counters", async () => {
    const registry = new MetricsRegistry();

    // two attempts at doubao: one success, one failure
    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "started",
      provider: "doubao",
    });
    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "started",
      provider: "doubao",
    });
    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "success",
      provider: "doubao",
    });
    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "provider_error",
      provider: "doubao",
    });
    registry.observeHistogram("model_request_latency_ms", 100, {
      operation: "chat",
      provider: "doubao",
    });
    registry.observeHistogram("model_request_latency_ms", 300, {
      operation: "chat",
      provider: "doubao",
    });

    // an attempt the breaker skipped must not count as a real attempt
    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "circuit_open",
      provider: "doubao",
    });

    // provider-less events (request start/failure before routing) stay out
    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "started",
    });

    const snapshot = await registry.snapshotProviderTraffic();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      provider: "doubao",
      attempts: 2,
      successes: 1,
      errors: 1,
      avgLatencyMs: 200,
      // 2 observations (100, 300); 50th-percentile rank (1) is reached by
      // the le=100 bucket.
      p50LatencyMs: 100,
    });
    expect(snapshot[0]!.lastObservedAt).not.toBeNull();
  });

  it("caps the percentile estimate to the largest finite bucket boundary when the rank falls in the +Inf bucket", async () => {
    const registry = new MetricsRegistry();

    registry.observeHistogram("model_request_latency_ms", 40, {
      operation: "chat",
      provider: "zhipu",
    });
    // 19 extreme outliers beyond every finite bucket (>10_000ms) - the
    // 95th-percentile rank (of 20 total) only reaches the +Inf bucket.
    for (let i = 0; i < 19; i++) {
      registry.observeHistogram("model_request_latency_ms", 50_000, {
        operation: "chat",
        provider: "zhipu",
      });
    }

    const [snapshot] = await registry.snapshotProviderTraffic();

    expect(snapshot!.p95LatencyMs).toBe(10_000);
  });

  it("returns null for a provider with no latency observations yet", async () => {
    const registry = new MetricsRegistry();

    registry.incCounter("model_requests_total", {
      operation: "chat",
      status: "started",
      provider: "claude",
    });

    const [snapshot] = await registry.snapshotProviderTraffic();

    expect(snapshot).toMatchObject({
      provider: "claude",
      attempts: 1,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
    });
  });
});

describe("MetricsRegistry.getInFlightRequests / getProcessStartedAt", () => {
  it("sums the in-flight gauge across labels", async () => {
    const registry = new MetricsRegistry();

    registry.changeGauge("model_request_in_flight", 1, { operation: "chat" });
    registry.changeGauge("model_request_in_flight", 1, {
      operation: "stream",
    });
    registry.changeGauge("model_request_in_flight", -1, {
      operation: "chat",
    });

    await expect(registry.getInFlightRequests()).resolves.toBe(1);
  });

  it("reports a stable ISO timestamp captured at construction", () => {
    const registry = new MetricsRegistry();

    expect(() => new Date(registry.getProcessStartedAt())).not.toThrow();
    expect(registry.getProcessStartedAt()).toBe(registry.getProcessStartedAt());
  });
});
