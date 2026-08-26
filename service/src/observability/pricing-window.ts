/**
 * pricing-window.ts - TD-047 item 2. Which requests were served off-peak.
 *
 * DeepSeek's own wording, from https://api-docs.deepseek.com/quick_start/pricing :
 *
 *   "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00
 *    and 06:00 - 10:00 UTC, Monday through Friday (all other hours are
 *    off-peak)."
 *
 * Two things about that sentence shape the design.
 *
 * First, the provider defines PEAK and derives off-peak as the complement, so
 * this file does the same. Listing off-peak windows instead would be a second
 * expression of one fact, and the two would drift the first time a window moved.
 *
 * Second, it is stated in UTC. The tech-debt register stated the same window in
 * Beijing time, which is equivalent - but storing the Beijing form would mean a
 * timezone conversion on every evaluation, and a conversion is a place to be
 * wrong that the UTC form simply does not have. So the policy is UTC, and a
 * policy declaring any other timezone is REFUSED rather than quietly evaluated
 * as UTC: an eight-hour error in which requests were discounted produces a
 * completely plausible number.
 *
 * The window is not in SQL on purpose. SQL emits an hour-of-week histogram -
 * at most 168 buckets - and the rule is applied here, where it can be asserted
 * and where changing a provider's window does not mean editing a query string.
 *
 * Scale of the thing: 7 peak hours a day across 5 days is 35 of 168, so on
 * DeepSeek roughly 79% of the week is off-peak. This is not a rounding
 * correction.
 */

/** Which price components a discount touches. Explicit, never assumed. */
export const PRICE_COMPONENTS = ["input", "cachedInput", "output", "request"] as const;
export type PriceComponent = (typeof PRICE_COMPONENTS)[number];

export interface PeakWindow {
  /** ISO weekday numbers, 1 = Monday .. 7 = Sunday. */
  days: readonly number[];
  /** Half-open [fromHour, toHour) in UTC hours, 0-24. */
  fromHour: number;
  toHour: number;
}

export interface OffPeakPolicy {
  timezone: "UTC";
  /** Decimal string, e.g. "0.50000000". Never a float. */
  multiplier: string;
  appliesTo: readonly PriceComponent[];
  peakWindows: readonly PeakWindow[];
}

function fail(reason: string): never {
  throw new Error(`provider config.pricing.offPeak is unusable: ${reason}`);
}

/**
 * Parse `config.pricing.offPeak` off a provider row.
 *
 * Returns `null` when the provider simply has not declared one - that is a
 * normal state and the caller reports it as uncovered. Everything else throws:
 * a malformed policy silently ignored would price an entire provider's traffic
 * at full rate while the operator believes a discount is configured, which is
 * the "configured but inert" shape this repo bans.
 */
export function parseOffPeakPolicy(raw: unknown): OffPeakPolicy | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("not an object");

  const source = raw as Record<string, unknown>;
  const offPeak = source["offPeak"];
  if (offPeak === null || offPeak === undefined) return null;
  if (typeof offPeak !== "object" || Array.isArray(offPeak)) fail("offPeak is not an object");

  const policy = offPeak as Record<string, unknown>;

  if (policy["timezone"] !== "UTC") {
    fail(
      `timezone must be "UTC" (got ${JSON.stringify(policy["timezone"])}). ` +
        "The histogram this is applied to is bucketed in UTC, so any other " +
        "value would be evaluated against the wrong hours and produce a " +
        "plausible, wrong discount.",
    );
  }

  const multiplier = policy["multiplier"];
  if (typeof multiplier !== "string" || !/^\d+(?:\.\d{1,8})?$/u.test(multiplier)) {
    fail(`multiplier must be a decimal string with at most 8 places, got ${JSON.stringify(multiplier)}`);
  }

  const appliesTo = policy["appliesTo"];
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) {
    fail("appliesTo must list at least one price component");
  }
  for (const component of appliesTo) {
    if (!PRICE_COMPONENTS.includes(component as PriceComponent)) {
      fail(`unknown price component ${JSON.stringify(component)}`);
    }
  }

  const windows = policy["peakWindows"];
  if (!Array.isArray(windows) || windows.length === 0) {
    // An empty list would mean "every hour is off-peak", which is a claim no
    // provider makes and which would halve an entire bill by omission.
    fail("peakWindows must list at least one window");
  }

  const peakWindows: PeakWindow[] = windows.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) fail(`peakWindows[${index}] is not an object`);
    const w = entry as Record<string, unknown>;
    const days = w["days"];
    const fromHour = w["fromHour"];
    const toHour = w["toHour"];
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.some((d) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)
    ) {
      fail(`peakWindows[${index}].days must be ISO weekdays 1-7`);
    }
    if (
      !Number.isInteger(fromHour) ||
      !Number.isInteger(toHour) ||
      (fromHour as number) < 0 ||
      (toHour as number) > 24 ||
      (fromHour as number) >= (toHour as number)
    ) {
      fail(`peakWindows[${index}] hours must satisfy 0 <= fromHour < toHour <= 24`);
    }
    return {
      days: days as number[],
      fromHour: fromHour as number,
      toHour: toHour as number,
    };
  });

  return {
    timezone: "UTC",
    multiplier,
    appliesTo: appliesTo as PriceComponent[],
    peakWindows,
  };
}

/**
 * Is this UTC hour-of-week inside a peak window?
 *
 * `hour` is the hour the request started, so a request at 03:59 is in the
 * 01:00-04:00 window and one at 04:00 is not - half-open, matching how the
 * provider writes the range.
 */
export function isPeak(policy: OffPeakPolicy, isoDow: number, hour: number): boolean {
  return policy.peakWindows.some(
    (w) => w.days.includes(isoDow) && hour >= w.fromHour && hour < w.toHour,
  );
}

/**
 * The policy DeepSeek publishes, as configuration would express it. Exported so
 * the operator setting `config.pricing` has something exact to copy rather than
 * re-deriving it from prose, and so a test can assert it against the quoted
 * sentence at the top of this file.
 *
 * READ, MERGE, THEN WRITE. `PATCH /capability/providers/:id` sets `config`
 * WHOLESALE - the repository hands the object straight to Prisma, which
 * replaces the JSON column rather than merging into it. Sending
 * `{ config: { pricing: DEEPSEEK_OFF_PEAK } }` on its own therefore deletes
 * everything else that provider's config holds, and on DeepSeek that is
 * `config.wire`: the chat path, the auth style, `streamUsage`, and the
 * `extraBody` that turns thinking off. The next call would go out with none of
 * it. Fetch the provider, merge `pricing` into the config it already has, and
 * PATCH the whole object back.
 *
 * This note exists because exporting a constant "to copy" is exactly what
 * invites the unsafe version of that copy.
 */
export const DEEPSEEK_OFF_PEAK: OffPeakPolicy = {
  timezone: "UTC",
  multiplier: "0.50000000",
  appliesTo: ["input", "cachedInput", "output", "request"],
  peakWindows: [
    { days: [1, 2, 3, 4, 5], fromHour: 1, toHour: 4 },
    { days: [1, 2, 3, 4, 5], fromHour: 6, toHour: 10 },
  ],
};
