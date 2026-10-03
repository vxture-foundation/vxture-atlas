/**
 * health.service.ts - 模型平台健康检查编排
 * @package @atlas/service
 * @layer Domain
 * @category service
 */

import { evaluateRoute } from "../health/route-config";
import { PrismaHealthStore } from "../health/health.store";
import { upstreamHealth } from "../health/upstream-health";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  buildHealthIdentity,
  serviceIdentity,
  type HealthLiveResponse,
  type ServiceIdentity,
} from "@vxture/shared";

import { ProviderKeyRepository } from "../provider-keys/provider-key.repository";
import { metricsRegistry } from "./metrics.registry";
import { ModelRegistryRepository } from "../registry/model-registry.repository";
import type { AiModelRecord, ModelConfig } from "../types/runtime.types";

export type HealthCheckStatus = "pass" | "warn" | "fail";
export type ReadinessStatus = "ready" | "degraded" | "blocked";

/**
 * Per-check deadline for `/readyz`.
 *
 * Readiness is answered under a deadline because the whole point of the
 * endpoint is to answer FAST whether this instance should take traffic. Before
 * this bound it was fastest when everything was fine and slowest exactly when
 * the answer mattered: measured 2026-08-23 against a stopped database,
 * `/readyz` took **19.8s and 23.0s** while each check sat on a connection that
 * would never be acquired.
 *
 * That is not a slow-page problem, it is a signal-loss problem. Any prober with
 * a sane timeout gives up first and records "unreachable / timed out", which is
 * a different diagnosis from "the service answered and told you it is blocked,
 * and here is which dependency failed". The console does exactly this at a 4s
 * probe timeout, so the `blocked` body - carefully computed here, and pinned by
 * tests on the consumer side - was **never once observed in practice**.
 *
 * A timed-out check is a FAILING check, not an unknown one: it resolves to
 * `fail` with a message naming the deadline, so the roll-up still says
 * `blocked` and `checks` still names which dependency went quiet. The caller
 * gets strictly more than a probe timeout would have told it.
 */
const CHECK_DEADLINE_MS = 2_000;

/**
 * Readiness leaves a trace in the server log. Before, a `blocked` existed only
 * in the one HTTP response that reported it: twice on 2026-10-03 a freshly
 * started dev container answered `blocked` on its first /readyz and nothing
 * anywhere recorded which check failed or why.
 */
const readinessLogger = new Logger("Readiness");
/** The full error behind an opaque /readyz message, at most once per message per window. */
const DETAIL_LOG_WINDOW_MS = 5 * 60_000;
const detailLoggedAt = new Map<string, number>();

/**
 * Run a check under the deadline. Never rejects - a check that overruns becomes
 * a `fail` result, because "we could not find out in time" is an answer about
 * readiness, and readiness must not depend on a dependency's willingness to
 * time out politely.
 */
