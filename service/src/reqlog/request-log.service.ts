import { Injectable, Logger } from "@nestjs/common";
import { serviceIdentity } from "@vxture/shared";

import { Prisma } from "../generated/prisma";
import { prisma } from "../prisma";
import { priceOneCall } from "../observability/cost-rollup";
import { metricsRegistry } from "../runtime/metrics.registry";
import { isUuid } from "../uuid";
import type { ErrorLogEntry, RequestLogEntry } from "./request-log.types";

/** The CHECK vocabulary on `reqlog.request_records.usage_type`. */
const USAGE_TYPES: ReadonlySet<string> = new Set(["normal", "retry", "test"]);

/**
 * `reqlog.request_records`'s attribution columns are `uuid` (nullable). A
 * caller's own composite identifier - karda's `tenantId` is the live example -
 * would abort the INSERT with a UUID cast error.
 *
 * The request path turns that into a 400; here it must not: refusing to log
 * because one dimension is malformed would lose the whole record, including
 * the dimensions that were fine. So a non-UUID is written NULL. That is
 * honest - the column cannot hold the value - and the row still carries
 * model/provider/tokens/latency plus whatever else resolved.
 */
function asUuidOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && isUuid(trimmed) ? trimmed : null;
}

function asBigIntOrNull(value: number | undefined): bigint | null {
  return typeof value === "number" && Number.isFinite(value)
    ? BigInt(Math.trunc(value))
    : null;
}

/** Postgres `varchar(n)` rejects overlong input; truncate rather than lose the row. */
function clamp(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Atlas's own per-request history - the detail layer of the metering
 * split described in `docs/30-design/210-usage-metering-and-history.md`.
 *
 * Hard rule: **recording must never fail the request it describes.** An
 * inference call that succeeded must not be turned into an error because the
 * log write failed. Every method swallows its errors into a warning.
 */
/**
 * Usage-record batch 3 (B10): the stage that writes every row, read from the
 * same identity `/healthz` reports - one source, so a row and the health
 * endpoint cannot name different environments. Clamped to the column.
 */
const DEPLOY_STAGE: string | null =
  serviceIdentity({ service: "atlas" }).stage?.slice(0, 16) || null;

/** smallint columns: counts past its range are clamped rather than failing the whole insert. */
function smallCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(32767, Math.max(0, Math.trunc(value)));
}

@Injectable()
export class RequestLogService {
  private readonly logger = new Logger(RequestLogService.name);

  /**
   * Say out loud that a request's tenant attribution is being dropped.
   *
   * Writing NULL is still the right call - see `asUuidOrNull`, the column is
   * `uuid` and losing the whole row over one bad dimension would be worse -
   * but doing it silently is not. The observed failure (#198 §4) was that a
   * caller sent a non-UUID tenantId, every call succeeded, and their traffic
   * was simply absent from every tenant-dimension report. No error, no
   * warning, nothing to notice: it surfaced only much later, wearing a
   * completely different error's face.
   *
   * P3: the deviation itself may be justified, being quiet about it is not.
   * `productCode` rides along so an operator knows whom to tell, and this is
   * per-request on purpose - a caller doing it on every call is exactly the
   * case worth being noisy about, and it stops the moment they fix it.
   */
  private warnOnDroppedTenant(entry: RequestLogEntry): void {
    const raw = entry.tenantId?.trim();
    if (!raw || isUuid(raw)) return;
    this.logger.warn(
      `tenant attribution dropped for requestId=${entry.requestId}: ` +
        `tenantId is not a UUID, so reqlog.tenant_id is written NULL and this ` +
        `request will not appear in any tenant-dimension report` +
        (entry.productCode ? ` (product=${entry.productCode})` : ""),
    );
  }

