/**
 * gateway-api-key.service.ts - CRUD/lifecycle management for
 * key.gateway_api_keys. Distinct from provider-keys/ (credentials Atlas
 * presents outward to upstream model providers) - this is the reverse
 * direction: credentials Atlas issues to whoever calls the Atlas gateway
 * itself. CRUD-only - nothing here is accepted by any auth path yet.
 */
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { generateGatewayApiKey } from "./gateway-api-key-crypto";
import { GatewayApiKeyException } from "./gateway-api-key.errors";
import { GatewayApiKeyRepository } from "./gateway-api-key.repository";
import type {
  CreateGatewayApiKeyBody,
  GatewayApiKeyAdminRecord,
  GatewayApiKeyEffectiveState,
  GatewayApiKeyKind,
  GatewayApiKeySecretResult,
  GatewayApiKeyState,
  GatewayApiKeyStoredStatus,
} from "./gateway-api-key.types";
import type { GatewayApiKeyRow } from "../prisma";

const VALID_KINDS = new Set<GatewayApiKeyKind>(["external"]);

/**
 * Stored status combined with the clock.
 *
 * Terminal first: a revoked key is revoked whatever its expiry says. Then the
 * operator's own switch - a disabled key reads `disabled` rather than
 * `expired`, because that is the state they chose and can undo, and telling
 * them the clock ran out would send them to fix the wrong thing.
 */
/** An unparseable expiry is refused rather than silently treated as "no term". */
function parseExpiry(raw: string | null | undefined): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new GatewayApiKeyException(
      HttpStatus.BAD_REQUEST,
      "GATEWAY_API_KEY_VALIDATION_FAILED",
      "expiresAt must be an ISO 8601 timestamp",
      { field: "expiresAt" },
    );
  }
  return parsed;
}

/**
 * The stored value -> the API vocabulary.
 *
 * A `switch` with an exhaustiveness check rather than a ternary, and the
 * difference is not style. The first version was
 * `status === "disabled" ? "inactive" : status`, whose comment claimed a
 * fourth stored value could not slip through - it passed any other value
 * through verbatim. The value arrives as `row.status as
 * GatewayApiKeyStoredStatus`, a cast over `string` (`prisma.ts`), so the type
 * is an assertion about the database rather than a fact about the argument.
 *
 * Now: a new member of the stored union without a case here is a compile
 * error, and an unrecognised value at runtime fails CLOSED.
 */
const logger = new Logger("GatewayApiKeyState");

function toState(status: GatewayApiKeyStoredStatus): GatewayApiKeyState {
  switch (status) {
    case "active":
      return "active";
    case "disabled":
      return "inactive";
    case "revoked":
      return "revoked";
    default:
      return assertUnreachableStatus(status);
  }
}

/** The API vocabulary -> the stored value, for writes. Same discipline. */
function toStoredStatus(state: GatewayApiKeyState): GatewayApiKeyStoredStatus {
  switch (state) {
    case "active":
      return "active";
    case "inactive":
      return "disabled";
    case "revoked":
      return "revoked";
    default:
      return assertUnreachableState(state);
  }
}

/**
 * Unreachable while the DB CHECK holds - which is why it must not read as
 * `active`. This is a CREDENTIAL: an unknown state defaulting to "usable" is
 * the one wrong answer that cannot be walked back, so it degrades to
 * `revoked`, the terminal state, and says so loudly first.
 */
function assertUnreachableStatus(status: never): GatewayApiKeyState {
  logger.error(
    `gateway api key carries an unrecognised stored status ${JSON.stringify(status)} - reporting it as revoked rather than active`,
  );
  return "revoked";
}

function assertUnreachableState(state: never): GatewayApiKeyStoredStatus {
  logger.error(
    `unrecognised gateway api key state ${JSON.stringify(state)} - refusing to write it`,
  );
  return "revoked";
}

