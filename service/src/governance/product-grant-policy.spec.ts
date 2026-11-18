/**
 * Security regressions for declarative product grants.
 * @package @atlas/service
 * @layer Domain
 * @category Test
 * @author AI-Generated
 * @date 2026-11-18
 */
import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  mergeTerms,
  validatePolicyUpdate,
  validateRules,
  type GrantRule,
  type PolicyResource,
} from "./product-grant-policy";

const resources: PolicyResource[] = [
  {
    id: "vendor.a",
    category: "crm",
    tags: ["safe", "paid"],
    eligible: true,
    dependencies: ["vendor.b"],
  },
  { id: "vendor.b", category: "data", tags: ["safe"], eligible: true },
  { id: "vendor.draft", category: "crm", tags: ["safe"], eligible: false },
];
function rule(over: Partial<GrantRule> = {}): GrantRule {
  return {
    id: "all",
    name: "All",
    enabled: true,
    effect: "allow",
    selector: { mode: "all", values: [], tagMatch: "any", excludedIds: [] },
    riskScope: "read",
    criticalRequiresApproval: true,
    ...over,
  };
}

// Validation ---------------------------------------------------------------
describe("policy validation", () => {
  it("rejects implicit all, unknown fields and duplicate identities", () => {
    expect(() =>
      validateRules([
        rule({
          selector: {
            mode: "categories",
            values: [],
            tagMatch: "any",
            excludedIds: [],
          },
        }),
      ]),
    ).toThrow();
    expect(() => validateRules([{ ...rule(), actorId: "forged" }])).toThrow();
    expect(() => validateRules([rule(), rule()])).toThrow();
    expect(() =>
      validateRules([rule({ enabled: "false" as unknown as boolean })]),
    ).toThrow();
  });
  it("requires a bounded optimistic revision and strict nested fields", () => {
    for (const expectedRevision of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER])
      expect(() =>
        validatePolicyUpdate({ expectedRevision, rules: [] }),
      ).toThrow();
    expect(() =>
      validateRules([
        rule({
          selector: {
            ...rule().selector,
            extra: true,
          } as GrantRule["selector"],
        }),
      ]),
    ).toThrow();
    expect(
      validatePolicyUpdate({ expectedRevision: 0, rules: [rule()] }).rules,
    ).toHaveLength(1);
  });
});

