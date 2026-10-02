import type { BadRequestException } from "@nestjs/common";

/**
 * vendor-balance.ts - a vendor's prepaid balance as a health subject
 * (ADR-013, design 120 section 4.3). Pure: which vendors have a balance Atlas
 * can read, how a reading turns into a state, and which thresholds apply.
 *
 * Owner, 2026-10-02: warn when EITHER the balance is below a minimum amount OR
 * it is projected to run out within a minimum number of days. The projection
 * is the balance's own decline over the trailing 7 days, top-ups left out - it
 * needs no price table and no reqlog join, and it counts every spend on the
 * key, including spend that did not go through Atlas.
 */

export const VENDOR_BALANCE_STATES = ["ok", "balance_low", "not_supported", "unknown"] as const;
export type VendorBalanceState = (typeof VENDOR_BALANCE_STATES)[number];

/** Built-in defaults; `.env` overrides them, a vendor's own row overrides both. */
export const BUILT_IN_MIN_AMOUNT: Readonly<Record<string, number>> = { CNY: 100, USD: 15 };
export const BUILT_IN_MIN_DAYS = 3;
export const BUILT_IN_POLL_MINUTES = 60;
export const MAX_MIN_DAYS = 30;
export const MIN_POLL_MINUTES = 15;
export const MAX_POLL_MINUTES = 1440;

/** Projected days need this much history; less is noise, not a trend. */
export const PROJECTION_MIN_SPAN_MS = 6 * 3_600_000;
export const PROJECTION_WINDOW_MS = 7 * 24 * 3_600_000;

export type BalanceReader =
  | { kind: "deepseek"; url: string }
  | { kind: "not_supported"; reason: string };

/**
 * Decided by the HOST the vendor's models call, not by provider_code - the
 * code is an operator's label, the host is what the key is valid for.
 */
export function balanceReaderFor(endpointUrl: string): BalanceReader {
  let host: string;
  try {
    host = new URL(endpointUrl).host.toLowerCase();
  } catch {
    return { kind: "not_supported", reason: `endpoint "${endpointUrl}" is not a URL` };
  }
  if (host === "api.deepseek.com") {
    return { kind: "deepseek", url: "https://api.deepseek.com/user/balance" };
  }
  if (host.endsWith(".volces.com")) {
    return {
      kind: "not_supported",
      reason:
        "Volcengine reports balance only through its billing API (QueryBalanceAcct), which needs an " +
        "account AK/SK; Atlas holds an Ark API key, which cannot read it",
    };
  }
  if (host === "open.bigmodel.cn") {
    return {
      kind: "not_supported",
      reason:
        "Zhipu publishes no balance API; arrears show on calls as code 1113, which Atlas records as account_refused",
    };
  }
  return { kind: "not_supported", reason: `no balance reader for host ${host}` };
}

export interface BalanceReading {
  currency: string;
  total: number;
  /** The vendor's own "can this key still spend" flag, where it gives one. */
  isAvailable: boolean | null;
}

/**
 * DeepSeek `GET /user/balance`:
 * `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00",...}]}`.
 * One entry per currency; the first is taken, and a second is reported as an
 * error rather than summed - two currencies cannot be added.
 */
export function parseDeepSeekBalance(body: unknown): BalanceReading {
  const o = body as { is_available?: unknown; balance_infos?: unknown } | null;
  const infos = Array.isArray(o?.balance_infos) ? (o.balance_infos as unknown[]) : undefined;
  if (!infos || infos.length === 0) throw new Error("balance response has no balance_infos");
  if (infos.length > 1) {
    throw new Error(`balance response has ${infos.length} currencies; Atlas reads one`);
  }
  const info = infos[0] as { currency?: unknown; total_balance?: unknown };
  const total = Number(info.total_balance);
  if (typeof info.currency !== "string" || info.currency === "" || info.total_balance === null || !Number.isFinite(total)) {
    throw new Error("balance response has no readable currency / total_balance");
  }
  return {
    currency: info.currency.toUpperCase(),
    total,
    isAvailable: typeof o?.is_available === "boolean" ? o.is_available : null,
  };
}

export interface BalanceSample {
  at: number;
  total: number;
}