function effectiveState(
  status: GatewayApiKeyStoredStatus,
  expiresAt: Date | null,
): GatewayApiKeyEffectiveState {
  // Terminal first, then the operator's own switch, then the clock. The
  // previous shape ended in a bare `return "active"`, so an unrecognised
  // status fell past every guard and was reported as usable - failing OPEN on
  // a credential. Deriving from `toState` means it cannot: an unknown value is
  // already `revoked` by the time expiry is considered.
  const state = toState(status);
  if (state === "revoked") return "revoked";
  if (state === "inactive") return "inactive";
  if (expiresAt && expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

function toAdminRecord(row: GatewayApiKeyRow): GatewayApiKeyAdminRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as GatewayApiKeyKind,
    effectiveState: effectiveState(
      row.status as GatewayApiKeyStoredStatus,
      row.expiresAt,
    ),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    owner: row.owner,
    keyPrefix: row.keyPrefix,
    state: toState(row.status as GatewayApiKeyStoredStatus),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class GatewayApiKeyService {
  private readonly logger = new Logger(GatewayApiKeyService.name);

  constructor(
    @Inject(GatewayApiKeyRepository)
    private readonly repository: GatewayApiKeyRepository,
  ) {}

  async list(): Promise<GatewayApiKeyAdminRecord[]> {
    const rows = await this.repository.list();
    return rows.map(toAdminRecord);
  }

  async create(
    body: CreateGatewayApiKeyBody,
    createdBy?: string,
  ): Promise<GatewayApiKeySecretResult> {
    const name = body.name?.trim();
    if (!name) {
      throw new GatewayApiKeyException(
        HttpStatus.BAD_REQUEST,
        "GATEWAY_API_KEY_VALIDATION_FAILED",
        "name is required",
        { field: "name" },
      );
    }

    const kind = (body.kind?.trim() || "external") as GatewayApiKeyKind;
    if (!VALID_KINDS.has(kind)) {
      throw new GatewayApiKeyException(
        HttpStatus.BAD_REQUEST,
        "GATEWAY_API_KEY_VALIDATION_FAILED",
        kind === ("internal" as string)
          ? 'kind "internal" is retired - sibling products authenticate with an OIDC S2S token, which carries a signed product identity instead of a long-lived shared secret'
          : 'kind must be "external"',
        { field: "kind" },
      );
    }

    const owner = body.owner?.trim() || null;
    const expiresAt = parseExpiry(body.expiresAt);
    const generated = generateGatewayApiKey(kind);

    const row = await this.repository.create({
      expiresAt,
      name,
      kind,
      owner,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      createdBy: createdBy ?? null,
    });

    this.logger.log(`gateway api key created: ${row.name} (${row.id})`);

    return { ...toAdminRecord(row), secret: generated.secret };
  }

  /** Rotates the secret material in place; the old hash is overwritten, never retained. */
  async rotate(
    gatewayApiKeyId: string,
    updatedBy?: string,
    expiresAt?: string | null,
  ): Promise<GatewayApiKeySecretResult> {
    const existing = await this.findOrThrow(gatewayApiKeyId);
    this.assertNotRevoked(existing);

    const generated = generateGatewayApiKey(existing.kind as GatewayApiKeyKind);
    const row = await this.repository.update(gatewayApiKeyId, {
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      status: "active",
      // Rotation reissues the credential, so it reissues the term with it.
      // This is the only way to revive an expired key, and deliberately so:
      // extending a term without changing the secret leaves a credential that
      // was exposed for its whole original life still valid.
      ...(expiresAt !== undefined ? { expiresAt: parseExpiry(expiresAt) } : {}),
      updatedBy: updatedBy ?? null,
    });

    this.logger.log(
      `gateway api key rotated: ${row.name} (${gatewayApiKeyId})`,
    );

    return { ...toAdminRecord(row), secret: generated.secret };
  }

  /**
   * active<->disabled is reversible; revoked is a terminal state (issue's
   * own distinction between "can re-enable" and "permanently invalid") -
   * enforced here, not by the DB, since it's an application-level lifecycle
   * rule rather than a structural one.
   */
  async setState(
    gatewayApiKeyId: string,
    state: GatewayApiKeyState,
    updatedBy?: string,
  ): Promise<GatewayApiKeyAdminRecord> {
    const existing = await this.findOrThrow(gatewayApiKeyId);
    if (state !== "revoked") {
      this.assertNotRevoked(existing);
    }

    // Callers speak the API vocabulary; the column keeps its own spelling.
    // Converting here rather than at each of the three routes means the
    // stored word appears in exactly one place.
    const row = await this.repository.update(gatewayApiKeyId, {
      status: toStoredStatus(state),
      updatedBy: updatedBy ?? null,
    });
    return toAdminRecord(row);
  }

  /**
   * Soft delete, and only once the key can no longer authorize anything -
   * `disabled` or `revoked`. Same two-step as every other resource: nothing
   * goes from live to gone in one action.
   */
  async remove(
    gatewayApiKeyId: string,
    updatedBy?: string,
  ): Promise<GatewayApiKeyAdminRecord> {
    const existing = await this.findOrThrow(gatewayApiKeyId);
    if (existing.status === "active") {
      throw new GatewayApiKeyException(
        HttpStatus.CONFLICT,
        "GATEWAY_API_KEY_MUST_DEACTIVATE_FIRST",
        `Gateway API key "${gatewayApiKeyId}" is still active - deactivate or revoke it before deleting`,
        { gatewayApiKeyId },
      );
    }

    const row = await this.repository.update(gatewayApiKeyId, {
      deletedAt: new Date(),
      updatedBy: updatedBy ?? null,
    });
    this.logger.log(`gateway api key deleted: ${row.name} (${gatewayApiKeyId})`);
    return toAdminRecord(row);
  }

  private assertNotRevoked(existing: GatewayApiKeyRow): void {
    if (existing.status === "revoked") {
      throw new GatewayApiKeyException(
        HttpStatus.CONFLICT,
        "GATEWAY_API_KEY_REVOKED",
        `Gateway API key "${existing.id}" is revoked and cannot be changed - issue a new key instead`,
        { gatewayApiKeyId: existing.id },
      );
    }
  }

  private async findOrThrow(
    gatewayApiKeyId: string,
  ): Promise<GatewayApiKeyRow> {
    const existing = await this.repository.findById(gatewayApiKeyId);
    if (!existing) {
      throw new GatewayApiKeyException(
        HttpStatus.NOT_FOUND,
        "GATEWAY_API_KEY_NOT_FOUND",
        `Gateway API key "${gatewayApiKeyId}" not found`,
        { gatewayApiKeyId },
      );
    }
    return existing;
  }
}
