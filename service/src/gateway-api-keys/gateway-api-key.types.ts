/**
 * Only `external` remains. `internal` was retired in incr/08: sibling vxture
 * products already hold an OIDC client and call `/v1/*` with a short-lived S2S
 * token whose `act.sub` IS the product identity `product_endpoint_grants`
 * authorizes against. An internal key would not add a capability - it would
 * swap a 300-second signed identity for a long-lived shared secret.
 *
 * Rows issued before the retirement keep `kind: "internal"` and are revoked;
 * the database constraint is NOT VALID so history still says what it was. The
 * union here is the set that may be CREATED, which is why it has one member.
 */
export type GatewayApiKeyKind = "external";

/**
 * What the COLUMN holds. `key.gateway_api_keys.status` is CHECK-constrained to
 * these three (`00_baseline.sql`), and it keeps spelling the middle one
 * `disabled`.
 *
 * The API says `inactive` instead (product_251 M-B3's minimum vocabulary), and
 * the two are reconciled at the record boundary rather than by migrating the
 * data. Not laziness - `rollback.yml` swaps the image and never touches DDL,
 * so a data migration here would leave a rolled-back image reading a value its
 * own switch does not handle. The gain would have been one word; the cost is a
 * rollback that half-works.
 */
export type GatewayApiKeyStoredStatus = "active" | "disabled" | "revoked";

/**
 * What the API reports (M-B3): the minimum vocabulary `active`/`inactive`, plus
 * `revoked` as a genuine terminal extension - a revoked key is not merely
 * switched off, it can never come back.
 */
export type GatewayApiKeyState = "active" | "inactive" | "revoked";

/** Metadata-only view of a gateway API key - never carries the secret or its hash. */
export interface GatewayApiKeyAdminRecord {
  id: string;
  name: string;
  kind: GatewayApiKeyKind;
  owner: string | null;
  keyPrefix: string;
  /**
   * What the operator SET: active / inactive / revoked. Distinct from
   * `effectiveState`, which folds in expiry - and they disagree exactly when
   * a key's term has run out, which is the case worth seeing.
   */
  state: GatewayApiKeyState;
  /** What is actually true right now. See `GatewayApiKeyEffectiveState`. */
  effectiveState: GatewayApiKeyEffectiveState;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned only from create/rotate - the full secret is never retrievable again after this. */
export interface GatewayApiKeySecretResult extends GatewayApiKeyAdminRecord {
  secret: string;
}

export interface CreateGatewayApiKeyBody {
  /** ISO 8601. Omitted means no term - the key runs until revoked. */
  expiresAt?: string | null;
  name?: string;
  kind?: string;
  owner?: string | null;
}

/**
 * What an operator SEES, which is the stored status combined with the clock.
 *
 * `expired` is derived, never stored. A sweeper flipping rows when a timestamp
 * passes would rewrite history to make a schedule true, and between the moment
 * expiry lands and the moment the job runs the stored value would be a lie -
 * the same reason price rules and policies evaluate expiry at read time.
 *
 * Precedence is terminal-first: a revoked key is revoked whatever its expiry
 * says, and a disabled key reads disabled rather than expired because that is
 * the state an operator chose and can undo.
 */
export type GatewayApiKeyEffectiveState =
  | "active"
  | "expired"
  | "inactive"
  | "revoked";
