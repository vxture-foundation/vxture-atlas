import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_OFF_PEAK,
  isPeak,
  parseOffPeakPolicy,
  type OffPeakPolicy,
} from "./pricing-window";

const VALID = {
  offPeak: {
    timezone: "UTC",
    multiplier: "0.50000000",
    appliesTo: ["input", "cachedInput", "output", "request"],
    peakWindows: [{ days: [1, 2, 3, 4, 5], fromHour: 1, toHour: 4 }],
  },
};

function withOffPeak(over: Record<string, unknown>) {
  return { offPeak: { ...VALID.offPeak, ...over } };
}

describe("parseOffPeakPolicy", () => {
  it("returns null when a provider simply has not declared one", () => {
    // Normal state, not an error: the caller reports it as uncovered.
    expect(parseOffPeakPolicy(null)).toBeNull();
    expect(parseOffPeakPolicy(undefined)).toBeNull();
    expect(parseOffPeakPolicy({})).toBeNull();
  });

  it("refuses a timezone other than UTC instead of evaluating it as UTC", () => {
    // The histogram is bucketed in UTC. Silently treating Asia/Shanghai as UTC
    // would discount the wrong eight hours and produce a plausible number.
    expect(() => parseOffPeakPolicy(withOffPeak({ timezone: "Asia/Shanghai" }))).toThrow(
      /timezone must be "UTC"/u,
    );
  });

  it("refuses a float multiplier - money never travels as one", () => {
    expect(() => parseOffPeakPolicy(withOffPeak({ multiplier: 0.5 }))).toThrow(
      /multiplier must be a decimal string/u,
    );
  });

  it("refuses an empty peakWindows list, which would halve a whole bill by omission", () => {
    // Empty means "no hour is peak", i.e. everything is discounted. No provider
    // says that, and nothing else would notice.
    expect(() => parseOffPeakPolicy(withOffPeak({ peakWindows: [] }))).toThrow(
      /at least one window/u,
    );
  });

  it("refuses an empty appliesTo rather than guessing that it means all", () => {
    expect(() => parseOffPeakPolicy(withOffPeak({ appliesTo: [] }))).toThrow(
      /at least one price component/u,
    );
  });

  it("refuses an unknown price component", () => {
    expect(() => parseOffPeakPolicy(withOffPeak({ appliesTo: ["input", "storage"] }))).toThrow(
      /unknown price component/u,
    );
  });

  it("refuses an inverted or out-of-range window", () => {
    expect(() =>
      parseOffPeakPolicy(withOffPeak({ peakWindows: [{ days: [1], fromHour: 10, toHour: 6 }] })),
    ).toThrow(/fromHour < toHour/u);
    expect(() =>
      parseOffPeakPolicy(withOffPeak({ peakWindows: [{ days: [1], fromHour: 0, toHour: 25 }] })),
    ).toThrow(/fromHour < toHour <= 24/u);
    expect(() =>
      parseOffPeakPolicy(withOffPeak({ peakWindows: [{ days: [0], fromHour: 1, toHour: 4 }] })),
    ).toThrow(/ISO weekdays 1-7/u);
  });

  it("accepts a well-formed policy", () => {
    const policy = parseOffPeakPolicy(VALID) as OffPeakPolicy;
    expect(policy.multiplier).toBe("0.50000000");
    expect(policy.peakWindows).toHaveLength(1);
  });
});

describe("isPeak, against DeepSeek's published window", () => {
  // "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
  //  (all other hours are off-peak)."
  const p = DEEPSEEK_OFF_PEAK;

  it("treats the range as half-open, the way the provider writes it", () => {
    expect(isPeak(p, 1, 0)).toBe(false); // 00:xx - before the window opens
    expect(isPeak(p, 1, 1)).toBe(true); // 01:00 - first peak hour
    expect(isPeak(p, 1, 3)).toBe(true); // 03:59 is still peak
    expect(isPeak(p, 1, 4)).toBe(false); // 04:00 - the window has closed
  });

  it("leaves the midday gap off-peak", () => {
    // 04:00-06:00 UTC is Beijing 12:00-14:00, the lunch break in the Beijing
    // phrasing of the same window.
    expect(isPeak(p, 3, 4)).toBe(false);
    expect(isPeak(p, 3, 5)).toBe(false);
    expect(isPeak(p, 3, 6)).toBe(true);
    expect(isPeak(p, 3, 9)).toBe(true);
    expect(isPeak(p, 3, 10)).toBe(false);
  });

  it("makes the whole weekend off-peak", () => {
    for (const hour of [1, 3, 6, 9]) {
      expect(isPeak(p, 6, hour)).toBe(false);
      expect(isPeak(p, 7, hour)).toBe(false);
    }
  });

  it("comes to 35 peak hours out of 168 - about 79% of the week discounted", () => {
    // The number that makes this worth building. If a future edit narrows the
    // windows by accident, this is what notices.
    let peak = 0;
    for (let dow = 1; dow <= 7; dow++) {
      for (let hour = 0; hour < 24; hour++) if (isPeak(p, dow, hour)) peak++;
    }
    expect(peak).toBe(35);
  });

  it("agrees with the Beijing-time phrasing the tech-debt register used", () => {
    // Beijing is UTC+8 and observes no DST, so Beijing 09:00-12:00 and
    // 14:00-18:00 Mon-Fri is the same set of instants. Both statements are
    // correct; UTC is stored because it is the provider's own form.
    const beijingPeak = (dow: number, beijingHour: number) =>
      isPeak(p, dow, (beijingHour - 8 + 24) % 24);
    expect(beijingPeak(1, 9)).toBe(true);
    expect(beijingPeak(1, 11)).toBe(true);
    expect(beijingPeak(1, 12)).toBe(false);
    expect(beijingPeak(1, 14)).toBe(true);
    expect(beijingPeak(1, 17)).toBe(true);
    expect(beijingPeak(1, 18)).toBe(false);
  });
});