  async record(entry: RequestLogEntry): Promise<void> {
    this.warnOnDroppedTenant(entry);
    const pricing = await this.priceRow(entry);
    try {
      await prisma.requestRecord.create({
        data: {
          // Usage-record batch 2 (incr/05). Enough on the row to price it
          // alone, without joining back to state that has since changed.
          startedAt: entry.startedAt ?? null,
          firstTokenAt: entry.firstTokenAt ?? null,
          selectorKind: entry.selectorKind ?? null,
          selectorValue: clamp(entry.selectorValue, 128),
          providerKeyAlias: clamp(entry.providerKeyAlias, 128),
          thinkingMode: entry.thinkingMode ?? null,
          maxTokens:
            typeof entry.maxTokens === "number" ? Math.trunc(entry.maxTokens) : null,
          streamed: entry.streamed ?? null,
          cancelledBy: entry.cancelledBy ?? null,
          upstreamCost: pricing?.cost ?? null,
          costCurrency: pricing?.currency ?? null,
          priceRuleId: pricing?.priceRuleId ?? null,
          pricingWindow: pricing?.window ?? null,
          // Usage-record batch 3 (incr/06).
          tokenJti: clamp(entry.tokenJti, 128),
          deployStage: DEPLOY_STAGE,
          modelBehaviorVersion: clamp(entry.modelBehaviorVersion, 64),
          toolCount: smallCount(entry.toolCount),
          toolCallsMade: smallCount(entry.toolCallsMade),
          messageCount: smallCount(entry.messageCount),
          vectorCount:
            typeof entry.vectorCount === "number" ? Math.trunc(entry.vectorCount) : null,
          vectorDimension:
            typeof entry.vectorDimension === "number" ? Math.trunc(entry.vectorDimension) : null,
          requestId: clamp(entry.requestId, 128) ?? entry.requestId,
          status: entry.status,
          // Clamped but NOT coerced (product_251 X-2 requires it verbatim).
          // Deliberately not `asUuidOrNull`: the caller mints this and runos -
          // the other half of the same agent task - does not constrain it to a
          // uuid either. Coercing would silently break exactly the join the
          // column exists to make, which is the failure `tenantId` already had.
          taskId: clamp(entry.taskId, 128),
          // Token-derived (authoritative per S2S rule 8).
          workspaceId: asUuidOrNull(entry.workspaceId),
          userId: asUuidOrNull(entry.userId),
          // Caller-supplied scope, as the grant/quota lookup used it.
          tenantId: asUuidOrNull(entry.tenantId),
          applicationId: asUuidOrNull(entry.applicationId),
          applicationType: clamp(entry.applicationType, 32),
          agentId: asUuidOrNull(entry.agentId),
          featureId: asUuidOrNull(entry.featureId),
          // Atlas domain facts.
          modelCode: clamp(entry.modelCode, 128),
          providerCode: clamp(entry.providerCode, 64),
          // NULL when the caller named a model/taskProfile directly - a real
          // routing mode, not a gap. Also NULL for every row predating
          // incr/03_reqlog_endpoint_code.sql, which is not backfillable.
          endpointCode: clamp(entry.endpointCode, 128),
          productCode: clamp(entry.productCode, 64),
          inputTokens: asBigIntOrNull(entry.inputTokens),
          outputTokens: asBigIntOrNull(entry.outputTokens),
          totalTokens: asBigIntOrNull(entry.totalTokens),
          // TD-047. asBigIntOrNull already maps "absent" to NULL, which is the
          // required behaviour: the upstream reporting no split and the split
          // being zero are different facts, and only the second one is free.
          cachedInputTokens: asBigIntOrNull(entry.cachedInputTokens),
          reasoningTokens: asBigIntOrNull(entry.reasoningTokens),
          // Usage-record batch 1 (incr/04). Same NULL-not-zero rule.
          cacheWriteInputTokens: asBigIntOrNull(entry.cacheWriteInputTokens),
          cacheWrite1hInputTokens: asBigIntOrNull(entry.cacheWrite1hInputTokens),
          // CHECK-constrained, like costUnit below: passed through so the
          // constraint rejects an out-of-vocabulary value instead of clamp()
          // bending it into one it might accept.
          usageSource: entry.usageSource ?? null,
          finishReason: entry.finishReason ?? null,
          upstreamRequestId: clamp(entry.upstreamRequestId, 200),
          upstreamModel: clamp(entry.upstreamModel, 200),
          nativeFinishReason: clamp(entry.nativeFinishReason, 64),
          // Verbatim: every normalized column above is derived from it, and a
          // pricing rule written later can re-derive from it. Prisma's
          // DbNull, not JS null, is what leaves a Json? column NULL.
          upstreamUsage:
            entry.upstreamUsage !== undefined
              ? (entry.upstreamUsage as Prisma.InputJsonValue)
              : Prisma.DbNull,
          latencyMs:
            typeof entry.latencyMs === "number"
              ? Math.trunc(entry.latencyMs)
              : null,
          // TD-037. Zero-based position of this attempt in a failover chain.
          // Absent stays NULL rather than becoming 0: 0 asserts "first of
          // several", and a row from a caller that ran no chain asserts nothing.
          attemptIndex:
            typeof entry.attemptIndex === "number"
              ? Math.trunc(entry.attemptIndex)
              : null,
          usageType: this.asUsageTypeOrNull(entry.usageType, entry.requestId),
          businessId: clamp(entry.businessId, 128),
          billedMetricKey: clamp(entry.billedMetricKey, 64),
          billedAmount: asBigIntOrNull(entry.billedAmount),
          // CHECK-constrained in incr/14. clamp() would silently truncate an
          // out-of-vocabulary value into something the constraint might still
          // accept, so this passes through and lets the constraint reject it.
          costUnit: entry.costUnit ?? null,
          // The platform's usage_events id (210 §4). NULL until the platform
          // adds the field to its consume response - the client parses it
          // defensively, correlation meanwhile is via `requestId`, which both
          // sides record. A NULL `billedAmount` is the reconciliation signal
          // for "served but not billed".
          usageEventId: asUuidOrNull(entry.usageEventId),
          // `productId` stays NULL and always will - a uuid FK-shaped
          // reference into the platform's product.products, in another
          // database. The resolvable form is `product_code` above (incr/05).
        },
      });
    } catch (error) {
      recordWriteFailure("request_records", error);
      this.logger.warn(
        `request log write failed for requestId=${entry.requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Usage-record batch 2 (J1/J2): what the vendor charged for this row, by the
   * price rule in force when the attempt STARTED - the same rule the cost
   * rollup would pick (`effective_at <= t < expires_at`, not deleted, token
   * billing, `is_active` deliberately ignored), priced by the same formula
   * (`priceOneCall` shares `priceUsage` with the rollup).
   *
   * Never throws and never guesses. No token counts, no model, no rule in
   * force, or an unreadable provider policy all leave the columns NULL -
   * "unpriced" - because a 0 would say "this call was free".
   */
  private async priceRow(entry: RequestLogEntry): Promise<
    | { cost: string; currency: string; priceRuleId: string; window: "peak" | "off_peak" }
    | undefined
  > {
    if (!entry.modelCode) return undefined;
    if (typeof entry.inputTokens !== "number" && typeof entry.outputTokens !== "number") {
      return undefined;
    }
    const at = entry.startedAt ?? new Date();
    try {
      const rule = await prisma.modelPriceRule.findFirst({
        where: {
          modelDef: { modelCode: entry.modelCode },
          billingMode: "token",
          deletedAt: null,
          effectiveAt: { lte: at },
          OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
        },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      });
      if (!rule) return undefined;
      const provider = entry.providerCode
        ? await prisma.modelProvider.findFirst({
            where: { providerCode: entry.providerCode },
            select: { config: true },
          })
        : null;
      const providerPricing =
        provider?.config && typeof provider.config === "object"
          ? (provider.config as Record<string, unknown>)["pricing"]
          : undefined;
      const priced = priceOneCall(
        {
          input: entry.inputTokens ?? 0,
          cached: entry.cachedInputTokens,
          cacheWrite: entry.cacheWriteInputTokens,
          cacheWrite1h: entry.cacheWrite1hInputTokens,
          output: entry.outputTokens ?? 0,
        },
        {
          unitTokens: rule.unitTokens,
          inputUnitPrice: rule.inputUnitPrice.toString(),
          outputUnitPrice: rule.outputUnitPrice.toString(),
          requestUnitPrice: rule.requestUnitPrice.toString(),
          // `?.` and not `=== null`: an absent value must read as "not
          // declared" too, never throw and leave the whole row unpriced.
          cachedInputUnitPrice: rule.cachedInputUnitPrice?.toString() ?? null,
          cacheWriteUnitPrice: rule.cacheWriteUnitPrice?.toString() ?? null,
          cacheWrite1hUnitPrice: rule.cacheWrite1hUnitPrice?.toString() ?? null,
        },
        providerPricing,
        at,
      );
      if (!priced) return undefined;
      return { ...priced, currency: rule.currency, priceRuleId: rule.id };
    } catch (error) {
      this.logger.warn(
        `request cost not priced for requestId=${entry.requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /**
   * `usage_type` carries `CHECK (usage_type IN ('normal','retry','test'))`.
   * An out-of-vocabulary value would fail the CHECK and abort the INSERT -
   * losing the whole row after the workspace was already billed, i.e. "billed
   * but never served" as far as reqlog can tell. Same degradation rule as
   * asUuidOrNull: the column cannot hold the value, so it goes NULL and the
   * rest of the record survives.
   */
  private asUsageTypeOrNull(
    value: string | undefined,
    requestId: string,
  ): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (USAGE_TYPES.has(trimmed)) return trimmed;
    this.logger.warn(
      `usage_type "${trimmed}" is outside the reqlog vocabulary (normal|retry|test) for requestId=${requestId} - written NULL`,
    );
    return null;
  }

  async recordError(entry: ErrorLogEntry): Promise<void> {
    try {
      await prisma.errorRecord.create({
        data: {
          requestId: clamp(entry.requestId, 128),
          providerCode: clamp(entry.providerCode, 64),
          modelCode: clamp(entry.modelCode, 128),
          endpointCode: clamp(entry.endpointCode, 128),
          errorCode: clamp(entry.errorCode, 64),
          // error_message is `text` - no length cap, but keep a sane bound so a
          // provider echoing back a huge body cannot bloat the partition.
          errorMessage: clamp(entry.errorMessage, 4000),
        },
      });
    } catch (error) {
      recordWriteFailure("error_records", error);
      this.logger.warn(
        `error log write failed for requestId=${entry.requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * The failure, sorted into a closed vocabulary. The Prisma/Postgres wording is
 * free text; as a label it would mint one series per message. The classes are
 * the ones that have actually happened or that the table's design makes
 * likely: a column the database lacks (a skipped db-init), a CHECK or
 * permission refusal, and the rest.
 */
export function writeFailureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/column .* does not exist/i.test(text)) return "missing_column";
  if (/violates check constraint/i.test(text)) return "check_violation";
  if (/permission denied/i.test(text)) return "permission_denied";
  if (/no partition of relation|no partition .* found/i.test(text)) {
    return "missing_partition";
  }
  if (/connect|ECONNREFUSED|timed? ?out/i.test(text)) return "unreachable";
  return "other";
}

function recordWriteFailure(table: string, error: unknown): void {
  metricsRegistry.incCounter("reqlog_write_failures_total", {
    table,
    reason: writeFailureReason(error),
  });
}
