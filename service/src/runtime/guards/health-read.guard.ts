/**
 * health-read.guard.ts — platform#562 监测读面校验。
 * @package @atlas/service
 * @layer Domain
 * @category guard
 *
 * @description
 *   Verifies an RS256 S2S token minted by the platform's token-exchange for the
 *   **health read** plane only. It guards `GET /s2s/health` — a read-only view
 *   of `ServiceHealthService.current()` — so the platform's unattended watchdog
 *   can poll model-service health without a human operator session.
 *
 *   THREE planes stay disjoint by scope, and this guard is the third:
 *     · `/capability/*` → `OperatorAuthGuard`  — scope `mgmt:<aud>`, operator token.
 *     · `/v1/*`,`/tenancy/*` → `S2sAuthGuard`  — scope `tool:<aud>`, supply token.
 *     · `/s2s/health`    → `HealthReadGuard`    — scope `health:<aud>`, service token.
 *   A health token carries `health:atlas` and is rejected by BOTH other guards;
 *   an operator (`mgmt:`) or supply (`tool:`) token is rejected by this one. A
 *   read-only monitor therefore can touch nothing but health — it cannot reach
 *   `/v1/chat` (that would be widening the supply plane) nor the management
 *   plane.
 *
 *   TWO independent claims, as in `S2sAuthGuard`:
 *     `mode`  must be exactly `service` — a monitor is never OBO; a human
 *             operator token carries `operator`/nothing and fails.
 *     `scope` must be `health:<audience>` — minted from the same audience
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
 * The scope a health token for THIS audience must carry. Derived from the
 * audience (not hardcoded) for the same reason `S2sAuthGuard` derives its
 * `tool:<aud>`: the issuer builds `health:${target}` from the requested
 * audience, so a configurable `S2S_AUDIENCE` keeps matching. Exact match, not
 * a space-delimited membership test — one scope per token, by construction.
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

export async function verifyHealthReadToken(
  token: string,
  options: { jwks: JWTVerifyGetKey; issuer: string; audience: string },
): Promise<HealthReadContext> {
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
      errorBody("HEALTH_TOKEN_INVALID", "Health-read token failed verification"),
    );
  }

  const act = payload["act"] as { sub?: unknown } | undefined;
  const callerProductCode = typeof act?.sub === "string" ? act.sub : undefined;
  if (!callerProductCode) {
    // act.sub 必须存在 — 无 act = 用户级/误发 token，拒。
    throw new UnauthorizedException(
      errorBody(
        "HEALTH_TOKEN_MISSING_ACT",
        "Health-read token is missing act.sub (caller identity)",
      ),
    );
  }

  // scope 说「这是哪个面的票」：必须是 health:<aud>，拒掉 mgmt:/tool:。
  const scope = payload["scope"];
  if (scope !== requiredScope(options.audience)) {
    throw new UnauthorizedException(
      errorBody(
        "HEALTH_TOKEN_WRONG_SCOPE",
        `Health-read token must carry scope="${requiredScope(options.audience)}"`,
      ),
    );
  }

  // mode 说「这是哪种兑换铸的」：监测只接受 service（绝不 obo，更非 operator）。
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
    scope: typeof scope === "string" ? scope : "",
    ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
  };
}

@Injectable()
export class HealthReadGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<HealthReadAuthenticatedRequest>();
    const token = extractBearerToken(req.headers);
    if (!token) {
      throw new UnauthorizedException(
        errorBody("HEALTH_TOKEN_MISSING", "Missing health-read bearer token"),
      );
    }

    const issuer = requireIssuer();
    const audience = process.env["S2S_AUDIENCE"] || DEFAULT_AUDIENCE;

    req.healthReadAuth = await verifyHealthReadToken(token, {
      jwks: resolveRemoteJwks(issuer),
      issuer,
      audience,
    });
    return true;
  }
}
