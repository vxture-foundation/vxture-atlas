import "reflect-metadata";
// Must stay ABOVE the AtlasModule/prisma imports: Prisma 7's driver adapter
// captures DATABASE_URL when src/prisma.ts evaluates (see src/env.ts).
import "./env";

import { NestFactory } from "@nestjs/core";

import { AtlasModule } from "./atlas.module";
import { prisma } from "./prisma";

async function bootstrap(): Promise<void> {
  await prisma.$connect();

  // rawBody: true - the provisioning webhook (POST /provisioning/webhook) must
  // verify its HMAC signature over the exact raw request bytes, not a
  // re-serialized JSON.stringify(parsedBody) (docs/30-design/identity/080-rp-integration.md
  // section 4 step 1). Nest/Express exposes this as req.rawBody when enabled.
  const app = await NestFactory.create(AtlasModule, { rawBody: true });
  // No CORS on purpose: Atlas has no browser surface (S2S + operator plane via
  // opera-bff, server side), and enabling it would let a malicious page read
  // responses cross-origin.

  // PORT is what docker-compose sets; the container healthcheck probes
  // 127.0.0.1:3100, so this default must agree with compose.
  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port);
}

void bootstrap();
