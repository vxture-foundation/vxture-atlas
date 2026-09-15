import { Inject, Injectable, NestMiddleware } from "@nestjs/common";

import { AuditService } from "./audit.service";
import { canonicalCapabilitySegment } from "../capability-route-names";
import type { OperatorAuthContext } from "../runtime/guards/operator-auth.guard";

/**
 * Records every mutating operator request into `audit.change_records`
 * (product_250 M-5).
 *
 * **Why this is derived from the route rather than called from each service
 * method.** There are around thirty write routes on the operator plane.
 * Explicit calls would audit exactly the ones someone remembered to annotate,
 * and forgetting one fails silently: the endpoint works, the change lands, and
 * only a later investigation finds the trail has a hole with no way to
 * reconstruct what is missing. Deriving from the route inverts that - a new
 * write route is audited the moment it exists, and excluding one takes
 * deliberate effort instead of an oversight.
 *
 * The route already carries everything needed:
 * `POST /capability/providers/:id/deactivate` is resource, id and action in
 * order, with nothing to infer.
 *
 * **Why middleware and not an interceptor.** The record is written from
 * `res.on("finish")`, so the outcome is the status code the client actually
 * received - after exception filters have had their say. An interceptor sees
 * the thrown error instead, and would have to re-derive the status the filter
 * was going to pick. Middleware also keeps `rxjs` out of this file's imports;
 * it is not a direct dependency of this package.
 *
 * Middleware runs before the guard chain, but the handler is registered on
 * `finish` - by the time it fires, `OperatorAuthGuard` has long since attached
 * the verified identity.
 *
 * Reads are never recorded. Auditing GETs would bury the ~30 writes a week
 * that matter under the thousands of list calls a dashboard makes on refresh,
 * and M-5 asks for a *change* trail.
 */
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  use(request: AuditableRequest, response: AuditableResponse, next: () => void): void {
    const descriptor = describeMutation(request);
    if (!descriptor) {
      next();
      return;
    }

    response.on("finish", () => {
      const status = response.statusCode ?? 0;
      void this.audit.record({
        ...descriptor,
        // A guard rejection never reaches a handler, but it did reach the
        // plane, and a burst of them is the shape most worth seeing. An
        // unauthenticated attempt has no operator identity by definition -
        // recorded as "unknown" rather than dropped, because a write attempt
        // with no attributable operator is exactly what an auditor looks for.
        actorId: request.operatorAuth?.operatorId ?? "unknown",
        // The TOKEN keeps calling this `actorClientId` - it is `act.sub`, the
        // workforce RP, and that is the accurate name for what the token
        // carries. The AUDIT RECORD calls the same value `actorConsole`,
        // because in the audit vocabulary the question it answers is "which
        // management surface did this change come from". The rename is X-3's
        // and stops at the record boundary; it is not an auth-plumbing change.
        ...(request.operatorAuth?.actorClientId !== undefined
          ? { actorConsole: request.operatorAuth.actorClientId }
          : {}),
        // A handler that minted its own request id hands it over on the
        // request (see `AuditRequestIdCarrier`). Read at `finish`, which is
        // after the handler ran - reading it any earlier would always miss.
        ...(request.auditRequestId !== undefined
          ? { requestId: request.auditRequestId }
          : {}),
        // The status the client actually got, so a rejected change can never
        // be mistaken for one that landed.
        outcome: status >= 200 && status < 400 ? "success" : "failure",
      });
    });

    next();
  }
}

/**
 * What a handler sets when its write produced a request id of its own.
 *
 * The probe routes are the case this exists for: `probe-<uuid>` is also the
 * `reqlog.request_records.request_id` of the row the probe wrote, and that row
 * is attributed to the platform sentinel - a probe belongs to no tenant, so the
 * row cannot say who ran it. This record can (`actorId`). Without the id the
 * two only line up by timestamp, which stops being an answer the moment two
 * operators probe within the same second. With it, "who spent these tokens"
 * is a join on one key.
 *
 * Deliberately NOT written into the reqlog row's `user_id`: that column is the
 * customer end user carried by an S2S token, and an operator is a workforce
 * identity. Mixing the two realms would put probes into end-user usage.
 */
export interface AuditRequestIdCarrier {
  auditRequestId?: string;
}

interface AuditableRequest extends AuditRequestIdCarrier {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  body?: unknown;
  operatorAuth?: OperatorAuthContext;
}

