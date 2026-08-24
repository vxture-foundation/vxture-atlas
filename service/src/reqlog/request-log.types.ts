import type { ApplicationType } from "../types/runtime.types";
import type { CostUnit } from "./cost-unit";

/**
 * One served request, as Atlas records it. Mirrors `reqlog.request_records`
 * (`deploy/database/ddl/00_baseline.sql`).
 *
 * Every field except `requestId`/`status` is optional on purpose: this is an
 * observability record, and a partially-attributed row is strictly more useful
 * than no row. Anything that cannot be established is written NULL rather than
 * guessed - see `request-log.service.ts` for the UUID coercion rule.
 */
export interface RequestLogEntry {
  requestId: string;
  status: "success" | "error" | "timeout";

  /**
   * The caller's task identity (product_251 X-2), stored verbatim and never
   * coerced. `requestId` identifies ONE call and so relates a call to nothing;
   * `taskId` is what lets a single agent task be totalled across Atlas and
   * runos, which is the only way to answer "what did this task cost, and where
   * did it fail" when it used both a model and a capability.
   *
   * Optional today because karda and vxtpl are live and do not send it yet.
   * X-2 makes it mandatory; that half needs the callers, not Atlas.
   */
  taskId?: string | undefined;

  /**
   * Authoritative tenancy dimensions, derived from the verified S2S token
   * (rule 8). `tenantId` prefers the token's `org_id` claim over anything the
   * caller supplied: it is the rollup level for tenant-scoped views, and a
   * caller-asserted value is both untrustworthy and, in practice, often not a
   * UUID at all - which would coerce to NULL and leave the tenant dimension
   * permanently empty.
   */
  tenantId?: string | undefined;
  workspaceId?: string | undefined;
  userId?: string | undefined;
  applicationId?: string | undefined;
  applicationType?: ApplicationType | undefined;
  agentId?: string | undefined;
  featureId?: string | undefined;

  /** Atlas domain facts. */
  modelCode?: string | undefined;
  providerCode?: string | undefined;
  /**
   * The entry point that routed this call, when one did. NULL means the caller
   * named a `modelCode` or `taskProfile` directly - a real routing mode, not
   * missing data, so the read side must not fold it in with a real endpoint.
   * Rows written before `incr/03_reqlog_endpoint_code.sql` are also NULL and
   * are not backfillable: the endpoint that served them was never recorded.
   */
  /**
   * Which product made the call - `act.sub` on the verified S2S token, so it
   * cannot be caller-asserted. The resolvable form of `productId`, which is a
   * cross-database uuid and stays NULL (incr/05).
   */
  productCode?: string | undefined;
  endpointCode?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  /**
   * TD-047. Subsets of the two above, written only when the upstream reported
   * them - absent stays NULL in the column, because an unmeasured call must not
   * read as a free one. `cachedInputTokens` is billed at 1/30 of the uncached
   * rate on DeepSeek; `reasoningTokens` is billed at the output rate and is the
   * one output cost an operator can switch off.
   */
  cachedInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  latencyMs?: number | undefined;
  usageType?: "normal" | "retry" | "test" | undefined;
  businessId?: string | undefined;

  /**
   * Set only when the C3 consume call actually landed. Absent
   * means "served but not billed" - the reconciliation signal from
   * docs/30-design/210-usage-metering-and-history.md §4.
   */
  billedMetricKey?: string | undefined;
  billedAmount?: number | undefined;
  /**
   * What `billedAmount` counts. Absent when nothing was billed - a unit with
   * no amount says nothing, and writing one would suggest a charge that did
   * not happen.
   */
  costUnit?: CostUnit | undefined;
  /**
   * The platform's usage_events id, echoed back per 210 §4. Today's consume
   * response body does not carry it yet (platform contract addition pending),
   * so this stays absent and correlation falls back to `requestId`, which
   * both sides record; the client already parses the field defensively for
   * the day the platform ships it.
   */
  usageEventId?: string | undefined;
}

/** A failed request's provider/protocol detail (`reqlog.error_records`). */
export interface ErrorLogEntry {
  requestId: string;
  providerCode?: string | undefined;
  modelCode?: string | undefined;
  endpointCode?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Read-side mirror of `RequestLogEntry` - what `GET /capability/logs`
 * (`ModelRegistryRepository.searchRequestLogs`) returns. Every attribution
 * field can be null on the row itself (see `RequestLogEntry`'s own note on
 * partial attribution), so the read shape allows the same.
 */
export interface RequestLogRecord {
  id: string;
  requestId: string;
  /**
   * product_251 X-2. Present on the READ shape as well as the write one: a
   * dimension that can be filtered on but never comes back leaves the caller
   * unable to group the rows it just fetched.
   */
  taskId: string | null;
  status: string | null;
  tenantId: string | null;
  workspaceId: string | null;
  applicationId: string | null;
  applicationType: string | null;
  agentId: string | null;
  modelCode: string | null;
  providerCode: string | null;
  productCode: string | null;
  endpointCode: string | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  totalTokens: bigint | null;
  latencyMs: number | null;
  usageType: string | null;
  costUnit: string | null;
  createdAt: Date;
}

/** Read-side mirror of `ErrorLogEntry` (`reqlog.error_records`). */
export interface ErrorLogRecord {
  id: string;
  requestId: string | null;
  providerCode: string | null;
  modelCode: string | null;
  endpointCode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}
