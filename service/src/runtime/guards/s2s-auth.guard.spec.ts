/**
 * s2s-auth.guard.spec.ts - S2S token 校验测试 (product_210 §3.3)
 * @package @atlas/service
 * @layer Domain
 * @category test
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

import { verifyS2sToken } from "./s2s-auth.guard";

const ISSUER = "https://accounts.vxture.com";
const AUDIENCE = "atlas";
const KID = "test-key-1";

describe("verifyS2sToken", () => {
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

  it("accepts a valid service-mode token", async () => {
    const token = await sign({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
      org_id: "org_1",
      workspace_id: "ws_1",
    });

    const ctx = await verifyS2sToken(token, {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(ctx).toEqual({
      callerProductCode: "varda",
      mode: "service",
      scope: "tool:atlas",
      tenantId: "org_1",
      workspaceId: "ws_1",
      userId: undefined,
      jti: undefined,
    });
  });

  it("accepts a valid obo-mode token carrying a user subject", async () => {
    const token = await sign({
      sub: "user_42",
      act: { sub: "console-bff" },
      mode: "obo",
      scope: "tool:atlas",
    });

    const ctx = await verifyS2sToken(token, {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(ctx.callerProductCode).toBe("console-bff");
    expect(ctx.mode).toBe("obo");
    expect(ctx.userId).toBe("user_42");
  });

  it("rejects a token for the wrong audience (rule 4)", async () => {
    const token = await new SignJWT({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience("ontos")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects a token from the wrong issuer (rule 3)", async () => {
    const token = await new SignJWT({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer("https://evil.example")
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects an expired token (rule 5)", async () => {
    const token = await sign({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    }, { expiresIn: "-1h" });

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects a token missing act.sub (rule 6)", async () => {
    const token = await sign({
      mode: "service",
      scope: "tool:atlas",
    });

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it("rejects a token with an unrecognized mode claim", async () => {
    const token = await sign({
      act: { sub: "varda" },
      mode: "admin",
      scope: "tool:atlas",
    });

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  // Each of these asserts the specific code rather than just `.rejects`: a
  // `.toThrow()` here would still pass if the scope check were deleted, since
  // some other judgement would catch most of these tokens anyway.
  it("rejects a token whose scope is for the management plane", async () => {
    const token = await sign({
      act: { sub: "opera" },
      mode: "service",
      scope: "mgmt:atlas",
    });

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toMatchObject({
      response: { code: "S2S_TOKEN_WRONG_SCOPE" },
    });
  });

  it("rejects a token carrying no scope claim at all", async () => {
    const token = await sign({
      act: { sub: "varda" },
      mode: "service",
    });

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toMatchObject({
      response: { code: "S2S_TOKEN_WRONG_SCOPE" },
    });
  });

  it("rejects on scope independently of mode - a valid mode does not rescue it", async () => {
    // The two judgements must not collapse into one. This token is correct in
    // every way `mode` can observe, so if it is admitted the scope check has
    // stopped applying even though the mode check still passes.
    const token = await sign({
      act: { sub: "varda" },
      mode: "obo",
      scope: "tool:something-else",
      org_id: "org_1",
      workspace_id: "ws_1",
      sub: "usr_1",
    });

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toMatchObject({
      response: { code: "S2S_TOKEN_WRONG_SCOPE" },
    });
  });

  it("derives the required scope from the audience rather than hardcoding atlas", async () => {
    // The issuer mints `tool:${target}` from the requested audience, so a
    // deployment with a different S2S_AUDIENCE must still work. A hardcoded
    // `tool:atlas` would reject this token, and a deleted check would accept
    // the mismatched one below.
    const OTHER = "atlas-beta";
    const signFor = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(OTHER)
        .setExpirationTime("5m")
        .sign(privateKey);

    const matching = await signFor({
      act: { sub: "varda" },
      mode: "service",
      scope: `tool:${OTHER}`,
    });
    const ctx = await verifyS2sToken(matching, {
      jwks,
      issuer: ISSUER,
      audience: OTHER,
    });
    expect(ctx.scope).toBe(`tool:${OTHER}`);

    const mismatched = await signFor({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    });
    await expect(
      verifyS2sToken(mismatched, { jwks, issuer: ISSUER, audience: OTHER }),
    ).rejects.toMatchObject({
      response: { code: "S2S_TOKEN_WRONG_SCOPE" },
    });
  });

  it("rejects HS256-signed tokens (rule 1 - RS256 only)", async () => {
    const secret = new TextEncoder().encode("shared-secret-not-allowed");
    const token = await new SignJWT({
      act: { sub: "varda" },
      mode: "service",
      scope: "tool:atlas",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(secret);

    await expect(
      verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  // The platform's data model calls this a tenant
  // (personal|organization) and auto-creates a personal tenant + default
  // workspace per user, but the wire claim is `org_id`, minted only when an
  // organization is active. Accept both so the rename needs no coordinated
  // deploy, and prove the personal-tenant case degrades rather than crashes.
  it("prefers a tenant_id claim over the legacy org_id", async () => {
    const token = await sign({
      act: { sub: "console" },
      mode: "service",
      scope: "tool:atlas",
      tenant_id: "tenant_new",
      org_id: "org_legacy",
      workspace_id: "ws_1",
    });

    const ctx = await verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE });

    expect(ctx.tenantId).toBe("tenant_new");
  });

  it("leaves tenantId undefined when neither claim is present (personal tenant today)", async () => {
    const token = await sign({
      act: { sub: "console" },
      mode: "service",
      scope: "tool:atlas",
      workspace_id: "ws_1",
    });

    const ctx = await verifyS2sToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE });

    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.workspaceId).toBe("ws_1");
  });
});
