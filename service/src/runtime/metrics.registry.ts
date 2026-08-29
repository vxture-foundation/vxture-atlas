/**
 * metrics.registry.ts - 模型平台 Prometheus 指标注册与采集
 * @package @atlas/service
 * @layer Domain
 * @category metrics
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

type LabelDict = Record<string, string>;
type MetricName =
  | "model_requests_total"
  | "model_request_errors_total"
  | "model_request_in_flight"
  | "model_request_latency_ms"
  | "model_grant_authorizations_total"
  | "model_request_rejections_total"
  | "model_reasoning_tool_exposure_total"
  | "capability_legacy_path_requests_total"
  | "data_plane_legacy_path_requests_total";

type MetricDefinition = {
  type: "counter" | "gauge" | "histogram";
  help: string;
  labelNames: string[];
  buckets?: number[];
};

const METRIC_DEFINITIONS: Record<MetricName, MetricDefinition> = {
  model_requests_total: {
    type: "counter",
    help: "model_requests_total 模型平台运行时请求总数（按操作、状态、provider 聚合）",
    labelNames: ["operation", "status", "provider"],
  },
  /**
   * TRANSITIONAL (incr/06): which authorization axis allowed a call - the new
   * product axis, the legacy tenant axis, or neither. The tenant axis is
   * removed only once this shows nothing still authorizes through it, rather
   * than by assuming the migration finished.
   *
   * Process-local and reset on restart, like every counter here. That is
   * adequate for "is the tenant axis still carrying traffic": a non-zero
   * reading is proof it is, and a zero reading over a long-lived process is
   * the evidence being looked for.
   */
  model_grant_authorizations_total: {
    type: "counter",
    help: "model_grant_authorizations_total 授权轴命中计数（product=新轴 / tenant=旧轴 / denied）",
    labelNames: ["axis"],
  },
  /**
   * Requests refused BEFORE anything is logged.
   *
   * `validateChatRequest` runs ahead of the in-flight gauge and the first
   * reqlog write, so a rejection there leaves no row, no error record and no
   * log line - the request simply never happened as far as every operator
   * view is concerned. That is fine for a caller (they got a 400 naming the
   * problem) and useless for an operator asking "who is still sending this",
   * which is exactly the question a tightened validation creates.
   *
   * Labelled by product so the answer is "vxtpl, 900 times" rather than "some
   * traffic is being rejected".
   */
  /**
   * TD-046's population, because TD-046's FAILURE is unobservable here.
   *
   * A thinking model's reasoning must be echoed back on later turns when
   * `tools` is in play; both adapters drop it; the upstream's 400 therefore
   * lands at the caller and Atlas sees a normal 200. That true sentence was
   * being used as a second one - "so the exposure cannot be surveyed" - and
   * #23 was parked on it. It can be surveyed: Atlas already recorded whether
   * the model reasoned and can see whether the call is multi-round; only
   * "did this request carry tools" was going nowhere.
   *
   * A counter rather than a column, deliberately: the first question is
   * go/no-go, and this answers it without db-init. A column earns its place
   * if this reads non-zero - that is the grain needed to tell a named tenant.
   *
   * `multi_round="no"` is exposure created (the caller now holds a turn it
   * cannot echo); `"yes"` is exposure exercised.
   */
  model_reasoning_tool_exposure_total: {
    type: "counter",
    help: "model_reasoning_tool_exposure_total 带 tools 且模型产出了推理内容的调用数（TD-046 的风险面，不是失败数）",
    labelNames: ["product", "multi_round"],
  },
  model_request_rejections_total: {
    type: "counter",
    help: "model_request_rejections_total 进入日志前被拒的请求数（按错误码与调用产品聚合）",
    labelNames: ["code", "product"],
  },
  /**
   * TRANSITIONAL (#206): which spelling of a renamed operator route was called.
   *
   * Same job as `model_grant_authorizations_total` above, for the same reason:
   * the retired path names are deleted once this shows nobody calls them, not
   * on the sunset date alone. A calendar cannot tell you whether opera actually
   * cut over; this can.
   *
   * `operator` rather than a bare count, because the useful form of the answer
   * is "opera-bff, 40 times an hour" - that names who to talk to.
   */
  capability_legacy_path_requests_total: {
    type: "counter",
    help: "capability_legacy_path_requests_total 运营面已弃用路径名的调用数（按旧路径段与调用运营者聚合）",
    labelNames: ["path", "operator"],
  },
  data_plane_legacy_path_requests_total: {
    type: "counter",
    help: "data_plane_legacy_path_requests_total 数据面已弃用路径名的调用数（按旧路径与调用产品聚合；读到 0 是删除旧名的前提，TD-042）",
    labelNames: ["path", "product"],
  },
  model_request_errors_total: {
    type: "counter",
    help: "model_request_errors_total 模型平台运行时错误总数（按错误码、provider 聚合）",
    labelNames: ["code", "provider"],
  },
  /**
   * `operation` is declared but never supplied. The only caller,
   * `RuntimeService.incrementInflightRequest`, calls `changeGauge` with no
   * labels, and `getLabelsAsObject` fills a missing label with "unknown", so
   * every scrape exposes exactly one series:
   * `model_request_in_flight{operation="unknown"}`. Do not build a
   * chat-vs-stream breakdown on it - `model_requests_total` and
   * `model_request_latency_ms` are the ones that really carry `operation`.
   */
  model_request_in_flight: {
    type: "gauge",
    help: "model_request_in_flight 当前进行中的模型平台运行时请求数",
    labelNames: ["operation"],
  },
  model_request_latency_ms: {
    type: "histogram",
    help: "model_request_latency_ms 模型平台运行时延迟分布（毫秒）",
    labelNames: ["operation", "provider"],
    buckets: [50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000],
  },
};

