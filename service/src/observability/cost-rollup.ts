/**
 * cost-rollup.ts - TD-047, the arithmetic half.
 *
 * Atlas meters; it does not bill. What this produces is a derived estimate for
 * the internal cost pool, and it is a different number from the tenant-facing
 * token quota in both direction and purpose. Anywhere it surfaces it must say
 * so, which is why `basis` travels with the result instead of living in a
 * document nobody opens next to the number.
 *
 * This file is pure on purpose. The temporal join - "the price rule in force
 * when this request was written" - is the one part SQL does better than
 * anything else, and it stays in the repository. The multiplication does not:
 * money maths inside a `$queryRawUnsafe` string is money maths no test in this
 * repo can reach, because vitest mocks Prisma. A fully green suite would have
 * said nothing about any of the three ways this is quietly wrong:
 *
 *   1. `reasoningTokens` is a SUBSET of `outputTokens`, already priced at the
 *      output rate. Adding it is double-charging every thinking model, and the
 *      result still looks entirely plausible - just larger.
 *   2. `cachedInputTokens` is a SUBSET of `inputTokens`. The uncached half is
 *      the difference, and pricing the full input at the uncached rate
 *      overstates DeepSeek traffic by up to 30x on the cached portion.
 *   3. An undeclared `cachedInputUnitPrice` is NULL, not zero. Falling back to
 *      `inputUnitPrice` overstates; treating it as free understates and states
 *      something specific and false about the provider.
 *
 * Arithmetic is exact integer arithmetic on scaled BigInt, never float. Prices
 * are `numeric(18,8)`, so everything is scaled to 8 decimal places and stays
 * there until the last step renders a string. A cost that arrives as a JS
 * number has already lost the argument.
 */

/** Decimal places in `numeric(18,8)`, and therefore in every scaled integer. */
const SCALE = 8n;
const SCALE_FACTOR = 10n ** SCALE;

/** One (model, provider, price rule) group as the repository returns it. */
export interface CostGroupRow {
  modelCode: string | null;
  providerCode: string | null;
  /** `null` when no rule was in force for these requests. */
  priceRuleId: string | null;
  currency: string | null;
  unitTokens: number | null;
  inputUnitPrice: string | null;
  outputUnitPrice: string | null;
  requestUnitPrice: string | null;
  /** `null` means "no cached rate declared", never "cached input is free". */
  cachedInputUnitPrice: string | null;
  requests: bigint;
  requestsMissingInput: bigint;
  requestsMissingOutput: bigint;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
}

export interface CostRollupItem {
  modelCode: string | null;
  providerCode: string | null;
  priceRuleId: string | null;
  currency: string | null;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** `inputTokens - cachedInputTokens`, the half charged at the full rate. */
  uncachedInputTokens: number;
  outputTokens: number;
  /** Reported, never added. See the header. */
  reasoningTokens: number;
  /** Decimal string, or `null` when no price rule was in force. */
  estimatedCost: string | null;
  /** True when the cached half fell back to `inputUnitPrice`. */
  cachedPriceFellBack: boolean;
}

export interface CostRollupResult {
  items: CostRollupItem[];
  /** Never one total: summing across currencies would invent a number. */
  totalsByCurrency: Array<{ currency: string; estimatedCost: string }>;
  coverage: {
    requests: number;
    requestsWithoutPriceRule: number;
    requestsMissingInputTokens: number;
    requestsMissingOutputTokens: number;
  };
}

/** `"3.00000000"` -> `300000000n`. Throws rather than guessing. */
function toScaled(price: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/u.exec(price.trim());
  if (!match) throw new Error(`unit price is not a decimal: ${price}`);
  const [, sign, whole, frac = ""] = match;
  if (frac.length > Number(SCALE)) {
    throw new Error(`unit price carries more than ${SCALE} decimals: ${price}`);
  }
  const digits = `${whole}${frac.padEnd(Number(SCALE), "0")}`;
  return BigInt(`${sign}${digits}`);
}

