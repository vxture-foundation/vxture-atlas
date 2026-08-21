/**
 * jwt-shared.ts - RS256/JWKS plumbing shared by every token-verifying guard.
 * Both `S2sAuthGuard` (S2S supply surface, `tool:atlas`) and
 * `OperatorAuthGuard` (management plane, `mgmt:atlas`)
 * trust the same platform issuer/JWKS - factored out so there is one JWKS
 * cache, not two, and one place that reads `OIDC_ISSUER`.
 */
import { UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

import { errorBody } from "../runtime.errors";

const JWKS_PATH = "/oidc/jwks";

let cachedJwks: JWTVerifyGetKey | undefined;
let cachedJwksUri: string | undefined;

/**
 * Network base for the JWKS fetch, separate from the issuer identity used
 * for `iss` claim matching. Defaults to `issuer` (correct in every real
 * deployment, where the issuer origin is directly reachable). Override with
 * `OIDC_BACKCHANNEL_ISSUER` when the network path differs from the issuer
 * string embedded in tokens - e.g. this app running as a Docker Desktop
 * container validating tokens minted by a host-process IdP at
 * `http://localhost:3081`: `localhost` inside the container resolves to the
 * container itself, not the host, so the JWKS fetch needs
 * `http://host.docker.internal:3081` while `iss` must still check against
 * `http://localhost:3081` to match the token. Mirrors vxture-platform's
 * `packages/core/oidc-rp` `backchannelIssuer` split (same problem, same
 * fix, `bff/admin-bff/src/oidc/oidc-rp.module.ts`).
 */
export function resolveBackchannelBase(issuer: string): string {
  const override = process.env["OIDC_BACKCHANNEL_ISSUER"];
  return (override ?? issuer).replace(/\/$/, "");
}

export function resolveRemoteJwks(issuer: string): JWTVerifyGetKey {
  const jwksUri = `${resolveBackchannelBase(issuer)}${JWKS_PATH}`;
  if (!cachedJwks || cachedJwksUri !== jwksUri) {
    cachedJwks = createRemoteJWKSet(new URL(jwksUri));
    cachedJwksUri = jwksUri;
  }
  return cachedJwks;
}

export function requireIssuer(): string {
  const issuer = process.env["OIDC_ISSUER"];
  if (!issuer) {
    throw new UnauthorizedException(
      errorBody("AUTH_ISSUER_NOT_CONFIGURED", "OIDC_ISSUER is not configured"),
    );
  }
  return issuer;
}

export function extractBearerToken(
  headers: Record<string, unknown>,
): string | undefined {
  const raw = headers["authorization"] ?? headers["Authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}