export class MetricsRegistry {
  // #region field
  private readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();
  private initialized = false;
  /** Last time each provider was observed, for `snapshotProviderTraffic`'s `lastObservedAt`. */
  private readonly lastObservedAt = new Map<string, number>();
  private readonly processStartedAt = new Date();
  // #endregion

  constructor() {
    this.bootstrap();
  }

  incCounter(name: MetricName, labels: LabelDict = {}, value = 1): void {
    const counter = this.getCounter(name);
    counter.inc(this.getLabelsAsObject(name, labels), value);
    this.touchProvider(labels);
  }

  /** See `model_grant_authorizations_total` - transitional migration signal. */
  recordGrantAuthorization(axis: "product" | "tenant" | "denied"): void {
    this.incCounter("model_grant_authorizations_total", { axis });
  }

  changeGauge(name: MetricName, delta: number, labels: LabelDict = {}): void {
    const gauge = this.getGauge(name);
    gauge.inc(this.getLabelsAsObject(name, labels), delta);
  }

  observeHistogram(
    name: MetricName,
    value: number,
    labels: LabelDict = {},
  ): void {
    const histogram = this.getHistogram(name);
    histogram.observe(this.getLabelsAsObject(name, labels), value);
    this.touchProvider(labels);
  }

  async scrape(): Promise<string> {
    return `${(await this.registry.metrics()).trimEnd()}\n`;
  }

  getProcessStartedAt(): string {
    return this.processStartedAt.toISOString();
  }

  async getInFlightRequests(): Promise<number> {
    const metrics = await this.registry.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === "model_request_in_flight");
    return (gauge?.values ?? []).reduce((sum, v) => sum + v.value, 0);
  }

  /**
   * Per-provider traffic derived from the same
   * counters/histogram `/metrics` scrapes - cumulative since process start,
   * not a rolling window. Consumers compute rate-over-time by diffing two
   * snapshots, the same semantics as any Prometheus counter. Only providers
   * that have carried real traffic through `model_runtime_*` (chat/stream)
   * appear here - embed/parse/rerank are not instrumented.
   */
  async snapshotProviderTraffic(): Promise<ProviderTrafficSnapshot[]> {
    const metrics = await this.registry.getMetricsAsJSON();
    const requests = findMetricValues(metrics, "model_requests_total");
    const latency = findMetricValues(metrics, "model_request_latency_ms");

    const byProvider = new Map<string, ProviderTrafficAccumulator>();
    const accumulatorFor = (provider: string): ProviderTrafficAccumulator => {
      let entry = byProvider.get(provider);
      if (!entry) {
        entry = {
          attempts: 0,
          successes: 0,
          errors: 0,
          latencySum: 0,
          latencyCount: 0,
          buckets: new Map(),
        };
        byProvider.set(provider, entry);
      }
      return entry;
    };

    for (const value of requests) {
      const provider = labelString(value.labels["provider"]);
      if (!provider || provider === "unknown") {
        continue;
      }
      const status = labelString(value.labels["status"]);
      const entry = accumulatorFor(provider);
      if (status === "started") {
        entry.attempts += value.value;
      } else if (status === "success") {
        entry.successes += value.value;
      } else if (status !== "circuit_open") {
        entry.errors += value.value;
      }
    }

    for (const value of latency) {
      const provider = labelString(value.labels["provider"]);
      if (!provider || provider === "unknown") {
        continue;
      }
      const entry = accumulatorFor(provider);
      if (value.metricName?.endsWith("_sum")) {
        entry.latencySum += value.value;
      } else if (value.metricName?.endsWith("_count")) {
        entry.latencyCount += value.value;
      } else if (value.metricName?.endsWith("_bucket")) {
        const bound = bucketBound(value.labels["le"]);
        entry.buckets.set(bound, (entry.buckets.get(bound) ?? 0) + value.value);
      }
    }

    return [...byProvider.entries()].map(([provider, entry]) => ({
      provider,
      attempts: entry.attempts,
      successes: entry.successes,
      errors: entry.errors,
      avgLatencyMs:
        entry.latencyCount > 0 ? entry.latencySum / entry.latencyCount : null,
      p50LatencyMs: percentileFromBuckets(entry.buckets, entry.latencyCount, 0.5),
      p95LatencyMs: percentileFromBuckets(
        entry.buckets,
        entry.latencyCount,
        0.95,
      ),
      lastObservedAt: this.lastObservedAt.has(provider)
        ? new Date(this.lastObservedAt.get(provider)!).toISOString()
        : null,
    }));
  }

  private touchProvider(labels: LabelDict): void {
    const provider = labels["provider"]?.trim();
    if (provider) {
      this.lastObservedAt.set(provider, Date.now());
    }
  }

  private bootstrap(): void {
    if (this.initialized) {
      return;
    }

    collectDefaultMetrics({
      register: this.registry,
      labels: { component: "atlas" },
    });

    for (const name of Object.keys(METRIC_DEFINITIONS) as MetricName[]) {
      const definition = METRIC_DEFINITIONS[name];
      switch (definition.type) {
        case "counter": {
          const metric = new Counter({
            name,
            help: definition.help,
            labelNames: definition.labelNames,
            registers: [this.registry],
          });
          this.counters.set(name, metric as Counter<string>);
          break;
        }
        case "gauge": {
          const metric = new Gauge({
            name,
            help: definition.help,
            labelNames: definition.labelNames,
            registers: [this.registry],
          });
          this.gauges.set(name, metric as Gauge<string>);
          break;
        }
        case "histogram": {
          if (!definition.buckets) {
            throw new Error(`Metric ${name} missing required buckets`);
          }
          const metric = new Histogram({
            name,
            help: definition.help,
            buckets: definition.buckets,
            labelNames: definition.labelNames,
            registers: [this.registry],
          });
          this.histograms.set(name, metric as Histogram<string>);
          break;
        }
      }
    }

    this.initialized = true;
  }

  private getCounter(name: MetricName): Counter<string> {
    const metric = this.counters.get(name);
    if (!metric) {
      throw new Error(`Unsupported metric: ${name}`);
    }
    return metric;
  }

  private getGauge(name: MetricName): Gauge<string> {
    const metric = this.gauges.get(name);
    if (!metric) {
      throw new Error(`Unsupported metric: ${name}`);
    }
    return metric;
  }

  private getHistogram(name: MetricName): Histogram<string> {
    const metric = this.histograms.get(name);
    if (!metric) {
      throw new Error(`Unsupported metric: ${name}`);
    }
    return metric;
  }

  private getLabelsAsObject(name: MetricName, labels: LabelDict): LabelDict {
    const definition = METRIC_DEFINITIONS[name];
    const result: LabelDict = {};

    for (const key of definition.labelNames) {
      result[key] = this.normalizeLabelValue(labels[key] ?? "");
    }

    return result;
  }

  private normalizeLabelValue(value: string): string {
    return value.trim() || "unknown";
  }
}

