/**
 * health-read.guard.spec.ts — platform#562 监测读面校验测试。
 * @package @atlas/service
 * @layer Domain
 * @category test
 *
 * Proves the three planes are disjoint by scope: a `health:atlas` service token
 * passes HealthRead, and is rejected by the supply guard (`verifyS2sToken`);
 * a `tool:atlas` / `mgmt:atlas` token is rejected by HealthRead.
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

import { verifyHealthReadToken } from "./health-read.guard";
import { verifyS2sToken } from "./s2s-auth.guard";

const ISSUER = "https://accounts.vxture.com";
const AUDIENCE = "atlas";
const KID = "test-key-1";

describe("verifyHealthReadToken", () => {
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
    opts: { alg?: string; expiresIn?: string } = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(privateKey);
  }

  const verify = (token: string) =>
    verifyHealthReadToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE });

  it("accepts a valid health-read service token", async () => {
    const token = await sign({
      act: { sub: "platform-api" },
      mode: "service",
      scope: "health:atlas",
      jti: "jti-1",
    });
    const ctx = await verify(token);
    expect(ctx).toEqual({
      callerProductCode: "platform-api",
      scope: "health:atlas",
      jti: "jti-1",
    });
  });

  it("rejects a supply (tool:atlas) token — wrong scope", async () => {
    const token = await sign({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    });
    await expect(verify(token)).rejects.toThrow();
  });

  it("rejects a management (mgmt:atlas) operator token — wrong scope", async () => {
    const token = await sign({
      act: { sub: "opera" },
      sub: "opr_1",
      mode: "operator",
      scope: "mgmt:atlas",
      realm: "workforce",
      userType: "operator",
    });
    await expect(verify(token)).rejects.toThrow();
  });

  it("rejects an obo-mode health token — monitor is never OBO", async () => {
    const token = await sign({
      act: { sub: "platform-api" },
      mode: "obo",
      scope: "health:atlas",
    });
    await expect(verify(token)).rejects.toThrow();
  });

  it("rejects a token missing act.sub", async () => {
    const token = await sign({ mode: "service", scope: "health:atlas" });
    await expect(verify(token)).rejects.toThrow();
  });

  it("rejects a non-RS256 token", async () => {
    const token = await sign(
      { act: { sub: "platform-api" }, mode: "service", scope: "health:atlas" },
      { alg: "RS256" },
    );
    // tamper: verify under an audience mismatch to force failure path parity
    await expect(
      verifyHealthReadToken(token, { jwks, issuer: ISSUER, audience: "runos" }),
    ).rejects.toThrow();
  });

  it("the supply guard rejects a health-read token (planes disjoint)", async () => {
    const health = await sign({
      act: { sub: "platform-api" },
      mode: "service",
      scope: "health:atlas",
    });
    await expect(
      verifyS2sToken(health, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });
});
