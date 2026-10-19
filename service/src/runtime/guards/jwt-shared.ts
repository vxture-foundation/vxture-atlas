/**
 * jwt-shared.ts - RS256/JWKS plumbing shared by every token-verifying guard.
 * Both `S2sAuthGuard` (S2S supply surface, `tool:atlas`) and
 * `OperatorAuthGuard` (management plane, `mgmt:atlas`)
 * trust the same platform issuer/JWKS - factored out so there is one JWKS
 * cache, not two, and one place that reads `OIDC_ISSUER`.
 * @package @atlas/service
 * @layer Domain
 * @category guard
 * @author AI-Generated
 * @date 2026-10-19
 */
import { UnauthorizedException } from "@nestjs/common";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import { errorBody, type ModelRuntimeErrorCode } from "../runtime.errors";

const JWKS_PATH = "/oidc/jwks";
const CLOCK_TOLERANCE_SECONDS = 60;

let cachedJwks: JWTVerifyGetKey | undefined;
let cachedJwksUri: string | undefined;

// ============================================================================
// Shared product-token verification
// ============================================================================

interface ProductTokenErrors {
  invalid: { code: ModelRuntimeErrorCode; message: string };
  missingActor: { code: ModelRuntimeErrorCode; message: string };
}

interface ProductTokenOptions {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

/**
 * Verify the common product identity without granting access to any surface.
 * @param token - Bearer credential supplied by the caller.
 * @param options - Trusted issuer, audience and signing-key resolver.
 * @param errors - Surface-specific errors retained by the calling guard.
 * @returns Verified claims and the required caller product identity.
 * @throws {UnauthorizedException} When verification or caller identity fails.
 */
export async function verifyProductToken(
  token: string,
  options: ProductTokenOptions,
  errors: ProductTokenErrors,
): Promise<{ payload: JWTPayload; callerProductCode: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, options.jwks, {
      algorithms: ["RS256"],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch {
    throw new UnauthorizedException(
      errorBody(errors.invalid.code, errors.invalid.message),
    );
  }

  const act = payload["act"] as { sub?: unknown } | undefined;
  const callerProductCode = typeof act?.sub === "string" ? act.sub : undefined;
  if (!callerProductCode) {
    throw new UnauthorizedException(
      errorBody(errors.missingActor.code, errors.missingActor.message),
    );
  }
  return { payload, callerProductCode };
}

// ============================================================================
// Issuer, JWKS cache and request headers
// ============================================================================

/**
 * Authenticate a request using the common product issuer configuration.
 * @param headers - Untrusted request headers, used only for the bearer token.
 * @param missing - Surface-specific error for an absent bearer token.
 * @param verify - Surface verifier that retains its own scope and mode checks.
 * @returns The verified surface-specific identity.
 * @throws {UnauthorizedException} When configuration or authentication fails.
 */
export async function verifyProductRequest<T>(
  headers: Record<string, unknown>,
  missing: { code: ModelRuntimeErrorCode; message: string },
  verify: (token: string, options: ProductTokenOptions) => Promise<T>,
): Promise<T> {
  const token = extractBearerToken(headers);
  if (!token) {
    throw new UnauthorizedException(errorBody(missing.code, missing.message));
  }
  const issuer = requireIssuer();
  return verify(token, {
    jwks: resolveRemoteJwks(issuer),
    issuer,
    audience: process.env["S2S_AUDIENCE"] || "atlas",
  });
}

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