// Effective authorization --------------------------------------------------
describe("continuous policies", () => {
  it("automatically includes future eligible resources and excludes drafts", () => {
    const result = evaluatePolicy(
      [rule()],
      [
        ...resources,
        { id: "vendor.future", category: "crm", tags: [], eligible: true },
      ],
    );
    expect(result.get("vendor.future")?.contributions).toHaveLength(1);
    expect(result.get("vendor.draft")?.contributions).toHaveLength(0);
  });
  it("supports category and any/all tag matching", () => {
    const category = rule({
      selector: {
        mode: "categories",
        values: ["data"],
        tagMatch: "any",
        excludedIds: [],
      },
    });
    expect(
      evaluatePolicy([category], resources).get("vendor.a")?.contributions,
    ).toHaveLength(0);
    const tags = rule({
      selector: {
        mode: "tags",
        values: ["safe", "paid"],
        tagMatch: "all",
        excludedIds: [],
      },
    });
    expect(
      evaluatePolicy([tags], resources).get("vendor.a")?.contributions,
    ).toHaveLength(1);
    expect(
      evaluatePolicy([tags], resources).get("vendor.b")?.contributions[0]
        ?.direct,
    ).toBe(false);
  });
  it("lets explicit deny override manual grants and all allows", () => {
    const deny = rule({
      id: "deny",
      effect: "deny",
      selector: {
        mode: "resources",
        values: ["vendor.b"],
        tagMatch: "any",
        excludedIds: [],
      },
    });
    const manual = new Map([
      [
        "vendor.b",
        [
          {
            source: "manual:g1",
            direct: true,
            riskScope: "critical" as const,
            criticalRequiresApproval: false,
          },
        ],
      ],
    ]);
    const result = evaluatePolicy([rule(), deny], resources, manual);
    expect(result.get("vendor.b")?.deniedBy).toEqual(["deny"]);
    expect(result.get("vendor.b")?.contributions).toHaveLength(0);
    expect(result.get("vendor.a")?.contributions).toHaveLength(0);
  });
  it("does not restore an excluded resource through a dependency", () => {
    const excluded = rule({
      selector: {
        mode: "all",
        values: [],
        tagMatch: "any",
        excludedIds: ["vendor.b"],
      },
    });
    expect(
      evaluatePolicy([excluded], resources).get("vendor.b")?.contributions,
    ).toHaveLength(0);
    expect(
      evaluatePolicy([excluded], resources).get("vendor.a")?.contributions,
    ).toHaveLength(0);
  });
  it("blocks a manual anchor when a required dependency is explicitly denied", () => {
    const denied = rule({
      effect: "deny",
      selector: {
        mode: "resources",
        values: ["vendor.b"],
        tagMatch: "any",
        excludedIds: [],
      },
    });
    const manual = new Map([
      [
        "vendor.a",
        [
          {
            source: "manual:g1",
            direct: true,
            riskScope: "read" as const,
            criticalRequiresApproval: true,
          },
        ],
      ],
    ]);
    expect(
      evaluatePolicy([denied], resources, manual).get("vendor.a")
        ?.contributions,
    ).toHaveLength(0);
  });
  it("does not erase manual permissions when a rule is removed", () => {
    const manual = new Map([
      [
        "vendor.b",
        [
          {
            source: "manual:g1",
            direct: true,
            riskScope: "read" as const,
            criticalRequiresApproval: true,
          },
        ],
      ],
    ]);
    expect(
      evaluatePolicy([], resources, manual)
        .get("vendor.b")
        ?.contributions.map((g) => g.source),
    ).toEqual(["manual:g1"]);
  });
  it("does not grant disabled rules or excluded resources", () => {
    expect(
      evaluatePolicy([rule({ enabled: false })], resources).get("vendor.a")
        ?.contributions,
    ).toHaveLength(0);
    const selected = rule({
      selector: {
        mode: "all",
        values: [],
        tagMatch: "any",
        excludedIds: ["vendor.a"],
      },
    });
    expect(
      evaluatePolicy([selected], resources).get("vendor.a")?.contributions,
    ).toHaveLength(0);
  });
  it("terminates cyclic dependency graphs and rejects missing dependencies", () => {
    const cyclic = resources.map((r) =>
      r.id === "vendor.b" ? { ...r, dependencies: ["vendor.a"] } : r,
    );
    expect(
      evaluatePolicy([rule()], cyclic).get("vendor.a")?.contributions.length,
    ).toBeGreaterThan(0);
    const missing = resources.map((r) =>
      r.id === "vendor.a" ? { ...r, dependencies: ["missing"] } : r,
    );
    expect(
      evaluatePolicy([rule()], missing).get("vendor.a")?.contributions,
    ).toHaveLength(0);
  });
  it("preserves separate provenance without duplicating one source", () => {
    const result = evaluatePolicy(
      [rule(), rule({ id: "second" })],
      resources,
    ).get("vendor.a")!;
    expect(new Set(result.contributions.map((g) => g.source)).size).toBe(2);
  });
  it("never borrows an approval waiver from a lower risk alternative", () => {
    const merged = mergeTerms([
      {
        source: "high",
        direct: true,
        riskScope: "critical",
        criticalRequiresApproval: true,
      },
      {
        source: "low",
        direct: true,
        riskScope: "read",
        criticalRequiresApproval: false,
      },
    ]);
    expect(merged).toEqual({
      riskScope: "critical",
      criticalRequiresApproval: true,
    });
  });
  it("accepts an independent critical grant which explicitly waives approval", () => {
    expect(
      mergeTerms([
        {
          source: "high",
          direct: true,
          riskScope: "critical",
          criticalRequiresApproval: false,
        },
      ])?.criticalRequiresApproval,
    ).toBe(false);
  });
});
