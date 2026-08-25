/**
 * request-contract.ts - what `/v1` refuses an incomplete request with (#21).
 *
 * ## Why this is not derived from the TypeScript types
 *
 * The obvious answer to "publish the request shapes" is to export the
 * interfaces. That would publish a **wrong** contract, and the proof is one
 * field: `ChatRequest.taskId` is declared `taskId?: string` - optional - while
 * `requireTaskId()` rejects every call that omits it, on all four surfaces.
 *
 * A schema generated from the types would therefore tell four consumers that
 * `taskId` is optional. That is the same class of statement as the letter which
 * promised `QUOTA_EXHAUSTED` for a code that has always been `QUOTA_EXCEEDED` -
 * and it is the class of statement #21 exists to stop shipping.
 *
 * The types describe what the compiler accepts inside this service. The
 * validators describe what the API accepts from outside it. Only the second one
 * is the contract, so the contract is written here, next to the codes it
 * publishes, and held to the validators by tests rather than by a generator.
 *
 * ## Both directions are checked, by different things
 *
 * - **Declared implies enforced**: for every rule below, a test omits the field
 *   on that surface and asserts the declared code comes back. A rule that
 *   describes a refusal the runtime does not make fails.
 * - **Enforced implies declared**: `check-request-contract.mjs` requires every
 *   `*_REQUIRED` code in the published vocabulary to appear here. Adding a new
 *   required field means adding a code (X-1 makes that unavoidable), and the
 *   guardrail then makes publishing it unavoidable too.
 *
 * Neither direction is a promise about this file being maintained. They are the
 * two halves that make it impossible to leave it stale quietly.
 */

/**
 * `always` - the field must be present and non-blank.
 * `oneOf` - at least one of `fields` must be present.
 * `requiredWith` - required only once the fields in `given` are present.
 */
export type V1RuleKind = "always" | "oneOf" | "requiredWith";

export interface V1RequestRule {
  kind: V1RuleKind;
  /** Top-level request fields the rule is about. */
  fields: string[];
  /** Only on `requiredWith`: what makes the rule apply. */
  given?: string[];
  /** The code `/v1` answers with when the rule is not satisfied. */
  code: string;
}

/**
 * One entry per `/v1` surface.
 *
 * Worth reading rather than skimming, because the surfaces genuinely differ and
 * the difference has bitten before: **`/v1/chat` attributes by `tenantId`, and
 * the three S2S capabilities attribute by `workspaceId`.** A caller that
 * assumes one shape across all four gets a 400 on three of them.
 */
export const V1_REQUEST_CONTRACT: Readonly<Record<string, readonly V1RequestRule[]>> =
  Object.freeze({
    "/v1/chat": [
      { kind: "always", fields: ["taskId"], code: "TASK_ID_REQUIRED" },
      { kind: "always", fields: ["tenantId"], code: "TENANT_ID_REQUIRED" },
      {
        kind: "oneOf",
        fields: ["modelCode", "endpointCode", "taskProfile"],
        code: "TARGET_SELECTOR_REQUIRED",
      },
      { kind: "always", fields: ["messages"], code: "CHAT_MESSAGES_REQUIRED" },
      {
        kind: "requiredWith",
        fields: ["applicationType"],
        given: ["applicationId"],
        code: "APPLICATION_TYPE_REQUIRED",
      },
      {
        kind: "requiredWith",
        fields: ["applicationId"],
        given: ["applicationId"],
        code: "APPLICATION_ID_REQUIRED",
      },
    ],
    "/v1/embed": [
      { kind: "always", fields: ["taskId"], code: "TASK_ID_REQUIRED" },
      { kind: "always", fields: ["workspaceId"], code: "WORKSPACE_ID_REQUIRED" },
      {
        kind: "oneOf",
        fields: ["modelCode", "endpointCode", "taskProfile"],
        code: "TARGET_SELECTOR_REQUIRED",
      },
      { kind: "always", fields: ["texts"], code: "EMBED_TEXTS_REQUIRED" },
    ],
    "/v1/rerank": [
      { kind: "always", fields: ["taskId"], code: "TASK_ID_REQUIRED" },
      { kind: "always", fields: ["workspaceId"], code: "WORKSPACE_ID_REQUIRED" },
      {
        kind: "oneOf",
        fields: ["modelCode", "endpointCode", "taskProfile"],
        code: "TARGET_SELECTOR_REQUIRED",
      },
      { kind: "always", fields: ["query"], code: "RERANK_QUERY_REQUIRED" },
      {
        kind: "always",
        fields: ["candidates"],
        code: "RERANK_CANDIDATES_REQUIRED",
      },
    ],
    "/v1/parse": [
      { kind: "always", fields: ["taskId"], code: "TASK_ID_REQUIRED" },
      { kind: "always", fields: ["workspaceId"], code: "WORKSPACE_ID_REQUIRED" },
      {
        kind: "oneOf",
        fields: ["modelCode", "endpointCode", "taskProfile"],
        code: "TARGET_SELECTOR_REQUIRED",
      },
      { kind: "always", fields: ["pages"], code: "PARSE_PAGES_REQUIRED" },
    ],
  });
