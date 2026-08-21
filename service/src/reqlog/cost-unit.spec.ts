import { describe, expect, it } from "vitest";

import { costUnitForMetric, type CostUnit } from "./cost-unit";
// The FULL declaration, not PUBLISHED_TOOL_DESCRIPTORS: atlas.parse is
// withheld from .well-known while no vision model is registered (TD-019), but
// it bills per page the moment it serves, so its descriptor has to be right
// now rather than the day it is published.
import { ATLAS_TOOL_DESCRIPTORS } from "../discovery/tool-descriptors";

/**
 * Ties three things that had already drifted apart: what a capability BILLS,
 * what the row SAYS it billed, and what the published descriptor CLAIMS.
 *
 * Three of the four descriptors said `per_call` while the code sent
 * `usage.totalTokens`, `candidates.length` and `pages.length` respectively -
 * and the `atlas.chat` entry, correct all along, carried a comment saying the
 * two must not drift apart. A comment is not a check.
 */
describe("cost units and the published descriptors agree", () => {
  const EXPECTED: Readonly<Record<string, CostUnit>> = {
    "atlas.chat": "token",
    "atlas.embed": "token",
    "atlas.rerank": "candidate",
    "atlas.parse": "page",
  };

  it.each(Object.entries(EXPECTED))(
    "%s bills in %s",
    (metric, unit) => {
      expect(costUnitForMetric(metric)).toBe(unit);
    },
  );

  it("declares per_unit for every capability that bills per unit", () => {
    // `per_call` would mean one request costs one thing regardless of size. No
    // Atlas capability works that way: chat and embed count tokens, rerank
    // counts candidates, parse counts pages.
    for (const descriptor of ATLAS_TOOL_DESCRIPTORS) {
      if (!descriptor.metering) continue;
      expect({
        name: descriptor.name,
        mode: descriptor.metering.mode,
      }).toEqual({ name: descriptor.name, mode: "per_unit" });
    }
  });

  it("has a unit for every metric a descriptor publishes", () => {
    // The direction that catches a NEW capability: publishing a tool whose
    // metric has no unit means its rows record an amount nobody can interpret.
    for (const descriptor of ATLAS_TOOL_DESCRIPTORS) {
      if (!descriptor.metering) continue;
      expect({
        metric: descriptor.metering.metric,
        unit: costUnitForMetric(descriptor.metering.metric),
      }).toEqual({
        metric: descriptor.metering.metric,
        unit: expect.any(String),
      });
    }
  });

  it("returns undefined for an unknown metric rather than guessing", () => {
    // Recording no unit is honest and visible; recording a wrong one is a
    // plausible number that nothing rejects.
    expect(costUnitForMetric("atlas.something-new")).toBeUndefined();
  });
});
