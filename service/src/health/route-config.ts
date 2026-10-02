import { routeState, type ModelHealthState, type RouteHealthState } from "./health-state";

/**
 * route-config.ts - can the models a route names actually serve it
 * (ADR-013, design 120 section 4.4). Pure.
 *
 * A model serves a route when it exists, is active under an active vendor,
 * has a key Atlas can use, and is of the route's type: the embed and rerank
 * paths call the vendor's embedding / rerank API, so a chat model named
 * there fails on every call, and a chat route cannot be answered by an
 * embedding model. Found in production 2026-10-02: six of twelve routes
 * named a model of the wrong type, one of them as the PRIMARY.
 *
 * What this cannot check: a capability no model declares. `chat/vision` needs
 * an image-capable model, and no model in the registry declares `vision`, so
 * that route is not judged here rather than judged by its name.
 */

/** Route categories with a type rule. Any other category is not judged. */
export const TYPED_CATEGORIES: ReadonlySet<string> = new Set(["chat", "embedding", "rerank"]);

export type RouteConfigIssueCode = "model_missing" | "model_inactive" | "wrong_type" | "no_key";

export interface RouteConfigIssue {
  role: "primary" | "fallback";
  modelCode: string;
  code: RouteConfigIssueCode;
  detail: string;
}

export interface ModelFacts {
  modelType: string;
  /** The model and its vendor are both active. */
  active: boolean;
  /** An active vault key backs it, or its vendor needs none. */
  hasKey: boolean;
}

export function modelIssues(
  role: "primary" | "fallback",
  modelCode: string,
  category: string,
  facts: ModelFacts | undefined,
): RouteConfigIssue[] {
  if (!facts) {
    return [{ role, modelCode, code: "model_missing", detail: `${role} "${modelCode}" is not a model in the registry` }];
  }
  const issues: RouteConfigIssue[] = [];
  if (TYPED_CATEGORIES.has(category) && facts.modelType !== category) {
    issues.push({
      role,
      modelCode,
      code: "wrong_type",
      detail: `${role} "${modelCode}" is a ${facts.modelType} model; a ${category} route needs a ${category} model`,
    });
  }
  if (!facts.active) {
    issues.push({ role, modelCode, code: "model_inactive", detail: `${role} "${modelCode}" or its vendor is inactive` });
  }
  if (!facts.hasKey) {
    issues.push({
      role,
      modelCode,
      code: "no_key",
      detail: `${role} "${modelCode}" has no active key in the vault; every call is refused before it leaves Atlas`,
    });
  }
  return issues;
}

export function routeConfigIssues(
  route: { category: string; primary: string; fallback: string | null },
  facts: ReadonlyMap<string, ModelFacts>,
): RouteConfigIssue[] {
  return [
    ...modelIssues("primary", route.primary, route.category, facts.get(route.primary)),
    ...(route.fallback !== null
      ? modelIssues("fallback", route.fallback, route.category, facts.get(route.fallback))
      : []),
  ];
}

/**
 * The route's state, with a model that cannot serve the route counted as not
 * serving it whatever its own health says. Without this, `rerank/default`
 * with its primary down and a healthy CHAT model as fallback read `degraded`
 * ("callers are still served") while every caller failed.
 */
export function evaluateRoute(
  route: { primary: string; fallback: string | null; configIssues?: readonly RouteConfigIssue[] },
  stateOf: (modelCode: string) => ModelHealthState | undefined,
): RouteHealthState {
  const broken = (role: "primary" | "fallback"): boolean =>
    (route.configIssues ?? []).some((i) => i.role === role);
  const primary: ModelHealthState | undefined = broken("primary") ? "unavailable" : stateOf(route.primary);
  const hasFallback = route.fallback !== null && !broken("fallback");
  return routeState(primary, hasFallback ? stateOf(route.fallback!) : undefined, hasFallback);
}
