import { Logger } from "@nestjs/common";

import { ProviderHttpError } from "../providers/base.provider";
import { UpstreamCallFailure } from "../providers/upstream-failure";
import { UpstreamTimeoutError } from "../providers/upstream-timeout";
import { metricsRegistry } from "../runtime/metrics.registry";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import { upstreamFailureClass } from "../runtime/upstream-status";
import { evaluateRoute, type RouteConfigIssue } from "./route-config";
import {
  initialRecord,
  modelSeverity,
  nextRecord,
  routeSeverity,
  type HealthSeverity,
  type HealthSignal,
  type ModelHealthRecord,
  type ModelHealthState,
  type RouteHealthState,
} from "./health-state";

/**
 * upstream-health.ts - the process-wide record of vendor model and route
 * health (ADR-013, design 120).
 *
 * A singleton like `metricsRegistry`, for the same reason: every call path
 * (chat, and the S2S embed / rerank / parse loop) reports into it, and none of
 * them should need a constructor change to do so. Recording is synchronous and
 * in memory; only a state TRANSITION reaches the store, queued so transitions
 * are written in the order they happened. With no store attached (unit tests)
 * it is memory only.
 */

/** A route as configured: `model.model_endpoints`. */
export interface RouteDef {
  code: string;
  primary: string;
  fallback: string | null;
  category?: string;
  /** Why a named model cannot serve this route (design 120 section 4.4); absent = not checked. */
  configIssues?: RouteConfigIssue[];
}

export interface Transition {
  subjectKind: "model" | "route" | "vendor" | "atlas";
  subjectKey: string;
  providerCode?: string;
  from: string;
  to: string;
  since: Date;
  severity: HealthSeverity;
  upstreamStatus?: number;
  detail?: string;
  affectedRoutes: string[];
  /** False for a first sighting of a healthy model: store the state, record no event. */
  event: boolean;
}

export interface HealthStore {
  load(): Promise<{
    models: { modelCode: string; providerCode: string | null; record: ModelHealthRecord }[];
    routes: { code: string; state: RouteHealthState }[];
  }>;
  listRoutes(): Promise<RouteDef[]>;
  save(transition: Transition): Promise<void>;
}

/** Calls that say nothing about the vendor's health: the request, the caller, or Atlas. */
const NOT_A_HEALTH_SIGNAL = new Set([
  "UPSTREAM_REJECTED_REQUEST",
  "CONTEXT_LENGTH_EXCEEDED",
  "OUTPUT_BUDGET_EXHAUSTED",
  "DEADLINE_EXCEEDED",
  "CLIENT_ABORTED",
]);

const DETAIL_MAX = 300;

function detailOf(error: unknown): string | undefined {
  const raw =
    error instanceof ProviderHttpError && error.responseBody
      ? error.responseBody
      : error instanceof Error
        ? error.message
        : undefined;
  if (raw === undefined) return undefined;
  const text = raw.replace(/\s+/gu, " ").trim();
  return text === "" ? undefined : text.slice(0, DETAIL_MAX);
}

/**
 * What a failed call says about the vendor - or undefined when it says nothing.
 * Decided from the ORIGINAL error, not the normalised code: Atlas's own rate
 * gate also answers RATE_LIMITED, and that is not the vendor throttling.
 */
export function classifyFailure(error: unknown, normalisedCode?: string): HealthSignal | undefined {
  if (normalisedCode !== undefined && NOT_A_HEALTH_SIGNAL.has(normalisedCode)) return undefined;
  if (error instanceof ProviderHttpError) {
    if (error.status === 404) return "model_missing";
    switch (upstreamFailureClass(error)) {
      case "account":
        return "account";
      case "rate_limit":
        return "rate_limited";
      case "server":
        return "unavailable";
      default:
        return undefined; // the vendor refused the request's content
    }
  }
  if (error instanceof UpstreamTimeoutError) return "unavailable";
  if (error instanceof UpstreamCallFailure) return undefined; // answered, with nothing usable
  if (error instanceof ModelRuntimeException) return undefined; // Atlas's own refusal
  if (error instanceof Error && error.name === "AbortError") return undefined; // caller or deadline
  if (error instanceof TypeError && /fetch failed/iu.test(error.message)) return "unreachable";
  if (error instanceof Error) return "unavailable";
  return undefined;
}

