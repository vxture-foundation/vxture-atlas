/**
 * request-body.ts - the one place a request body is read, and how big it may be.
 *
 * ## Why Atlas owns the parser instead of Nest's default
 *
 * Nest's built-in parser is body-parser at its factory default: 100 KB. That is
 * a web-form number, not a model-gateway number, and it was never chosen here -
 * it was simply what `NestFactory.create` did. A real tenderforge request of
 * 120,507 bytes (one bid document for interpretation) was refused in
 * production before it reached routing (vx-agent-bid liaison 40-2609291955).
 *
 * What the limit is FOR: body-parser buffers the whole body and then runs a
 * synchronous `JSON.parse`, so the limit bounds one request's memory and
 * event-loop cost. It is a guard for this process, not a business rule about
 * how much a model may read - that is the model's context window, a
 * per-model fact in the registry. The two cannot be merged: this check runs
 * before the body is parsed, so the route and model are not known yet.
 *
 * ## The raw body is kept for the webhook only
 *
 * The provisioning webhook verifies an HMAC over the exact bytes it received,
 * so it needs `req.rawBody`. Nest's `rawBody: true` keeps the buffer on EVERY
 * request for its whole lifetime - for a streamed chat, minutes - which at a
 * 16 MiB cap is a second full copy per in-flight call for no reader. body-parser's
 * `verify` hook sees the buffer before parsing, so it is kept only where it is
 * read. Nest's `useBodyParser` deliberately withholds `verify`, which is why
 * `express.json` is registered directly (and why `express` is a direct
 * dependency rather than a transitive one).
 *
 * ## Errors reach the caller as X-1, not as Nest's fallback
 *
 * A parser error used to fall through to Nest's unknown-exception handler:
 * `413 {statusCode, message}` with no `code` and no `retryable`, logged as an
 * unhandled error. Wrapping it as ModelRuntimeException sends it through the
 * same envelope every other /v1 refusal uses.
 */

import { HttpStatus } from "@nestjs/common";
import { json, urlencoded } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { IncomingMessage } from "node:http";

import { ModelRuntimeException } from "./runtime.errors";

/**
 * 16 MiB. Sized against two facts, measured 2026-09-29:
 *
 * - What callers need: a 1M-token context of Chinese text is roughly 3-5 MB
 *   of UTF-8, and up to twice that if the client escapes non-ASCII as `\uXXXX`
 *   (Python's `json.dumps` default). The largest request tenderforge
 *   plans is ~1.5 MB.
 * - What it costs: one request at the cap peaks at about 55 MB of process
 *   memory (buffer + decoded string + parsed object + the upstream
 *   re-serialisation), against ~375 MB of headroom in the 512M container.
 *
 * Every upstream that publishes a limit sits above this one (Claude 32 MB,
 * Bedrock 20 MB, OpenAI higher), so it does not become a new bottleneck
 * behind which the upstream would have accepted the request.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/** Operator override, in bytes. */
export const MAX_REQUEST_BODY_BYTES_ENV = "MAX_REQUEST_BODY_BYTES";

/** Paths whose handlers read `req.rawBody`. Compared lower-cased, no trailing slash. */
const RAW_BODY_PATHS = new Set(["/provisioning/webhook"]);

/**
 * Read the limit. An unset variable means the default; a set-but-unusable one
 * refuses to start. Falling back silently would leave an operator believing
 * their value is in force while the process runs on another number - the
 * configurable-but-inert shape this repo does not accept.
 */
export function resolveMaxRequestBodyBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[MAX_REQUEST_BODY_BYTES_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_REQUEST_BODY_BYTES;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(
      `${MAX_REQUEST_BODY_BYTES_ENV}=${raw} is not a whole number of bytes ` +
        `(no units: 16 MiB is 16777216).`,
    );
  }
  const bytes = Number(raw.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 1024) {
    throw new Error(
      `${MAX_REQUEST_BODY_BYTES_ENV}=${raw} is out of range (minimum 1024).`,
    );
  }
  return bytes;
}

/** Does this request's handler need the exact received bytes? */
export function keepsRawBody(req: IncomingMessage): boolean {
  const url = (req as Partial<Request>).originalUrl ?? req.url ?? "";
  const path = url.split("?")[0]?.toLowerCase().replace(/\/+$/u, "") ?? "";
  return RAW_BODY_PATHS.has(path);
}

interface BodyParserError {
  type: string;
  status?: number;
  statusCode?: number;
  message: string;
  length?: number;
  received?: number;
  limit?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { type?: unknown }).type === "string"
  );
}

/**
 * Parser error -> X-1 envelope. Only client errors are translated; anything the
 * parser reports as its own 5xx is passed through untouched rather than
 * relabelled as the caller's fault.
 */
export function toRequestBodyError(error: unknown): unknown {
  if (!isBodyParserError(error)) return error;
  const status = error.status ?? error.statusCode ?? 500;
  if (status >= 500) return error;

  if (error.type === "entity.too.large") {
    const size = error.length ?? error.received;
    return new ModelRuntimeException(
      HttpStatus.PAYLOAD_TOO_LARGE,
      "PAYLOAD_TOO_LARGE",
      `request body ${size === undefined ? "size unknown" : `${size} bytes`} ` +
        `exceeds limit ${error.limit ?? "unknown"} bytes`,
    );
  }

  return new ModelRuntimeException(
    HttpStatus.BAD_REQUEST,
    "REQUEST_BODY_MALFORMED",
    `request body could not be read (${error.type}): ${error.message}`,
  );
}

function translated(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (error?: unknown) => {
      next(error === undefined ? undefined : toRequestBodyError(error));
    });
  };
}

/**
 * The parsers, in the order Nest would have registered its own. Must be
 * installed before the first route is mapped (i.e. before `listen`/`init`),
 * with the app created under `bodyParser: false`.
 */
export function requestBodyParsers(limit: number): RequestHandler[] {
  const verify = (req: IncomingMessage, _res: unknown, buf: Buffer): void => {
    if (keepsRawBody(req)) (req as { rawBody?: Buffer }).rawBody = buf;
  };
  return [
    translated(json({ limit, verify })),
    translated(urlencoded({ limit, extended: true, verify })),
  ];
}
