/**
 * object-state.ts - "does this object count right now", as one word.
 *
 * product_251 M-B3: a boolean cannot carry the states that actually exist.
 * `GET /v1/endpoints` already needed a third value the day it was written
 * (`missing`, for a grant naming an endpoint code nothing has), and a version
 * lifecycle needs `deprecated` - still resolvable, no longer recommended -
 * which is not true, not false, and not expressible as either.
 *
 * The minimum vocabulary is `active` / `inactive`; a surface MAY extend it,
 * and `GrantedEndpointState` below is that extension made explicit rather than
 * a parallel invention.
 *
 * The DATABASE keeps `is_active boolean`. The rename is an API-contract change,
 * so it happens at the mapping boundary and needs no DDL, no db-init, and no
 * deploy ordering. A physical column would have meant a backfill plus a
 * dual-write window whose failure mode is the worst available: writes landing
 * in `state` while some reader still reads `is_active`, so an operator
 * deactivates a model, the console shows it inactive, and the model keeps
 * serving traffic.
 */
export type ObjectState = "active" | "inactive";

/** The catalog's extension: a grant can name an endpoint that does not exist. */
export type GrantedEndpointState = ObjectState | "missing";

export function toObjectState(isActive: boolean): ObjectState {
  return isActive ? "active" : "inactive";
}

export function isActiveState(state: ObjectState): boolean {
  return state === "active";
}

/**
 * A model's state, which needs the third value M-B3 names as the reason a
 * boolean is not enough: `deprecated` is still resolvable and no longer
 * recommended, which is not true, not false, and not expressible as either.
 *
 * Derived, never stored - `deleted_at` > `is_active` > `deprecated_at`, in
 * that order, because they answer different questions and only the first two
 * decide whether a call can be served.
 */
export type ModelState = ObjectState | "deprecated";

export function toModelState(model: {
  isActive: boolean;
  deprecatedAt: Date | null;
}): ModelState {
  // Deprecation does not switch a model off, so `inactive` wins: an operator
  // who deactivated a deprecated model means it, and reporting `deprecated`
  // would read as "still serving".
  if (!model.isActive) return "inactive";
  return model.deprecatedAt === null ? "active" : "deprecated";
}