interface AuditableResponse {
  statusCode?: number;
  on(event: "finish", listener: () => void): unknown;
}

/** Methods that change something. Everything else is a read. */
// `PUT` stays after the operator routes moved to PATCH (product_251 M-B1), and
// deliberately so: this middleware is registered `forRoutes("*")`, so a
// straggler `PUT /capability/models/:id` still passes through it and lands in
// `audit.change_records` as `action='update', outcome='failure'` (the outcome
// is derived from the status the client actually got, and an unrouted verb is
// a 404). That turns "has opera finished migrating" into a query against a
// table that already exists, rather than instrumentation somebody has to
// remember to add. Remove `PUT` here only once that query is reliably empty.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Sub-resource segments that name an action rather than a nested resource.
 * Anything else in that position is read as part of the resource path, so an
 * unfamiliar route degrades to a recognisable record instead of a wrong one.
 */
const ACTION_SEGMENTS = new Set([
  "activate",
  "deactivate",
  // product_251 X-4. Without these two here, `POST /capability/models/:id/
  // deprecate` falls to defaultAction("POST") and is recorded as `create` -
  // a retirement filed under the opposite verb, and "who deprecated this
  // model" answerable by nothing. A named route only pays off if the audit
  // knows the name.
  "deprecate",
  "undeprecate",
  "revoke",
  "rotate",
  "probe",
]);

export function describeMutation(request: AuditableRequest): {
  objectType: string;
  objectId: string | null;
  action: string;
  changedFields: string[];
} | null {
  const method = request.method?.toUpperCase();
  if (!method || !MUTATING.has(method)) return null;

  const path = `${request.baseUrl ?? ""}${request.originalUrl ?? request.url ?? ""}`;
  const segments = (path.split("?")[0] ?? "").split("/").filter(Boolean);
  const start = segments.indexOf("capability");
  if (start < 0) return null;

  const [rawObjectType, second, third] = segments.slice(start + 1);
  if (!rawObjectType) return null;

  // #206: three resources answer on two spellings each while opera migrates.
  // `resource_type` is derived from this segment, so WITHOUT this fold one
  // operation files under two resource types - `POST /capability/grants` as
  // `grants`, `POST /capability/tenant-model-grants` as `tenant-model-grants` -
  // and "who granted this tenant access to this model" answers with half the
  // trail, silently. That is the defect X-4 exists to remove, reintroduced by
  // the fix for it, so the canonical name is what gets recorded regardless of
  // which spelling the caller used. Non-renamed resources pass through.
  const objectType = canonicalCapabilitySegment(rawObjectType);

  const action =
    third && ACTION_SEGMENTS.has(third)
      ? third
      : second && ACTION_SEGMENTS.has(second)
        ? second
        : defaultAction(method);

  // `second` is the id unless it was the action word itself - reading it
  // positionally would otherwise put the literal string "rotate" in
  // resource_id on an id-less action route.
  const objectId =
    second && !ACTION_SEGMENTS.has(second) ? decodeSegment(second) : null;

  return {
    objectType,
    objectId,
    action,
    changedFields: fieldNamesOf(request.body),
  };
}

/**
 * `decodeURIComponent` throws URIError on malformed percent-encoding
 * (`%ZZ`), and this middleware runs pre-auth - an unauthenticated caller must
 * not be able to turn a bad id into a 500 that also skips the audit record.
 * The raw segment is still a truthful record of what was targeted.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function defaultAction(method: string): string {
  if (method === "POST") return "create";
  if (method === "DELETE") return "delete";
  return "update";
}

/**
 * Top-level key names only, never the values.
 *
 * Bodies on this plane carry provider API keys and gateway key secrets.
 * Recording values would make the audit table a second, unencrypted copy of
 * the key vault - a worse security problem than the gap it closes. Names
 * already answer the operational question ("someone changed the rate limit on
 * this policy"), and recovering old values is what append-versioning of
 * price_rules and policies exists for.
 *
 * Not recursed into nested objects: `config` would otherwise spill a provider
 * descriptor's whole shape into every row for no added meaning.
 */
function fieldNamesOf(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  // Explicit comparator: the default sort orders by UTF-16 code unit, which is
  // deterministic but not what "alphabetical" means to whoever reads the row.
  return Object.keys(body as Record<string, unknown>).sort((a, b) =>
    a.localeCompare(b),
  );
}
