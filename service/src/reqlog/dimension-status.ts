/**
 * dimension-status.ts - why a usage dimension is empty (usage-record batch 4).
 *
 * The owner's requirement (2026-09-30): Atlas is a base platform, so every
 * dimension exists as a column, and an empty one must say WHY it is empty -
 * "we have no mechanism" and "the other side has none" and "not integrated"
 * are different facts, and a bare NULL says none of them.
 *
 * Each of the eight words names who acts on it. That is the test for whether
 * two causes deserve two words: if different people fix them, they are
 * different words.
 *
 *   not_integrated   Atlas has no mechanism to collect it            -> Atlas dev
 *   not_supported    the other side does not offer it at all         -> nobody
 *   not_reported     the other side should have, and this time did not -> investigate
 *   not_configured   the mechanism exists, operator config is missing -> operator
 *   capture_failed   it was given, and Atlas failed to take it       -> Atlas (defect)
 *   not_specified    the caller did not specify it; default used     -> caller
 *   not_applicable   this kind of call has no such thing             -> nobody
 *   not_reached      the request never reached the other side        -> the error code
 *
 * "The other side" is whoever owns the fact: the model vendor for usage, the
 * platform for billing, the token issuer for token claims.
 *
 * `not_supported` is only ever DECLARED (by an adapter that knows its protocol
 * has no such field) and never inferred from "nothing arrived": an inferred
 * "not supported" and a "this time it was missing" look identical in the data,
 * which is the confusion this vocabulary exists to end.
 *
 * The database enforces the vocabulary (reqlog.dimension_status_valid, incr/07);
 * a test enforces that every nullable usage column of request_records is
 * registered here, so a column added later cannot silently fall outside it.
 */

export const DIMENSION_STATUSES = [
  "not_integrated",
  "not_supported",
  "not_reported",
  "not_configured",
  "capture_failed",
  "not_specified",
  "not_applicable",
  "not_reached",
] as const;
export type DimensionStatus = (typeof DIMENSION_STATUSES)[number];

export type Capability = "chat" | "embed" | "rerank" | "parse";

/** What the writer knows about the row beyond its column values. */
export interface ClassifyContext {
  capability: Capability | undefined;
  /** The call reached the other side (usage_source was set). */
  reached: boolean;
  usageSource: "reported" | "absent" | "partial" | undefined;
  streamed: boolean | undefined;
  /** Row fields the adapter declared its protocol does not offer. */
  notSupported: ReadonlySet<string>;
  /** Reasons a caller determined itself, which the rules below cannot see. */
  explicit: Readonly<Record<string, DimensionStatus>>;
  /** The row's own column values, for rules that follow another column. */
  row: Readonly<Record<string, unknown>>;
}

type Rule = (ctx: ClassifyContext) => DimensionStatus;

/** A fact the model vendor reports about the call. */
const upstream: Rule = (ctx) => {
  if (!ctx.reached) return "not_reached";
  return "not_reported";
};

const caller: Rule = () => "not_specified";
const integrated = (): DimensionStatus => "not_integrated";

/** Atlas writes this itself on every row that reached a provider; missing = a defect. */
const atlasWhenReached: Rule = (ctx) => (ctx.reached ? "capture_failed" : "not_reached");

interface Dimension {
  /** Capabilities the dimension exists for; absent = all. */
  appliesTo?: readonly Capability[];
  rule: Rule;
}

const CHAT: readonly Capability[] = ["chat"];

/**
 * Every nullable usage column of reqlog.request_records, by its Prisma field
 * name. Not in here, by design: the row's identity and bookkeeping
 * (id, requestId, status, usageType, createdAt) and dimensionStatus itself.
 */
