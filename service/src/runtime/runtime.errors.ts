/**
 * runtime.errors.ts - the consumption-plane error envelope
 * @package @atlas/service
 * @layer Domain
 * @category Runtime
 *
 * @description
 *   Every /v1 error leaves through here so callers branch on a stable `code`
 *   instead of parsing message text (product_251 X-1).
 */

import { HttpException, HttpStatus } from "@nestjs/common";

// ============================================================================
// Types
// ============================================================================

/**
 * The consumption-plane vocabulary. This union is the CONTRACT - consumers
 * write their error branches off it - so two properties have to hold, and both
 * are enforced mechanically rather than by review:
 *
 *   - every member is reachable   -> scripts/guardrails/check-error-codes.mjs
 *   - every member is classified  -> RETRYABLE below is an exhaustive Record,
 *                                    so adding a code without deciding whether
 *                                    it is worth retrying fails type-check
 *
 * Neither held before product_251 X-1 was applied. `MODEL_RUNTIME_REQUEST_FAILED`,
 * `QUOTA_EXHAUSTED` and `RERANK_UNAVAILABLE` were declared and never thrown,
 * while `MODEL_RUNTIME_STREAM_FAILED` and `PARSE_FAILED` were thrown at callers
 * and never declared. A consumer building branches from this list therefore got
 * three dead ones and missed two live ones.
 */
export type ModelRuntimeErrorCode =
  // --- routing ---
  | "MODEL_NOT_ROUTABLE"
  /** `endpointCode` named no live entry point (missing, or deactivated). */
  | "ENDPOINT_NOT_ROUTABLE"
  // No active grant matches the requested taskProfile for this tenant/application.
  | "TASK_PROFILE_NOT_ROUTABLE"
  | "MODEL_NOT_IMPLEMENTED"
  // --- authorization and limits ---
  | "NOT_ENTITLED"
  /**
   * The workspace has no remaining C2 quota. Spelled per product_251 X-1;
   * `QUOTA_EXHAUSTED` was the docs-only spelling and never existed in code.
   */
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  // --- upstream ---
  | "PROVIDER_UNAVAILABLE"
  /** Terminal failure of a streaming exchange, delivered as an SSE error frame. */
  | "MODEL_RUNTIME_STREAM_FAILED"
  /**
   * One malformed frame inside an otherwise live upstream stream. Recoverable:
   * the stream continues, so this is the one code a caller may see without the
   * exchange having ended.
   *
   * Spelled `PARSE_FAILED` until product_251 X-1. That name sat one letter away
   * from the `/v1/parse` document endpoint's own codes while meaning something
   * entirely unrelated - the exact one-word-two-meanings case P2 forbids. It was
   * never declared or documented, so no caller could have been branching on it.
   */
  | "UPSTREAM_FRAME_UNPARSEABLE"
  /**
   * The upstream answered 400/413/422: it refused THIS request's content (too
   * long for the model's context, a payload over its size cap, a parameter it
   * rejects), not the service. Kept apart from PROVIDER_UNAVAILABLE because the
   * two need opposite handling - that one is retryable and trips the circuit
   * breaker; this one must do neither, or one caller retrying an oversized
   * request takes the model offline for every other product.
   */
  | "UPSTREAM_REJECTED_REQUEST"
  // --- request body ---
  // Raised by the JSON parser, before routing, auth, or any /v1 surface code
  // runs - so no requestId exists yet and no reqlog row is written.
  /** Body over MAX_REQUEST_BODY_BYTES. The message names both sizes. */
  | "PAYLOAD_TOO_LARGE"
  /** Body is not parseable JSON (or form data), or its encoding is unsupported. */
  | "REQUEST_BODY_MALFORMED"
  // --- transport auth ---
  // Rejected by S2sAuthGuard before any runtime code runs, but still delivered
  // to the same caller on the same surface, so they belong to the same
  // published list. They used to be spelled only inside the guard, which is
  // why a consumer had to treat the guard's body as a THIRD envelope shape
  // (vxture-atlas#198) rather than one more code in a list they already had.
  | "S2S_TOKEN_MISSING"
  | "S2S_TOKEN_INVALID"
  | "S2S_TOKEN_MISSING_ACT"
  | "S2S_TOKEN_WRONG_SCOPE"
  | "S2S_TOKEN_INVALID_MODE"
  /** Server-side misconfiguration, not a caller error - no token can fix it. */
  | "AUTH_ISSUER_NOT_CONFIGURED"
  // --- caller identity and scope ---
  // tenantId/applicationId reaching a `uuid`-typed grant column must actually
  // be a UUID - rejected as a clean 400, not a Postgres cast error.
  | "INVALID_TENANT_ID"
  | "INVALID_APPLICATION_ID"
  | "UNKNOWN_FILTER"
  | "TENANCY_SCOPE_UNAVAILABLE"
  | "TENANCY_SCOPE_INVALID"
  | "INVALID_WINDOW"
  // --- request validation ---
  // These replace bare-string `BadRequestException`s, which Nest rendered as
  // `{statusCode, message, error}` with NO `code` at all - a second envelope
  // shape on the same surface, and the one a new consumer hits first.
  //
  // Codes are per CONCEPT, not per throw site: "one of modelCode/endpointCode/
  // taskProfile is required" is rejected in five files and is one fact about the
  // request, so it is one code. A caller should never have to learn which file
  // rejected it.
  | "TARGET_SELECTOR_REQUIRED"
  | "TASK_ID_REQUIRED"
  | "TENANT_ID_REQUIRED"
  | "WORKSPACE_ID_REQUIRED"
  | "APPLICATION_ID_REQUIRED"
  | "APPLICATION_TYPE_REQUIRED"
  | "APPLICATION_TYPE_INVALID"
  | "USAGE_TYPE_INVALID"
  | "CHAT_MESSAGES_REQUIRED"
  | "CHAT_MESSAGES_INVALID"
  | "EMBED_TEXTS_REQUIRED"
  | "EMBED_TEXTS_INVALID"
  | "RERANK_QUERY_REQUIRED"
  | "RERANK_CANDIDATES_REQUIRED"
  | "RERANK_CANDIDATES_INVALID"
  | "CANDIDATE_POOL_TOO_LARGE"
  | "PARSE_TASK_REQUIRED"
  | "PARSE_TASK_INVALID"
  | "PARSE_PAGES_REQUIRED"
  | "PARSE_PAGES_INVALID"
  // The client disconnected mid-stream: not a provider failure (no breaker
  // count, no failover), but still a recorded, possibly-token-burning event.
  | "CLIENT_ABORTED";

