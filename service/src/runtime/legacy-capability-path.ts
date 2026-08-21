/**
 * legacy-capability-path.ts - what a retired operator path answers with, and
 * the signal that says when it can stop being served.
 *
 * The vocabulary lives in `../capability-route-names` because the audit
 * middleware needs it too; this file is only the HTTP behaviour.
 *
 * Why both spellings are served at all: #206 objected that
 *
 * > 代理层与被代理者之间没有并存期可言 - 先动的那一方会让另一方直接断
 *
 * which is true of a CUTOVER and false of an ADDITION. One handler registers
 * both paths, so neither side has to move on the other's deploy. The retired
 * spelling then reports its own retirement in the response, rather than in a
 * message somebody has to remember to send - the failure this repo has hit
 * repeatedly from the other side.
 */

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";

import {
  CAPABILITY_PATH_SUNSET,
  RENAMED_CAPABILITY_SEGMENTS,
  legacySegmentOf,
} from "../capability-route-names";
import { metricsRegistry } from "./metrics.registry";

/** RFC 8594 wants an HTTP-date, not ISO 8601. */
const SUNSET_HTTP_DATE = new Date(CAPABILITY_PATH_SUNSET).toUTCString();

@Injectable()
export class LegacyCapabilityPathInterceptor implements NestInterceptor {
  // Return type taken from CallHandler rather than imported from rxjs: rxjs is
  // a transitive dependency of @nestjs/common here, not a declared one, and
  // importing it directly would make this file depend on something the
  // manifest does not promise.
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): ReturnType<CallHandler["handle"]> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      originalUrl?: string;
      url?: string;
      operatorAuth?: { operatorId?: string };
    }>();

    const legacy = legacySegmentOf(req.originalUrl ?? req.url ?? "");
    if (legacy !== undefined) {
      const canonical = RENAMED_CAPABILITY_SEGMENTS[legacy] as string;
      const res = http.getResponse<{
        setHeader?: (name: string, value: string) => void;
      }>();

      // RFC 9745 (Deprecation) + RFC 8594 (Sunset, Link rel=successor-version).
      res.setHeader?.("Deprecation", "true");
      res.setHeader?.("Sunset", SUNSET_HTTP_DATE);
      res.setHeader?.(
        "Link",
        `</capability/${canonical}>; rel="successor-version"`,
      );

      // Labelled by operator, not just by path: "who is still calling this" is
      // the question that decides whether the old name can be deleted, and
      // "some traffic" does not answer it.
      metricsRegistry.incCounter("capability_legacy_path_requests_total", {
        path: legacy,
        operator: req.operatorAuth?.operatorId ?? "unknown",
      });
    }

    return next.handle();
  }
}
