/**
 * reasoning-tool-exposure.ts - measure the population TD-046 breaks, given
 * that the breakage itself is unobservable here.
 *
 * ## The distinction this file exists to keep
 *
 * TD-046 says, correctly: **the failure is invisible to Atlas**. A thinking
 * model's `reasoning_content` must be echoed back on later turns when `tools`
 * is in play, both adapters drop it, and the upstream's 400 therefore lands at
 * the CALLER. From Atlas's side that exchange is a normal 200.
 *
 * That true sentence was then doing duty as a second one - "so the exposure
 * cannot be surveyed" - and vxture-atlas#23 was parked on it as *风险存在，且
 * 暂时无法调查*. The second sentence is false, and nothing separated it from
 * the first. An unmeasurable risk and a measured-at-zero one look identical on
 * a board, which is the shape this repo keeps producing.
 *
 * ## What is actually knowable
 *
 * The broken combination is three facts. Atlas already held two of them and
 * never joined them:
 *
 *   1. the model produced reasoning - `usage.reasoningTokens`, recorded since
 *      `incr/01_reqlog_cost_splits`;
 *   2. the request is multi-round - visible in `messages`;
 *   3. the request carried `tools` - visible on the request, stored nowhere.
 *
 * So this is one counter, not a column and not a schema change. Deliberately:
 * the question it has to answer first is go/no-go ("is anyone in this shape,
 * and which product"), and a metric answers that without db-init. If it reads
 * non-zero, a column earns its place then - that is the grain needed to tell
 * a specific tenant, and it is a cost worth paying only once the answer is
 * known to be yes.
 *
 * ## Two events, one label apart
 *
 * `multiRound="no"` is the **loaded gun**: this call carried `tools` and came
 * back with reasoning, so the caller now holds an assistant turn it has no way
 * to echo back. Nothing has failed yet.
 *
 * `multiRound="yes"` is the **trigger already pulled**: the caller sent prior
 * assistant turns alongside `tools` to a model that reasons - and Atlas saw a
 * success, which means either the upstream did not enforce it on this path or
 * the caller has not yet round-tripped a reasoning-bearing turn. Either way it
 * is the closest observable thing to the failure itself.
 *
 * ## What this does NOT measure, and who holds that half
 *
 * - **Whether anyone actually got a 400.** Still invisible here, by
 *   construction. This counts exposure, not incidents.
 * - **Calls that never reach a success log** - the 400 happens downstream of a
 *   response Atlas already returned, so those are not lost; but a call that
 *   fails inside Atlas has no usage to classify and is correctly absent.
 * - **Non-chat surfaces.** `tools` exists only on `/v1/chat`.
 */
import type { ChatMessage, TokenUsage } from "../types/runtime.types";

/** The metric. Labelled by product so the answer names who, not just how many. */
export const REASONING_TOOL_EXPOSURE_METRIC =
  "model_reasoning_tool_exposure_total";

export interface ReasoningToolExposureLabels {
  product: string;
  /** "yes" once the caller is sending prior assistant turns back. */
  multiRound: "yes" | "no";
}

/**
 * The labels for this call, or `undefined` when it is not in the population.
 *
 * Both conditions are required. `tools` alone is fine - a model that does not
 * reason has nothing to echo. Reasoning alone is fine - that is every ordinary
 * thinking-model call and it works today. Only the pair is the shape TD-046
 * describes, and counting either one alone would report a number far larger
 * than the risk, which is its own way of being useless.
 */
export function classifyReasoningToolCall(input: {
  toolsPresent: boolean;
  reasoningTokens: number | undefined;
  messages: readonly ChatMessage[] | undefined;
  productCode: string | undefined;
}): ReasoningToolExposureLabels | undefined {
  if (!input.toolsPresent) return undefined;

  // `undefined` means the upstream reported no split - not zero. Both are
  // outside the population, but for different reasons, and only one of them
  // would be a bug to treat as a number (TD-047's rule, applied here).
  const reasoning = input.reasoningTokens;
  if (reasoning === undefined || reasoning <= 0) return undefined;

  return {
    product: input.productCode ?? "unknown",
    multiRound: hasPriorAssistantTurn(input.messages) ? "yes" : "no",
  };
}

/**
 * Has the caller sent an assistant turn back?
 *
 * That - not the message count - is what makes a request multi-round in the
 * sense that matters: a conversation of ten user messages and no assistant
 * turns has never round-tripped anything, so there is no reasoning content the
 * caller could have failed to return.
 */
export function hasPriorAssistantTurn(
  messages: readonly ChatMessage[] | undefined,
): boolean {
  return (messages ?? []).some((m) => m.role === "assistant");
}

/** Narrow the usage shape this module needs, so callers cannot pass the wrong number. */
export function reasoningTokensOf(usage: TokenUsage | undefined): number | undefined {
  return usage?.reasoningTokens;
}
