/**
 * health.controller.ts - 模型平台健康检查入口
 * @package @atlas/service
 * @layer Domain
 * @category controller
 */

import { Controller, Get, Inject, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import {
  AtlasHealthService,
  type AtlasLiveResponse,
  type AtlasReadyResponse,
} from "./health.service";
import { InternalDiagnosticsGuard } from "./guards/internal-diagnostics.guard";
import { renderStatusPage } from "./status-page";

@Controller()
export class HealthController {
  constructor(
    @Inject(AtlasHealthService)
    private readonly health: AtlasHealthService,
  ) {}

  // Bare /healthz|/readyz only - no prefixed aliases.
  @Get("healthz")
  live(): AtlasLiveResponse {
    return this.health.live();
  }

  @Get("readyz")
  ready(): Promise<AtlasReadyResponse> {
    return this.health.ready();
  }

  @Get("internal/diagnostics")
  @UseGuards(InternalDiagnosticsGuard)
  diagnostics(): Promise<AtlasReadyResponse> {
    return this.health.diagnostics();
  }

  // Human-readable equivalent of karda/arda's portal /status page - same
  // gating as diagnostics (InternalDiagnosticsGuard), same underlying data,
  // just rendered as HTML since Atlas has no portal to host a Next.js page in.
  // It reads diagnostics(), not ready(): the guard is what earns the detail,
  // and rendering the redacted public view to an already-authorized operator
  // would withhold the cause of a failure for no gain.
  @Get("status")
  @UseGuards(InternalDiagnosticsGuard)
  async statusPage(@Res() res: Response): Promise<void> {
    const data = await this.health.diagnostics();
    res.type("html").send(renderStatusPage(data));
  }
}
