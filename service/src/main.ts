import "reflect-metadata";
// Must stay ABOVE the AtlasModule/prisma imports: Prisma 7's driver adapter
// captures DATABASE_URL when src/prisma.ts evaluates (see src/env.ts).
import "./env";

import { NestFactory } from "@nestjs/core";

import { AtlasModule } from "./atlas.module";
import { prisma } from "./prisma";
import {
  requestBodyParsers,
  resolveMaxRequestBodyBytes,
} from "./runtime/request-body";

async function bootstrap(): Promise<void> {
  // Resolved before anything else so a bad MAX_REQUEST_BODY_BYTES stops the
  // process at startup, not on the first large request.
  const bodyLimit = resolveMaxRequestBodyBytes();

  await prisma.$connect();

  // bodyParser: false - Atlas registers its own parsers (runtime/request-body.ts):
  // Nest's default caps bodies at 100 KB and keeps req.rawBody on every request,
  // where only the provisioning webhook's HMAC check (docs/30-design/identity/
  // 080-rp-integration.md section 4 step 1) reads it.
  const app = await NestFactory.create(AtlasModule, { bodyParser: false });
  for (const parser of requestBodyParsers(bodyLimit)) app.use(parser);
  // No CORS on purpose: Atlas has no browser surface (S2S + operator plane via
  // opera-bff, server side), and enabling it would let a malicious page read
  // responses cross-origin.

  // PORT is what docker-compose sets; the container healthcheck probes
  // 127.0.0.1:3100, so this default must agree with compose.
  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port);
}

void bootstrap();