/**
 * Is another attempt at the same request worth making? (product_251 X-1)
 *
 * Answered here, once, rather than at each throw site: the caller needs this on
 * EVERY error, and a per-site flag would drift the moment someone adds a throw
 * and forgets. Being an exhaustive Record over the union, a new code that
 * nobody has classified is a compile error, not a silent `undefined`.
 *
 * The line is "would the identical request succeed later, unattended". A
 * commercial quota ceiling is not retryable even though it does eventually
 * reset - retrying only floods the caller's own queue (the caller should
 * suspend the task); a technical rate gate is, and carries `retryAfterMs`.
 * Anything that needs a human - an operator granting access, a developer
 * fixing a payload - is not retryable, because nothing changes by waiting.
 */
const RETRYABLE: Record<ModelRuntimeErrorCode, boolean> = {
  MODEL_NOT_ROUTABLE: false,
  ENDPOINT_NOT_ROUTABLE: false,
  TASK_PROFILE_NOT_ROUTABLE: false,
  MODEL_NOT_IMPLEMENTED: false,
  NOT_ENTITLED: false,
  QUOTA_EXCEEDED: false,
  RATE_LIMITED: true,
  PROVIDER_UNAVAILABLE: true,
  MODEL_RUNTIME_STREAM_FAILED: true,
  UPSTREAM_FRAME_UNPARSEABLE: true,
  // The identical request is refused identically; the caller has to shrink or
  // split it. The same reasoning covers both body codes below.
  UPSTREAM_REJECTED_REQUEST: false,
  PAYLOAD_TOO_LARGE: false,
  REQUEST_BODY_MALFORMED: false,
  // A token problem is never fixed by repeating the same request. The caller's
  // move is to re-mint and call again, which is standard 401 handling and a
  // different thing from the back-off `retryable` describes.
  S2S_TOKEN_MISSING: false,
  S2S_TOKEN_INVALID: false,
  S2S_TOKEN_MISSING_ACT: false,
  S2S_TOKEN_WRONG_SCOPE: false,
  S2S_TOKEN_INVALID_MODE: false,
  AUTH_ISSUER_NOT_CONFIGURED: false,
  INVALID_TENANT_ID: false,
  INVALID_APPLICATION_ID: false,
  // A filter the endpoint does not know. Refused rather than dropped: an
  // ignored filter returns HTTP 200 and a well-formed body that answers a
  // different question than the caller asked, which they cannot detect.
  UNKNOWN_FILTER: false,
  TENANCY_SCOPE_UNAVAILABLE: false,
  TENANCY_SCOPE_INVALID: false,
  INVALID_WINDOW: false,
  TARGET_SELECTOR_REQUIRED: false,
  TASK_ID_REQUIRED: false,
  TENANT_ID_REQUIRED: false,
  WORKSPACE_ID_REQUIRED: false,
  APPLICATION_ID_REQUIRED: false,
  APPLICATION_TYPE_REQUIRED: false,
  APPLICATION_TYPE_INVALID: false,
  USAGE_TYPE_INVALID: false,
  CHAT_MESSAGES_REQUIRED: false,
  CHAT_MESSAGES_INVALID: false,
  EMBED_TEXTS_REQUIRED: false,
  EMBED_TEXTS_INVALID: false,
  RERANK_QUERY_REQUIRED: false,
  RERANK_CANDIDATES_REQUIRED: false,
  RERANK_CANDIDATES_INVALID: false,
  CANDIDATE_POOL_TOO_LARGE: false,
  PARSE_TASK_INVALID: false,
  PARSE_TASK_REQUIRED: false,
  PARSE_PAGES_REQUIRED: false,
  PARSE_PAGES_INVALID: false,
  CLIENT_ABORTED: false,
};

