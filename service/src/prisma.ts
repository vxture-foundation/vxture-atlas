import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient as PrismaClientImpl } from "./generated/prisma";
import type {
  AiModelGrantRecord,
  AiModelRecord,
  ModelConfig,
  ModelEndpointRecord,
  ModelPolicyRecord,
  ModelPriceRuleRecord,
  ModelProviderRecord,
} from "./types/runtime.types";

// The service's public record shapes are AiModelRecord / AiModelGrantRecord; the
// Prisma delegate names follow the model schema: modelDefinition / modelGrant.
// The DB rows do not match the public *Record shapes 1:1:
//   - model.models has no `provider` scalar → AiModelRow omits it and carries the
//     joined providerRef; the repository derives AiModelRecord.provider from it.
//
// Atlas's own DB has no metering tables; they live in the platform DB and
// cross-database FK is forbidden (boundary #1).

/** model.models row (no `provider` scalar; provider derived from the joined providerRef). */
export type AiModelRow = Omit<
  AiModelRecord,
  "provider" | "providerConfig" | "providerActive"
> & {
  providerRef?: {
    providerCode: string;
    config: ModelConfig | null;
    isActive: boolean;
  } | null;
};

/** provisioning.workspace_provisionings row (C3 provisioning webhook receiver). */
export interface WorkspaceProvisioningRow {
  id: string;
  workspaceId: string;
  tenantId: string | null;
  productCode: string;
  status: string;
  seq: bigint;
  provisionedAt: Date | null;
  deprovisionedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** provisioning.webhook_deliveries row (append-only idempotency ledger). */
export interface WebhookDeliveryRow {
  id: string;
  deliveryId: string;
  workspaceId: string;
  productCode: string;
  eventType: string;
  seq: bigint;
  receivedAt: Date;
}

/** key.provider_api_keys row - encryptedKey is envelope-encrypted ciphertext, never plaintext. */
export interface ProviderApiKeyRow {
  id: string;
  providerCode: string;
  keyAlias: string;
  encryptedKey: Buffer;
  encryptionKeyId: string;
  keyScope: string;
  isActive: boolean;
  lastRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** key.key_rotation_logs row (append-only audit trail). */
export interface KeyRotationLogRow {
  id: string;
  providerApiKeyId: string;
  rotatedBy: string | null;
  reason: string | null;
  rotatedAt: Date;
}

/** key.gateway_api_keys row - keyHash is one-way (sha256), never decryptable. */
export interface GatewayApiKeyRow {
  id: string;
  name: string;
  kind: string;
  owner: string | null;
  keyPrefix: string;
  keyHash: string;
  status: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * reqlog.request_records row - Atlas's own per-request history, the detail
 * layer of the metering split (docs/30-design/210-usage-metering-and-history.md).
 * Backed by partitioned tables in this repo's own database - Atlas's to
 * write, not the platform's.
 */
export interface RequestRecordRow {
  id: string;
  requestId: string;
  /** product_251 X-2 - see incr/13_reqlog_task_id.sql. */
  taskId: string | null;
  tenantId: string | null;
  workspaceId: string | null;
  productId: string | null;
  userId: string | null;
  applicationId: string | null;
  applicationType: string | null;
  agentId: string | null;
  featureId: string | null;
  downstreamIdentityHash: string | null;
  modelCode: string | null;
  providerCode: string | null;
  endpointCode: string | null;
  productCode: string | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  totalTokens: bigint | null;
  latencyMs: number | null;
  usageType: string | null;
  status: string | null;
  businessId: string | null;
  billedMetricKey: string | null;
  billedAmount: bigint | null;
  /** product_251 X-3 - see incr/14_reqlog_cost_unit.sql. */
  costUnit: string | null;
  usageEventId: string | null;
  createdAt: Date;
}

/** reqlog.error_records row. */
export interface ErrorRecordRow {
  id: string;
  requestId: string | null;
  providerCode: string | null;
  modelCode: string | null;
  endpointCode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

type PrismaArgs = Record<string, unknown>;

/** audit.change_records - the operator change trail (product_250 M-5). */
export interface ChangeRecordRow {
  eventId: string;
  objectType: string;
  objectId: string | null;
  action: string;
  actorId: string;
  actorConsole: string | null;
  changedFields: string[];
  requestId: string | null;
  outcome: string;
  occurredAt: Date;
}

interface PrismaMutationResult {
  count: number;
}

/** model.product_endpoint_grants - product-scoped authorization (incr/06). */
export interface ProductEndpointGrantRecord {
  id: string;
  productCode: string;
  endpointCode: string;
  applicationId: string | null;
  applicationType: string | null;
  isActive: boolean;
  reason: string | null;
  expiresAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface PrismaGroupByRow {
  _count: { _all: number };
  [key: string]: unknown;
}

interface PrismaDelegate<TRecord> {
  findFirst(args: PrismaArgs): Promise<TRecord | null>;
  groupBy(args: PrismaArgs): Promise<PrismaGroupByRow[]>;
  findMany(args?: PrismaArgs): Promise<TRecord[]>;
  create(args: PrismaArgs): Promise<TRecord>;
  update(args: PrismaArgs): Promise<TRecord>;
  updateMany(args: PrismaArgs): Promise<PrismaMutationResult>;
  upsert(args: PrismaArgs): Promise<TRecord>;
}

export interface AtlasPrismaClient {
  modelProvider: PrismaDelegate<ModelProviderRecord>;
  modelDefinition: PrismaDelegate<AiModelRow>;
  modelGrant: PrismaDelegate<AiModelGrantRecord>;
  modelPriceRule: PrismaDelegate<ModelPriceRuleRecord>;
  modelPolicy: PrismaDelegate<ModelPolicyRecord>;
  modelEndpoint: PrismaDelegate<ModelEndpointRecord>;
  productEndpointGrant: PrismaDelegate<ProductEndpointGrantRecord>;
  workspaceProvisioning: PrismaDelegate<WorkspaceProvisioningRow>;
  webhookDelivery: PrismaDelegate<WebhookDeliveryRow>;
  providerApiKey: PrismaDelegate<ProviderApiKeyRow>;
  keyRotationLog: PrismaDelegate<KeyRotationLogRow>;
  gatewayApiKey: PrismaDelegate<GatewayApiKeyRow>;
  requestRecord: PrismaDelegate<RequestRecordRow>;
  errorRecord: PrismaDelegate<ErrorRecordRow>;
  changeRecord: PrismaDelegate<ChangeRecordRow>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  /**
   * Only for fixed, constant catalogue queries with no interpolation - the
   * reqlog partition-runway readiness check (TD-018) reads `pg_inherits`,
   * which has no Prisma model. Never pass caller-derived input here.
   */
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(
    fn: (tx: AtlasPrismaClient) => Promise<T>,
  ): Promise<T>;
}

declare global {
  var __vxtureAtlasPrisma: AtlasPrismaClient | undefined;
}

/**
 * Connections this process may hold open at once.
 *
 * Stated rather than inherited. `pg.Pool` defaults to 10 and the adapter passes
 * the config straight through, so leaving it unset does bound the pool - but
 * bounds it somewhere nothing in this repo says out loud, while the database
 * container's memory ceiling is derived FROM this number
 * (`docker-compose.yml`, db service). An invisible default on one side of a
 * derivation is the same defect shape as a limit written in compose that never
 * reached the kernel: the arithmetic looks sound and nothing holds it up.
 *
 * 10 is the pg default kept deliberately, not a new number: it is what this
 * service has actually been running on. Raising it means re-deriving the db
 * ceiling in the same change.
 */
const DB_POOL_MAX = 10;

// Prisma 7: the connection is a driver adapter, no `url` in the schema.
// A missing DATABASE_URL surfaces at first query (the readiness probe turns
// `blocked`), not at import - keeping module load side-effect-free.
export const prisma: AtlasPrismaClient =
  globalThis.__vxtureAtlasPrisma ??
  (new PrismaClientImpl({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL ?? "",
      max: DB_POOL_MAX,
    }),
  }) as unknown as AtlasPrismaClient);

if (process.env.NODE_ENV !== "production") {
  globalThis.__vxtureAtlasPrisma = prisma;
}
