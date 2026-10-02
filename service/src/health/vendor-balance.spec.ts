import { describe, expect, it } from "vitest";

import {
  balanceReaderFor,
  effectiveBalanceSettings,
  evaluateBalance,
  parseDeepSeekBalance,
  projectedDays,
  readGlobalBalanceSettings,
} from "./vendor-balance";

const H = 3_600_000;
const D = 24 * H;
const NOW = 1_000 * D;

describe("balanceReaderFor - decided by the host the key is valid for", () => {
  it("reads DeepSeek, with or without /v1 on the endpoint", () => {
    expect(balanceReaderFor("https://api.deepseek.com/v1")).toEqual({
      kind: "deepseek",
      url: "https://api.deepseek.com/user/balance",
    });
    expect(balanceReaderFor("https://api.deepseek.com").kind).toBe("deepseek");
  });

  it("says why Volcengine and Zhipu cannot be read, rather than staying silent", () => {
    const volc = balanceReaderFor("https://ark.cn-beijing.volces.com/api/v3");
    expect(volc).toMatchObject({ kind: "not_supported" });
    expect(volc.kind === "not_supported" && volc.reason).toContain("AK/SK");
    const zhipu = balanceReaderFor("https://open.bigmodel.cn/api/paas/v4");
    expect(zhipu.kind === "not_supported" && zhipu.reason).toContain("1113");
  });
});

describe("parseDeepSeekBalance", () => {
  it("reads the documented shape", () => {
    expect(
      parseDeepSeekBalance({
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        ],
      }),
    ).toEqual({ currency: "CNY", total: 110, isAvailable: true });
  });

  it("refuses what it cannot read instead of reporting zero", () => {
    expect(() => parseDeepSeekBalance({ balance_infos: [] })).toThrow(/no balance_infos/u);
    expect(() => parseDeepSeekBalance({ balance_infos: [{ currency: "CNY" }] })).toThrow(/total_balance/u);
    expect(() =>
      parseDeepSeekBalance({
        balance_infos: [
          { currency: "CNY", total_balance: "1" },
          { currency: "USD", total_balance: "1" },
        ],
      }),
    ).toThrow(/2 currencies/u);
  });
});

describe("projectedDays - the trailing 7 days' decline", () => {
  it("is balance divided by the daily spend", () => {
    // 10 a day for a day; 90 left: 9 days.
    expect(projectedDays([{ at: NOW - D, total: 100 }, { at: NOW, total: 90 }], NOW)).toBeCloseTo(9);
  });

  it("leaves a top-up out of the spend, and does not let it hide the spend around it", () => {
    const samples = [
      { at: NOW - 2 * D, total: 100 },
      { at: NOW - D, total: 80 }, // spent 20
      { at: NOW - D + H, total: 180 }, // topped up 100
      { at: NOW, total: 160 }, // spent 20
    ];
    // 40 over 2 days = 20 a day; 160 left: 8 days.
    expect(projectedDays(samples, NOW)).toBeCloseTo(8);
  });

  it("needs 6 hours of history and some spend", () => {
    expect(projectedDays([{ at: NOW - H, total: 100 }, { at: NOW, total: 50 }], NOW)).toBeUndefined();
    expect(projectedDays([{ at: NOW - D, total: 100 }, { at: NOW, total: 100 }], NOW)).toBeUndefined();
    expect(projectedDays([{ at: NOW, total: 100 }], NOW)).toBeUndefined();
  });

  it("ignores samples older than 7 days", () => {
    const samples = [
      { at: NOW - 30 * D, total: 10_000 },
      { at: NOW - D, total: 100 },
      { at: NOW, total: 90 },
    ];
    expect(projectedDays(samples, NOW)).toBeCloseTo(9);
  });
});

