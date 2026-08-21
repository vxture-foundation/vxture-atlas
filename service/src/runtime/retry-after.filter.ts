import { Catch, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";

import { ModelRuntimeException } from "./runtime.errors";

/** The response surface actually used here - Express, minus the Express types. */
interface HeaderResponse {
  status(code: number): this;
  setHeader(name: string, value: string): this;
  json(body: unknown): this;
  headersSent?: boolean;
}

/**
 * retry-after.filter.ts - put `retryAfterMs` on the wire where a client looks.
 *
 * `docs/30-design/200-s2s-provider-surface.md` promised a `429` with
 * `retryAfterMs` in the body **plus a standard `Retry-After` header**. The body
 * half shipped; the header never existed - no code path anywhere set it, and
 * `ModelRuntimeException` has no way to, since an `HttpException` carries a
 * status and a body and nothing else.
 *
 * That gap is not cosmetic even though the same number is in the body: HTTP
 * clients, SDK retry helpers and reverse proxies honour `Retry-After` without
 * being taught anything, and a consumer that wired up standard back-off gets
 * silence and falls back to its own guess - pacing against a limit it was told
 * the shape of.
 *
 * Deliberately narrow. It catches only `ModelRuntimeException`, and rebuilds
 * the exact body Nest's default handler would have sent (`getResponse()`, which
 * is the object the constructor passed to `super`). So the envelope every X-1
 * consumer branches on is unchanged, byte for byte, and the only difference on
 * the wire is one header on responses that carry `retryAfterMs`.
 *
 * `Retry-After` is integer SECONDS (RFC 9110 section 10.2.3). `retryAfterMs`
 * stays in the body because it is the precise value; the header is rounded UP,
 * never down - rounding 400ms to `0` would tell a client to retry immediately
 * against a gate that is still closed.
 */
@Catch(ModelRuntimeException)
export class RetryAfterFilter implements ExceptionFilter {
  catch(exception: ModelRuntimeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HeaderResponse>();
    const body = exception.getResponse();
    const status = exception.getStatus();

    // A streaming reply has already committed its headers and delivers errors
    // as SSE frames (G-2); writing a second status here would corrupt it.
    if (response.headersSent === true) return;

    const retryAfterMs =
      typeof body === "object" && body !== null
        ? (body as { retryAfterMs?: unknown }).retryAfterMs
        : undefined;

    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      response.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      );
    }

    response.status(status ?? HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
