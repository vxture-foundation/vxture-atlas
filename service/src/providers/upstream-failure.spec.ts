import { describe, expect, it } from "vitest";

import {
  UpstreamCallFailure,
  usageColumns,
  usageFromError,
} from "./upstream-failure";

describe("usageFromError", () => {
  it("returns what an upstream reported before failing", () => {
    const error = new UpstreamCallFailure("empty model response", {
      promptTokens: 84,
      completionTokens: 16,
      totalTokens: 100,
      reasoningTokens: 16,
    });

    // The exact shape of the 2026-08-25 DeepSeek onboarding failure: the whole
    // completion budget spent on the reasoning chain, no content, and a bill.
    expect(usageFromError(error)).toEqual({
      promptTokens: 84,
      completionTokens: 16,
      totalTokens: 100,
      reasoningTokens: 16,
    });
  });

  it("returns undefined for an ordinary error, which is most failures", () => {
    // A timeout or a refused connection reports nothing, and NULL is the honest
    // answer for those rows.
    expect(usageFromError(new Error("socket hang up"))).toBeUndefined();
    expect(usageFromError(undefined)).toBeUndefined();
    expect(usageFromError("not even an error")).toBeUndefined();
  });

  it("refuses a plain object that merely looks like one", () => {
    // Duck-typing on a `usage` property would let an arbitrary object put
    // invented numbers into the metering table - the NULL-not-zero failure
    // arriving through a different door.
    expect(usageFromError({ usage: { promptTokens: 999 } })).toBeUndefined();
  });

  it("treats an empty snapshot as no report at all", () => {
    // `{}` would write a row claiming the upstream said something.
    expect(usageFromError(new UpstreamCallFailure("nothing reported", {}))).toBeUndefined();
  });
});

describe("usageColumns", () => {
  it("writes nothing at all when nothing was reported", () => {
    // The row then carries NULLs, which is what "we did not measure it" means.
    expect(usageColumns(undefined)).toEqual({});
    expect(usageColumns({})).toEqual({});
  });

  it("maps each reported field to its column, and only those", () => {
    expect(
      usageColumns({ promptTokens: 84, completionTokens: 16, totalTokens: 100 }),
    ).toEqual({ inputTokens: 84, outputTokens: 16, totalTokens: 100 });
  });

  it("carries the two splits when the upstream broke them out", () => {
    expect(usageColumns({ cachedInputTokens: 40, reasoningTokens: 16 })).toEqual({
      cachedInputTokens: 40,
      reasoningTokens: 16,
    });
  });

  it("keeps a reported zero, which is not the same as an absent field", () => {
    // A provider that says "zero cached tokens" has measured something. Dropping
    // it here would turn a measurement into a NULL and lose the distinction the
    // whole column set exists to preserve.
    expect(usageColumns({ cachedInputTokens: 0 })).toEqual({ cachedInputTokens: 0 });
  });

  it("omits a field the provider did not break out, rather than inventing 0", () => {
    // Anthropic counts thinking inside output_tokens and reports no reasoning
    // split; a 0 here would be a specific, false claim about that provider.
    expect(usageColumns({ promptTokens: 84, cachedInputTokens: 40 })).toEqual({
      inputTokens: 84,
      cachedInputTokens: 40,
    });
  });
});