export class UpstreamHealth {
  private readonly logger = new Logger("UpstreamHealth");
  private readonly models = new Map<string, { provider: string; record: ModelHealthRecord }>();
  /** When each model last produced a result (a call or a probe), epoch ms. In memory only. */
  private readonly lastResult = new Map<string, number>();
  private readonly routes = new Map<string, RouteHealthState>();
  private store: HealthStore | undefined;
  private queue: Promise<void> = Promise.resolve();
  private now: () => number = Date.now;
  /**
   * The routes as configured, cached. A route's state is decided at the
   * moment a model changes, from the states at that moment - deciding it later,
   * in the write queue, reads states that have moved on and can skip a `down`
   * that lasted seconds (found by this file's own test). Refreshed at most
   * once a minute, so an operator's route edit is seen within a minute.
   */
  private routeDefs: RouteDef[] = [];
  private routeDefsAt = Number.NEGATIVE_INFINITY;

  /** Attach the durable store and restore what it holds. Models seen since start are kept. */
  attach(store: HealthStore): Promise<void> {
    this.store = store;
    return this.enqueue(async () => {
      const loaded = await store.load();
      for (const m of loaded.models) {
        if (!this.models.has(m.modelCode)) {
          this.models.set(m.modelCode, { provider: m.providerCode ?? "unknown", record: m.record });
        }
      }
      for (const r of loaded.routes) {
        if (!this.routes.has(r.code)) this.routes.set(r.code, r.state);
      }
      this.routeDefs = await store.listRoutes();
      this.routeDefsAt = this.now();
    });
  }

  recordSuccess(modelCode: string, provider: string): void {
    this.apply(modelCode, provider, "success", {});
  }

