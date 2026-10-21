/**
 * Trailing slash normalization and adversarial suffix regressions.
 *
 * @package @atlas/service
 * @layer Infrastructure
 * @category Test
 * @author AI-Generated
 * @date 2026-10-21
 */
import { describe, expect, it } from "vitest";

import { trimTrailingSlashes } from "./http-path";

describe("trimTrailingSlashes", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["////", ""],
    ["https://idp.test/oidc/token///", "https://idp.test/oidc/token"],
    ["/nested//path", "/nested//path"],
    ["/path/\n", "/path/\n"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it("preserves a long slash run followed by a non-slash", () => {
    const input = `/${"/".repeat(100_000)}x`;
    expect(trimTrailingSlashes(input)).toBe(input);
  });

  it("removes a long trailing run while preserving the preceding path", () => {
    expect(trimTrailingSlashes(`/path${"/".repeat(100_000)}`)).toBe("/path");
  });
});