/** Scaled integer -> the decimal string that goes on the wire. */
function render(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * `tokens * price / unitTokens`, in scaled integers.
 *
 * The division truncates, once per group rather than once per request, which is
 * the difference between an estimate and a rounding argument nobody can settle.
 * Truncation can only understate, and by less than one hundred-millionth of a
 * currency unit per group.
 */
function priceTokens(tokens: bigint, scaledPrice: bigint, unitTokens: bigint): bigint {
  if (unitTokens <= 0n) {
    throw new Error(`unit_tokens must be positive, got ${unitTokens}`);
  }
  return (tokens * scaledPrice) / unitTokens;
}

export function computeCostRollup(rows: readonly CostGroupRow[]): CostRollupResult {
  const items: CostRollupItem[] = [];
  const byCurrency = new Map<string, bigint>();

  let requests = 0n;
  let withoutRule = 0n;
  let missingInput = 0n;
  let missingOutput = 0n;

  for (const row of rows) {
    requests += row.requests;
    missingInput += row.requestsMissingInput;
    missingOutput += row.requestsMissingOutput;

    // An upstream that reports more cached tokens than input tokens is
    // reporting nonsense; clamping keeps the uncached half from going negative
    // and quietly crediting the pool.
    const cached =
      row.cachedInputTokens > row.inputTokens ? row.inputTokens : row.cachedInputTokens;
    const uncached = row.inputTokens - cached;

    const base = {
      modelCode: row.modelCode,
      providerCode: row.providerCode,
      priceRuleId: row.priceRuleId,
      currency: row.currency,
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      cachedInputTokens: Number(cached),
      uncachedInputTokens: Number(uncached),
      outputTokens: Number(row.outputTokens),
      reasoningTokens: Number(row.reasoningTokens),
    };

    if (
      row.priceRuleId === null ||
      row.currency === null ||
      row.unitTokens === null ||
      row.inputUnitPrice === null ||
      row.outputUnitPrice === null ||
      row.requestUnitPrice === null
    ) {
      // Unpriced traffic is a fact to report, not an empty group to drop. A
      // zero here would read as "these requests cost nothing".
      withoutRule += row.requests;
      items.push({ ...base, estimatedCost: null, cachedPriceFellBack: false });
      continue;
    }

    const unitTokens = BigInt(row.unitTokens);
    const inputPrice = toScaled(row.inputUnitPrice);
    const cachedPriceFellBack = row.cachedInputUnitPrice === null;
    const cachedPrice = cachedPriceFellBack
      ? inputPrice
      : toScaled(row.cachedInputUnitPrice as string);

    const cost =
      row.requests * toScaled(row.requestUnitPrice) +
      priceTokens(uncached, inputPrice, unitTokens) +
      priceTokens(cached, cachedPrice, unitTokens) +
      // `outputTokens` already includes `reasoningTokens`, which are billed at
      // this same rate. Adding the reasoning term here would charge them twice.
      priceTokens(row.outputTokens, toScaled(row.outputUnitPrice), unitTokens);

    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + cost);
    items.push({ ...base, estimatedCost: render(cost), cachedPriceFellBack });
  }

  return {
    items,
    totalsByCurrency: [...byCurrency.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currency, scaled]) => ({ currency, estimatedCost: render(scaled) })),
    coverage: {
      requests: Number(requests),
      requestsWithoutPriceRule: Number(withoutRule),
      requestsMissingInputTokens: Number(missingInput),
      requestsMissingOutputTokens: Number(missingOutput),
    },
  };
}

/**
 * Travels with every response. The numbers are meaningless without it: a reader
 * who does not know reasoning tokens are excluded from the sum will reconcile
 * against the provider's invoice and conclude the meter is broken.
 */
export const COST_ROLLUP_BASIS = {
  meters:
    "Atlas meters, it does not bill. This is a derived estimate for the internal cost pool, " +
    "separate from the tenant-facing token quota.",
  priceSelected:
    "For each request, the price rule whose effective_at/expires_at window contains its created_at. " +
    "is_active is deliberately NOT part of the selection: it is a present-tense switch, and letting " +
    "it decide history would make last month's number change today.",
  reasoningTokens:
    "Reported, never added. They are a subset of outputTokens and are already charged at the output rate.",
  cachedInput:
    "Charged at cachedInputUnitPrice. When that is undeclared the uncached rate is used, which " +
    "overstates rather than understates - an undeclared rate is not a free one.",
  unpriced:
    "Requests with no rule in force are counted in coverage.requestsWithoutPriceRule and contribute " +
    "no cost, rather than contributing zero.",
} as const;
