import type { ToolDescriptor } from "./discovery.types";

/**
 * The three target selectors, defined once and spread into all four tools.
 *
 * `anyOf` says they are ACCEPTED equally; it cannot say they are equally
 * ADVISABLE, and until 2026-08-26 nothing published here did. A consumer read
 * three peer options, picked `taskProfile` because "routes by intent" reads
 * best, and was then blocked on a `tenantId` it had no reason to hold - on the
 * axis `model_grant_authorizations_total{axis}` exists to count down to zero
 * (vxture-atlas#4/#39, corrected in #47, root cause TD-052).
 *
 * These live in one constant rather than four copies for the reason the
 * guidance itself exists: four copies is four places for the advice to drift,
 * and the next person to correct it would have to find all of them.
 */
const TARGET_SELECTOR_PROPERTIES = {
  modelCode: {
    type: "string",
    description:
      "Pins one model by code. Exact, and therefore the selector an operator " +
      "cannot repoint - prefer endpointCode unless the model itself is the " +
      "requirement.",
  },
  endpointCode: {
    type: "string",
    description:
      "Preferred selector for a product integration. Names a stable entry " +
      "point on the PRODUCT authorization axis; operators repoint it and " +
      "every product holding it follows, with no grant to update and no " +
      "tenant involved. Discover the codes you hold at GET /v1/endpoints.",
  },
  taskProfile: {
    type: "string",
    description:
      "Legacy TENANT axis. Resolves through model_grants.task_profile, so " +
      "it requires a tenantId the caller may have no reason to hold, and " +
      "repointing costs a grant row per tenant. That axis is being counted " +
      "down to removal - a product integrating today should use " +
      "endpointCode instead (vxture-atlas#47, TD-052).",
  },
} as const;

/** The `anyOf` clause that goes with the selectors above. */
const TARGET_SELECTOR_ANY_OF = [
  { required: ["modelCode"] },
  { required: ["endpointCode"] },
  { required: ["taskProfile"] },
] as const;

/**
 * Descriptors for Atlas's four S2S contract shapes. Kept in sync by
 * hand with the real request/response types (`runtime.types.ts`,
 * `embedding.types.ts`, `rerank.types.ts`, `parse.types.ts`) and
 * `docs/30-design/200-s2s-provider-surface.md` - not generated, since the
 * project has no JSON-Schema-from-TS pipeline today.
 */