/**
 * Days until the balance reaches zero at the trailing 7 days' spend rate.
 * Spend is the sum of DECREASES between consecutive samples, so a top-up
 * neither counts as negative spend nor hides the spend around it. Undefined
 * when there is too little history or no spend at all.
 */
export function projectedDays(samples: readonly BalanceSample[], now: number): number | undefined {
  const window = samples
    .filter((s) => s.at >= now - PROJECTION_WINDOW_MS && s.at <= now)
    .sort((a, b) => a.at - b.at);
  if (window.length < 2) return undefined;
  const span = window.at(-1)!.at - window[0]!.at;
  if (span < PROJECTION_MIN_SPAN_MS) return undefined;
  let spent = 0;
  for (let i = 1; i < window.length; i += 1) {
    const drop = window[i - 1]!.total - window[i]!.total;
    if (drop > 0) spent += drop;
  }
  if (spent <= 0) return undefined;
  const perDay = spent / (span / 86_400_000);
  return Math.max(0, window.at(-1)!.total) / perDay;
}

export interface BalanceThresholds {
  /** In the reading's currency; 0 or null = no amount warning. */
  minAmount: number | null;
  /** 0 = no days warning. */
  minDays: number;
}

export interface BalanceVerdict {
  state: "ok" | "balance_low";
  severity: "info" | "warning" | "critical";
  detail: string;
}

function money(currency: string, n: number): string {
  return `${currency} ${n.toFixed(2)}`;
}

export function evaluateBalance(
  reading: BalanceReading,
  days: number | undefined,
  t: BalanceThresholds,
): BalanceVerdict {
  const reasons: string[] = [];
  if (reading.isAvailable === false) reasons.push("the vendor reports the key can no longer spend");
  if (t.minAmount !== null && t.minAmount > 0 && reading.total < t.minAmount) {
    reasons.push(`below ${money(reading.currency, t.minAmount)}`);
  }
  if (t.minDays > 0 && days !== undefined && days < t.minDays) {
    reasons.push(`under ${t.minDays} days left at the 7-day spend rate`);
  }
  const daysText =
    days === undefined
      ? "days left unknown (under 6h of history, or no spend)"
      : `about ${days.toFixed(1)} days left`;
  const head = `${money(reading.currency, reading.total)}, ${daysText}`;
  if (reasons.length === 0) return { state: "ok", severity: "info", detail: head };
  return {
    state: "balance_low",
    // Out of money is an outage in waiting; low is a warning.
    severity: reading.isAvailable === false || reading.total <= 0 ? "critical" : "warning",
    detail: `${head}: ${reasons.join("; ")}`,
  };
}

// ---------------------------------------------------------------- settings

export type BalanceSettingSource = "provider" | "global" | "default";

interface Sourced<T> {
  value: T;
  source: "global" | "default";
}

export interface GlobalBalanceSettings {
  /** Per currency. */
  minAmount: Record<string, Sourced<number>>;
  minDays: Sourced<number>;
  pollMinutes: Sourced<number>;
}

export interface BalanceSettingRow {
  subjectKind: string;
  subjectKey: string;
  balanceMinAmount: { toString(): string } | number | null;
  balanceMinDays: number | null;
  balancePollMinutes: number | null;
}

export interface EffectiveBalanceSettings {
  /** Null when the vendor's currency is not known yet and no level names an amount for it. */
  minAmount: number | null;
  minAmountSource: BalanceSettingSource;
  minDays: number;
  minDaysSource: BalanceSettingSource;
  pollMinutes: number;
  pollMinutesSource: BalanceSettingSource;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  check: (n: number) => boolean,
  rule: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!check(n)) throw new Error(`${name} must be ${rule}, got "${raw}"`);
  return n;
}

