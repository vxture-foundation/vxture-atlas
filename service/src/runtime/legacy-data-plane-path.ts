/**
 * legacy-data-plane-path.ts - what a retired data-plane path answers with, and
 * the signal that says when it can stop being served.
 *
 * The vocabulary lives in `../data-plane-route-names`; this file is only the
 * HTTP behaviour. Same split as the operator plane, for a different reason:
 * there the vocabulary had a second consumer (the audit middleware), here it
 * has one, and the split is kept anyway so the two planes read the same when
 * somebody compares them.
 *
 * Why both spellings are served rather than cut over: a cutover between a
 * caller and a callee that deploy independently breaks whichever moves second.
 * An addition breaks neither. The retired spelling then reports its own
 * retirement in the response - which is the part that matters, because the
 * alternative is a message somebody has to remember to send, and this repo has
 * been on the receiving end of that failure more than once.
 */

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";

import {
  DATA_PLANE_PATH_SUNSET,
  legacyDataPlaneRouteOf,
} from "../data-plane-route-names";
import { metricsRegistry } from "./metrics.registry";

/** RFC 8594 wants an HTTP-date, not ISO 8601. */
const SUNSET_HTTP_DATE = new Date(DATA_PLANE_PATH_SUNSET).toUTCString();

@Injectable()
export class LegacyDataPlanePathInterceptor implements NestInterceptor {
  // Return type taken from CallHandler rather than imported from rxjs: rxjs is
  // a transitive dependency of @nestjs/common here, not a declared one, and
  // importing it directly would make this file depend on something the manifest
  // does not promise.
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): ReturnType<CallHandler["handle"]> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      originalUrl?: string;
      url?: string;
      s2sAuth?: { callerProductCode?: string };
    }>();

    const legacy = legacyDataPlaneRouteOf(req.originalUrl ?? req.url ?? "");
    if (legacy !== undefined) {
      const res = http.getResponse<{
        setHeader?: (name: string, value: string) => void;
      }>();

      // RFC 9745 (Deprecation) + RFC 8594 (Sunset, Link rel=successor-version).
      res.setHeader?.("Deprecation", "true");
      res.setHeader?.("Sunset", SUNSET_HTTP_DATE);
      res.setHeader?.(
        "Link",
        `<${legacy.successorPath}>; rel="successor-version"`,
      );

      // Labelled by calling PRODUCT, not just by path. On the operator plane the
      // same label is an operator id; here the question "who is still on the old
      // name" is answered by `act.sub`, because that is the identity a caller
      // cannot forge - and it is the identity the liaison round has to name when
      // removal is proposed. "Some traffic" does not tell anyone whom to talk to.
      metricsRegistry.incCounter("data_plane_legacy_path_requests_total", {
        path: legacy.key,
        product: req.s2sAuth?.callerProductCode ?? "unknown",
      });
    }

    return next.handle();
  }
}