  recordFailure(modelCode: string, provider: string, error: unknown, normalisedCode?: string): void {
    const signal = classifyFailure(error, normalisedCode);
    if (signal === undefined) return;
    const detail = detailOf(error);
    this.apply(modelCode, provider, signal, {
      ...(error instanceof ProviderHttpError ? { upstreamStatus: error.status } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  snapshot(): {
    models: { modelCode: string; providerCode: string; state: ModelHealthState; since: Date; upstreamStatus?: number; detail?: string }[];
    routes: { code: string; state: RouteHealthState }[];
  } {
    return {
      models: [...this.models.entries()]
        .map(([modelCode, { provider, record }]) => ({
          modelCode,
          providerCode: provider,
          state: record.state,
          since: new Date(record.since),
          ...(record.upstreamStatus !== undefined && record.state !== "ok"
            ? { upstreamStatus: record.upstreamStatus }
            : {}),
          ...(record.detail !== undefined && record.state !== "ok" ? { detail: record.detail } : {}),
        }))
        .sort((a, b) => a.modelCode.localeCompare(b.modelCode)),
      routes: [...this.routes.entries()]
        .map(([code, state]) => ({ code, state }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    };
  }

  modelState(modelCode: string): ModelHealthState | undefined {
    return this.models.get(modelCode)?.record.state;
  }

  /** When the model last produced a result in this process; undefined = not since start. */
  lastResultAt(modelCode: string): number | undefined {
    return this.lastResult.get(modelCode);
  }

  /** Every model with a recorded state (seen live, or restored). */
  seenModels(): string[] {
    return [...this.models.keys()];
  }

  /**
   * An `ok` model with no result for `silentForMs` becomes `unknown`, quietly -
   * idleness is not news. A failing model is NOT moved: with no successful call
   * there is no reason to believe it recovered.
   */
  markUnknownIfSilent(modelCode: string, silentForMs: number): void {
    const entry = this.models.get(modelCode);
    if (!entry || entry.record.state !== "ok") return;
    const last = this.lastResult.get(modelCode);
    const at = this.now();
    if (last !== undefined && at - last < silentForMs) return;
    if (last === undefined && at - entry.record.since < silentForMs) return;
    const next: ModelHealthRecord = { state: "unknown", since: at, consecutiveFailures: 0 };
    this.models.set(modelCode, { provider: entry.provider, record: next });
    metricsRegistry.incCounter("health_transitions_total", { kind: "model", to: "unknown" });
    if (this.store) {
      const store = this.store;
      this.enqueue(() =>
        store.save({
          subjectKind: "model",
          subjectKey: modelCode,
          providerCode: entry.provider,
          from: "ok",
          to: "unknown",
          since: new Date(at),
          severity: "info",
          affectedRoutes: [],
          event: false,
        }),
      );
    }
  }

  /**
   * Re-read the routes and re-judge every one. A route can change state with
   * no model changing: on 2026-10-03 an operator cleared the fallbacks of
   * `chat/fast` and `chat/extract` while their primary was refused, which made
   * both `down` - and the stored state stayed `degraded`, with no event,
   * because routes were only re-judged when a model moved. Called once a
   * minute by the probe scheduler.
   */
  syncRoutes(): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    return this.enqueue(async () => {
      this.routeDefs = await store.listRoutes();
      this.routeDefsAt = this.now();
      for (const t of this.reevaluateRoutes(this.now())) await store.save(t);
    });
  }

  /** Every transition queued so far has been written. For tests and shutdown. */
  flushed(): Promise<void> {
    return this.queue;
  }

  /** Tests only. */
  resetForTests(now?: () => number): void {
    this.models.clear();
    this.lastResult.clear();
    this.routes.clear();
    this.store = undefined;
    this.queue = Promise.resolve();
    this.now = now ?? Date.now;
    this.routeDefs = [];
    this.routeDefsAt = Number.NEGATIVE_INFINITY;
  }

  private apply(
    modelCode: string,
    provider: string,
    signal: HealthSignal,
    facts: { upstreamStatus?: number; detail?: string },
  ): void {
    const at = this.now();
    this.lastResult.set(modelCode, at);
    const current = this.models.get(modelCode)?.record ?? initialRecord(at);
    const next = nextRecord(current, signal, at, facts);
    this.models.set(modelCode, { provider, record: next });
    if (next.state === current.state) return;

    metricsRegistry.incCounter("health_transitions_total", {
      kind: "model",
      to: next.state,
    });
    // `unknown -> ok` is the first sighting of a healthy model, not news.
    if (current.state === "unknown" && next.state === "ok") {
      if (this.store) this.enqueue(() => this.persistQuietly(modelCode, provider, next));
      return;
    }
    this.refreshRouteDefsIfStale();
    const from = current.state;
    const affectedRoutes = this.routeDefs
      .filter((route) => route.primary === modelCode || route.fallback === modelCode)
      .map((route) => route.code);
    const modelTransition: Transition = {
      subjectKind: "model",
      subjectKey: modelCode,
      providerCode: provider,
      from,
      to: next.state,
      since: new Date(next.since),
      severity: modelSeverity(next.state),
      ...(next.state !== "ok" && next.upstreamStatus !== undefined
        ? { upstreamStatus: next.upstreamStatus }
        : {}),
      ...(next.state !== "ok" && next.detail !== undefined ? { detail: next.detail } : {}),
      affectedRoutes,
      event: true,
    };
    // Decided now, from the states as they are now; only the writes wait.
    const routeTransitions = this.reevaluateRoutes(at);
    this.enqueue(async () => {
      await this.store?.save(modelTransition);
      for (const t of routeTransitions) await this.store?.save(t);
    });
  }

  private refreshRouteDefsIfStale(): void {
    if (!this.store || this.now() - this.routeDefsAt < 60_000) return;
    this.routeDefsAt = this.now();
    const store = this.store;
    this.enqueue(async () => {
      this.routeDefs = await store.listRoutes();
    });
  }

  /** A first sighting is stored as the current state, without an event. */
  private async persistQuietly(modelCode: string, provider: string, record: ModelHealthRecord): Promise<void> {
    await this.store?.save({
      subjectKind: "model",
      subjectKey: modelCode,
      providerCode: provider,
      from: "unknown",
      to: record.state,
      since: new Date(record.since),
      severity: "info",
      affectedRoutes: [],
      event: false,
    });
  }

  /** Route transitions caused by the model states as they are right now. */
  private reevaluateRoutes(at: number): Transition[] {
    const transitions: Transition[] = [];
    for (const route of this.routeDefs) {
      const to = evaluateRoute(route, (code) => this.modelState(code));
      const from = this.routes.get(route.code) ?? "ok";
      this.routes.set(route.code, to);
      if (from === to) continue;
      metricsRegistry.incCounter("health_transitions_total", { kind: "route", to });
      transitions.push({
        subjectKind: "route",
        subjectKey: route.code,
        from,
        to,
        since: new Date(at),
        severity: routeSeverity(to),
        affectedRoutes: [route.code],
        event: true,
      });
    }
    return transitions;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      metricsRegistry.incCounter("health_write_failures_total", {});
      this.logger.warn(
        `health state write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.queue;
  }
}

export const upstreamHealth = new UpstreamHealth();
