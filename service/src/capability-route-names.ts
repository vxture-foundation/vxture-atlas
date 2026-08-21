/**
 * capability-route-names.ts - the operator plane's renamed resources.
 *
 * product_251 X-4 (one word, one meaning): `grants` named three different
 * things across the fleet's operator console - a product's access to a model
 * ENTRY POINT (atlas), a tenant's access to a MODEL (atlas again), a product's
 * access to a CAPABILITY (runos) - and `endpoints` named two. Names agreed in
 * vxture-atlas#206.
 *
 * This module holds the vocabulary and nothing else, because THREE places have
 * to agree on it and two of them are not the router:
 *
 * 1. `model-admin.controller.ts` registers both spellings per route.
 * 2. `runtime/legacy-capability-path.ts` stamps the deprecation headers and
 *    counts retired-path traffic.
 * 3. `audit/audit.middleware.ts` derives `resource_type` from the first path
 *    segment, so it MUST fold a retired spelling back to the canonical one.
 *
 * Point 3 is why this file exists rather than a constant next to the
 * interceptor. Serving both spellings without it files ONE operation under TWO
 * resource types: `POST /capability/grants` records `grants` and
 * `POST /capability/tenant-model-grants` records `tenant-model-grants`, so
 * "who granted this tenant access to this model" silently answers with half the
 * trail. That is a fresh instance of exactly the defect X-4 exists to remove,
 * introduced by the fix for it - and it survived a 913-test run in a first
 * attempt, because nothing in the build ties `objectType` to the route table.
 */

/**
 * Retired first path segment -> the name that replaces it.
 *
 * Order is irrelevant BY CONSTRUCTION: every lookup below compares whole path
 * segments, never substrings, so `grants` cannot match inside `product-grants`.
 * A substring test would report every `product-grants` call as legacy `grants`
 * traffic, and the counter that gates deleting the old names would never reach
 * zero.
 */
export const RENAMED_CAPABILITY_SEGMENTS: Readonly<Record<string, string>> = {
  "product-grants": "product-endpoint-grants",
  grants: "tenant-model-grants",
  endpoints: "model-routes",
};

/**
 * When the retired spellings stop being served.
 *
 * A date rather than a release number, because the client team schedules
 * against a calendar. It is a FLOOR, not a trigger: removal also requires
 * `capability_legacy_path_requests_total` to read zero, so an operator still on
 * an old path in October gets a conversation instead of an outage. Same
 * discipline as `model_grant_authorizations_total`, which exists so the legacy
 * tenant authorization axis is removed once it is shown unused rather than
 * assumed to be.
 *
 * **Nothing reads that counter on a schedule** - TD-041. The date below is
 * therefore a note to a person, not a mechanism, and this comment is the only
 * place that says so out loud.
 */
export const CAPABILITY_PATH_SUNSET = "2026-09-16T00:00:00.000Z";

/** Whole path segments of `/capability/...`, query string dropped. */
function capabilitySegments(url: string): string[] | undefined {
  const path = url.split("?")[0] ?? "";
  const parts = path.split("/").filter((p) => p.length > 0);
  const at = parts.indexOf("capability");
  return at < 0 ? undefined : parts.slice(at + 1);
}

/**
 * The retired segment this request came in on, or undefined.
 *
 * Exported for its own tests: whole-segment matching is the correctness
 * property of this module, so it is asserted directly rather than through an
 * HTTP round trip.
 */
export function legacySegmentOf(url: string): string | undefined {
  const segment = capabilitySegments(url)?.[0];
  if (segment === undefined) return undefined;
  return Object.hasOwn(RENAMED_CAPABILITY_SEGMENTS, segment)
    ? segment
    : undefined;
}

/**
 * Fold a resource segment to its canonical name; anything not renamed is
 * returned unchanged.
 *
 * This is what keeps the audit trail single-valued while both spellings are
 * served. It is total on purpose - the audit middleware records every operator
 * route, most of which were never renamed, and a function that only knew about
 * the renamed three would force a conditional at the call site that someone
 * would eventually get backwards.
 */
export function canonicalCapabilitySegment(segment: string): string {
  // `Object.hasOwn`, not `map[segment] ?? segment`. The segment comes from the
  // request URL, so a call to `/capability/constructor` makes the plain lookup
  // resolve to `Object.prototype.constructor` - a function, which is not
  // nullish, so `??` keeps it and a FUNCTION lands in
  // `audit.change_records.resource_type`. Caught by its own test; the same guard
  // is why `legacySegmentOf` above uses `hasOwn` too.
  return Object.hasOwn(RENAMED_CAPABILITY_SEGMENTS, segment)
    ? (RENAMED_CAPABILITY_SEGMENTS[segment] as string)
    : segment;
}
