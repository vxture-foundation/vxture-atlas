import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { ProvisioningWebhookService } from "./provisioning-webhook.service";
import type { ProvisioningWebhookPayload } from "./provisioning.types";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller("provisioning/webhook")
export class ProvisioningWebhookController {
  // Explicit @Inject: the deployed artifact is an esbuild bundle, which does
  // not emit `design:paramtypes`, so constructor injection by type alone
  // resolves to undefined at runtime even though tsconfig sets
  // emitDecoratorMetadata and the unit tests (swc) pass.
  constructor(
    @Inject(ProvisioningWebhookService)
    private readonly webhook: ProvisioningWebhookService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest,
    @Body() body: ProvisioningWebhookPayload,
    @Headers("x-vxture-signature") signature: string | undefined,
  ): Promise<{ status: "ok"; outcome: string }> {
    // rawBody is populated by Nest (NestFactory.create(..., { rawBody: true })
    // in main.ts). The signature MUST be verified over these exact bytes, never
    // a re-serialization of the already-parsed `body` - if rawBody is missing,
    // that is a bootstrap misconfiguration, not something to silently paper
    // over with a re-stringify that would verify the wrong bytes.
    if (!req.rawBody) {
      throw new UnauthorizedException(
        "Raw request body unavailable - cannot verify provisioning webhook signature",
      );
    }

    const outcome = await this.webhook.handle(req.rawBody, signature, body);
    return { status: "ok", outcome };
  }
}
