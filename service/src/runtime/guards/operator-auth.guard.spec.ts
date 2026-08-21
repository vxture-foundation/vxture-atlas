/**
 * operator-auth.guard.spec.ts - operator token verification tests
 * (product_250_management-plane-contract.md §2 M-1/M-5)
 */

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  verifyOperatorToken,
} from "./operator-auth.guard";
import { verifyS2sToken } from "./s2s-auth.guard";

const ISSUER = "https://accounts.vxture.com";
const AUDIENCE = "atlas";
const KID = "test-key-1";

describe("verifyOperatorToken", () => {
  let privateKey: CryptoKey;
  let jwks: JWTVerifyGetKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwks = createLocalJWKSet({
      keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
    });
  });

  function sign(
    claims: Record<string, unknown>,
    opts: { alg?: string; expiresIn?: string; audience?: string } = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(privateKey);
  }

  const validClaims = {
    sub: "opr_11111111-1111-1111-1111-111111111111",
    act: { sub: "admin" },
    mode: "operator",
    userType: "operator",
    realm: "workforce",
    scope: "mgmt:atlas",
  };

  it("accepts a valid operator token and extracts M-5 attribution", async () => {
    const token = await sign(validClaims);

    const ctx = await verifyOperatorToken(token, { jwks, issuer: ISSUER });

    expect(ctx).toEqual({
      operatorId: "opr_11111111-1111-1111-1111-111111111111",
      actorClientId: "admin",
    });
  });

  it("rejects a well-formed S2S token - scope disjointness is not incidental", async () => {
    // The two token kinds must never both pass the same guard - product_250
    // §2's own words: "管理票过不了供给面守卫，反之亦然".
    const s2sToken = await sign({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    });

    await expect(
      verifyOperatorToken(s2sToken, { jwks, issuer: ISSUER }),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_TOKEN_WRONG_SCOPE" },
    });
  });

  it("rejects scope=tool:atlas even with every other operator claim present", async () => {
    const token = await sign({ ...validClaims, scope: "tool:atlas" });

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_TOKEN_WRONG_SCOPE" },
    });
  });

  it("rejects realm != workforce", async () => {
    const token = await sign({ ...validClaims, realm: "tenant" });

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_TOKEN_WRONG_REALM" },
    });
  });

  it("rejects userType != operator", async () => {
    const token = await sign({ ...validClaims, userType: "customer" });

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_TOKEN_WRONG_USER_TYPE" },
    });
  });

  it("rejects a token missing sub - M-5 has no fallback for attribution", async () => {
    const { sub: _sub, ...withoutSub } = validClaims;
    const token = await sign(withoutSub);

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_TOKEN_MISSING_SUB" },
    });
  });

  it("rejects a token missing act.sub", async () => {
    const { act: _act, ...withoutAct } = validClaims;
    const token = await sign(withoutAct);

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_TOKEN_MISSING_ACT" },
    });
  });

  it("rejects the wrong audience", async () => {
    const token = await sign(validClaims, { audience: "ontos" });

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await sign(validClaims, { expiresIn: "-1h" });

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toThrow();
  });

  it("rejects HS256-signed tokens", async () => {
    const secret = new TextEncoder().encode("shared-secret-not-allowed");
    const token = await new SignJWT(validClaims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(secret);

    await expect(
      verifyOperatorToken(token, { jwks, issuer: ISSUER }),
    ).rejects.toThrow();
  });

  it("keeps only token-level facts, dropping amr and operator_role", async () => {
    // The line this pins: Atlas holds facts about the TOKEN it verified, none
    // about the authentication ceremony (`amr`) or the authorization
    // evaluation (`operator_role`) - both happen upstream, where the
    // authoritative records already live. Carrying either here would be a
    // second copy of someone else's fact.
    //
    // Asserted on the whole key set, not on two absences: a future claim that
    // describes upstream evaluation would slip past `not.toHaveProperty`.
    const token = await sign({
      ...validClaims,
      amr: ["pwd", "otp", "mfa"],
      operator_role: "platform_admin",
      jti: "tok-1",
    });

    const ctx = await verifyOperatorToken(token, { jwks, issuer: ISSUER });

    expect(Object.keys(ctx).sort()).toEqual([
      "actorClientId",
      "jti",
      "operatorId",
    ]);
    expect(ctx.jti).toBe("tok-1");
  });

  // Cross-guard proof, not duplicated coverage: an operator token must also
  // fail S2sAuthGuard's own verification, so the disjointness holds in both
  // directions, not just the one this guard enforces.
  it("a valid operator token is rejected by verifyS2sToken (mode is not obo/service)", async () => {
    const token = await sign(validClaims);

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });
});