/** The `.env` level. An unreadable value fails start-up rather than being ignored. */
export function readGlobalBalanceSettings(env: NodeJS.ProcessEnv = process.env): GlobalBalanceSettings {
  const isAmount = (n: number): boolean => Number.isFinite(n) && n >= 0;
  const minAmount: GlobalBalanceSettings["minAmount"] = {};
  for (const [currency, builtIn] of Object.entries(BUILT_IN_MIN_AMOUNT)) {
    const v = envNumber(
      env,
      `HEALTH_BALANCE_MIN_AMOUNT_${currency}`,
      isAmount,
      "a number >= 0 (0 = no amount warning)",
    );
    minAmount[currency] = v === undefined ? { value: builtIn, source: "default" } : { value: v, source: "global" };
  }
  const days = envNumber(
    env,
    "HEALTH_BALANCE_MIN_DAYS",
    (n) => Number.isInteger(n) && n >= 0 && n <= MAX_MIN_DAYS,
    `an integer from 0 to ${MAX_MIN_DAYS} (0 = no days warning)`,
  );
  const poll = envNumber(
    env,
    "HEALTH_BALANCE_POLL_MINUTES",
    (n) => Number.isInteger(n) && n >= MIN_POLL_MINUTES && n <= MAX_POLL_MINUTES,
    `an integer from ${MIN_POLL_MINUTES} to ${MAX_POLL_MINUTES}`,
  );
  return {
    minAmount,
    minDays: days === undefined ? { value: BUILT_IN_MIN_DAYS, source: "default" } : { value: days, source: "global" },
    pollMinutes:
      poll === undefined ? { value: BUILT_IN_POLL_MINUTES, source: "default" } : { value: poll, source: "global" },
  };
}

/**
 * The vendor's own row, then `.env`, then built-in. No model level: a balance
 * belongs to the account, not to a model. The amount is in the vendor's
 * currency, so the global level is looked up by the currency last read.
 */
export function effectiveBalanceSettings(
  providerCode: string,
  currency: string | undefined,
  rows: readonly BalanceSettingRow[],
  global: GlobalBalanceSettings,
): EffectiveBalanceSettings {
  const row = rows.find((r) => r.subjectKind === "provider" && r.subjectKey === providerCode);
  const globalAmount = currency !== undefined ? global.minAmount[currency] : undefined;
  const amount: { value: number | null; source: BalanceSettingSource } =
    row?.balanceMinAmount != null
      ? { value: Number(row.balanceMinAmount.toString()), source: "provider" }
      : (globalAmount ?? { value: null, source: "default" });
  const days: { value: number; source: BalanceSettingSource } =
    row?.balanceMinDays != null ? { value: row.balanceMinDays, source: "provider" } : global.minDays;
  const poll: { value: number; source: BalanceSettingSource } =
    row?.balancePollMinutes != null ? { value: row.balancePollMinutes, source: "provider" } : global.pollMinutes;
  return {
    minAmount: amount.value,
    minAmountSource: amount.source,
    minDays: days.value,
    minDaysSource: days.source,
    pollMinutes: poll.value,
    pollMinutesSource: poll.source,
  };
}

export interface BalanceFieldsInput {
  balanceMinAmount?: number | null;
  balanceMinDays?: number | null;
  balancePollMinutes?: number | null;
}

/** Balance fields of a write body; the caller has already refused unknown fields. */
export function parseBalanceFields(
  input: Record<string, unknown>,
  refuse: (message: string) => BadRequestException,
): BalanceFieldsInput {
  const out: BalanceFieldsInput = {};
  if ("balanceMinAmount" in input) {
    const v = input["balanceMinAmount"];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v >= 1e12)) {
      throw refuse(
        "balanceMinAmount must be a number >= 0 in the vendor's currency (0 = no amount warning), or null to inherit",
      );
    }
    out.balanceMinAmount = v === null ? null : Math.round((v as number) * 100) / 100;
  }
  if ("balanceMinDays" in input) {
    const v = input["balanceMinDays"];
    if (v !== null && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_MIN_DAYS)) {
      throw refuse(`balanceMinDays must be an integer from 0 to ${MAX_MIN_DAYS} (0 = no days warning), or null to inherit`);
    }
    out.balanceMinDays = v as number | null;
  }
  if ("balancePollMinutes" in input) {
    const v = input["balancePollMinutes"];
    if (
      v !== null &&
      (!Number.isInteger(v) || (v as number) < MIN_POLL_MINUTES || (v as number) > MAX_POLL_MINUTES)
    ) {
      throw refuse(
        `balancePollMinutes must be an integer from ${MIN_POLL_MINUTES} to ${MAX_POLL_MINUTES}, or null to inherit`,
      );
    }
    out.balancePollMinutes = v as number | null;
  }
  return out;
}
