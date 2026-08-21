/**
 * gateway-api-key-crypto.ts - key material for key.gateway_api_keys.
 *
 * Deliberately one-way, unlike provider-key-crypto.ts's envelope encryption:
 * these are keys Atlas itself issues (high-entropy random tokens), not
 * third-party secrets Atlas needs to present back to an upstream provider -
 * there is never a legitimate reason to recover the plaintext, only to
 * verify a presented value against what was issued. A sha256 digest of a
 * 256-bit random value has no meaningful brute-force surface, so no salt/
 * work-factor KDF (bcrypt/scrypt) is needed the way it would be for a
 * human-chosen password.
 */
import { createHash, randomBytes } from "node:crypto";

const SECRET_BYTES = 32; // 256 bits of entropy
/** Chars of the random portion kept visible in the masked prefix (after the kind tag). */
const PREFIX_VISIBLE_CHARS = 8;

/**
 * `vxk_int_` is not produced any more (incr/08 retired the internal kind) but
 * the mapping stays total: keys issued before the retirement still carry that
 * prefix, and a lookup that could not recognise them would fail to identify a
 * credential that exists.
 */
function kindTag(kind: string): string {
  return kind === "internal" ? "vxk_int_" : "vxk_ext_";
}

export interface GeneratedGatewayApiKey {
  /** Full secret - caller sees this exactly once, at create/rotate time. */
  secret: string;
  /** Masked display value, e.g. "vxk_int_9f2a1c3d" - safe to list/log. */
  keyPrefix: string;
  /** sha256 hex digest of `secret` - what actually persists. */
  keyHash: string;
}

export function generateGatewayApiKey(
  kind: "internal" | "external",
): GeneratedGatewayApiKey {
  const tag = kindTag(kind);
  const random = randomBytes(SECRET_BYTES).toString("base64url");
  const secret = `${tag}${random}`;

  return {
    secret,
    keyPrefix: secret.slice(0, tag.length + PREFIX_VISIBLE_CHARS),
    keyHash: hashGatewayApiKey(secret),
  };
}

export function hashGatewayApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
