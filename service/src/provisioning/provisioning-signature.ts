/**
 * provisioning-signature.ts - Stripe-style HMAC verification for the C3
 * provisioning webhook (docs/30-design/identity/080-rp-integration.md §4 step 1,
 * §5 "签名" note).
 *
 * signed_payload = "{t}.{raw_request_body}" (raw bytes, never a re-serialized
 * JSON.stringify). Verified against every configured secret (current + next,
 * for rotation overlap) in constant time; accepted if any one matches.
 * Timestamp tolerance is +/-5 minutes to bound replay.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { ParsedSignatureHeader } from "./provisioning.types";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function parseSignatureHeader(
  header: string,
): ParsedSignatureHeader | null {
  let t: number | undefined;
  let v1: string | undefined;

  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key === "t" && value) t = Number(value);
    if (key === "v1" && value) v1 = value;
  }

  if (t === undefined || !Number.isFinite(t) || !v1) {
    return null;
  }

  return { t, v1 };
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secrets: readonly (string | undefined)[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return false;
  }

  if (Math.abs(nowSeconds - parsed.t) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(parsed.v1, "hex");
  } catch {
    return false;
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${parsed.t}.`, "utf8"),
    rawBody,
  ]);

  for (const secret of secrets) {
    if (!secret) continue;

    const expected = createHmac("sha256", secret).update(signedPayload).digest();
    if (
      expected.length === providedSignature.length &&
      timingSafeEqual(expected, providedSignature)
    ) {
      return true;
    }
  }

  return false;
}
