/**
 * model-rate-limiter.service.spec.ts - RPM window + concurrency gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModelRateLimiterService,
  RateLimitBreach,
} from "./model-rate-limiter.service";

describe("ModelRateLimiterService", () => {
  let limiter: ModelRateLimiterService;

  beforeEach(() => {
    limiter = new ModelRateLimiterService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("checkRpm", () => {
    it("does nothing when the limit is unset - policies are opt-in per field", () => {
      expect(() => {
        for (let i = 0; i < 100; i += 1) {
          limiter.checkRpm("model-1:tenant-1", null);
          limiter.checkRpm("model-1:tenant-1", undefined);
        }
      }).not.toThrow();
    });

    it("allows requests up to the limit within the window", () => {
      for (let i = 0; i < 3; i += 1) {
        expect(() => limiter.checkRpm("model-1:tenant-1", 3)).not.toThrow();
      }
    });

    it("throws once the window's count reaches the limit", () => {
      for (let i = 0; i < 3; i += 1) {
        limiter.checkRpm("model-1:tenant-1", 3);
      }
      expect(() => limiter.checkRpm("model-1:tenant-1", 3)).toThrow(
        RateLimitBreach,
      );
    });

    it("resets the count once the window elapses", () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i += 1) {
        limiter.checkRpm("model-1:tenant-1", 3);
      }
      expect(() => limiter.checkRpm("model-1:tenant-1", 3)).toThrow(
        RateLimitBreach,
      );

      vi.advanceTimersByTime(60_000);

      expect(() => limiter.checkRpm("model-1:tenant-1", 3)).not.toThrow();
    });

    it("tracks separate keys independently - one tenant's usage never counts against another", () => {
      for (let i = 0; i < 3; i += 1) {
        limiter.checkRpm("model-1:tenant-1", 3);
      }
      expect(() => limiter.checkRpm("model-1:tenant-2", 3)).not.toThrow();
    });
  });

  describe("concurrency", () => {
    it("does nothing when the limit is unset", () => {
      expect(() => {
        for (let i = 0; i < 10; i += 1) {
          limiter.acquireConcurrency("model-1:tenant-1", null);
        }
      }).not.toThrow();
    });

    it("allows up to the limit concurrently", () => {
      limiter.acquireConcurrency("model-1:tenant-1", 2);
      expect(() =>
        limiter.acquireConcurrency("model-1:tenant-1", 2),
      ).not.toThrow();
    });

    it("throws once at the limit", () => {
      limiter.acquireConcurrency("model-1:tenant-1", 1);
      expect(() =>
        limiter.acquireConcurrency("model-1:tenant-1", 1),
      ).toThrow(RateLimitBreach);
    });

    it("admits a new request once a slot is released", () => {
      limiter.acquireConcurrency("model-1:tenant-1", 1);
      limiter.releaseConcurrency("model-1:tenant-1");
      expect(() =>
        limiter.acquireConcurrency("model-1:tenant-1", 1),
      ).not.toThrow();
    });

    it("releasing below zero is a no-op, not a negative count", () => {
      limiter.releaseConcurrency("never-acquired");
      // If this underflowed to -1, a limit of 1 would incorrectly still
      // admit two more requests before blocking.
      limiter.acquireConcurrency("never-acquired", 1);
      expect(() => limiter.acquireConcurrency("never-acquired", 1)).toThrow(
        RateLimitBreach,
      );
    });
  });
});
