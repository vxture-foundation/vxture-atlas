/**
 * metrics.controller.spec.ts - 模型平台指标抓取控制器测试
 * @package @atlas/service
 * @layer Domain
 * @category test
 */
import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";

import { MetricsController } from "./metrics.controller";
import { InternalDiagnosticsGuard } from "./guards/internal-diagnostics.guard";
import { metricsRegistry } from "./metrics.registry";

describe("MetricsController", () => {
  beforeEach(() => {
    vi.spyOn(metricsRegistry, "scrape").mockResolvedValue("metric_payload\n");
  });

  it("should expose metrics content", () => {
    const controller = new MetricsController();

    expect(controller.scrape()).resolves.toBe("metric_payload\n");
  });

  it("should protect /metrics with internal diagnostics guard", () => {
    const guardMetadata = Reflect.getMetadata(
      GUARDS_METADATA,
      MetricsController.prototype,
      "scrape",
    );

    expect(guardMetadata).toContain(InternalDiagnosticsGuard);
  });
});
