import "reflect-metadata";

import { Body, Controller, HttpCode, Module, Post, Req } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  keepsRawBody,
  requestBodyParsers,
  resolveMaxRequestBodyBytes,
  toRequestBodyError,
} from "./request-body";
import { RetryAfterFilter } from "./retry-after.filter";
import { ModelRuntimeException } from "./runtime.errors";

// --- a real HTTP stack: the parsers, Nest's routing, and the global filter ---
//
// The failure this replaces was not in any one function: body-parser raised,
// Nest's fallback handler rendered `{statusCode, message}`, and no `code`
// reached the caller. Only an app that actually listens shows which of those
// layers answers, so the envelope is asserted on the wire, not on a mapping.

type RawRequest = { rawBody?: Buffer };

@Controller("v1/chat")
class ChatProbe {
  @Post()
  @HttpCode(200)
  receive(@Req() req: RawRequest, @Body() body: { padding?: string }) {
    return {
      paddingLength: body.padding?.length ?? 0,
      hasRawBody: req.rawBody !== undefined,
    };
  }
}

@Controller("provisioning/webhook")
class WebhookProbe {
  @Post()
  @HttpCode(200)
  receive(@Req() req: RawRequest) {
    return { rawBodyLength: req.rawBody?.length ?? null };
  }
}

@Module({
  controllers: [ChatProbe, WebhookProbe],
  providers: [{ provide: APP_FILTER, useClass: RetryAfterFilter }],
})
class ProbeModule {}

let app: INestApplication | undefined;

async function boot(limit: number): Promise<string> {
  app = await NestFactory.create(ProbeModule, {
    bodyParser: false,
    logger: false,
  });
  for (const parser of requestBodyParsers(limit)) app.use(parser);
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function post(base: string, path: string, body: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** A JSON body of exactly `bytes` bytes, padded with CJK text (3 bytes/char). */
function bodyOfSize(bytes: number): string {
  const shell = JSON.stringify({ endpointCode: "chat/fast", padding: "" });
  const room = bytes - Buffer.byteLength(shell);
  const padding = "招".repeat(Math.floor(room / 3)) + "x".repeat(room % 3);
  const body = JSON.stringify({ endpointCode: "chat/fast", padding });
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
}

describe("request body limit, over HTTP", () => {
  it("accepts the request that production refused (120,507 bytes, liaison 40-2609291955)", async () => {
    const base = await boot(DEFAULT_MAX_REQUEST_BODY_BYTES);

    const response = await post(base, "/v1/chat", bodyOfSize(120_507));

    expect(response.status).toBe(200);
  });

  it("accepts a body exactly at the limit", async () => {
    const base = await boot(DEFAULT_MAX_REQUEST_BODY_BYTES);

    const response = await post(
      base,
      "/v1/chat",
      bodyOfSize(DEFAULT_MAX_REQUEST_BODY_BYTES),
    );

    expect(response.status).toBe(200);
  });

  it("refuses one byte over with the X-1 envelope, naming both sizes", async () => {
    const base = await boot(4096);

    const response = await post(base, "/v1/chat", bodyOfSize(4097));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "request body 4097 bytes exceeds limit 4096 bytes",
      retryable: false,
    });
  });

  it("refuses malformed JSON with a code, not Nest's codeless 400", async () => {
    const base = await boot(4096);

    const response = await post(base, "/v1/chat", '{"endpointCode": ');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "REQUEST_BODY_MALFORMED",
      retryable: false,
    });
  });

  it("keeps the raw bytes for the webhook's HMAC, and only for the webhook", async () => {
    const base = await boot(4096);
    const body = '{"event":"tenant.provisioned",  "id":1}';

    const webhook = await post(base, "/provisioning/webhook", body);
    const chat = await post(base, "/v1/chat", '{"padding":"x"}');

    // Exact bytes, including the double space a re-serialisation would drop.
    expect(await webhook.json()).toEqual({
      rawBodyLength: Buffer.byteLength(body),
    });
    expect(await chat.json()).toEqual({ paddingLength: 1, hasRawBody: false });
  });
});

describe("resolveMaxRequestBodyBytes", () => {
  it("defaults to 16 MiB when unset or blank", () => {
    expect(resolveMaxRequestBodyBytes({})).toBe(16 * 1024 * 1024);
    expect(resolveMaxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: " " })).toBe(
      16 * 1024 * 1024,
    );
  });

  it("takes a whole number of bytes", () => {
    expect(
      resolveMaxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: "10485760" }),
    ).toBe(10_485_760);
  });

  // Refusing to start is the point: a value that silently fell back to the
  // default would leave the operator believing their number was in force.
  it.each(["16mb", "10MB", "1e7", "-1", "12.5", "0", "1023"])(
    "refuses %s at startup instead of falling back",
    (value) => {
      expect(() =>
        resolveMaxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: value }),
      ).toThrow(/MAX_REQUEST_BODY_BYTES/u);
    },
  );
});

describe("keepsRawBody", () => {
  const at = (url: string) => keepsRawBody({ url } as never);

  it("matches the webhook however Express would route it", () => {
    expect(at("/provisioning/webhook")).toBe(true);
    expect(at("/provisioning/webhook/")).toBe(true);
    expect(at("/Provisioning/Webhook?x=1")).toBe(true);
  });

  it("does not keep it anywhere else", () => {
    expect(at("/v1/chat")).toBe(false);
    expect(at("/provisioning/webhook-other")).toBe(false);
    expect(at("/capability/models")).toBe(false);
  });
});

describe("toRequestBodyError", () => {
  it("reports the received size when no Content-Length was sent", () => {
    const error = toRequestBodyError({
      type: "entity.too.large",
      status: 413,
      message: "request entity too large",
      received: 5000,
      limit: 4096,
    }) as ModelRuntimeException;

    expect(error.getResponse()).toMatchObject({
      message: "request body 5000 bytes exceeds limit 4096 bytes",
    });
  });

  it("leaves the parser's own 5xx alone rather than blaming the caller", () => {
    const internal = {
      type: "stream.encoding.set",
      status: 500,
      message: "stream encoding should not be set",
    };

    expect(toRequestBodyError(internal)).toBe(internal);
  });

  it("passes anything that is not a parser error through untouched", () => {
    const other = new Error("boom");

    expect(toRequestBodyError(other)).toBe(other);
  });
});
