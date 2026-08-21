import { describe, expect, it } from "vitest";

import { isActiveState, toObjectState } from "./object-state";

/**
 * product_251 M-B3. The value of a shared vocabulary is that every surface
 * spells it the same way, so this pins the spelling itself - three surfaces
 * previously said `isActive`, one said `status`, and a fourth wrote its own
 * `"active" | "inactive" | "missing"` union by hand.
 */
describe("the object-state vocabulary", () => {
  it("spells the two required values exactly", () => {
    expect(toObjectState(true)).toBe("active");
    expect(toObjectState(false)).toBe("inactive");
  });

  it("round-trips, so the boundary mapping cannot invert", () => {
    // The DB keeps `is_active boolean`; a mapping that flipped would deactivate
    // everything the console showed as live, and vice versa. That is worth one
    // assertion.
    for (const value of [true, false]) {
      expect(isActiveState(toObjectState(value))).toBe(value);
    }
  });
});
