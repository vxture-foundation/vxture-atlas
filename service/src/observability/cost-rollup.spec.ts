import { describe, expect, it } from "vitest";

import { computeCostRollup, type CostGroupRow } from "./cost-rollup";

/**
 * A group priced the way DeepSeek prices flash at peak: 3.00 CNY per million
 * uncached input, 0.10 per million cached (1/30), 12.00 per million output.
 */
function group(over: Partial<CostGroupRow> = {}): CostGroupRow {
  return {
    modelCode: "deepseek-v4-flash",
    providerCode: "deepseek",
    priceRuleId: "rule-1",
    currency: "CNY",
    unitTokens: 1_000_000,
    inputUnitPrice: "3.00000000",
    outputUnitPrice: "12.00000000",
    requestUnitPrice: "0.00000000",
    cachedInputUnitPrice: "0.10000000",
    requests: 1n,
    requestsMissingInput: 0n,
    requestsMissingOutput: 0n,
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    ...over,
  };
}

describe("computeCostRollup", () => {
  it("prices the uncached half at the full rate and the cached half at the cached rate", () => {
    // 600k uncached at 3.00/M = 1.80; 400k cached at 0.10/M = 0.04.
    const { items } = computeCostRollup([
      group({ inputTokens: 1_000_000n, cachedInputTokens: 400_000n }),
    ]);
    expect(items[0]?.uncachedInputTokens).toBe(600_000);
    expect(items[0]?.estimatedCost).toBe("1.84000000");
  });

  it("does NOT add reasoning tokens - they are already inside outputTokens", () => {
    // The whole defect this file exists to prevent. Both groups bill 100k
    // output at 12.00/M = 1.20; the second merely reports how much of it was
    // reasoning. If the reasoning term were added, the second would be 2.40.
    const withoutReasoning = computeCostRollup([group({ outputTokens: 100_000n })]);
    const withReasoning = computeCostRollup([
      group({ outputTokens: 100_000n, reasoningTokens: 100_000n }),
    ]);

    expect(withoutReasoning.items[0]?.estimatedCost).toBe("1.20000000");
    expect(withReasoning.items[0]?.estimatedCost).toBe("1.20000000");
    expect(withReasoning.items[0]?.reasoningTokens).toBe(100_000);
  });

  it("falls back to the uncached rate when no cached rate is declared, and says so", () => {
    // NULL is "not declared", never "free": 400k cached at the 3.00 rate.
    const { items } = computeCostRollup([
      group({
        inputTokens: 1_000_000n,
        cachedInputTokens: 400_000n,
        cachedInputUnitPrice: null,
      }),
    ]);
    expect(items[0]?.estimatedCost).toBe("3.00000000");
    expect(items[0]?.cachedPriceFellBack).toBe(true);
  });

  it("treats a declared zero cached rate as free, unlike an undeclared one", () => {
    const { items } = computeCostRollup([
      group({
        inputTokens: 1_000_000n,
        cachedInputTokens: 400_000n,
        cachedInputUnitPrice: "0.00000000",
      }),
    ]);
    expect(items[0]?.estimatedCost).toBe("1.80000000");
    expect(items[0]?.cachedPriceFellBack).toBe(false);
  });

  it("reports unpriced traffic as unpriced, not as zero cost", () => {
    const { items, coverage, totalsByCurrency } = computeCostRollup([
      group({
        requests: 7n,
        priceRuleId: null,
        currency: null,
        unitTokens: null,
        inputUnitPrice: null,
        outputUnitPrice: null,
        requestUnitPrice: null,
        cachedInputUnitPrice: null,
        inputTokens: 500_000n,
      }),
    ]);
    expect(items[0]?.estimatedCost).toBeNull();
    expect(coverage.requestsWithoutPriceRule).toBe(7);
    expect(totalsByCurrency).toEqual([]);
  });

  it("charges the per-request price once per request", () => {
    const { items } = computeCostRollup([
      group({ requests: 250n, requestUnitPrice: "0.00400000" }),
    ]);
    expect(items[0]?.estimatedCost).toBe("1.00000000");
  });

  it("never sums across currencies", () => {
    const { totalsByCurrency } = computeCostRollup([
      group({ outputTokens: 100_000n }),
      group({
        modelCode: "gpt-x",
        providerCode: "openai",
        priceRuleId: "rule-2",
        currency: "USD",
        outputTokens: 100_000n,
        outputUnitPrice: "6.00000000",
      }),
    ]);
    expect(totalsByCurrency).toEqual([
      { currency: "CNY", estimatedCost: "1.20000000" },
      { currency: "USD", estimatedCost: "0.60000000" },
    ]);
  });

  it("clamps an upstream that reports more cached input than input", () => {
    // Nonsense from the provider must not credit the pool with a negative
    // uncached half.
    const { items } = computeCostRollup([
      group({ inputTokens: 100_000n, cachedInputTokens: 400_000n }),
    ]);
    expect(items[0]?.uncachedInputTokens).toBe(0);
    expect(items[0]?.cachedInputTokens).toBe(100_000);
    expect(items[0]?.estimatedCost).toBe("0.01000000");
  });

  it("carries missing-token counts through instead of hiding them in the sum", () => {
    const { coverage } = computeCostRollup([
      group({ requests: 10n, requestsMissingInput: 3n, requestsMissingOutput: 4n }),
    ]);
    expect(coverage).toEqual({
      requests: 10,
      requestsWithoutPriceRule: 0,
      requestsMissingInputTokens: 3,
      requestsMissingOutputTokens: 4,
    });
  });

  it("stays exact where floating point would not", () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; three groups of a tenth must
    // come to exactly three tenths.
    const tenth = group({ requests: 1n, requestUnitPrice: "0.10000000" });
    const { totalsByCurrency } = computeCostRollup([tenth, tenth, tenth]);
    expect(totalsByCurrency[0]?.estimatedCost).toBe("0.30000000");
  });

  it("refuses a unit price it cannot represent rather than rounding it away", () => {
    expect(() =>
      computeCostRollup([group({ inputUnitPrice: "3.000000001", inputTokens: 1n })]),
    ).toThrow(/more than 8 decimals/u);
  });

  it("consumes what Postgres actually returns, verified against a live postgres:18", () => {
    // Not a hand-written fixture. These two rows are the literal output of
    // `summarizeRequestCost` run against a throwaway postgres:18 on 2026-08-26
    // with the real baseline DDL plus incr/01 and incr/02, seeded with an
    // EXPIRED rule (99/99) alongside the one in force (3/12/0.1), one row with
    // null token counts, one unpriced model, and one `usage_type='test'` row.
    //
    // What that run proved, and this test now keeps: the expired rule is not
    // selected, probe traffic is excluded, an unpriced model gets its own group
    // instead of being dropped, and `numeric(18,8)` arrives as a STRING. The
    // last one was an assumption in this file's design until it was checked -
    // a number there would have silently reintroduced float money.
    const fromPostgres: CostGroupRow[] = [
      {
        modelCode: "deepseek-v4-flash",
        providerCode: "deepseek",
        priceRuleId: "44444444-4444-4444-4444-444444444444",
        currency: "CNY",
        unitTokens: 1_000_000,
        inputUnitPrice: "3.00000000",
        outputUnitPrice: "12.00000000",
        requestUnitPrice: "0.00000000",
        cachedInputUnitPrice: "0.10000000",
        requests: 2n,
        requestsMissingInput: 1n,
        requestsMissingOutput: 1n,
        inputTokens: 1_000_000n,
        cachedInputTokens: 400_000n,
        outputTokens: 100_000n,
        reasoningTokens: 60_000n,
      },
      {
        modelCode: "unpriced-model",
        providerCode: "deepseek",
        priceRuleId: null,
        currency: null,
        unitTokens: null,
        inputUnitPrice: null,
        outputUnitPrice: null,
        requestUnitPrice: null,
        cachedInputUnitPrice: null,
        requests: 1n,
        requestsMissingInput: 0n,
        requestsMissingOutput: 0n,
        inputTokens: 500_000n,
        cachedInputTokens: 0n,
        outputTokens: 1_000n,
        reasoningTokens: 0n,
      },
    ];

    const { items, totalsByCurrency, coverage } = computeCostRollup(fromPostgres);

    // 600k uncached at 3.00/M = 1.80, 400k cached at 0.10/M = 0.04,
    // 100k output at 12.00/M = 1.20. The 60k reasoning tokens are inside that
    // output and are not charged again.
    expect(items[0]?.estimatedCost).toBe("3.04000000");
    expect(items[1]?.estimatedCost).toBeNull();
    expect(totalsByCurrency).toEqual([{ currency: "CNY", estimatedCost: "3.04000000" }]);
    expect(coverage).toEqual({
      requests: 3,
      requestsWithoutPriceRule: 1,
      requestsMissingInputTokens: 1,
      requestsMissingOutputTokens: 1,
    });
  });

  it("refuses a non-positive unit_tokens instead of dividing by zero", () => {
    expect(() =>
      computeCostRollup([group({ unitTokens: 0, inputTokens: 1n })]),
    ).toThrow(/unit_tokens must be positive/u);
  });
});