describe("evaluateBalance - either threshold warns (owner, 2026-10-02)", () => {
  const reading = { currency: "CNY", total: 110, isAvailable: true };

  it("ok above both", () => {
    expect(evaluateBalance(reading, 20, { minAmount: 100, minDays: 3 })).toMatchObject({ state: "ok" });
  });

  it("low on amount alone", () => {
    const v = evaluateBalance({ ...reading, total: 80 }, 20, { minAmount: 100, minDays: 3 });
    expect(v).toMatchObject({ state: "balance_low", severity: "warning" });
    expect(v.detail).toContain("below CNY 100.00");
  });

  it("low on days alone - a large balance spent fast", () => {
    const v = evaluateBalance({ ...reading, total: 5_000 }, 2, { minAmount: 100, minDays: 3 });
    expect(v).toMatchObject({ state: "balance_low", severity: "warning" });
    expect(v.detail).toContain("under 3 days");
  });

  it("0 switches a threshold off", () => {
    expect(evaluateBalance({ ...reading, total: 1 }, 0.5, { minAmount: 0, minDays: 0 }).state).toBe("ok");
  });

  it("critical when the vendor says the key can no longer spend, or nothing is left", () => {
    expect(evaluateBalance({ ...reading, isAvailable: false }, undefined, { minAmount: 0, minDays: 0 })).toMatchObject({
      state: "balance_low",
      severity: "critical",
    });
    expect(evaluateBalance({ ...reading, total: 0 }, undefined, { minAmount: 100, minDays: 3 }).severity).toBe(
      "critical",
    );
  });

  it("an unknown projection never warns on days, and says so", () => {
    const v = evaluateBalance(reading, undefined, { minAmount: 100, minDays: 3 });
    expect(v.state).toBe("ok");
    expect(v.detail).toContain("days left unknown");
  });
});

describe("balance settings - vendor, then .env, then built-in", () => {
  it("built-in: CNY 100 / USD 15, 3 days, every 60 minutes", () => {
    const g = readGlobalBalanceSettings({});
    expect(effectiveBalanceSettings("deepseek", "CNY", [], g)).toEqual({
      minAmount: 100,
      minAmountSource: "default",
      minDays: 3,
      minDaysSource: "default",
      pollMinutes: 60,
      pollMinutesSource: "default",
    });
    expect(effectiveBalanceSettings("x", "USD", [], g).minAmount).toBe(15);
  });

  it("a currency with no default has no amount threshold until one is set - reported as null, not guessed", () => {
    expect(effectiveBalanceSettings("x", "EUR", [], readGlobalBalanceSettings({})).minAmount).toBeNull();
  });

  it(".env overrides built-in; the vendor's row overrides both", () => {
    const g = readGlobalBalanceSettings({ HEALTH_BALANCE_MIN_AMOUNT_CNY: "200", HEALTH_BALANCE_MIN_DAYS: "5" });
    const rows = [
      {
        subjectKind: "provider",
        subjectKey: "deepseek",
        balanceMinAmount: { toString: () => "50.00" },
        balanceMinDays: null,
        balancePollMinutes: 30,
      },
    ];
    expect(effectiveBalanceSettings("deepseek", "CNY", rows, g)).toEqual({
      minAmount: 50,
      minAmountSource: "provider",
      minDays: 5,
      minDaysSource: "global",
      pollMinutes: 30,
      pollMinutesSource: "provider",
    });
  });

  it("refuses an unreadable .env value instead of quietly using the default", () => {
    expect(() => readGlobalBalanceSettings({ HEALTH_BALANCE_MIN_DAYS: "31" })).toThrow(/HEALTH_BALANCE_MIN_DAYS/u);
    expect(() => readGlobalBalanceSettings({ HEALTH_BALANCE_POLL_MINUTES: "5" })).toThrow(/POLL/u);
    expect(() => readGlobalBalanceSettings({ HEALTH_BALANCE_MIN_AMOUNT_CNY: "-1" })).toThrow(/CNY/u);
  });
});
