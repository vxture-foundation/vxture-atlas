/**
 * operator-auth.guard.ts - management-plane operator-token verification
 * (product_250_management-plane-contract.md §2 M-1/M-5, vxture-atlas#52).
 *
 * Guards the capability plane (`/capability/*`) - registry CRUD and
 * provider-keys.
 *
 * Token contract (minted by the platform's token-exchange operator-OBO
 * mode): RS256, same issuer/JWKS `S2sAuthGuard` trusts. `aud="atlas"` ·
 * `sub="opr_<operator uuid>"` · `act.sub`=workforce client_id (currently
 * `"admin"`) · `mode="operator"` · `userType="operator"` · `realm="workforce"`
 * · `scope="mgmt:atlas"` · `exp` (TTL 300s) · `jti`. The token also carries
 * `amr` and `operator_role`; Atlas reads neither, which is a decision rather
 * than an omission - see `OperatorAuthContext`.
 *
 * `scope` discipline: management tokens carry `mgmt:atlas`, S2S tokens carry
 * `tool:atlas` - the two audiences are structurally disjoint by design
 * (product_250 §2: "管理票过不了供给面守卫，反之亦然"). This guard only
 * accepts `mgmt:atlas`, and `S2sAuthGuard` enforces the mirror rule.
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
import { isUuid } from "../../uuid";

const CLOCK_TOLERANCE_SECONDS = 60;
const AUDIENCE = "atlas";
const REQUIRED_REALM = "workforce";
const REQUIRED_USER_TYPE = "operator";
const REQUIRED_SCOPE = "mgmt:atlas";

/**
 * What Atlas keeps off a verified operator token.
 *
 * The line is: Atlas holds facts about the TOKEN, which it verifies itself,
 * and holds none about the AUTHENTICATION CEREMONY or the AUTHORIZATION
 * EVALUATION, which happen upstream and which it never witnesses.
 *
 * That is why `amr` and `operator_role` are not read at all - not read and
 * discarded, simply never touched:
 *
 * - `amr` describes how the operator authenticated to the IdP. Atlas was not
 *   present for it and cannot corroborate it. The authoritative record already
 *   exists in the platform's own audit; mirroring it into
 *   `audit.change_records` would create a second copy of a fact someone else
 *   owns - the same two-sources-of-truth objection that keeps
 *   `created_by`/`updated_by` unpopulated.
 * - `operator_role` is an input to authorization evaluation, and product_250
 *   M-2 assigns evaluation to platform. A provider holding the role without
 *   deciding on it is a field that invites exactly the wrong follow-up.
 *
 * `jti` stays: it identifies the token Atlas itself verified, so it is a fact
 * about this artifact and is symmetric with `S2sAuthContext`.
 */
export interface OperatorAuthContext {
  /** `opr_<uuid>` - the verified operator's identity (M-5 attribution). */
  operatorId: string;
  /** Workforce RP client id that minted the OBO exchange (`act.sub`). */
  actorClientId: string;
  jti?: string;
}

/**
 * `opr_<uuid>` -> `<uuid>`, for the columns that store a platform operator
 * ACCOUNT id rather than the token subject.
 *
 * Three tables type that column as `uuid` and document it as a bare value
 * referencing platform `admin.operator_accounts`
 * (`gateway_api_keys.created_by`/`updated_by`, `key_rotation_logs.rotated_by`).
 * The token subject is not that value - it is the prefixed form - so the
 * prefix must be stripped before the value reaches a `uuid` column.
 *
 * Returns undefined rather than throwing when the shape is unfamiliar. This
 * value is attribution, and `audit.change_records` already records the full
 * `operator_sub` as text for every write on these routes - so an unrecognised
 * subject should cost the redundant copy, not the operation. Failing the
 * rotation of a leaked provider key because a subject gained a new prefix
 * would be the wrong trade in the exact moment it matters most.
 */
export function toOperatorAccountUuid(
  operatorId: string | undefined,
): string | undefined {
  if (!operatorId) return undefined;
  const bare = operatorId.startsWith("opr_") ? operatorId.slice(4) : operatorId;
  return isUuid(bare) ? bare : undefined;
}

export interface OperatorAuthenticatedRequest {
  headers: Record<string, unknown>;
  operatorAuth?: OperatorAuthContext;
}

