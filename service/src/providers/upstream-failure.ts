/**
 * upstream-failure.ts - a failed upstream call that still cost tokens.
 *
 * TD-037 unified the reqlog grain so a failed candidate writes its own row.
 * That made the ATTEMPT visible and left its COST invisible: the row went in
 * with NULL token columns, because the throw path discarded whatever the
 * upstream had reported.
 *
 * For most failures there is nothing to discard - a timeout, a refused
 * connection and a 5xx carry no usage, and NULL is then the honest answer.
 * One failure mode is different, and it is the expensive one: a response that
 * arrives complete, with a usage object, and no content. That is what a
 * thinking model does when the output budget is spent on the reasoning chain -
 * the case that opened this whole line of work. The provider charges for those
 * tokens. Atlas had them in hand and threw them away.
 *
 * So the error carries them. Not as a loose property on `Error`, which nothing
 * type-checks and one typo silently disables, but as a class with a guard: a
 * caller either matches it or does not, and "does not" means NULL, which is
 * what it already meant.
 */

/**
 * What an upstream reported about a call that then failed. Every field is
 * optional for the same reason the reqlog columns are nullable: absent and zero
 * are different facts, and only one of them is free.
 */
export interface UpstreamUsageSnapshot {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Subset of `promptTokens`. */
  cachedInputTokens?: number;
  /** Subset of `completionTokens`, billed at the output rate. */
  reasoningTokens?: number;
}

/**
 * An upstream call that failed after the provider had already reported usage.
 *
 * Thrown instead of a bare `Error` only where a snapshot actually exists;
 * everywhere else the existing throw is still correct and still means "nothing
 * was reported".
 */
export class UpstreamCallFailure extends Error {
  readonly usage: UpstreamUsageSnapshot;
  /**
   * The upstream stopped for LENGTH before producing any answer - the
   * caller's `maxTokens` was spent (on a thinking model, usually all of it on
   * the reasoning chain). The caller's budget, not the provider's health, so
   * the runtime answers it as `OUTPUT_BUDGET_EXHAUSTED`, outside the breaker.
   */
  readonly outputBudgetExhausted: boolean;

  constructor(
    message: string,
    usage: UpstreamUsageSnapshot,
    options: { outputBudgetExhausted?: boolean } = {},
  ) {
    super(message);
    this.name = "UpstreamCallFailure";
    this.usage = usage;
    this.outputBudgetExhausted = options.outputBudgetExhausted === true;
  }
}

/**
 * The usage an error carries, or `undefined`.
 *
 * `instanceof` rather than duck-typing on a `usage` property: a plain object
 * that happens to have one is not a report from an upstream, and treating it as
 * one would put invented numbers into the metering table - the failure this
 * repo's NULL-not-zero discipline exists to prevent, arriving by a different
 * door.
 */
export function usageFromError(error: unknown): UpstreamUsageSnapshot | undefined {
  if (!(error instanceof UpstreamCallFailure)) return undefined;
  // An empty snapshot is not a report either. Returning `{}` would write a row
  // that claims the upstream said something and said nothing.
  return Object.keys(error.usage).length > 0 ? error.usage : undefined;
}

/**
 * The token columns a failed attempt's row carries, when the upstream reported
 * any.
 *
 * A named function rather than five inline ternaries: the rule it encodes -
 * absent stays absent, and absent becomes NULL, never 0 - is the one this table
 * is built around, and five conditional spreads buried in a ninety-line writer
 * is not where a load-bearing rule should live. SonarCloud flagged the
 * complexity that produced; the flag was worth taking.
 */
export function usageColumns(
  usage: UpstreamUsageSnapshot | undefined,
): Record<string, number> {
  if (!usage) return {};
  const columns: Record<string, number> = {};
  if (usage.promptTokens !== undefined) columns["inputTokens"] = usage.promptTokens;
  if (usage.completionTokens !== undefined) {
    columns["outputTokens"] = usage.completionTokens;
  }
  if (usage.totalTokens !== undefined) columns["totalTokens"] = usage.totalTokens;
  if (usage.cachedInputTokens !== undefined) {
    columns["cachedInputTokens"] = usage.cachedInputTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    columns["reasoningTokens"] = usage.reasoningTokens;
  }
  return columns;
}
