import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";

import { S2sAuthGuard } from "../runtime/guards/s2s-auth.guard";
import type { S2sAuthenticatedRequest } from "../runtime/guards/s2s-auth.guard";
import { EmbeddingService } from "./embedding.service";
import type { EmbedRequest, EmbedResponse } from "./embedding.types";

@Controller("v1/embed")
@UseGuards(S2sAuthGuard)
export class EmbeddingController {
  // Explicit @Inject: the deployed artifact is an esbuild bundle, which does
  // not emit `design:paramtypes`, so constructor injection by type alone
  // resolves to undefined at runtime even though tsconfig sets
  // emitDecoratorMetadata and the unit tests (swc) pass.
  constructor(
    @Inject(EmbeddingService)
    private readonly embedding: EmbeddingService,
  ) {}

  // Attribution comes from the verified token, never the body (rule 8).
  @Post()
  embed(
    @Body() body: EmbedRequest,
    @Req() req: S2sAuthenticatedRequest,
  ): Promise<EmbedResponse> {
    return this.embedding.embed(body, req.s2sAuth);
  }
}
