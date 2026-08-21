import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";

import { S2sAuthGuard } from "../runtime/guards/s2s-auth.guard";
import type { S2sAuthenticatedRequest } from "../runtime/guards/s2s-auth.guard";
import { ParseService, type ParseResponse } from "./parse.service";
import type { ParseRequest } from "./parse.types";

@Controller("v1/parse")
@UseGuards(S2sAuthGuard)
export class ParseController {
  // Explicit @Inject: the deployed artifact is an esbuild bundle, which does
  // not emit `design:paramtypes`, so constructor injection by type alone
  // resolves to undefined at runtime even though tsconfig sets
  // emitDecoratorMetadata and the unit tests (swc) pass.
  constructor(
    @Inject(ParseService)
    private readonly parse: ParseService,
  ) {}

  // Attribution comes from the verified token, never the body (rule 8).
  @Post()
  run(
    @Body() body: ParseRequest,
    @Req() req: S2sAuthenticatedRequest,
  ): Promise<ParseResponse> {
    return this.parse.parse(body, req.s2sAuth);
  }
}
