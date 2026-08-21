/**
 * s2s-auth.guard.ts - product_210 S2S token exchange 被调方校验 (§3.3)
 * @package @atlas/service
 * @layer Domain
 * @category guard
 *
 * @description
 *   Verifies the RS256 S2S access token issued by the platform's token-exchange
 *   endpoint (`product_210` §3.2). Implements the eight callee obligations in
 *   §3.3: RS256-only (rule 1), kid-based JWKS lookup with cache (rule 2, via
 *   `jose`'s remote JWKS set), exact `iss` match (rule 3), single-value `aud`
 *   match (rule 4), `exp` with 60s skew (rule 5), required `act.sub` (rule 6).
 *   Rule 7 (never accept `AUTH_INTERNAL_TOKEN` as an inter-product credential)
 *   and rule 8 (never trust header/body-supplied org/workspace context) are
 *   satisfied by omission: this guard only reads the `Authorization: Bearer`
 *   header and only derives context from verified token claims.
 *
 *   Guards only the S2S supply surface (`/v1/*`, `/tenancy/*`) - the
 *   management plane (`/capability/*`) is `OperatorAuthGuard`'s. TWO
 *   independent claims keep the two planes disjoint:
 *
 *     `mode`   must be `obo` or `service` - what KIND of exchange minted it.
 *              An operator token carries `operator`, or nothing, and fails.
 *     `scope`  must be `tool:<audience>` - what SURFACE it was minted for.
 *              An operator token carries `mgmt:<audience>` and fails.
 *
 *   Admission requires a token to be right in two independent ways.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

import {
  extractBearerToken,
  requireIssuer,
  resolveRemoteJwks,
} from "./jwt-shared";
import { errorBody } from "../runtime.errors";

const CLOCK_TOLERANCE_SECONDS = 60;
const DEFAULT_AUDIENCE = "atlas";

/**
 * The scope a token for THIS audience must carry.
 *
 * Derived from the audience rather than hardcoded, because that is how the
 * issuer builds it: token-exchange mints `tool:${target}` where `target` is
 * the requested audience, so hardcoding `tool:atlas` would silently stop
 * matching for any deployment that sets a different `S2S_AUDIENCE`. The
 * operator guard hardcodes its own `mgmt:atlas` and would want the same
 * treatment if that value ever became configurable.
 *
 * Exact match, mirroring `OperatorAuthGuard` - not a space-delimited
 * membership test. The issuer produces exactly one scope per token from a
 * template literal, and if that ever becomes a multi-valued scope the right
 * outcome is a loud 401 that sends someone here, not a silent widening of
 * what this guard accepts.
 */
const requiredScope = (audience: string): string => `tool:${audience}`;

export interface S2sAuthContext {
  callerProductCode: string;
  mode: "obo" | "service";
  scope: string;
  /** Tenant (personal or organization) - see the claim note in verifyS2sToken. */
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  jti?: string;
}

export interface S2sAuthenticatedRequest {
  headers: Record<string, unknown>;
  s2sAuth?: S2sAuthContext;
}

export async function verifyS2sToken(
  token: string,
  options: { jwks: JWTVerifyGetKey; issuer: string; audience: string },
): Promise<S2sAuthContext> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, options.jwks, {
      algorithms: ["RS256"],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch {
    throw new UnauthorizedException(
      errorBody("S2S_TOKEN_INVALID", "S2S token failed verification"),
    );
  }

  const act = payload["act"] as { sub?: unknown } | undefined;
  const callerProductCode = typeof act?.sub === "string" ? act.sub : undefined;
  if (!callerProductCode) {
    // rule 6: act.sub 必须存在 - 无 act = 用户级 token 混用，拒
    throw new UnauthorizedException(
      errorBody(
        "S2S_TOKEN_MISSING_ACT",
        "S2S token is missing act.sub (caller product identity)",
      ),
    );
  }

  // One of two independent judgements that do not restate each other: `mode`
  // says what KIND of exchange produced the token, `scope` says what SURFACE
  // it was minted for. Both must hold.
  const scope = payload["scope"];
  if (scope !== requiredScope(options.audience)) {
    throw new UnauthorizedException(
      errorBody(
        "S2S_TOKEN_WRONG_SCOPE",
        `S2S token must carry scope="${requiredScope(options.audience)}"`,
      ),
    );
  }

  const mode = payload["mode"];
  if (mode !== "obo" && mode !== "service") {
    throw new UnauthorizedException(
      errorBody("S2S_TOKEN_INVALID_MODE", "S2S token has an unrecognized mode claim"),
    );
  }

  // Tenancy identity. The platform's data model calls this a **tenant**
  // (`tenancy.tenants.type CHECK(personal/organization)`) and auto-creates a
  // `personal` tenant for every user, so "org" names only one of the two
  // kinds and excludes the common case. The wire claim is still `org_id`
  // today and is minted nullable (`org_id: req.orgId ?? null` in auth-bff's
  // token-exchange, sourced from `active_org`), unlike `workspace_id` which
  // is validated as required.
  //
  // Prefer a `tenant_id` claim and fall back to `org_id`, so the platform can
  // rename without a coordinated deploy on this side.
  const tenantId = payload["tenant_id"] ?? payload["org_id"];
  const workspaceId = payload["workspace_id"];

  return {
    callerProductCode,
    mode,
    scope: typeof payload["scope"] === "string" ? payload["scope"] : "",
    ...(typeof tenantId === "string" ? { tenantId } : {}),
    ...(typeof workspaceId === "string" ? { workspaceId } : {}),
    ...(typeof payload.sub === "string" ? { userId: payload.sub } : {}),
    ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
  };
}

@Injectable()
export class S2sAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<S2sAuthenticatedRequest>();
    const token = extractBearerToken(req.headers);
    if (!token) {
      throw new UnauthorizedException(
        errorBody("S2S_TOKEN_MISSING", "Missing S2S bearer token"),
      );
    }

    const issuer = requireIssuer();
    const audience = process.env["S2S_AUDIENCE"] || DEFAULT_AUDIENCE;

    req.s2sAuth = await verifyS2sToken(token, {
      jwks: resolveRemoteJwks(issuer),
      issuer,
      audience,
    });
    return true;
  }
}
