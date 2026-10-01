import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyNulls,
  DIMENSION_STATUSES,
  DIMENSIONS,
  toColumn,
  type ClassifyContext,
} from "./dimension-status";
import { billingReasons, hostOf } from "./record-facts";

/**
 * The guard. Every nullable column of reqlog.request_records is a usage
 * dimension and must say why it is empty - so every one must be registered,
 * and the column name the status map uses must be the real one. A column added
 * later without a registration turns this red, which is the point: an
 * unregistered NULL is exactly the unexplained empty value batch 4 ended.
 */
describe("every nullable usage column is registered", () => {
  const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
  const block = /model RequestRecord \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
  const fields = block
    .split("\n")
    .map((line) => /^\s{2}(\w+)\s+(\w+)(\?)?(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && !m[1]!.startsWith("@@"))
    .map((m) => ({
      field: m[1]!,
      optional: m[3] === "?",
      column: /@map\("([^"]+)"\)/.exec(m[4] ?? "")?.[1] ?? m[1]!,
    }));

  // Identity and bookkeeping, not dimensions: always present on a row.
  const EXEMPT = new Set(["id", "requestId", "status", "usageType", "createdAt", "dimensionStatus"]);

  it("reads the model at all (a parse that finds nothing would pass everything)", () => {
    expect(fields.length).toBeGreaterThan(70);
    // Including the names a letters-only pattern would miss (the digit in `1h`).
    const names = new Set(fields.map((f) => f.field));
    for (const name of ["inputTokens", "cacheWrite1hInputTokens", "dimensionStatus"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("registers every nullable column", () => {
    const missing = fields
      .filter((f) => f.optional && !EXEMPT.has(f.field))
      .filter((f) => !(f.field in DIMENSIONS))
      .map((f) => f.field);
    expect(missing).toEqual([]);
  });

  it("registers nothing that is not a column", () => {
    const known = new Set(fields.map((f) => f.field));
    expect(Object.keys(DIMENSIONS).filter((k) => !known.has(k))).toEqual([]);
  });

  it("keys the status map by the real column name", () => {
    const wrong = fields
      .filter((f) => f.field in DIMENSIONS)
      .filter((f) => toColumn(f.field) !== f.column)
      .map((f) => `${f.field} -> ${toColumn(f.field)} (column is ${f.column})`);
    expect(wrong).toEqual([]);
  });
});

describe("classifyNulls - each word, and only when it is true", () => {
  const base: Omit<ClassifyContext, "row"> = {
    capability: "chat",
    reached: true,
    usageSource: "reported",
    streamed: false,
    notSupported: new Set(),
    explicit: {},
  };
  const statusOf = (row: Record<string, unknown>, ctx: Partial<Omit<ClassifyContext, "row">> = {}) =>
    classifyNulls(row, { ...base, ...ctx }) ?? {};

  it("not_integrated: Atlas has no mechanism", () => {
    expect(statusOf({})["generated_image_count"]).toBe("not_integrated");
    expect(statusOf({})["reasoning_budget_tokens"]).toBe("not_integrated");
    // S2S rows never had an attempt ordinal wired.
    expect(statusOf({}, { capability: "embed" })["attempt_index"]).toBe("not_integrated");
  });

  it("not_supported: only when the adapter DECLARED it, and the call reached it", () => {
    const declared = new Set(["cacheWriteInputTokens"]);
    expect(statusOf({}, { notSupported: declared })["cache_write_input_tokens"]).toBe("not_supported");
    // Undeclared absence is "this time it did not come", never "does not exist".
    expect(statusOf({})["cache_write_input_tokens"]).toBe("not_reported");
    // A call that never reached the vendor cannot tell us what the vendor offers.
    expect(
      statusOf({}, { notSupported: declared, reached: false, usageSource: undefined })[
        "cache_write_input_tokens"
      ],
    ).toBe("not_reached");
  });

  it("not_reported: the vendor should have, this time did not", () => {
    expect(statusOf({}, { usageSource: "absent" })["input_tokens"]).toBe("not_reported");
    expect(statusOf({})["service_tier"]).toBe("not_reported");
  });

  it("not_configured: the mechanism is there, operator config is not", () => {
    expect(statusOf({})["provider_key_alias"]).toBe("not_configured");
    expect(
      statusOf({}, { explicit: { upstreamCost: "not_configured" } })["upstream_cost"],
    ).toBe("not_configured");
  });

  it("capture_failed: Atlas should have taken it and did not", () => {
    expect(statusOf({})["message_count"]).toBe("capture_failed");
    expect(statusOf({})["started_at"]).toBe("capture_failed");
  });

  it("not_specified: the caller did not send it", () => {
    expect(statusOf({})["thinking_mode"]).toBe("not_specified");
    expect(statusOf({})["max_tokens"]).toBe("not_specified");
  });

  it("not_applicable: this kind of call has no such thing", () => {
    expect(statusOf({})["first_token_at"]).toBe("not_applicable"); // non-stream
    expect(statusOf({})["vector_count"]).toBe("not_applicable"); // chat
    expect(statusOf({}, { capability: "embed" })["thinking_mode"]).toBe("not_applicable");
    expect(statusOf({})["cancelled_by"]).toBe("not_applicable");
  });

  it("not_reached: the request never got to the other side", () => {
    const refused = statusOf({}, { reached: false, usageSource: undefined });
    expect(refused["input_tokens"]).toBe("not_reached");
    expect(refused["upstream_request_id"]).toBe("not_reached");
    expect(refused["queue_wait_ms"]).toBe("not_reached");
  });

  it("marks nothing that has a value, and returns undefined when nothing is null", () => {
    expect(statusOf({ inputTokens: 5 })["input_tokens"]).toBeUndefined();
    const everything = Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, 1]));
    expect(classifyNulls(everything, base)).toBeUndefined();
  });

  it("lets a reason the caller stated win over the rule", () => {
    expect(
      statusOf({}, { explicit: { tenantId: "capture_failed" } })["tenant_id"],
    ).toBe("capture_failed");
  });

  it("only ever produces words of the vocabulary", () => {
    const words = new Set<string>(DIMENSION_STATUSES);
    for (const ctx of [
      base,
      { ...base, capability: "embed" as const },
      { ...base, reached: false, usageSource: undefined },
      { ...base, streamed: true },
    ]) {
      for (const value of Object.values(classifyNulls({}, ctx) ?? {})) {
        expect(words.has(value)).toBe(true);
      }
    }
  });
});

describe("billingReasons - the platform is the other side", () => {
  const ctx = { reported: true, workspaceKnown: true };
  it("billed: only the event id is empty, because the platform never returns one", () => {
    expect(billingReasons({ billed: true }, ctx)).toEqual({ usageEventId: "not_supported" });
    expect(billingReasons({ billed: true, usageEventId: "e1" }, ctx)).toEqual({});
  });
  it.each([
    ["rejected", "not_reported"],
    ["failed", "not_reached"],
    ["not_configured", "not_configured"],
    ["no_amount", "not_applicable"],
  ] as const)("not billed because %s -> %s", (why, status) => {
    expect(billingReasons({ billed: false, notBilledBecause: why }, ctx)["billedAmount"]).toBe(status);
  });
  it("no workspace on the token: the caller did not specify one", () => {
    expect(
      billingReasons({ billed: false }, { reported: true, workspaceKnown: false })["billedAmount"],
    ).toBe("not_specified");
  });
  it("no usage from the vendor: nothing to bill, for the vendor's reason", () => {
    expect(
      billingReasons({ billed: false }, { reported: false, workspaceKnown: true })["billedAmount"],
    ).toBe("not_reported");
  });
});

describe("hostOf", () => {
  it("takes the host of a URL and nothing from anything else", () => {
    expect(hostOf("https://ark.cn-beijing.volces.com/api/v3")).toBe("ark.cn-beijing.volces.com");
    expect(hostOf("not a url")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});
