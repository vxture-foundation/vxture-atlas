import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";

import {
  rejectUnknownFilters,
  unknownFilterMessage,
  unknownFilters,
} from "./http-query";

/**
 * The defect these guard against is not an exception anybody sees in a log -
 * it is a 200 with a well-formed body that answers a different question. So
 * the assertions here are about what the caller can TELL, not just that a
 * throw happened.
 */
describe("unknown query filters", () => {
  const ALLOWED = ["tenantId", "modelId"];

  it("names the rejected filter and the accepted ones", () => {
    let thrown: BadRequestException | undefined;
    try {
      rejectUnknownFilters({ productCode: "vxtpl" }, ALLOWED, "X_UNKNOWN");
    } catch (error) {
      thrown = error as BadRequestException;
    }

    const body = thrown?.getResponse() as Record<string, unknown>;
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(body["code"]).toBe("X_UNKNOWN");
    expect(body["retryable"]).toBe(false);
    expect(body["field"]).toBe("productCode");
    // Both sides: after a rename the caller is sending something that was
    // correct last week, and "unknown filter" alone reads as a typo.
    expect(body["message"]).toContain("productCode");
    expect(body["message"]).toContain("modelId, tenantId");
  });

  it("accepts a request that uses only known filters", () => {
    expect(() =>
      rejectUnknownFilters({ tenantId: "t", modelId: "m" }, ALLOWED, "X"),
    ).not.toThrow();
    expect(() => rejectUnknownFilters({}, ALLOWED, "X")).not.toThrow();
  });

  it("reports every unknown filter, not just the first", () => {
    // A caller that fixes one and retries should not have to discover the
    // rest one round-trip at a time.
    expect(unknownFilters({ b: "1", a: "2", tenantId: "t" }, ALLOWED)).toEqual([
      "a",
      "b",
    ]);
  });

  it("sorts both lists so the message is stable across calls", () => {
    // Query-parameter order is the caller's, not ours; an unstable message
    // makes the same refusal look like two different ones in a log.
    expect(unknownFilterMessage(["b", "a"], ["z", "y"])).toBe(
      unknownFilterMessage(["a", "b"], ["y", "z"]),
    );
  });
});
