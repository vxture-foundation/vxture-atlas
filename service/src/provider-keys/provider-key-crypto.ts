/**
 * provider-key-crypto.ts - envelope encryption for key.provider_api_keys.encrypted_key.
 * Authority: deploy/database/ddl/00_baseline.sql schema `key` comment - the column
 * packs nonce||ciphertext||tag for AES-256-GCM; encryption_key_id is a reference to
 * which wrapping (master) key produced it, never the key material itself, so the
 * master key can rotate without touching stored ciphertext until the next rewrite.
 *
 * The master key set lives in env (PROVIDER_KEY_ENCRYPTION_KEYS, PROVIDER_KEY_
 * ENCRYPTION_ACTIVE_KEY_ID) - this is deliberately still an env-configured secret,
 * but it is the *master* key, rotated rarely (ops event), not a per-provider key.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class ProviderKeyEncryptionConfigError extends Error {}
export class ProviderKeyDecryptionError extends Error {}

interface MasterKeySet {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

let cachedKeySet: MasterKeySet | undefined;

function parseMasterKeys(raw: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderKeyEncryptionConfigError(
      "PROVIDER_KEY_ENCRYPTION_KEYS must be a JSON object of {keyId: base64Key}",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderKeyEncryptionConfigError(
      "PROVIDER_KEY_ENCRYPTION_KEYS must be a JSON object of {keyId: base64Key}",
    );
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ProviderKeyEncryptionConfigError(
        `PROVIDER_KEY_ENCRYPTION_KEYS["${keyId}"] must be a base64 string`,
      );
    }
    const buf = Buffer.from(value, "base64");
    if (buf.length !== KEY_LENGTH) {
      throw new ProviderKeyEncryptionConfigError(
        `PROVIDER_KEY_ENCRYPTION_KEYS["${keyId}"] must decode to ${KEY_LENGTH} bytes (AES-256), got ${buf.length}`,
      );
    }
    keys.set(keyId, buf);
  }

  if (keys.size === 0) {
    throw new ProviderKeyEncryptionConfigError(
      "PROVIDER_KEY_ENCRYPTION_KEYS must contain at least one key",
    );
  }

  return keys;
}

/** Reads and validates the master-key set from env once, then caches it for the process lifetime. */
function loadMasterKeySet(): MasterKeySet {
  if (cachedKeySet) return cachedKeySet;

  const rawKeys = process.env["PROVIDER_KEY_ENCRYPTION_KEYS"];
  if (!rawKeys) {
    throw new ProviderKeyEncryptionConfigError(
      "PROVIDER_KEY_ENCRYPTION_KEYS is required to store or read provider keys",
    );
  }

  const keys = parseMasterKeys(rawKeys);

  const activeKeyId = process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"]?.trim();
  if (!activeKeyId) {
    throw new ProviderKeyEncryptionConfigError(
      "PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID is required to select which master key encrypts new/rotated provider keys",
    );
  }
  if (!keys.has(activeKeyId)) {
    throw new ProviderKeyEncryptionConfigError(
      `PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" is not present in PROVIDER_KEY_ENCRYPTION_KEYS`,
    );
  }

  cachedKeySet = { activeKeyId, keys };
  return cachedKeySet;
}

/** Test-only escape hatch - clears the process-lifetime cache so specs can swap env between cases. */
export function resetProviderKeyEncryptionCacheForTests(): void {
  cachedKeySet = undefined;
}

export interface EncryptedProviderKey {
  encryptedKey: Buffer;
  encryptionKeyId: string;
}

/** Encrypts a plaintext provider secret under the currently-active master key. */
export function encryptProviderKey(plaintext: string): EncryptedProviderKey {
  const { activeKeyId, keys } = loadMasterKeySet();
  const masterKey = keys.get(activeKeyId);
  if (!masterKey) {
    throw new ProviderKeyEncryptionConfigError(
      `Active master key "${activeKeyId}" is missing after load`,
    );
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedKey: Buffer.concat([iv, authTag, ciphertext]),
    encryptionKeyId: activeKeyId,
  };
}

/** Decrypts a stored provider secret using the master key referenced by encryptionKeyId. */
export function decryptProviderKey(
  encryptedKey: Buffer,
  encryptionKeyId: string,
): string {
  const { keys } = loadMasterKeySet();
  const masterKey = keys.get(encryptionKeyId);
  if (!masterKey) {
    throw new ProviderKeyDecryptionError(
      `No master key configured for encryption_key_id "${encryptionKeyId}" - it may have been retired before this ciphertext was re-wrapped`,
    );
  }

  if (encryptedKey.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new ProviderKeyDecryptionError("Encrypted key blob is malformed (too short)");
  }

  const iv = encryptedKey.subarray(0, IV_LENGTH);
  const authTag = encryptedKey.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encryptedKey.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new ProviderKeyDecryptionError(
      "Failed to decrypt provider key - ciphertext or auth tag mismatch",
    );
  }
}