export const ATLAS_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "atlas.chat",
    title: "Chat completion",
    description:
      "Generation (A4): chat/completion against a registered model, with optional tool-calling and streaming.",
    endpoint: { method: "POST", path: "/v1/chat" },
    input_schema: {
      type: "object",
      required: ["taskId", "tenantId", "messages"],
      // One of three, not modelCode alone - publishing modelCode as the sole
      // required selector is how a consumer ends up pinning a model code it
      // should not have pinned (vxture-atlas#198). Which of the three to
      // actually reach for is published in TARGET_SELECTOR_PROPERTIES above.
      anyOf: [...TARGET_SELECTOR_ANY_OF],
      properties: {
        ...TARGET_SELECTOR_PROPERTIES,
        // product_251 X-2, required since 2026-08-16: the agent task this call
        // belongs to. Same value across every product and model the task
        // touches - it is the only key that totals a task back up.
        taskId: { type: "string", maxLength: 128 },
        // /v1/chat takes tenantId from the BODY and refuses a non-UUID with
        // 400 INVALID_TENANT_ID. It was absent from this descriptor entirely,
        // so a caller building from the published contract 400s on its first
        // call. The other three capabilities key on workspaceId instead.
        tenantId: { type: "string", format: "uuid" },
        messages: { type: "array" },
        temperature: { type: "number" },
        maxTokens: { type: "integer" },
        topP: { type: "number" },
        tools: { type: "array" },
        toolChoice: {},
        stream: { type: "boolean" },
        applicationId: { type: "string" },
        applicationType: {
          enum: ["agent", "workflow", "api_client", "internal_service"],
        },
        usageType: { enum: ["normal"] },
      },
    },
    // TD-044 (2026-08-18): bumped from 1.0.0 for the first time. It never
    // moved when `taskId` became required (#230/#231, v0.15.0), which is
    // the whole reason this field was worth nothing as a drift signal - a
    // consumer diffing it alone would have seen no change. This bump is
    // retroactive: it documents ground truth for whoever starts polling
    // today, not a new change happening now. Same reason on the other three
    // descriptors below, without repeating the explanation.
    version: "1.2.0",
    deprecated: false,
    // Chat bills by realized tokens, not by call - a 100k-token
    // completion and a 100-token one are not the same unit of consumption.
    // This is what the C3 consume call actually sends as `amount`; the two
    // must not drift apart.
    metering: { metric: "atlas.chat", mode: "per_unit" },
  },
  {
    name: "atlas.embed",
    title: "Text embedding",
    description:
      "A1: batch text embedding. modelCode is itself the version-pinned identifier - dimension is stable per modelCode.",
    endpoint: { method: "POST", path: "/v1/embed" },
    input_schema: {
      type: "object",
      required: ["taskId", "texts", "workspaceId"],
      // One of three, not modelCode alone - publishing modelCode as the sole
      // required selector is how a consumer ends up pinning a model code it
      // should not have pinned (vxture-atlas#198). Which of the three to
      // actually reach for is published in TARGET_SELECTOR_PROPERTIES above.
      anyOf: [...TARGET_SELECTOR_ANY_OF],
      properties: {
        ...TARGET_SELECTOR_PROPERTIES,
        // product_251 X-2, required since 2026-08-16: the agent task this call
        // belongs to. Same value across every product and model the task
        // touches - it is the only key that totals a task back up.
        taskId: { type: "string", maxLength: 128 },
        texts: { type: "array", items: { type: "string" } },
        workspaceId: { type: "string" },
        tenantId: { type: "string" },
        applicationId: { type: "string" },
        applicationType: {
          enum: ["agent", "workflow", "api_client", "internal_service"],
        },
      },
    },
    output_schema: {
      type: "object",
      properties: {
        modelCode: { type: "string" },
        modelVersion: { type: "string" },
        dimension: { type: "integer" },
        vectors: { type: "array", items: { type: "array", items: { type: "number" } } },
      },
    },
    // TD-044 - same bump, same reason: see atlas.chat above.
    version: "1.2.0",
    deprecated: false,
    // Bills realized tokens, not calls: one request embeds N texts and the C3
    // consume sends `usage.totalTokens`. Published as `per_call` until
    // product_251 X-3 - a caller sizing its budget off this descriptor would
    // have been out by orders of magnitude, and the `atlas.chat` entry above
    // already said the two must not drift apart.
    metering: { metric: "atlas.embed", mode: "per_unit" },
  },
  {
    name: "atlas.rerank",
    title: "Candidate rerank",
    description:
      "A3: cross-encoder rerank of up to 100 candidates against a query. Scores are globally comparable within a modelCode.",
    endpoint: { method: "POST", path: "/v1/rerank" },
    input_schema: {
      type: "object",
      required: ["taskId", "query", "candidates", "workspaceId"],
      // One of three, not modelCode alone - publishing modelCode as the sole
      // required selector is how a consumer ends up pinning a model code it
      // should not have pinned (vxture-atlas#198). Which of the three to
      // actually reach for is published in TARGET_SELECTOR_PROPERTIES above.
      anyOf: [...TARGET_SELECTOR_ANY_OF],
      properties: {
        ...TARGET_SELECTOR_PROPERTIES,
        // product_251 X-2, required since 2026-08-16: the agent task this call
        // belongs to. Same value across every product and model the task
        // touches - it is the only key that totals a task back up.
        taskId: { type: "string", maxLength: 128 },
        query: { type: "string" },
        candidates: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            required: ["id", "text"],
            properties: { id: { type: "string" }, text: { type: "string" } },
          },
        },
        workspaceId: { type: "string" },
        tenantId: { type: "string" },
        applicationId: { type: "string" },
        applicationType: {
          enum: ["agent", "workflow", "api_client", "internal_service"],
        },
      },
    },
    output_schema: {
      type: "object",
      properties: {
        modelCode: { type: "string" },
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, score: { type: "number" } },
          },
        },
      },
    },
    // TD-044 - same bump, same reason: see atlas.chat above.
    version: "1.2.0",
    deprecated: false,
    // Bills per CANDIDATE - the C3 consume sends `candidates.length`, so a
    // 500-candidate pool is not one call's worth of consumption.
    metering: { metric: "atlas.rerank", mode: "per_unit" },
  },
  {
    name: "atlas.parse",
    title: "Document parse",
    description:
      "A2: layout/OCR/table/formula extraction over one or more page images, batched per request.",
    endpoint: { method: "POST", path: "/v1/parse" },
    input_schema: {
      type: "object",
      required: ["taskId", "task", "pages", "workspaceId"],
      // One of three, not modelCode alone - publishing modelCode as the sole
      // required selector is how a consumer ends up pinning a model code it
      // should not have pinned (vxture-atlas#198). Which of the three to
      // actually reach for is published in TARGET_SELECTOR_PROPERTIES above.
      anyOf: [...TARGET_SELECTOR_ANY_OF],
      properties: {
        ...TARGET_SELECTOR_PROPERTIES,
        // product_251 X-2, required since 2026-08-16: the agent task this call
        // belongs to. Same value across every product and model the task
        // touches - it is the only key that totals a task back up.
        taskId: { type: "string", maxLength: 128 },
        task: { enum: ["layout", "ocr", "table", "formula"] },
        pages: {
          type: "array",
          items: {
            type: "object",
            required: ["pageIndex"],
            properties: {
              pageIndex: { type: "integer" },
              imageRef: { type: "string" },
              imageBase64: { type: "string" },
              regions: { type: "array" },
            },
          },
        },
        workspaceId: { type: "string" },
        tenantId: { type: "string" },
        applicationId: { type: "string" },
        applicationType: {
          enum: ["agent", "workflow", "api_client", "internal_service"],
        },
      },
    },
    // TD-044 - same bump, same reason: see atlas.chat above.
    version: "1.2.0",
    deprecated: false,
    // Bills per PAGE - the C3 consume sends `pages.length`.
    metering: { metric: "atlas.parse", mode: "per_unit" },
  },
];

export const VXTURE_TOOLS_PROTOCOL_VERSION = "1.0";

/**
 * A descriptor may only be published once something actually serves it.
 * `atlas.parse` is defined above and the code path is complete
 * (`OpenAiCompatibleProvider.parseDocument`, vision-gated), but no registered
 * model carries `config.supportsVision: true`, so every call is still a
 * `501 MODEL_NOT_IMPLEMENTED`. Publishing it as formally identical to the
 * three capabilities we really serve would tell a product_210 §11 discovery
 * consumer that parse is available - withholding beats a visible 501.
 *
 * `deprecated: true` would be the wrong signal (retiring, not not-yet-built);
 * the descriptor shape cannot express maturity. Delete this set the day a
 * vision-capable model is registered and verified.
 */
const UNIMPLEMENTED_TOOL_NAMES: ReadonlySet<string> = new Set(["atlas.parse"]);

/** The subset actually served, i.e. what `.well-known/vxture-tools` returns. */
export const PUBLISHED_TOOL_DESCRIPTORS: ToolDescriptor[] =
  ATLAS_TOOL_DESCRIPTORS.filter(
    (descriptor) => !UNIMPLEMENTED_TOOL_NAMES.has(descriptor.name),
  );
