import { describe, expect, it } from "vitest";

import {
  classifyReasoningToolCall,
  hasPriorAssistantTurn,
} from "./reasoning-tool-exposure";
import type { ChatMessage } from "../types/runtime.types";

const msg = (role: ChatMessage["role"], content = "x"): ChatMessage => ({
  role,
  content,
});

const base = {
  toolsPresent: true,
  reasoningTokens: 120,
  messages: [msg("user")],
  productCode: "karda",
};

/**
 * The population, not the failure. TD-046's 400 lands at the caller and is
 * genuinely invisible here - what these tests pin is that the SHAPE is not,
 * which is the sentence vxture-atlas#23 had been parked on.
 */
describe("classifyReasoningToolCall", () => {
  it("counts a tools call that came back with reasoning", () => {
    expect(classifyReasoningToolCall(base)).toEqual({
      product: "karda",
      multiRound: "no",
    });
  });

  it("marks it multi-round once the caller sends an assistant turn back", () => {
    expect(
      classifyReasoningToolCall({
        ...base,
        messages: [msg("user"), msg("assistant"), msg("user")],
      }),
    ).toEqual({ product: "karda", multiRound: "yes" });
  });

  /**
   * Both conditions are load-bearing. Counting either alone would report a
   * number far larger than the risk - `tools` without reasoning is most tool
   * traffic in the fleet, and reasoning without `tools` is every ordinary
   * thinking-model call, which works today. An inflated exposure number is its
   * own way of being useless: nobody acts on a metric they have learned to
   * discount.
   */
  it("does not count tools without reasoning", () => {
    expect(
      classifyReasoningToolCall({ ...base, reasoningTokens: 0 }),
    ).toBeUndefined();
  });

  it("does not count reasoning without tools", () => {
    expect(
      classifyReasoningToolCall({ ...base, toolsPresent: false }),
    ).toBeUndefined();
  });

  /**
   * "The upstream reported no split" is not "the model reasoned zero" - the
   * same rule TD-047 applies to the reqlog columns. Both fall outside the
   * population, but treating `undefined` as a number is the bug that rule
   * exists to prevent, so it is asserted separately rather than folded in.
   */
  it("treats an unreported split as absent, not as zero", () => {
    expect(
      classifyReasoningToolCall({ ...base, reasoningTokens: undefined }),
    ).toBeUndefined();
  });

  it("labels an unattributed caller rather than dropping the count", () => {
    // Losing the row would understate the exposure; "unknown" keeps the total
    // honest and still says the attribution is missing.
    expect(
      classifyReasoningToolCall({ ...base, productCode: undefined })?.product,
    ).toBe("unknown");
  });
});

describe("hasPriorAssistantTurn", () => {
  /**
   * Message COUNT is the wrong test, and the difference is the whole point: a
   * conversation of ten user messages has never round-tripped anything, so
   * there is no reasoning content the caller could have failed to return.
   */
  it("is false for many user turns and no assistant turn", () => {
    expect(hasPriorAssistantTurn([msg("user"), msg("user"), msg("user")])).toBe(
      false,
    );
  });

  it("is true as soon as one assistant turn is present", () => {
    expect(hasPriorAssistantTurn([msg("user"), msg("assistant")])).toBe(true);
  });

  it("is false for a system prompt alone", () => {
    expect(hasPriorAssistantTurn([msg("system")])).toBe(false);
  });

  it("handles an absent message list", () => {
    expect(hasPriorAssistantTurn(undefined)).toBe(false);
  });
});
