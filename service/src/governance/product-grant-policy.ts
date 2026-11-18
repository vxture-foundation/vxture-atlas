/**
 * Product policy validation and deterministic grant evaluation.
 * @package @atlas/service
 * @layer Domain
 * @category Authorization
 * @author AI-Generated
 * @date 2026-11-18
 */

// Types and validation --------------------------------------------------------

export type RiskScope = "read" | "write" | "critical";
export interface GrantRule {
  id: string;
  name: string;
  enabled: boolean;
  effect: "allow" | "deny";
  selector: {
    mode: "all" | "categories" | "tags" | "resources";
    values: string[];
    tagMatch: "any" | "all";
    excludedIds: string[];
  };
  riskScope: RiskScope;
  criticalRequiresApproval: boolean;
}
export interface PolicyResource {
  id: string;
  category: string;
  tags: readonly string[];
  eligible: boolean;
  dependencies?: readonly string[];
}
export interface GrantContribution {
  source: string;
  direct: boolean;
  riskScope: RiskScope;
  criticalRequiresApproval: boolean;
}
export interface EffectivePermission {
  resourceId: string;
  contributions: GrantContribution[];
  deniedBy: string[];
}
export class PolicyValidationError extends Error {}

function fail(message: string): never {
  throw new PolicyValidationError(message);
}
function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("Expected an object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !fields.includes(key)))
    fail("Unknown policy field");
  return object;
}
function text(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(`Invalid ${label}`);
  return value;
}
function strings(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${label}`);
  const result = value.map((item: unknown) => text(item, 128, label));
  if (new Set(result).size !== result.length) fail(`Duplicate ${label}`);
  return result;
}
export function validateProductCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(value))
    fail("Invalid productCode");
  return value;
}
export function validatePolicyUpdate(value: unknown): {
  expectedRevision: number;
  rules: GrantRule[];
} {
  const body = record(value, ["expectedRevision", "rules"]);
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    (body.expectedRevision as number) < 0 ||
    (body.expectedRevision as number) > 2147483646
  )
    fail("Invalid expectedRevision");
  return {
    expectedRevision: body.expectedRevision as number,
    rules: validateRules(body.rules),
  };
}
export function validateRules(value: unknown): GrantRule[] {
  if (!Array.isArray(value) || value.length > 100)
    fail("rules must contain at most 100 entries");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    const rule = record(item, [
      "id",
      "name",
      "enabled",
      "effect",
      "selector",
      "riskScope",
      "criticalRequiresApproval",
    ]);
    const id = text(rule.id, 64, "rule id");
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
      fail("Invalid or duplicate rule id");
    ids.add(id);
    const name = text(rule.name, 100, "rule name");
    if (
      typeof rule.enabled !== "boolean" ||
      typeof rule.criticalRequiresApproval !== "boolean"
    )
      fail("Policy flags must be boolean");
    if (rule.effect !== "allow" && rule.effect !== "deny")
      fail("Invalid effect");
    if (!["read", "write", "critical"].includes(String(rule.riskScope)))
      fail("Invalid riskScope");
    const selector = record(rule.selector, [
      "mode",
      "values",
      "tagMatch",
      "excludedIds",
    ]);
    if (
      !["all", "categories", "tags", "resources"].includes(
        String(selector.mode),
      )
    )
      fail("Invalid selector mode");
    if (selector.tagMatch !== "any" && selector.tagMatch !== "all")
      fail("Invalid tagMatch");
    const values = strings(selector.values, 1000, "selector values");
    if (selector.mode === "all" ? values.length !== 0 : values.length === 0)
      fail("Selector needs explicit values or explicit all");
    if (
      selector.mode === "tags" &&
      values.some((tag) => !/^[a-z0-9][a-z0-9-]{1,31}$/.test(tag))
    )
      fail("Invalid tag");
    return {
      id,
      name,
      enabled: rule.enabled,
      effect: rule.effect,
      selector: {
        mode: selector.mode as GrantRule["selector"]["mode"],
        values,
        tagMatch: selector.tagMatch,
        excludedIds: strings(selector.excludedIds, 1000, "excludedIds"),
      },
      riskScope: rule.riskScope as RiskScope,
      criticalRequiresApproval: rule.criticalRequiresApproval,
    };
  });
}

// Matching and dependency closure --------------------------------------------

export function ruleMatches(
  rule: GrantRule,
  resource: PolicyResource,
): boolean {
  if (!rule.enabled || rule.selector.excludedIds.includes(resource.id))
    return false;
  const { mode, values, tagMatch } = rule.selector;
  if (mode === "all") return true;
  if (mode === "resources") return values.includes(resource.id);
  if (mode === "categories") return values.includes(resource.category);
  return tagMatch === "all"
    ? values.every((tag) => resource.tags.includes(tag))
    : values.some((tag) => resource.tags.includes(tag));
}

/** Compile without writing synthetic grants to the manual grant table. */
export function evaluatePolicy(
  rules: readonly GrantRule[],
  resources: readonly PolicyResource[],
  manual: ReadonlyMap<string, readonly GrantContribution[]> = new Map(),
): Map<string, EffectivePermission> {
  const catalog = new Map(resources.map((resource) => [resource.id, resource]));
  const result = new Map<string, EffectivePermission>();
  const sourceIndex = new Map<string, Map<string, GrantContribution>>();
  for (const resource of resources) {
    const deniedBy = rules
      .filter((rule) => rule.effect === "deny" && ruleMatches(rule, resource))
      .map((rule) => rule.id);
    sourceIndex.set(resource.id, new Map());
    result.set(resource.id, {
      resourceId: resource.id,
      deniedBy,
      contributions: [...(manual.get(resource.id) ?? [])],
    });
  }
  for (const anchor of resources) {
    if (!anchor.eligible) continue;
    const closure = new Set<string>();
    const queue = [anchor.id];
    let blocked = false;
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      if (closure.has(id)) continue;
      closure.add(id);
      const resource = catalog.get(id);
      if (!resource?.eligible || result.get(id)!.deniedBy.length > 0) {
        blocked = true;
        break;
      }
      queue.push(...(resource.dependencies ?? []));
    }
    if (blocked) {
      // A manual anchor cannot bypass a denied required dependency either.
      const entry = result.get(anchor.id)!;
      entry.contributions = entry.contributions.filter(
        (grant) => !grant.source.startsWith("manual:"),
      );
      continue;
    }
    const allows = rules.filter(
      (rule) =>
        rule.effect === "allow" &&
        ruleMatches(rule, anchor) &&
        ![...closure].some((id) => rule.selector.excludedIds.includes(id)),
    );
    for (const rule of allows)
      for (const id of closure) {
        const entry = result.get(id)!;
        const source = `rule:${rule.id}`;
        const previous = sourceIndex.get(id)!.get(source);
        if (previous) {
          previous.direct ||= id === anchor.id;
          continue;
        }
        const contribution = {
          source,
          direct: id === anchor.id,
          riskScope: rule.riskScope,
          criticalRequiresApproval: rule.criticalRequiresApproval,
        };
        sourceIndex.get(id)!.set(source, contribution);
        entry.contributions.push(contribution);
      }
  }
  for (const entry of result.values())
    if (entry.deniedBy.length > 0) entry.contributions = [];
  return result;
}

/** Preserve risk/approval correlation when collapsing alternative grants. */
export function mergeTerms(
  contributions: readonly GrantContribution[],
): { riskScope: RiskScope; criticalRequiresApproval: boolean } | undefined {
  const levels: RiskScope[] = ["critical", "write", "read"];
  const riskScope = levels.find((risk) =>
    contributions.some((grant) => grant.riskScope === risk),
  );
  if (!riskScope) return undefined;
  return {
    riskScope,
    criticalRequiresApproval: !contributions.some(
      (grant) =>
        grant.riskScope === "critical" && !grant.criticalRequiresApproval,
    ),
  };
}
