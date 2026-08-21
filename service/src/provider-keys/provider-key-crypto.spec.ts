import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

import {
  decryptProviderKey,
  encryptProviderKey,
  resetProviderKeyEncryptionCacheForTests,
  ProviderKeyDecryptionError,
  ProviderKeyEncryptionConfigError,
} from "./provider-key-crypto";

const KEY_V1 = randomBytes(32).toString("base64");
const KEY_V2 = randomBytes(32).toString("base64");

const savedEnv = process.env;

beforeEach(() => {
  process.env = { ...savedEnv };
  resetProviderKeyEncryptionCacheForTests();
});

afterEach(() => {
  process.env = savedEnv;
  resetProviderKeyEncryptionCacheForTests();
});

function withKeys(keys: Record<string, string>, activeKeyId: string): void {
  process.env["PROVIDER_KEY_ENCRYPTION_KEYS"] = JSON.stringify(keys);
  process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"] = activeKeyId;
}

describe("provider-key-crypto", () => {
  it("round-trips a plaintext secret through encrypt/decrypt", () => {
    withKeys({ v1: KEY_V1 }, "v1");

    const { encryptedKey, encryptionKeyId } = encryptProviderKey("sk-secret-abc");
    expect(encryptionKeyId).toBe("v1");
    expect(encryptedKey).toBeInstanceOf(Buffer);

    const plaintext = decryptProviderKey(encryptedKey, encryptionKeyId);
    expect(plaintext).toBe("sk-secret-abc");
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    withKeys({ v1: KEY_V1 }, "v1");

    const first = encryptProviderKey("same-secret");
    const second = encryptProviderKey("same-secret");
    expect(first.encryptedKey.equals(second.encryptedKey)).toBe(false);
  });

  it("decrypts ciphertext produced under a retired key id as long as it is still present in the set", () => {
    withKeys({ v1: KEY_V1, v2: KEY_V2 }, "v1");
    const old = encryptProviderKey("secret-under-v1");

    // Simulates a restart after the active key rotates from v1 to v2 - both
    // remain in the set (overlap window), so v1 ciphertext still decrypts.
    resetProviderKeyEncryptionCacheForTests();
    withKeys({ v1: KEY_V1, v2: KEY_V2 }, "v2");
    const fresh = encryptProviderKey("secret-under-v2");

    expect(fresh.encryptionKeyId).toBe("v2");
    expect(decryptProviderKey(old.encryptedKey, old.encryptionKeyId)).toBe(
      "secret-under-v1",
    );
    expect(decryptProviderKey(fresh.encryptedKey, fresh.encryptionKeyId)).toBe(
      "secret-under-v2",
    );
  });

  it("throws when the referenced master key id has been retired from the key set", () => {
    withKeys({ v1: KEY_V1 }, "v1");
    const encrypted = encryptProviderKey("secret");

    // Simulates a restart after v1 is fully retired from the master key set
    // (cache is process-lifetime; a real rotation only takes effect on restart).
    resetProviderKeyEncryptionCacheForTests();
    withKeys({ v2: KEY_V2 }, "v2");
    expect(() =>
      decryptProviderKey(encrypted.encryptedKey, encrypted.encryptionKeyId),
    ).toThrow(ProviderKeyDecryptionError);
  });

  it("throws when ciphertext is tampered with (auth tag mismatch)", () => {
    withKeys({ v1: KEY_V1 }, "v1");
    const { encryptedKey, encryptionKeyId } = encryptProviderKey("secret");
    const tampered = Buffer.from(encryptedKey);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;

    expect(() => decryptProviderKey(tampered, encryptionKeyId)).toThrow(
      ProviderKeyDecryptionError,
    );
  });

  it("throws a config error when PROVIDER_KEY_ENCRYPTION_KEYS is missing", () => {
    delete process.env["PROVIDER_KEY_ENCRYPTION_KEYS"];
    delete process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"];
    expect(() => encryptProviderKey("secret")).toThrow(
      ProviderKeyEncryptionConfigError,
    );
  });

  it("throws a config error when the active key id is not in the key set", () => {
    process.env["PROVIDER_KEY_ENCRYPTION_KEYS"] = JSON.stringify({ v1: KEY_V1 });
    process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"] = "does-not-exist";
    expect(() => encryptProviderKey("secret")).toThrow(
      ProviderKeyEncryptionConfigError,
    );
  });

  it("throws a config error when a key does not decode to 32 bytes", () => {
    process.env["PROVIDER_KEY_ENCRYPTION_KEYS"] = JSON.stringify({
      v1: Buffer.from("too-short").toString("base64"),
    });
    process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"] = "v1";
    expect(() => encryptProviderKey("secret")).toThrow(
      ProviderKeyEncryptionConfigError,
    );
  });

  it("throws a config error when PROVIDER_KEY_ENCRYPTION_KEYS is not valid JSON", () => {
    process.env["PROVIDER_KEY_ENCRYPTION_KEYS"] = "not json";
    process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"] = "v1";
    expect(() => encryptProviderKey("secret")).toThrow(
      ProviderKeyEncryptionConfigError,
    );
  });
});
