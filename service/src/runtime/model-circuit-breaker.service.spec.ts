/**
 * model-circuit-breaker.service.spec.ts - trip/cooldown/reset logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelCircuitBreakerService } from "./model-circuit-breaker.service";

describe("ModelCircuitBreakerService", () => {
  let breaker: ModelCircuitBreakerService;

  beforeEach(() => {
    breaker = new ModelCircuitBreakerService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not tripped for a model it has never seen", () => {
    expect(breaker.isTripped("unknown-model")).toBe(false);
  });

  it("stays untripped below the failure threshold", () => {
    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    expect(breaker.isTripped("flaky-model")).toBe(false);
  });

  it("trips once the threshold is reached", () => {
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    expect(breaker.isTripped("flaky-model")).toBe(true);
  });

  it("does not affect other models", () => {
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    expect(breaker.isTripped("healthy-model")).toBe(false);
  });

  it("recovers automatically once the cooldown elapses - half-open retry, no separate state machine", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    expect(breaker.isTripped("flaky-model")).toBe(true);

    vi.advanceTimersByTime(30_000);

    expect(breaker.isTripped("flaky-model")).toBe(false);
  });

  it("recordSuccess clears the circuit outright, not just resets the counter", () => {
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    expect(breaker.isTripped("flaky-model")).toBe(true);

    breaker.recordSuccess("flaky-model");

    expect(breaker.isTripped("flaky-model")).toBe(false);
  });

  it("a fresh failure after recordSuccess starts the count over, not re-trip immediately", () => {
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    breaker.recordSuccess("flaky-model");

    breaker.recordFailure("flaky-model");

    expect(breaker.isTripped("flaky-model")).toBe(false);
  });

  it("re-trips after cooldown if the half-open retry fails again", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("flaky-model");
    }
    vi.advanceTimersByTime(30_000);
    expect(breaker.isTripped("flaky-model")).toBe(false);

    breaker.recordFailure("flaky-model");

    expect(breaker.isTripped("flaky-model")).toBe(true);
  });
});
