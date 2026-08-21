import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";

import { S2sAuthGuard } from "../runtime/guards/s2s-auth.guard";
import type { S2sAuthenticatedRequest } from "../runtime/guards/s2s-auth.guard";
import { RerankService } from "./rerank.service";
import type { RerankRequest, RerankResponse } from "./rerank.types";

@Controller("v1/rerank")
@UseGuards(S2sAuthGuard)
export class RerankController {
  // Explicit @Inject: the deployed artifact is an esbuild bundle, which does
  // not emit `design:paramtypes`, so constructor injection by type alone
  // resolves to undefined at runtime even though tsconfig sets
  // emitDecoratorMetadata and the unit tests (swc) pass.
  constructor(
    @Inject(RerankService)
    private readonly rerank: RerankService,
  ) {}

  // Attribution comes from the verified token, never the body (rule 8).
  @Post()
  score(
    @Body() body: RerankRequest,
    @Req() req: S2sAuthenticatedRequest,
  ): Promise<RerankResponse> {
    return this.rerank.rerank(body, req.s2sAuth);
  }
}
