/**
 * health-read.guard.ts - platform#562 health-read surface verification.
 * @package @atlas/service
 * @layer Domain
 * @category guard
 * @author AI-Generated
 * @date 2026-10-19
 *
 * @description
 *   Verifies an RS256 S2S token minted by the platform's token-exchange for the
 *   **health read** plane only. It guards `GET /s2s/health[/events]` - read-only views
 *   of `ServiceHealthService.current()` - so the platform's unattended watchdog
 *   can poll model-service health without a human operator session.
 *
 *   THREE planes stay disjoint by scope, and this guard is the third:
 *     - `/capability/*` -> `OperatorAuthGuard`  - scope `mgmt:<aud>`, operator token.
 *     - `/v1/*`,`/tenancy/*` -> `S2sAuthGuard`  - scope `tool:<aud>`, supply token.
 *     - `/s2s/health`    -> `HealthReadGuard`    - scope `health:<aud>`, service token.
 *   A health token carries `health:atlas` and is rejected by BOTH other guards;
 *   an operator (`mgmt:`) or supply (`tool:`) token is rejected by this one. A
 *   read-only monitor therefore can touch nothing but health - it cannot reach
 *   `/v1/chat` (that would be widening the supply plane) nor the management
 *   plane.
 *
 *   TWO independent claims, as in `S2sAuthGuard`:
 *     `mode`  must be exactly `service` - a monitor is never OBO; a human
 *             operator token carries `operator`/nothing and fails.
 *     `scope` must be `health:<audience>` - minted from the same audience
 *             template the issuer uses (`health:${target}`), so it tracks a
 *             reconfigured `S2S_AUDIENCE` instead of silently ceasing to match.
 *   Deliberately does NOT check `realm`/`userType`: a service token carries
 *   neither, so copying the operator guard's checks here would make every valid
 *   health token inert.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { JWTVerifyGetKey } from "jose";

import { verifyProductRequest, verifyProductToken } from "./jwt-shared";
import { errorBody } from "../runtime.errors";

// ============================================================================
// Health-read identity and scope
// ============================================================================

/**
 * The scope a health token for THIS audience must carry. Derived from the
 * audience (not hardcoded) for the same reason `S2sAuthGuard` derives its
 * `tool:<aud>`: the issuer builds `health:${target}` from the requested
 * audience, so a configurable `S2S_AUDIENCE` keeps matching. Exact match, not
 * a space-delimited membership test - one scope per token, by construction.
 */
const requiredScope = (audience: string): string => `health:${audience}`;

export interface HealthReadContext {
  callerProductCode: string;
  scope: string;
  jti?: string;
}

export interface HealthReadAuthenticatedRequest {
  headers: Record<string, unknown>;
  healthReadAuth?: HealthReadContext;
}

/**
 * Verify a token for health reads without granting supply or management access.
 * @param token - Bearer credential supplied by the caller.
 * @param options - Trusted signing keys, issuer and expected audience.
 * @returns The authenticated health-read identity.
 * @throws {UnauthorizedException} When identity, scope or mode is invalid.
 */
export async function verifyHealthReadToken(
  token: string,
  options: { jwks: JWTVerifyGetKey; issuer: string; audience: string },
): Promise<HealthReadContext> {
  const { payload, callerProductCode } = await verifyProductToken(
    token,
    options,
    {
      invalid: {
        code: "HEALTH_TOKEN_INVALID",
        message: "Health-read token failed verification",
      },
      missingActor: {
        code: "HEALTH_TOKEN_MISSING_ACT",
        message: "Health-read token is missing act.sub (caller identity)",
      },
    },
  );

  // Scope separates health reads from management and supply access.
  const scope = payload["scope"];
  if (scope !== requiredScope(options.audience)) {
    throw new UnauthorizedException(
      errorBody(
        "HEALTH_TOKEN_WRONG_SCOPE",
        `Health-read token must carry scope="${requiredScope(options.audience)}"`,
      ),
    );
  }

  // Unattended monitoring accepts service mode only.
  const mode = payload["mode"];
  if (mode !== "service") {
    throw new UnauthorizedException(
      errorBody(
        "HEALTH_TOKEN_INVALID_MODE",
        'Health-read token must carry mode="service"',
      ),
    );
  }

  return {
    callerProductCode,
    scope,
    ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
  };
}

@Injectable()
export class HealthReadGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<HealthReadAuthenticatedRequest>();
    req.healthReadAuth = await verifyProductRequest(
      req.headers,
      {
        code: "HEALTH_TOKEN_MISSING",
        message: "Missing health-read bearer token",
      },
      verifyHealthReadToken,
    );
    return true;
  }
}
