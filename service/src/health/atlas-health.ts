import { Logger } from "@nestjs/common";

import { metricsRegistry } from "../runtime/metrics.registry";
import type { HealthSeverity } from "./health-state";
import type { Transition } from "./upstream-health";

/**
 * atlas-health.ts - Atlas's own working parts as health subjects
 * (ADR-013, design 120 section 4.6, F3b-A). Vendors and routes are not the
 * only things that fail: usage that never reaches the platform, request
 * records that are not written, and partitions running out are Atlas's own,
 * and until now they lived only in counters nothing reads and in `/readyz`.
 *
 * A singleton like `upstreamHealth`, for the same reason - the call sites
 * (the C3 client, the request log) report into it without a constructor
 * change. Recording is synchronous; a state CHANGE is written through the
 * same store as model and route transitions, so the platform's watcher reads
 * it from the same event feed.
 */

export const ATLAS_COMPONENTS = ["usage_reporting", "request_log", "partitions"] as const;
export type AtlasComponent = (typeof ATLAS_COMPONENTS)[number];

export const ATLAS_COMPONENT_STATES = ["ok", "failing", "at_risk", "unknown"] as const;
export type AtlasComponentState = (typeof ATLAS_COMPONENT_STATES)[number];

/** Usage reporting fails after this many refusals or failures in a row. One success clears it. */
export const USAGE_FAILING_AFTER = 3;
/** The request log is failing while a write failed within this window. */
export const REQUEST_LOG_WINDOW_MS = 10 * 60_000;

/**
 * Severity when a component reaches a state. A request record not written is
 * data lost for good - critical. Usage not reported is money not billed but
 * recoverable from `reqlog` (TD-056 / E5) - a warning, as is a partition
 * runway running short.
 */
export function atlasSeverity(component: AtlasComponent, to: AtlasComponentState): HealthSeverity {
  if (to === "ok" || to === "unknown") return "info";
  if (component === "request_log" && to === "failing") return "critical";
  return "warning";
}

interface Entry {
  state: AtlasComponentState;
  since: number;
  detail?: string;
  consecutiveFailures: number;
  lastFailureAt?: number;
}

export interface AtlasHealthStore {
  save(transition: Transition): Promise<void>;
  loadAtlas(): Promise<{ component: string; state: string; since: Date; detail: string | null }[]>;
}

export class AtlasHealth {
  private readonly logger = new Logger("AtlasHealth");
  private readonly entries = new Map<AtlasComponent, Entry>();
  private store: AtlasHealthStore | undefined;
  private queue: Promise<void> = Promise.resolve();
  private now: () => number = Date.now;

  attach(store: AtlasHealthStore): Promise<void> {
    this.store = store;
    return this.enqueue(async () => {
      const known: ReadonlySet<string> = new Set(ATLAS_COMPONENT_STATES);
      for (const row of await store.loadAtlas()) {
        const component = row.component as AtlasComponent;
        if (!ATLAS_COMPONENTS.includes(component) || !known.has(row.state) || this.entries.has(component)) continue;
        this.entries.set(component, {
          state: row.state as AtlasComponentState,
          since: row.since.getTime(),
          ...(row.detail !== null ? { detail: row.detail } : {}),
          consecutiveFailures: 0,
        });
      }
    });
  }

  /** From the C3 client: what happened to one usage report. `skipped` says nothing about the platform. */
  recordConsume(outcome: "billed" | "rejected" | "failed" | "skipped", reason: string): void {
    if (outcome === "skipped") return;
    const e = this.entry("usage_reporting");
    if (outcome === "billed") {
      e.consecutiveFailures = 0;
      this.move("usage_reporting", "ok", "usage reports are accepted");
      return;
    }
    e.consecutiveFailures += 1;
    if (e.consecutiveFailures >= USAGE_FAILING_AFTER) {
      this.move(
        "usage_reporting",
        "failing",
        `${e.consecutiveFailures} usage reports in a row not accepted by the platform; last: ${outcome} (${reason}) - calls are served, not billed`,
      );
    }
  }

  /** From the request log: a write failed. */
  recordRequestLogFailure(table: string, reason: string): void {
    const e = this.entry("request_log");
    e.lastFailureAt = this.now();
    this.move("request_log", "failing", `writing reqlog.${table} failed (${reason}) - that record is lost`);
  }

  /** Once a minute: the request log recovers after a window with no failure. */
  evaluate(): void {
    const e = this.entries.get("request_log");
    if (e?.state === "failing" && e.lastFailureAt !== undefined && this.now() - e.lastFailureAt >= REQUEST_LOG_WINDOW_MS) {
      this.move("request_log", "ok", `no reqlog write failure for ${REQUEST_LOG_WINDOW_MS / 60_000} minutes`);
    }
  }

  /** From the partition runway read. */
  recordPartitions(monthsAhead: number, defaultPartitionRows: number): void {
    if (defaultPartitionRows > 0) {
      this.move(
        "partitions",
        "failing",
        `${defaultPartitionRows} reqlog row(s) in the DEFAULT partition - drop-based retention is broken; run db-init, then relocate the rows`,
      );
    } else if (monthsAhead < 2) {
      this.move("partitions", "at_risk", `only ${monthsAhead} month(s) of reqlog partitions left - run db-init to extend`);
    } else {
      this.move("partitions", "ok", `${monthsAhead} months of reqlog partitions ahead`);
    }
  }

  snapshot(): { component: AtlasComponent; state: AtlasComponentState; since: Date; detail?: string }[] {
    return ATLAS_COMPONENTS.map((component) => {
      const e = this.entries.get(component);
      return {
        component,
        state: e?.state ?? "unknown",
        since: new Date(e?.since ?? this.startedAt),
        ...(e?.detail !== undefined ? { detail: e.detail } : {}),
      };
    });
  }

  flushed(): Promise<void> {
    return this.queue;
  }

  /** Tests only. */
  resetForTests(now?: () => number): void {
    this.entries.clear();
    this.store = undefined;
    this.queue = Promise.resolve();
    this.now = now ?? Date.now;
    this.startedAt = this.now();
  }

  private startedAt = Date.now();

  private entry(component: AtlasComponent): Entry {
    let e = this.entries.get(component);
    if (!e) {
      e = { state: "unknown", since: this.now(), consecutiveFailures: 0 };
      this.entries.set(component, e);
    }
    return e;
  }

  private move(component: AtlasComponent, to: AtlasComponentState, detail: string): void {
    const e = this.entry(component);
    e.detail = detail;
    if (e.state === to) return;
    const from = e.state;
    e.state = to;
    e.since = this.now();
    metricsRegistry.incCounter("health_transitions_total", { kind: "atlas", to });
    const store = this.store;
    if (!store) return;
    const transition: Transition = {
      subjectKind: "atlas",
      subjectKey: component,
      from,
      to,
      since: new Date(e.since),
      severity: atlasSeverity(component, to),
      detail,
      affectedRoutes: [],
      // The first sighting of a working part is not news.
      event: !(from === "unknown" && to === "ok"),
    };
    void this.enqueue(() => store.save(transition));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      metricsRegistry.incCounter("health_write_failures_total", {});
      this.logger.warn(`atlas health write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.queue;
  }
}

export const atlasHealth = new AtlasHealth();