export const metricsRegistry = new MetricsRegistry();

export interface ProviderTrafficSnapshot {
  provider: string;
  attempts: number;
  successes: number;
  errors: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  lastObservedAt: string | null;
}

interface ProviderTrafficAccumulator {
  attempts: number;
  successes: number;
  errors: number;
  latencySum: number;
  latencyCount: number;
  /** bucket upper bound -> cumulative count (Prometheus `le` semantics). */
  buckets: Map<number, number>;
}

/**
 * prom-client's public `.d.ts` types `getMetricsAsJSON()` values without
 * `metricName`, but the histogram collector does attach one per sub-series
 * (`_sum`/`_count`/`_bucket`) - see `lib/histogram.js` `setValuePair`. Typed
 * locally rather than trusting the (imprecise) upstream declaration.
 */
interface PromMetricValue {
  value: number;
  labels: Record<string, string | number | undefined>;
  metricName?: string;
}

function findMetricValues(
  metrics: Awaited<ReturnType<Registry["getMetricsAsJSON"]>>,
  name: string,
): PromMetricValue[] {
  const metric = metrics.find((m) => m.name === name);
  return (metric?.values ?? []) as PromMetricValue[];
}

function labelString(value: string | number | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function bucketBound(le: string | number | undefined): number {
  return le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le);
}

/**
 * Estimates a percentile from cumulative Prometheus histogram buckets: the
 * upper bound of the first bucket whose cumulative count reaches the target
 * rank. This is the standard coarse-bucket approximation - accurate to the
 * nearest configured bucket boundary, not exact. When the target rank only
 * falls in the `+Inf` bucket, the largest finite boundary is returned as a
 * floor estimate ("at least this much") rather than a non-serializable
 * `Infinity`.
 */
function percentileFromBuckets(
  buckets: Map<number, number>,
  totalCount: number,
  percentile: number,
): number | null {
  if (totalCount <= 0 || buckets.size === 0) {
    return null;
  }

  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const target = totalCount * percentile;

  for (const [upperBound, cumulative] of sorted) {
    if (cumulative >= target) {
      if (Number.isFinite(upperBound)) {
        return upperBound;
      }
      const largestFinite = sorted[sorted.length - 2];
      return largestFinite ? largestFinite[0] : null;
    }
  }

  return null;
}
