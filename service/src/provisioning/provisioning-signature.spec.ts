import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  parseSignatureHeader,
  verifyWebhookSignature,
} from "./provisioning-signature";

const SECRET = "test-secret";
const NEXT_SECRET = "test-secret-next";

function sign(secret: string, t: number, rawBody: Buffer): string {
  const signedPayload = Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]);
  return createHmac("sha256", secret).update(signedPayload).digest("hex");
}

function header(secret: string, t: number, rawBody: Buffer): string {
  return `t=${t},v1=${sign(secret, t, rawBody)}`;
}

describe("parseSignatureHeader", () => {
  it("parses a well-formed header", () => {
    expect(parseSignatureHeader("t=1700000000,v1=abc123")).toEqual({
      t: 1700000000,
      v1: "abc123",
    });
  });

  it("tolerates extra whitespace", () => {
    expect(parseSignatureHeader(" t = 1700000000 , v1 = abc123 ")).toEqual({
      t: 1700000000,
      v1: "abc123",
    });
  });

  it("returns null when t is missing", () => {
    expect(parseSignatureHeader("v1=abc123")).toBeNull();
  });

  it("returns null when v1 is missing", () => {
    expect(parseSignatureHeader("t=1700000000")).toBeNull();
  });

  it("returns null when t is not a number", () => {
    expect(parseSignatureHeader("t=notanumber,v1=abc123")).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const rawBody = Buffer.from(JSON.stringify({ id: "delivery-1" }));
  const now = 1_700_000_000;

  it("accepts a valid signature from the primary secret", () => {
    const sig = header(SECRET, now, rawBody);
    expect(verifyWebhookSignature(rawBody, sig, [SECRET], now)).toBe(true);
  });

  it("accepts a valid signature from the rotation (next) secret", () => {
    const sig = header(NEXT_SECRET, now, rawBody);
    expect(
      verifyWebhookSignature(rawBody, sig, [SECRET, NEXT_SECRET], now),
    ).toBe(true);
  });

  it("rejects when no secret matches", () => {
    const sig = header("wrong-secret", now, rawBody);
    expect(verifyWebhookSignature(rawBody, sig, [SECRET], now)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = header(SECRET, now, rawBody);
    const tampered = Buffer.from(JSON.stringify({ id: "delivery-2" }));
    expect(verifyWebhookSignature(tampered, sig, [SECRET], now)).toBe(false);
  });

  it("rejects a timestamp outside the 5-minute tolerance", () => {
    const staleT = now - 301;
    const sig = header(SECRET, staleT, rawBody);
    expect(verifyWebhookSignature(rawBody, sig, [SECRET], now)).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const boundaryT = now - 300;
    const sig = header(SECRET, boundaryT, rawBody);
    expect(verifyWebhookSignature(rawBody, sig, [SECRET], now)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(rawBody, undefined, [SECRET], now)).toBe(
      false,
    );
  });

  it("rejects a malformed signature header", () => {
    expect(
      verifyWebhookSignature(rawBody, "not-a-valid-header", [SECRET], now),
    ).toBe(false);
  });

  it("ignores unset secrets in the rotation list", () => {
    const sig = header(SECRET, now, rawBody);
    expect(
      verifyWebhookSignature(rawBody, sig, [undefined, SECRET], now),
    ).toBe(true);
  });
});