export function isRetryable(code: ModelRuntimeErrorCode): boolean {
  return RETRYABLE[code];
}

/** The vocabulary, at runtime. Keyed off RETRYABLE so the two cannot diverge. */
export const MODEL_RUNTIME_ERROR_CODES = Object.keys(
  RETRYABLE,
) as ModelRuntimeErrorCode[];

export function isModelRuntimeErrorCode(
  value: unknown,
): value is ModelRuntimeErrorCode {
  return typeof value === "string" && Object.hasOwn(RETRYABLE, value);
}

/**
 * The envelope as a plain body, for the few places that must keep throwing a
 * specific Nest exception class (the auth guards, whose 401/403 status is part
 * of the transport contract) and so cannot use ModelRuntimeException. Same
 * fields, same `retryable` source - the point is that there is no second
 * definition of the shape anywhere.
 */
export function errorBody(
  code: ModelRuntimeErrorCode,
  message: string,
): ModelRuntimeErrorResponse {
  return { code, message, retryable: RETRYABLE[code] };
}

export interface ModelRuntimeErrorResponse {
  code: ModelRuntimeErrorCode;
  message: string;
  /**
   * product_251 X-1: MUST be present on every error. Without it a caller has
   * to hard-code its own copy of the table above and re-derive it from the
   * code, which goes stale silently.
   */
  retryable: boolean;
  requestId?: string;
  modelCode?: string;
  provider?: string;
  /** RATE_LIMITED (429) - milliseconds until the caller should retry. */
  retryAfterMs?: number;
}

// ============================================================================
// Exception
// ============================================================================

export class ModelRuntimeException extends HttpException {
  constructor(
    status: HttpStatus | number,
    readonly code: ModelRuntimeErrorCode,
    message: string,
    metadata: {
      requestId?: string;
      modelCode?: string;
      provider?: string;
      retryAfterMs?: number;
    } = {},
  ) {
    super(
      {
        code,
        message,
        retryable: RETRYABLE[code],
        ...(metadata.requestId !== undefined
          ? { requestId: metadata.requestId }
          : {}),
        ...(metadata.modelCode !== undefined
          ? { modelCode: metadata.modelCode }
          : {}),
        ...(metadata.provider !== undefined
          ? { provider: metadata.provider }
          : {}),
        ...(metadata.retryAfterMs !== undefined
          ? { retryAfterMs: metadata.retryAfterMs }
          : {}),
      } satisfies ModelRuntimeErrorResponse,
      status,
    );
  }
}