/**
 * Where the line sits, and why it is NOT "check as little as possible".
 *
 * Two different questions get confused with each other, and this repo has now
 * answered each once, in opposite directions:
 *
 * **"Is this instruction genuine, current, and addressed to me?"** - Atlas's
 * own, and nobody can answer it on Atlas's behalf. There is no network
 * boundary that distinguishes console from any other tailnet neighbour (karda
 * calls `/v1/*` directly, by design), so "it came from console" is not
 * something Atlas can observe - only something the token can prove. Every one
 * of the seven rejections below serves that question and all seven stay,
 * including the ones that overlap. `realm`/`userType` do partly re-assert what
 * `scope=mgmt:atlas` already implies; that redundancy is kept deliberately,
 * because the cost is one string comparison and the failure it covers is a
 * mis-minted token reaching a management plane.
 *
 * **"Is this person allowed to do this?"** - NOT Atlas's, at any level.
 * console / admin-bff / opera-bff authenticate the operator, evaluate the role
 * and run whatever step-up the platform catalogue demands. Re-deriving that
 * here does not add a second opinion, it adds a second AUTHORITY, and two
 * authorities drift.
 *
 * That is the whole distinction. Redundant verification of the CREDENTIAL is
 * cheap defence. Redundant adjudication of the PERSON is a contradiction
 * waiting to fire.
 *
 * So: do not "clean up" the checks below on the grounds that platform already
 * validated the operator - that reasoning applies to `amr` and
 * `operator_role`, which are deliberately not read, and not to these.
 */
export async function verifyOperatorToken(
  token: string,
  options: { jwks: JWTVerifyGetKey; issuer: string },
): Promise<OperatorAuthContext> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, options.jwks, {
      algorithms: ["RS256"],
      issuer: options.issuer,
      audience: AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch {
    throw new UnauthorizedException({
      code: "OPERATOR_TOKEN_INVALID",
      message: "Operator token failed verification",
    });
  }

  if (payload["scope"] !== REQUIRED_SCOPE) {
    // Disjoint-by-design (product_250 §2) - an S2S tool:atlas token must
    // 401 here exactly as an mgmt:atlas token must 401 on S2sAuthGuard.
    throw new UnauthorizedException({
      code: "OPERATOR_TOKEN_WRONG_SCOPE",
      message: `Operator token must carry scope="${REQUIRED_SCOPE}"`,
    });
  }

  if (payload["realm"] !== REQUIRED_REALM) {
    throw new UnauthorizedException({
      code: "OPERATOR_TOKEN_WRONG_REALM",
      message: `Operator token must carry realm="${REQUIRED_REALM}"`,
    });
  }

  if (payload["userType"] !== REQUIRED_USER_TYPE) {
    throw new UnauthorizedException({
      code: "OPERATOR_TOKEN_WRONG_USER_TYPE",
      message: `Operator token must carry userType="${REQUIRED_USER_TYPE}"`,
    });
  }

  const operatorId = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!operatorId) {
    // M-5: attribution has no fallback - a token with no verifiable operator
    // identity cannot be allowed to mutate anything under this guard.
    throw new UnauthorizedException({
      code: "OPERATOR_TOKEN_MISSING_SUB",
      message: "Operator token is missing sub (operator identity)",
    });
  }

  const act = payload["act"] as { sub?: unknown } | undefined;
  const actorClientId = typeof act?.sub === "string" ? act.sub : undefined;
  if (!actorClientId) {
    throw new UnauthorizedException({
      code: "OPERATOR_TOKEN_MISSING_ACT",
      message: "Operator token is missing act.sub (workforce RP identity)",
    });
  }

  return {
    operatorId,
    actorClientId,
    ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
  };
}

@Injectable()
export class OperatorAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<OperatorAuthenticatedRequest>();
    const token = extractBearerToken(req.headers);
    if (!token) {
      throw new UnauthorizedException({
        code: "OPERATOR_TOKEN_MISSING",
        message: "Missing operator bearer token",
      });
    }

    const issuer = requireIssuer();
    req.operatorAuth = await verifyOperatorToken(token, {
      jwks: resolveRemoteJwks(issuer),
      issuer,
    });
    return true;
  }
}
