/**
 * cost-unit.ts - what `billed_amount` counts, per metric.
 *
 * product_251 X-3 keeps the unit difference as DATA rather than flattening it,
 * because flattening would invent a unit: a 100-page parse is not one call's
 * worth of consumption and a 500-candidate rerank is not either.
 *
 * Derived from the metric rather than passed in at each call site. The two
 * cannot disagree that way, and the alternative had already gone wrong once in
 * the published tool descriptors, which claimed `per_call` for three
 * capabilities that bill per unit.
 */
export type CostUnit = "token" | "candidate" | "page";

/**
 * Exhaustive over the C3 metrics Atlas consumes. A new capability must add its
 * metric here or `costUnitForMetric` returns undefined and the row records no
 * unit - which is the honest outcome, and visible, rather than a wrong one.
 */
const COST_UNIT_BY_METRIC: Readonly<Record<string, CostUnit>> = {
  "atlas.chat": "token",
  "atlas.embed": "token",
  "atlas.rerank": "candidate",
  "atlas.parse": "page",
};

export function costUnitForMetric(metric: string): CostUnit | undefined {
  return COST_UNIT_BY_METRIC[metric];
}