export const DIMENSIONS: Readonly<Record<string, Dimension>> = {
  // --- attribution -----------------------------------------------------------
  taskId: { rule: caller },
  // A non-UUID tenant is dropped to NULL by the writer; it passes that in as
  // capture_failed explicitly. Otherwise the caller simply sent none.
  tenantId: { rule: caller },
  workspaceId: { rule: caller },
  userId: { rule: caller },
  applicationId: { rule: caller },
  applicationType: { rule: caller },
  agentId: { rule: caller },
  featureId: { rule: caller },
  businessId: { rule: caller },
  productCode: { rule: caller },
  // A uuid into another database; product_code is the resolvable form and
  // nothing resolves this one.
  productId: { rule: integrated },
  downstreamIdentityHash: { rule: integrated },
  modelCode: { rule: () => "not_reached" },
  providerCode: { rule: () => "not_reached" },
  // NULL when the caller named a model or task profile rather than an endpoint.
  endpointCode: { rule: () => "not_applicable" },
  selectorKind: { rule: caller },
  selectorValue: { rule: caller },
  tokenJti: {
    rule: (ctx) => (ctx.row["productCode"] == null ? "not_specified" : "not_reported"),
  },

  // --- what the vendor reported ---------------------------------------------
  inputTokens: { rule: upstream },
  outputTokens: { rule: upstream },
  totalTokens: { rule: upstream },
  cachedInputTokens: { appliesTo: CHAT, rule: upstream },
  reasoningTokens: { appliesTo: CHAT, rule: upstream },
  cacheWriteInputTokens: { appliesTo: CHAT, rule: upstream },
  cacheWrite1hInputTokens: { appliesTo: CHAT, rule: upstream },
  upstreamRequestId: { rule: upstream },
  upstreamModel: { rule: upstream },
  upstreamUsage: { rule: upstream },
  finishReason: { appliesTo: CHAT, rule: upstream },
  nativeFinishReason: { appliesTo: CHAT, rule: upstream },
  serviceTier: { rule: upstream },
  inputImageTokens: { appliesTo: CHAT, rule: upstream },
  inputAudioTokens: { appliesTo: CHAT, rule: upstream },
  outputAudioTokens: { appliesTo: CHAT, rule: upstream },
  outputImageTokens: { appliesTo: CHAT, rule: upstream },
  toolUsePromptTokens: { appliesTo: CHAT, rule: upstream },
  webSearchRequests: { appliesTo: CHAT, rule: upstream },
  // Derived from finish_reason, so it is empty for exactly the same reason.
  contentFiltered: { appliesTo: CHAT, rule: upstream },
  usageSource: { rule: () => "not_reached" },

  // --- what Atlas knew at the call -----------------------------------------
  latencyMs: { rule: () => "not_reached" },
  // The chat path writes it on every attempt; the S2S surfaces never have.
  attemptIndex: {
    rule: (ctx) => (ctx.capability === "chat" ? "capture_failed" : "not_integrated"),
  },
  startedAt: { rule: atlasWhenReached },
  firstTokenAt: {
    rule: (ctx) => {
      if (ctx.streamed !== true) return "not_applicable";
      return ctx.reached ? "not_reported" : "not_reached";
    },
  },
  streamed: { rule: atlasWhenReached },
  providerKeyAlias: { rule: () => "not_configured" },
  thinkingMode: { appliesTo: CHAT, rule: caller },
  maxTokens: { appliesTo: CHAT, rule: caller },
  // Empty because nothing cut the call short.
  cancelledBy: { rule: () => "not_applicable" },
  modelBehaviorVersion: { rule: () => "not_reached" },
  deployStage: { rule: () => "not_configured" },
  toolCount: { appliesTo: CHAT, rule: () => "capture_failed" },
  messageCount: { appliesTo: CHAT, rule: () => "capture_failed" },
  toolCallsMade: {
    appliesTo: CHAT,
    rule: (ctx) => (ctx.reached ? "not_reported" : "not_reached"),
  },
  vectorCount: { appliesTo: ["embed"], rule: upstream },
  vectorDimension: { appliesTo: ["embed"], rule: upstream },
  upstreamHost: {
    rule: (ctx) => (ctx.reached ? "not_configured" : "not_reached"),
  },
  // Atlas has neither a queue nor a batch mode; the writer states 0 / false on
  // every row that reached a provider.
  queueWaitMs: { rule: atlasWhenReached },
  isBatch: { rule: atlasWhenReached },
  // Knobs and inputs Atlas does not have today.
  reasoningBudgetTokens: { appliesTo: CHAT, rule: integrated },
  inputImageCount: { appliesTo: ["chat", "parse"], rule: integrated },
  inputAudioSeconds: { appliesTo: CHAT, rule: integrated },
  inputFileCount: { appliesTo: CHAT, rule: integrated },
  generatedImageCount: { rule: integrated },
  generatedMediaSeconds: { rule: integrated },

  // --- the row's own price (the writer passes its reason explicitly) -------
  upstreamCost: { rule: upstream },
  costCurrency: { rule: upstream },
  priceRuleId: { rule: upstream },
  pricingWindow: { rule: upstream },

  // --- the platform (the runtime passes the consume outcome explicitly) ----
  billedMetricKey: { rule: () => "not_applicable" },
  billedAmount: { rule: () => "not_applicable" },
  costUnit: { rule: () => "not_applicable" },
  usageEventId: { rule: () => "not_applicable" },
};

/**
 * For every registered dimension that is null in `row`, the reason - in this
 * order: a reason the caller stated; not_applicable when the dimension does
 * not exist for this capability; not_supported when the adapter declared it
 * (and the call reached it); otherwise the dimension's own rule.
 *
 * Returns undefined when nothing is null, so a fully populated row carries no
 * map at all.
 */
export function classifyNulls(
  row: Readonly<Record<string, unknown>>,
  ctx: Omit<ClassifyContext, "row">,
): Record<string, DimensionStatus> | undefined {
  const full: ClassifyContext = { ...ctx, row };
  const out: Record<string, DimensionStatus> = {};
  for (const [field, dim] of Object.entries(DIMENSIONS)) {
    const value = row[field];
    if (value !== null && value !== undefined) continue;
    const explicit = ctx.explicit[field];
    if (explicit !== undefined) {
      out[toColumn(field)] = explicit;
      continue;
    }
    if (dim.appliesTo && ctx.capability && !dim.appliesTo.includes(ctx.capability)) {
      out[toColumn(field)] = "not_applicable";
      continue;
    }
    if (ctx.reached && ctx.notSupported.has(field)) {
      out[toColumn(field)] = "not_supported";
      continue;
    }
    out[toColumn(field)] = dim.rule(full);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The map is keyed by COLUMN name - it is read with SQL, next to the columns. */
export function toColumn(field: string): string {
  return field
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([a-z])(\d)/g, "$1_$2")
    .toLowerCase();
}
