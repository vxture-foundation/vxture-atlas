/**
 * data-plane-route-names.ts - the data plane's renamed resources.
 *
 * product_251 X-4 (one word, one meaning). #206 renamed `endpoints` ->
 * `model-routes` and `grants` -> `tenant-model-grants` on `/capability/*`, and
 * deliberately excluded the data plane: its consumers are products rather than
 * one console, so the wider blast radius was deferred to "a separate window".
 *
 * TD-042 recorded the obvious problem with that: **deferring to a window nobody
 * opened is not deferring, it is dropping.** This module opens it.
 *
 * What is being fixed is CONSISTENCY, not a defect. `/v1/endpoints` and
 * `/tenancy/grants` carry the SAME meaning as their operator-plane
 * counterparts, so no word here carries an Nth meaning - the X-4 obligation was
 * already met. What was left is that the operator console and the agent-facing
 * list use two words for one thing, and anybody reading both has to hold a
 * translation in their head.
 *
 * Why this can land without waiting on karda / vxtpl to agree the names:
 * the shape is ADDITIVE. One handler registers both spellings, so nothing
 * breaks on anyone's deploy, and the retired spelling reports its own
 * retirement in the response instead of in a message somebody has to remember
 * to send. Removal is a separate decision, gated on the counter below reading
 * zero - and THAT is the point the consumers have to agree on. The interface
 * clause says it directly: a rename does not need three parties to agree,
 * because a name that says what it points at cannot collide with someone
 * else's; waiting costs a day of silent misreading for every day spent.
 *
 * ── Two differences from the `/capability/*` module, both deliberate ────────
 *
 * 1. **Keys carry their base path.** `endpoints` under `/v1` and `endpoints`
 *    under `/capability` are the same word for the same thing, but `grants`
 *    under `/tenancy` and `product-grants` under `/capability` are not - and
 *    the data plane has exactly two prefixes. Keying on the bare segment would
 *    make this module answer for paths it does not own.
 *
 * 2. **No audit fold.** `canonicalCapabilitySegment` exists because the audit
 *    middleware derives `resource_type` from the first path segment, so serving
 *    two spellings would file one operation under two resource types. The data
 *    plane is not audited into `audit.change_records`, so that half has no
 *    counterpart here. This is the smaller half of what #206 did, and saying so
 *    out loud is cheaper than the next reader diffing the two modules to find
 *    out whether the omission was an oversight.
 */

/**
 * `"<base>/<retired segment>"` -> the segment that replaces it.
 *
 * Whole segments, never substrings. A substring test would report every
 * `/capability/product-grants` call as legacy `grants` traffic, and the counter
 * that gates deleting the old names would never reach zero - the same trap the
 * operator-plane module calls out.
 */
export const RENAMED_DATA_PLANE_ROUTES: Readonly<Record<string, string>> = {
  "v1/endpoints": "model-routes",
  "tenancy/grants": "tenant-model-grants",
};

/**
 * When the retired data-plane spellings stop being served.
 *
 * Later than `CAPABILITY_PATH_SUNSET` on purpose: that one moves one console
 * that ships with this repo's own release train, this one moves karda and
 * vxtpl, who schedule independently and were not part of the #206
 * conversation.
 *
 * It is a FLOOR, not a trigger. Removal also requires
 * `data_plane_legacy_path_requests_total` to read zero, so a product still on
 * an old path past the date gets a conversation instead of an outage.
 *
 * **Nothing reads that counter on a schedule** - the same gap TD-041 records
 * for the operator plane. The date is a note to a person, not a mechanism, and
 * this comment is the only place that says so.
 */
export const DATA_PLANE_PATH_SUNSET = "2026-12-16T00:00:00.000Z";

/** Whole path segments, query string dropped, leading/empty parts removed. */
function pathSegments(url: string): string[] {
  const path = url.split("?")[0] ?? "";
  return path.split("/").filter((p) => p.length > 0);
}

export type LegacyDataPlaneRoute = {
  /** `"v1/endpoints"` - what was asked for. Used as the metric label. */
  key: string;
  /** `"model-routes"` - the segment that replaces it. */
  canonical: string;
  /** `"/v1/model-routes"` - the successor path, for `Link rel=successor-version`. */
  successorPath: string;
};

/**
 * The retired data-plane route this request came in on, or undefined.
 *
 * Exported for its own tests: whole-segment matching is this module's
 * correctness property, so it is asserted directly rather than only through an
 * HTTP round trip.
 */
export function legacyDataPlaneRouteOf(
  url: string,
): LegacyDataPlaneRoute | undefined {
  const parts = pathSegments(url);
  if (parts.length < 2) return undefined;

  const [base, segment] = parts;
  if (base === undefined || segment === undefined) return undefined;

  const key = `${base}/${segment}`;
  // `Object.hasOwn` rather than a plain lookup - but NOT for the reason the
  // operator-plane module gives, and the difference was measured rather than
  // assumed. There the key is a bare segment, so `/capability/constructor`
  // really does resolve to `Object.prototype.constructor` and a FUNCTION really
  // can reach a metric label. Here the key is `base/segment`, and no property of
  // `Object.prototype` contains a slash - prototype keys are unreachable BY
  // CONSTRUCTION, so this line is belt-and-braces.
  //
  // Kept anyway, because it becomes load-bearing the moment someone re-keys this
  // map on a bare segment. Written down rather than left implied: a guard whose
  // stated reason does not hold is worse than no guard, because the next reader
  // trusts it. Deleting this line does not turn any test red - verified, not
  // supposed - and the spec says so where it would otherwise take the credit.
  if (!Object.hasOwn(RENAMED_DATA_PLANE_ROUTES, key)) return undefined;

  const canonical = RENAMED_DATA_PLANE_ROUTES[key] as string;
  return { key, canonical, successorPath: `/${base}/${canonical}` };
}
