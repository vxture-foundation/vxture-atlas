/**
 * health-read.guard.spec.ts - platform#562 health-read verification tests.
 * @package @atlas/service
 * @layer Domain
 * @category test
 * @author AI-Generated
 * @date 2026-10-19
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

// ============================================================================
// Signed-token regressions and surface isolation
// ============================================================================

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

  const claims = {
    act: { sub: "platform-api" },
    mode: "service",
    scope: "health:atlas",
  };

  function errorWithCode(code: string) {
    return {
      response: expect.objectContaining({ code, retryable: false }),
    };
  }

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

  it("rejects a supply (tool:atlas) token - wrong scope", async () => {
    const token = await sign({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    });
    await expect(verify(token)).rejects.toThrow();
  });

  it("rejects a management (mgmt:atlas) operator token - wrong scope", async () => {
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

  it("rejects an obo-mode health token - monitor is never OBO", async () => {
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
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(
        new TextEncoder().encode(
          "synthetic-test-signing-key-at-least-32-bytes",
        ),
      );
    await expect(verify(token)).rejects.toMatchObject(
      errorWithCode("HEALTH_TOKEN_INVALID"),
    );
  });

  it("rejects a token for a different audience", async () => {
    const token = await sign(claims);
    await expect(
      verifyHealthReadToken(token, { jwks, issuer: ISSUER, audience: "runos" }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "HEALTH_TOKEN_INVALID" }),
    });
  });

  it("rejects an issuer mismatch even with a trusted signing key", async () => {
    const token = await sign(claims);
    await expect(
      verifyHealthReadToken(token, {
        jwks,
        issuer: "https://other.example",
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "HEALTH_TOKEN_INVALID" }),
    });
  });

  it("rejects a token signed by an untrusted key", async () => {
    const untrusted = await generateKeyPair("RS256");
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(untrusted.privateKey);
    await expect(verify(token)).rejects.toMatchObject(
      errorWithCode("HEALTH_TOKEN_INVALID"),
    );
  });

  it("retains the sixty-second expiration tolerance", async () => {
    expect(await verify(await sign(claims, { expiresIn: "-30s" }))).toEqual({
      callerProductCode: "platform-api",
      scope: "health:atlas",
    });
    await expect(
      verify(await sign(claims, { expiresIn: "-2m" })),
    ).rejects.toMatchObject(errorWithCode("HEALTH_TOKEN_INVALID"));
  });

  it.each([undefined, null, {}, { sub: "" }, { sub: 42 }])(
    "rejects a missing or invalid actor: %j",
    async (act) => {
      await expect(
        verify(await sign({ ...claims, act })),
      ).rejects.toMatchObject(errorWithCode("HEALTH_TOKEN_MISSING_ACT"));
    },
  );

  it.each([undefined, "", "health:atlas tool:atlas", "health:runos"])(
    "requires one exact scope: %s",
    async (scope) => {
      await expect(
        verify(await sign({ ...claims, scope })),
      ).rejects.toMatchObject(errorWithCode("HEALTH_TOKEN_WRONG_SCOPE"));
    },
  );

  it.each([undefined, "operator", "obo"])(
    "rejects a non-service mode: %s",
    async (mode) => {
      await expect(
        verify(await sign({ ...claims, mode })),
      ).rejects.toMatchObject(errorWithCode("HEALTH_TOKEN_INVALID_MODE"));
    },
  );

  it("omits an absent token ID", async () => {
    expect(await verify(await sign({ ...claims, jti: undefined }))).toEqual({
      callerProductCode: "platform-api",
      scope: "health:atlas",
    });
  });

  it("reports signature errors before untrusted scope or actor claims", async () => {
    await expect(verify("not-a-jwt")).rejects.toMatchObject(
      errorWithCode("HEALTH_TOKEN_INVALID"),
    );
    await expect(
      verify(await sign({ scope: "tool:atlas" })),
    ).rejects.toMatchObject(errorWithCode("HEALTH_TOKEN_MISSING_ACT"));
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
