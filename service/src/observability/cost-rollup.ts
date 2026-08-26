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

import {
  isPeak,
  parseOffPeakPolicy,
  type OffPeakPolicy,
  type PriceComponent,
} from "./pricing-window";

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
  /** ISO weekday of the bucket in UTC, 1 = Monday .. 7 = Sunday. */
  isoDow: number | null;
  /** Hour of the bucket in UTC, 0-23. */
  hourUtc: number | null;
  /** `config.pricing` off the provider row, as JSON text. */
  providerPricing: string | null;
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
  /** Requests served inside the provider's declared peak windows. */
  peakRequests: number;
  /** Everything else - on DeepSeek, about 79% of the week. */
  offPeakRequests: number;
  /**
   * False when the provider has declared no off-peak policy. The number is then
   * priced entirely at peak rates, which OVERSTATES it - and says so here
   * rather than reading as an exact figure.
   */
  offPeakPolicyApplied: boolean;
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
    /**
     * Requests whose provider declares no off-peak policy. They are billed at
     * peak rates here; on a provider that actually discounts, that is an
     * overstatement waiting for a config row, not a correct total.
     */
    requestsWithoutPricingWindow: number;
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

/** `price * multiplier`, both scaled, truncating. */
function discounted(scaledPrice: bigint, multiplier: bigint): bigint {
  return (scaledPrice * multiplier) / SCALE_FACTOR;
}

/**
 * Rows arrive one per (model, provider, rule, UTC hour-of-week) bucket, because
 * the discount is a property of WHEN a request ran and a sum cannot be split
 * after the fact. They are re-aggregated here to the same item shape callers
 * already had, with the peak/off-peak split reported alongside.
 */
/**
 * A provider whose `config.pricing` cannot be read.
 *
 * Carries the provider code because the operator has to know WHICH row to fix,
 * and a message that says only "unusable" sends them to read every provider.
 */
export class InvalidPricingPolicyError extends Error {
  readonly providerCode: string | null;

  constructor(providerCode: string | null, reason: string) {
    super(reason);
    this.name = "InvalidPricingPolicyError";
    this.providerCode = providerCode;
  }
}

/**
 * Parse once per distinct config text, and fail with the provider named.
 *
 * The throw is deliberate - a malformed policy silently ignored prices a whole
 * provider at full rate while the operator believes a discount is live. But it
 * is OPERATOR DATA, not a defect, so the caller turns this into a coded 4xx
 * rather than letting it surface as a bare 500. A 500 caused by a config row is
 * the shape `PATCH /capability/price-rules/:id` had for weeks (TD-047), and it
 * tells the person who can fix it nothing at all.
 */
function readPolicy(
  providerCode: string | null,
  raw: string | null,
): OffPeakPolicy | null {
  if (raw === null) return null;
  try {
    return parseOffPeakPolicy(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new InvalidPricingPolicyError(
      providerCode,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function computeCostRollup(rows: readonly CostGroupRow[]): CostRollupResult {
  const byCurrency = new Map<string, bigint>();
  const items = new Map<string, CostRollupItem>();
  const costs = new Map<string, bigint>();
  // Parsed once per distinct config text: a malformed policy must throw once,
  // not once per hour bucket.
  const policies = new Map<string, OffPeakPolicy | null>();

  let requests = 0n;
  let withoutRule = 0n;
  let missingInput = 0n;
  let missingOutput = 0n;
  let withoutWindow = 0n;

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

    const key = JSON.stringify([
      row.modelCode,
      row.providerCode,
      row.priceRuleId,
      row.currency,
    ]);

    const cachedPriceFellBack =
      row.priceRuleId !== null && row.cachedInputUnitPrice === null;

    let item = items.get(key);
    if (!item) {
      item = {
        modelCode: row.modelCode,
        providerCode: row.providerCode,
        priceRuleId: row.priceRuleId,
        currency: row.currency,
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        estimatedCost: null,
        cachedPriceFellBack,
        peakRequests: 0,
        offPeakRequests: 0,
        offPeakPolicyApplied: false,
      };
      items.set(key, item);
    }

    item.requests += Number(row.requests);
    item.inputTokens += Number(row.inputTokens);
    item.cachedInputTokens += Number(cached);
    item.uncachedInputTokens += Number(uncached);
    item.outputTokens += Number(row.outputTokens);
    item.reasoningTokens += Number(row.reasoningTokens);

    const policyKey = row.providerPricing ?? "";
    if (!policies.has(policyKey)) {
      policies.set(policyKey, readPolicy(row.providerCode, row.providerPricing));
    }
    const policy = policies.get(policyKey) ?? null;

    // A bucket with no hour is a row we cannot place in the week; it is treated
    // as undiscounted AND counted as uncovered, never silently discounted.
    const placeable = row.isoDow !== null && row.hourUtc !== null;
    const peak =
      policy === null || !placeable
        ? true
        : isPeak(policy, row.isoDow as number, row.hourUtc as number);

    if (policy !== null && placeable) {
      item.offPeakPolicyApplied = true;
    } else {
      withoutWindow += row.requests;
    }
    if (peak) item.peakRequests += Number(row.requests);
    else item.offPeakRequests += Number(row.requests);

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
      continue;
    }

    const discount = !peak && policy !== null ? toScaled(policy.multiplier) : null;
    const rate = (component: PriceComponent, price: string): bigint => {
      const scaled = toScaled(price);
      return discount !== null && policy !== null && policy.appliesTo.includes(component)
        ? discounted(scaled, discount)
        : scaled;
    };

    const unitTokens = BigInt(row.unitTokens);
    const inputPrice = rate("input", row.inputUnitPrice);
    // The fallback happens BEFORE the discount: an undeclared cached rate means
    // "charge it as uncached", and an uncached rate is discounted off-peak like
    // any other. Discounting a fallback is not double-counting - it is the same
    // rate the provider would have charged.
    const cachedPrice = cachedPriceFellBack
      ? inputPrice
      : rate("cachedInput", row.cachedInputUnitPrice as string);

    const cost =
      row.requests * rate("request", row.requestUnitPrice) +
      priceTokens(uncached, inputPrice, unitTokens) +
      priceTokens(cached, cachedPrice, unitTokens) +
      // `outputTokens` already includes `reasoningTokens`, which are billed at
      // this same rate. Adding the reasoning term here would charge them twice.
      priceTokens(row.outputTokens, rate("output", row.outputUnitPrice), unitTokens);

    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + cost);
    costs.set(key, (costs.get(key) ?? 0n) + cost);
  }

  for (const [key, item] of items) {
    const cost = costs.get(key);
    if (cost !== undefined) item.estimatedCost = render(cost);
  }

  return {
    items: [...items.values()],
    totalsByCurrency: [...byCurrency.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currency, scaled]) => ({ currency, estimatedCost: render(scaled) })),
    coverage: {
      requests: Number(requests),
      requestsWithoutPriceRule: Number(withoutRule),
      requestsMissingInputTokens: Number(missingInput),
      requestsMissingOutputTokens: Number(missingOutput),
      requestsWithoutPricingWindow: Number(withoutWindow),
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
  offPeak:
    "Requests are bucketed by UTC hour-of-week and priced at the provider's off-peak multiplier when " +
    "they fall outside its declared peak windows - on DeepSeek that is roughly 79% of the week. A " +
    "provider with no declared policy is priced entirely at peak rates, which OVERSTATES it; those " +
    "requests are counted in coverage.requestsWithoutPricingWindow rather than presented as exact.",
} as const;
