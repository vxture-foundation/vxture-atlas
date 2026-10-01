import { describe, expect, it } from "vitest";

import { unmappedUsagePaths } from "./usage-keys";

describe("unmappedUsagePaths - every shape Atlas reads today is known", () => {
  it.each([
    [
      "doubao (as stored in reqlog, 2026-10-01)",
      {
        prompt_tokens: 34,
        completion_tokens: 1,
        total_tokens: 35,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    ],
    [
      "deepseek (top-level cache spelling)",
      {
        prompt_tokens: 84,
        completion_tokens: 9,
        total_tokens: 93,
        prompt_tokens_details: { cached_tokens: 20 },
        prompt_cache_hit_tokens: 20,
        prompt_cache_miss_tokens: 64,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    ],
    [
      "anthropic (cache writes split by TTL, server tool use)",
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 },
        service_tier: "standard",
        server_tool_use: { web_search_requests: 2 },
      },
    ],
    ["zhipu embed / rerank", { prompt_tokens: 12, total_tokens: 12 }],
  ])("%s", (_name, usage) => {
    expect(unmappedUsagePaths(usage)).toEqual([]);
  });

  it("does not count a field the vendor sent as null - it states nothing", () => {
    expect(unmappedUsagePaths({ prompt_tokens: 1, prompt_tokens_details: null })).toEqual([]);
  });
});

describe("unmappedUsagePaths - a field Atlas does not map is named", () => {
  it("names a new top-level and a new nested field by dotted path", () => {
    expect(
      unmappedUsagePaths({
        prompt_tokens: 1,
        completion_tokens_details: {
          reasoning_tokens: 0,
          accepted_prediction_tokens: 2,
        },
        prompt_tokens_details: { cached_tokens: 0, image_tokens: 7 },
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 },
        cost: 0.002,
      }),
    ).toEqual([
      "completion_tokens_details.accepted_prediction_tokens",
      "prompt_tokens_details.image_tokens",
      "server_tool_use.web_fetch_requests",
      "cost",
    ]);
  });

  it("stops at a fixed depth and never mints an odd label", () => {
    expect(unmappedUsagePaths({ a: { b: { c: { d: 1 } } } })).toEqual(["a.b.c"]);
    expect(unmappedUsagePaths({ "weird key!": 1 })).toEqual(["malformed"]);
  });

  it("reads nothing from a usage that is not an object", () => {
    expect(unmappedUsagePaths(undefined)).toEqual([]);
    expect(unmappedUsagePaths(null)).toEqual([]);
  });
});