async function withDeadline(
  name: string,
  run: () => Promise<HealthCheckResult>,
): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<HealthCheckResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "fail",
          latencyMs: Date.now() - startedAt,
          message: `check did not answer within ${CHECK_DEADLINE_MS}ms`,
        }),
      CHECK_DEADLINE_MS,
    );
  });

  try {
    return await Promise.race([run(), deadline]);
  } catch (error) {
    /* A check that throws outside its own try/catch still must not take the
       endpoint down - /readyz returning 500 tells a prober nothing about which
       dependency broke. */
    return {
      status: "fail",
      latencyMs: Date.now() - startedAt,
      message: `${name} threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface HealthCheckResult {
  status: HealthCheckStatus;
  latencyMs?: number;
  message?: string;
  [key: string]: unknown;
}

// Liveness + identity per standard 025.
export type AtlasLiveResponse = HealthLiveResponse;

// Readiness = identity block + per-dependency checks (standard 025 §3).
export interface AtlasReadyResponse extends ServiceIdentity {
  status: ReadinessStatus;
  checks: {
    database: HealthCheckResult;
    modelRegistry: HealthCheckResult;
    providerKeys: HealthCheckResult;
    usageSummaryRead: HealthCheckResult;
    reqlogPartitions: HealthCheckResult;
    registryDrift: HealthCheckResult;
    routeHealth: HealthCheckResult;
  };
}

@Injectable()
export class AtlasHealthService {
  constructor(
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
    // The REPOSITORY, not ProviderKeyService: readiness needs to know an alias
    // has an active row behind it, and nothing more. Injecting the service
    // would hand a health check the ability to decrypt.
    @Inject(ProviderKeyRepository)
    private readonly providerKeys: ProviderKeyRepository,
  ) {}

  /** The last overall status, so a change is logged once rather than on every poll. */
  private lastStatus: ReadinessStatus | undefined;

  /**
   * Counts every failing check, and logs the overall status when it CHANGES,
   * naming each failing check with its latency and reason - so a `blocked`
   * that lasted one poll can still be explained afterwards.
   */
  private recordReadiness(status: ReadinessStatus, checks: Record<string, HealthCheckResult>): void {
    const failing = Object.entries(checks).filter(([, c]) => c.status === "fail");
    for (const [name] of failing) metricsRegistry.incCounter("readiness_check_failures_total", { check: name });
    const previous = this.lastStatus;
    this.lastStatus = status;
    if (previous === status) return;
    const reasons = failing
      .map(([name, c]) => `${name} (${c.latencyMs ?? "?"}ms: ${c.message ?? "no message"})`)
      .join("; ");
    const line = `readiness ${previous ?? "start"} -> ${status}${reasons ? `: ${reasons}` : ""}`;
    if (status === "blocked") readinessLogger.warn(line);
    else readinessLogger.log(line);
  }

  live(): AtlasLiveResponse {
    return buildHealthIdentity({
      service: "atlas",
      product: "vxture",
    });
  }

  // GET /readyz is unguarded.
  ready(): Promise<AtlasReadyResponse> {
    return this.collect(false);
  }

  // Behind InternalDiagnosticsGuard.
  diagnostics(): Promise<AtlasReadyResponse> {
    return this.collect(true);
  }

  /**
   * One body, two surfaces. The only difference is the caught-exception text:
   * a Prisma/pg error message carries the internal host, port, user and
   * database name, and must not leave through the unguarded /readyz. Atlas's
   * own static messages and every structured counter are not sensitive and
   * stay on both surfaces - withholding them would cost operators the signal
   * without protecting anything.
   *
   * Status is rolled up from the same check results either way, so the two
   * surfaces can never disagree about whether Atlas is serving.
   */
  private async collect(includeDetail: boolean): Promise<AtlasReadyResponse> {
    const [
      database,
      modelRegistry,
      usageSummaryRead,
      reqlogPartitions,
      registryDrift,
    ] =
      await Promise.all([
        withDeadline("database", () => this.checkDatabase(includeDetail)),
        withDeadline("modelRegistry", () =>
          this.checkModelRegistry(includeDetail),
        ),
        withDeadline("usageSummaryRead", () =>
          this.checkUsageSummaryRead(includeDetail),
        ),
        withDeadline("reqlogPartitions", () =>
          this.checkReqlogPartitions(includeDetail),
        ),
        withDeadline("registryDrift", () =>
          this.checkRegistryDrift(includeDetail),
        ),
      ]);
    const routeHealth = await withDeadline("routeHealth", () =>
      this.checkRouteHealth(includeDetail),
    );
    const providerKeys =
      modelRegistry.status === "fail"
        ? { status: "fail" as const, message: "model registry unavailable" }
        : await withDeadline("providerKeys", () =>
            this.checkProviderKeys(modelRegistry.models as AiModelRecord[]),
          );

    const checks = {
      database,
      modelRegistry,
      providerKeys,
      usageSummaryRead,
      reqlogPartitions,
    };
    const status = resolveReadinessStatus(Object.values(checks));
    this.recordReadiness(status, checks);

    return {
      ...serviceIdentity({ service: "atlas", product: "vxture" }),
      status: resolveReadinessStatus([
        database,
        modelRegistry,
        providerKeys,
        usageSummaryRead,
        reqlogPartitions,
        // registryDrift is deliberately NOT in this list: it reports config
        // drift, not liveness. Atlas is perfectly healthy while an operator
        // has a provider switched off and its models still serving - that is
        // something to see, not a reason to fall out of the load balancer.
        // routeHealth is not in it either, for the same reason: a vendor
        // account refusing Atlas is not Atlas failing to serve.
      ]),
      checks: {
        database,
        modelRegistry: omitPrivateCheckData(modelRegistry),
        providerKeys,
        usageSummaryRead,
        reqlogPartitions,
        registryDrift,
        routeHealth,
      },
    };
  }

  /**
   * ADR-013: routes with no working candidate. Reported, never blocking -
   * like registryDrift. Atlas is serving; the vendors behind a route are not.
   * Opera's health page already polls /readyz, so a `down` route shows there.
   */
  private async checkRouteHealth(includeDetail: boolean): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
      const routes = await new PrismaHealthStore().listRoutes();
      const down = routes
        .filter((r) => evaluateRoute(r, (code) => upstreamHealth.modelState(code)) === "down")
        .map((r) => r.code);
      // A route naming a model that cannot serve it (design 120 section 4.4).
      const misconfigured = routes.filter((r) => (r.configIssues ?? []).length > 0).map((r) => r.code);
      const messages = [
        down.length > 0 ? `${down.length} route(s) have no working candidate: ${down.join(", ")}` : "",
        misconfigured.length > 0
          ? `${misconfigured.length} route(s) name a model that cannot serve them: ${misconfigured.join(", ")}`
          : "",
      ].filter(Boolean);
      return {
        status: down.length > 0 || misconfigured.length > 0 ? "warn" : "pass",
        latencyMs: Date.now() - startedAt,
        routesDown: down,
        routesMisconfigured: misconfigured,
        ...(messages.length > 0 ? { message: messages.join("; ") } : {}),
      };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        message: failureMessage(error, includeDetail),
      };
    }
  }

  private async checkDatabase(
    includeDetail: boolean,
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
      await this.repository.checkDatabaseConnectivity();
      return { status: "pass", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        message: failureMessage(error, includeDetail),
      };
    }
  }

  private async checkModelRegistry(
    includeDetail: boolean,
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
      const models = await this.repository.listActiveModels();
      if (models.length === 0) {
        return {
          status: "fail",
          latencyMs: Date.now() - startedAt,
          activeModels: 0,
          models,
          message: "active model registry is empty",
        };
      }

      return {
        status: "pass",
        latencyMs: Date.now() - startedAt,
        activeModels: models.length,
        models,
      };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        message: failureMessage(error, includeDetail),
      };
    }
  }

  /**
   * Two different things, deliberately reported together.
   *
   * `missing` is liveness: a model names an env var that is not set, so its
   * calls will fail. That fails readiness.
   *
   * `envVarModels` is not liveness at all - those models work fine. It is
   * reported because of what it COSTS: a key resolved from the environment
   * can only be rotated by editing a file on the host and restarting the
   * container. It cannot be rotated from the operator plane, and key rotation
   * is routine.
   *
   * **Rewritten 2026-08-17.** It used to check `apiKeyEnvVar` and nothing else:
   * `checkedKeys` counted env-var references and compared them against
   * `process.env`, while the vault - the actual key store since ADR-003 - was
   * outside its field of view entirely. A production reading of
   * `checkedKeys: 0` therefore meant "no model uses an env var", and was read
   * (by me, in vxture-atlas#240) as "no model has a key". Those are different
   * statements, and the check could not tell them apart.
   *
   * With the env path retired, the old form would have reported `0` forever -
   * a check that cannot fail is decoration. This one asks the question that
   * now matters: does every model that names a vault alias actually have an
   * active key behind it?
   *
   * It does not fail readiness. A model with a dangling alias refuses its own
   * calls with PROVIDER_UNAVAILABLE, which is the caller's answer; dropping
   * the whole service out of the load balancer over one misconfigured model
   * would take down the four that are fine. Same reasoning as `registryDrift`.
   */
  private async checkProviderKeys(
    models: AiModelRecord[],
  ): Promise<HealthCheckResult> {
    const aliases = [
      ...new Set(
        models
          .map((model) => readManagedKeyAlias(model.config))
          .filter((alias): alias is string => Boolean(alias)),
      ),
    ].sort();

    // A model with no alias at all: the runtime refuses its calls outright
    // (the vault is the only source), so it is worth naming here rather than
    // leaving an operator to discover it one 503 at a time.
    const keyless = models
      .filter((model) => !readManagedKeyAlias(model.config))
      .map((model) => model.modelCode)
      .sort();

    const rows = await this.providerKeys.list();
    const active = new Set(
      rows
        // list() already excludes soft-deleted rows.
        .filter((row) => row.isActive)
        .map((row) => row.keyAlias),
    );
    const dangling = aliases.filter((alias) => !active.has(alias));

    const detail = {
      checkedAliases: aliases.length,
      dangling,
      keylessModels: keyless,
    };

    if (dangling.length > 0 || keyless.length > 0) {
      return {
        status: "pass",
        ...detail,
        message:
          [
            dangling.length > 0
              ? `${dangling.length} model alias(es) have no active vault key`
              : "",
            keyless.length > 0
              ? `${keyless.length} model(s) have no key at all and will refuse every call`
              : "",
          ]
            .filter(Boolean)
            .join("; "),
      };
    }

    return { status: "pass", ...detail };
  }

  /**
   * TD-018: reqlog partitions are pre-built a fixed number of months ahead.
   * When they run out, **nothing errors** - rows silently land in the DEFAULT
   * partition and keep working, while drop-based retention quietly stops
   * being possible. That silence is the actual defect, so it gets a readiness
   * signal rather than relying on someone remembering the calendar.
   *
   * Two independent signals:
   *  - `monthsAhead`: how much runway is left. Low = act soon.
   *  - `defaultPartitionRows`: must be 0. Any row here means a write already
   *    landed with no proper partition - retention is broken *now*, not soon.
   */
  /**
   * Config drift, not liveness - so it never blocks readiness. Atlas is
   * perfectly healthy while an operator has a provider switched off and its
   * models still serving; that is a thing to see, not a reason to fail out of
   * the load balancer.
   */
  private async checkRegistryDrift(
    includeDetail: boolean,
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
      const [row] = await this.repository.readRegistryDrift();
      const activeModelsUnderInactiveProvider = Number(
        row?.activeModelsUnderInactiveProvider ?? 0,
      );
      const activeEndpointsWithUnusableModel = Number(
        row?.activeEndpointsWithUnusableModel ?? 0,
      );
      const latencyMs = Date.now() - startedAt;
      const drifted =
        activeModelsUnderInactiveProvider + activeEndpointsWithUnusableModel;

      return {
        status: drifted > 0 ? "warn" : "pass",
        latencyMs,
        activeModelsUnderInactiveProvider,
        activeEndpointsWithUnusableModel,
        ...(drifted > 0
          ? {
              message: `${activeModelsUnderInactiveProvider} active model(s) unusable under a deactivated provider (not routable on /v1 and absent from GET /v1/models), ${activeEndpointsWithUnusableModel} active endpoint(s) cannot resolve their primary model`,
            }
          : {}),
      };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        message: failureMessage(error, includeDetail),
      };
    }
  }

  private async checkReqlogPartitions(
    includeDetail: boolean,
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
      const [row] = await this.repository.readReqlogPartitionRunway();
      const monthsAhead = Number(row?.monthsAhead ?? 0);
      const defaultPartitionRows = Number(row?.defaultPartitionRows ?? 0);
      const latencyMs = Date.now() - startedAt;

      if (defaultPartitionRows > 0) {
        return {
          status: "fail",
          latencyMs,
          monthsAhead,
          defaultPartitionRows,
          message:
            "reqlog rows landed in the DEFAULT partition - explicit partitions were missing, so drop-based retention is already broken; run db-init to extend partitions, then relocate these rows",
        };
      }

      if (monthsAhead < 2) {
        return {
          status: "warn",
          latencyMs,
          monthsAhead,
          defaultPartitionRows,
          message: `only ${monthsAhead} month(s) of reqlog partitions remain - run db-init to extend before they run out`,
        };
      }

      return { status: "pass", latencyMs, monthsAhead, defaultPartitionRows };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        message: failureMessage(error, includeDetail),
      };
    }
  }

  private async checkUsageSummaryRead(
    includeDetail: boolean,
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
      const summaries = await this.repository.listUsageSummaries({});
      return {
        status: "pass",
        latencyMs: Date.now() - startedAt,
        summaries: summaries.length,
      };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        message: failureMessage(error, includeDetail),
      };
    }
  }
}

function resolveReadinessStatus(checks: HealthCheckResult[]): ReadinessStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "blocked";
  }

  if (checks.some((check) => check.status === "warn")) {
    return "degraded";
  }

  return "ready";
}

function readManagedKeyAlias(config: ModelConfig | null): string | null {
  const value = config?.["managedKeyAlias"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function omitPrivateCheckData(check: HealthCheckResult): HealthCheckResult {
  const publicCheck = { ...check };
  delete publicCheck["models"];
  return publicCheck;
}

// Conveys the failure without its cause. A driver error message names the
// host, port, user and database it failed to reach.
const OPAQUE_FAILURE_MESSAGE = "dependency check failed";

function failureMessage(error: unknown, includeDetail: boolean): string {
  if (includeDetail) return errorMessage(error);
  // The unguarded surface hides the text (it names hosts and users); the
  // server log is internal and keeps it, rate-limited so an outage polled
  // every few seconds is one line, not thousands.
  const detail = errorMessage(error);
  const now = Date.now();
  const last = detailLoggedAt.get(detail);
  if (last === undefined || now - last >= DETAIL_LOG_WINDOW_MS) {
    detailLoggedAt.set(detail, now);
    readinessLogger.warn(`readiness check failed: ${detail}`);
  }
  return OPAQUE_FAILURE_MESSAGE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
