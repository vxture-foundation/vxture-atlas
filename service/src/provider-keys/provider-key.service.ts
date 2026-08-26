/**
 * provider-key.service.ts - provider-key vault (envelope encryption).
 * Adding or rotating a key is a DB write via this service, not a redeploy.
 * Only the master key set (PROVIDER_KEY_ENCRYPTION_KEYS) is env-configured,
 * and that only changes on the rare master-key-rotation event, not per
 * provider.
 */
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ProviderKeyCache } from "./provider-key-cache";

import {
  decryptProviderKey,
  encryptProviderKey,
} from "./provider-key-crypto";
import { ProviderKeyException } from "./provider-key.errors";
import { ProviderKeyRepository } from "./provider-key.repository";
import type {
  CreateProviderKeyBody,
  ProviderKeyAdminRecord,
  RotateProviderKeyInput,
} from "./provider-key.types";
import type { ProviderApiKeyRow } from "../prisma";
import { toObjectState } from "../object-state";

const VALID_KEY_SCOPES = new Set(["shared", "dedicated"]);
const PRISMA_UNIQUE_VIOLATION = "P2002";

function toAdminRecord(row: ProviderApiKeyRow): ProviderKeyAdminRecord {
  return {
    id: row.id,
    providerCode: row.providerCode,
    keyAlias: row.keyAlias,
    keyScope: row.keyScope,
    state: toObjectState(row.isActive),
    lastRotatedAt: row.lastRotatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}

@Injectable()
export class ProviderKeyService {
  /**
   * Resolved plaintext, cached in process. Invalidated by every mutation
   * BELOW before that mutation returns - see provider-key-cache.ts for why
   * invalidation and not the TTL is what makes this safe.
   */
  private readonly cache = new ProviderKeyCache();

  private readonly logger = new Logger(ProviderKeyService.name);

  constructor(
    @Inject(ProviderKeyRepository)
    private readonly repository: ProviderKeyRepository,
  ) {}

  async list(providerCode?: string): Promise<ProviderKeyAdminRecord[]> {
    const rows = await this.repository.list(providerCode);
    return rows.map(toAdminRecord);
  }

  async create(body: CreateProviderKeyBody): Promise<ProviderKeyAdminRecord> {
    const providerCode = body.providerCode?.trim();
    if (!providerCode) {
      throw new ProviderKeyException(
        HttpStatus.BAD_REQUEST,
        "PROVIDER_KEY_VALIDATION_FAILED",
        "providerCode is required",
        { field: "providerCode" },
      );
    }

    const keyAlias = body.keyAlias?.trim();
    if (!keyAlias) {
      throw new ProviderKeyException(
        HttpStatus.BAD_REQUEST,
        "PROVIDER_KEY_VALIDATION_FAILED",
        "keyAlias is required",
        { field: "keyAlias" },
      );
    }

    if (!body.plaintextKey || !body.plaintextKey.trim()) {
      throw new ProviderKeyException(
        HttpStatus.BAD_REQUEST,
        "PROVIDER_KEY_VALIDATION_FAILED",
        "plaintextKey is required",
        { field: "plaintextKey" },
      );
    }

    const keyScope = body.keyScope?.trim() || "shared";
    if (!VALID_KEY_SCOPES.has(keyScope)) {
      throw new ProviderKeyException(
        HttpStatus.BAD_REQUEST,
        "PROVIDER_KEY_VALIDATION_FAILED",
        'keyScope must be "shared" or "dedicated"',
        { field: "keyScope" },
      );
    }

    const { encryptedKey, encryptionKeyId } = encryptProviderKey(
      body.plaintextKey,
    );

    try {
      const row = await this.repository.create({
        providerCode,
        keyAlias,
        encryptedKey,
        encryptionKeyId,
        keyScope,
      });
      // A create can follow a resolve that missed. Nothing negative is cached,
      // so this is belt-and-braces - but the invariant "no mutation returns
      // with a stale entry alive" is worth holding without exceptions.
      this.cache.invalidate(row.providerCode, row.keyAlias);
      return toAdminRecord(row);
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ProviderKeyException(
          HttpStatus.CONFLICT,
          "PROVIDER_KEY_VALIDATION_FAILED",
          `A key with alias "${keyAlias}" already exists for provider "${providerCode}"`,
          { field: "keyAlias" },
        );
      }
      throw error;
    }
  }

  /** Rotates the secret material in place under the same (providerCode, keyAlias); old ciphertext is overwritten, never retained. */
  async rotate(
    providerKeyId: string,
    body: RotateProviderKeyInput,
  ): Promise<ProviderKeyAdminRecord> {
    const existing = await this.repository.findById(providerKeyId);
    if (!existing) {
      throw new ProviderKeyException(
        HttpStatus.NOT_FOUND,
        "PROVIDER_KEY_NOT_FOUND",
        `Provider key "${providerKeyId}" not found`,
        { providerKeyId },
      );
    }

    if (!body.plaintextKey || !body.plaintextKey.trim()) {
      throw new ProviderKeyException(
        HttpStatus.BAD_REQUEST,
        "PROVIDER_KEY_VALIDATION_FAILED",
        "plaintextKey is required",
        { field: "plaintextKey" },
      );
    }

    const { encryptedKey, encryptionKeyId } = encryptProviderKey(
      body.plaintextKey,
    );

    const row = await this.repository.update(providerKeyId, {
      encryptedKey,
      encryptionKeyId,
      isActive: true,
      lastRotatedAt: new Date(),
    });

    await this.repository.recordRotation({
      providerApiKeyId: providerKeyId,
      ...(body.rotatedBy !== undefined ? { rotatedBy: body.rotatedBy } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });

    // Rotation overwrites the ciphertext in place under the SAME alias, so a
    // cached plaintext is now the old secret. Drop it before returning.
    this.cache.invalidate(row.providerCode, row.keyAlias);

    this.logger.log(
      `provider key rotated: ${row.providerCode}/${row.keyAlias} (${providerKeyId})`,
    );

    return toAdminRecord(row);
  }

  /**
   * Soft delete, and only once the key is deactivated - nothing goes from
   * serving upstream calls to gone in one action.
   *
   * The row and its ciphertext stay; what changes is that it stops being
   * offered. The record of the deletion is in `audit.change_records`, and the
   * key's rotation history in `key_rotation_logs` is untouched.
   */
  async remove(providerKeyId: string): Promise<ProviderKeyAdminRecord> {
    const existing = await this.repository.findById(providerKeyId);
    if (!existing) {
      throw new ProviderKeyException(
        HttpStatus.NOT_FOUND,
        "PROVIDER_KEY_NOT_FOUND",
        `Provider key "${providerKeyId}" not found`,
        { providerKeyId },
      );
    }
    if (existing.isActive) {
      throw new ProviderKeyException(
        HttpStatus.CONFLICT,
        "PROVIDER_KEY_MUST_DEACTIVATE_FIRST",
        `Provider key "${providerKeyId}" is still active - deactivate it before deleting`,
        { providerKeyId },
      );
    }
    const row = await this.repository.update(providerKeyId, {
      deletedAt: new Date(),
    });
    // Drop the cached plaintext BEFORE returning, so a revoked or rotated key
    // cannot answer one more request. The TTL is only a backstop.
    this.cache.invalidate(row.providerCode, row.keyAlias);
    this.logger.log(`provider key deleted: ${row.providerCode}/${row.keyAlias}`);
    return toAdminRecord(row);
  }

  async setActive(
    providerKeyId: string,
    isActive: boolean,
  ): Promise<ProviderKeyAdminRecord> {
    const existing = await this.repository.findById(providerKeyId);
    if (!existing) {
      throw new ProviderKeyException(
        HttpStatus.NOT_FOUND,
        "PROVIDER_KEY_NOT_FOUND",
        `Provider key "${providerKeyId}" not found`,
        { providerKeyId },
      );
    }

    const row = await this.repository.update(providerKeyId, { isActive });
    // Drop the cached plaintext BEFORE returning, so a revoked or rotated key
    // cannot answer one more request. The TTL is only a backstop.
    this.cache.invalidate(row.providerCode, row.keyAlias);
    return toAdminRecord(row);
  }

  /** Runtime resolution path - decrypts in memory only, never logged, never returned over any admin endpoint. */
  async resolveKey(
    providerCode: string,
    keyAlias: string,
  ): Promise<string | null> {
    const cached = this.cache.get(providerCode, keyAlias);
    if (cached !== undefined) return cached;

    const row = await this.repository.findByCodeAndAlias(providerCode, keyAlias);
    // A miss is NOT cached: it means "no active key for this alias", which an
    // operator fixes by creating one, and caching that would make the fix look
    // like it did not work. It is also the cheap case - it never decrypts.
    if (!row || !row.isActive) return null;

    const plaintext = decryptProviderKey(row.encryptedKey, row.encryptionKeyId);
    this.cache.set(providerCode, keyAlias, plaintext);
    return plaintext;
  }

  /** Cache counters for /readyz - counts only, never a key. */
  cacheStats(): { size: number; hits: number; misses: number } {
    return this.cache.stats();
  }
}
