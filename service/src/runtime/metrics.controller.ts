/**
 * metrics.controller.ts - 模型平台指标抓取入口
 * @package @atlas/service
 * @layer Domain
 * @category controller
 */
import { Controller, Get, Header, UseGuards } from "@nestjs/common";

import { metricsRegistry } from "./metrics.registry";
import { InternalDiagnosticsGuard } from "./guards/internal-diagnostics.guard";

@Controller()
export class MetricsController {
  @UseGuards(InternalDiagnosticsGuard)
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  scrape(): Promise<string> {
    return metricsRegistry.scrape();
  }
}
