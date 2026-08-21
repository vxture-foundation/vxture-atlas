import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { ProviderKeyService } from "./provider-key.service";
import { ProviderKeyException } from "./provider-key.errors";
import {
  encryptProviderKey,
  resetProviderKeyEncryptionCacheForTests,
} from "./provider-key-crypto";
import type { ProviderApiKeyRow } from "../prisma";

const savedEnv = process.env;

beforeEach(() => {
  process.env = { ...savedEnv };
  process.env["PROVIDER_KEY_ENCRYPTION_KEYS"] = JSON.stringify({
    v1: randomBytes(32).toString("base64"),
  });
  process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"] = "v1";
  resetProviderKeyEncryptionCacheForTests();
});

afterEach(() => {
  process.env = savedEnv;
  resetProviderKeyEncryptionCacheForTests();
});

function makeRow(overrides: Partial<ProviderApiKeyRow> = {}): ProviderApiKeyRow {
  return {
    id: "key-1",
    providerCode: "doubao",
    keyAlias: "primary",
    encryptedKey: Buffer.from("ciphertext"),
    encryptionKeyId: "v1",
    keyScope: "shared",
    isActive: true,
    lastRotatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeService() {
  const repository = {
    findByCodeAndAlias: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    recordRotation: vi.fn(),
  };
  const service = new ProviderKeyService(repository as never);
  return { service, repository };
}

describe("ProviderKeyService.create", () => {
  it("rejects a missing providerCode", async () => {
    const { service } = makeService();
    await expect(
      service.create({ keyAlias: "primary", plaintextKey: "sk-x" }),
    ).rejects.toBeInstanceOf(ProviderKeyException);
  });

  it("rejects a missing keyAlias", async () => {
    const { service } = makeService();
    await expect(
      service.create({ providerCode: "doubao", plaintextKey: "sk-x" }),
    ).rejects.toBeInstanceOf(ProviderKeyException);
  });

  it("rejects a missing plaintextKey", async () => {
    const { service } = makeService();
    await expect(
      service.create({ providerCode: "doubao", keyAlias: "primary" }),
    ).rejects.toBeInstanceOf(ProviderKeyException);
  });

  it("rejects an invalid keyScope", async () => {
    const { service } = makeService();
    await expect(
      service.create({
        providerCode: "doubao",
        keyAlias: "primary",
        plaintextKey: "sk-x",
        keyScope: "tenant",
      }),
    ).rejects.toBeInstanceOf(ProviderKeyException);
  });

  it("encrypts the plaintext key and never returns it in the admin record", async () => {
    const { service, repository } = makeService();
    repository.create.mockImplementation(
      (data: Record<string, unknown>) =>
        Promise.resolve(makeRow(data as Partial<ProviderApiKeyRow>)),
    );

    const result = await service.create({
      providerCode: "doubao",
      keyAlias: "primary",
      plaintextKey: "sk-live-secret",
    });

    expect(result).not.toHaveProperty("plaintextKey");
    expect(result).not.toHaveProperty("encryptedKey");
    expect(JSON.stringify(result)).not.toContain("sk-live-secret");

    const createArgs = repository.create.mock.calls[0]![0] as {
      encryptedKey: Buffer;
      encryptionKeyId: string;
      keyScope: string;
    };
    expect(createArgs.encryptedKey).toBeInstanceOf(Buffer);
    expect(createArgs.encryptionKeyId).toBe("v1");
    expect(createArgs.keyScope).toBe("shared");
  });

  it("maps a unique-constraint violation to a 409 ProviderKeyException", async () => {
    const { service, repository } = makeService();
    repository.create.mockRejectedValue({ code: "P2002" });

    await expect(
      service.create({
        providerCode: "doubao",
        keyAlias: "primary",
        plaintextKey: "sk-x",
      }),
    ).rejects.toMatchObject({ getStatus: expect.any(Function) });
  });
});

describe("ProviderKeyService.rotate", () => {
  it("throws not-found for an unknown providerKeyId", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(null);

    await expect(
      service.rotate("missing-id", { plaintextKey: "sk-new" }),
    ).rejects.toBeInstanceOf(ProviderKeyException);
  });

  it("requires plaintextKey", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow());

    await expect(service.rotate("key-1", {})).rejects.toBeInstanceOf(
      ProviderKeyException,
    );
  });

  it("re-encrypts under the active key and records a rotation log entry", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow());
    repository.update.mockImplementation(
      (id: string, data: Record<string, unknown>) =>
        Promise.resolve(makeRow({ id, ...data } as Partial<ProviderApiKeyRow>)),
    );

    const result = await service.rotate("key-1", {
      plaintextKey: "sk-rotated",
      rotatedBy: "operator-1",
      reason: "scheduled rotation",
    });

    expect(result.id).toBe("key-1");
    expect(repository.update).toHaveBeenCalledWith(
      "key-1",
      expect.objectContaining({ isActive: true }),
    );
    expect(repository.recordRotation).toHaveBeenCalledWith({
      providerApiKeyId: "key-1",
      rotatedBy: "operator-1",
      reason: "scheduled rotation",
    });
  });
});

describe("ProviderKeyService.setActive", () => {
  it("throws not-found for an unknown providerKeyId", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(null);

    await expect(service.setActive("missing-id", false)).rejects.toBeInstanceOf(
      ProviderKeyException,
    );
  });

  it("deactivates an existing key", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow());
    repository.update.mockResolvedValue(makeRow({ isActive: false }));

    const result = await service.setActive("key-1", false);
    // The API record reports `state`; the repository still writes the boolean
    // column, which is the whole point of deriving at the boundary.
    expect(result.state).toBe("inactive");
    expect(repository.update).toHaveBeenCalledWith("key-1", { isActive: false });
  });
});

describe("ProviderKeyService.resolveKey", () => {
  it("returns null when no key row exists", async () => {
    const { service, repository } = makeService();
    repository.findByCodeAndAlias.mockResolvedValue(null);

    expect(await service.resolveKey("doubao", "primary")).toBeNull();
  });

  it("returns null when the matching key row is inactive", async () => {
    const { service, repository } = makeService();
    repository.findByCodeAndAlias.mockResolvedValue(makeRow({ isActive: false }));

    expect(await service.resolveKey("doubao", "primary")).toBeNull();
  });

  it("decrypts and returns the plaintext for an active key", async () => {
    const { service, repository } = makeService();
    const { encryptedKey, encryptionKeyId } =
      encryptProviderKey("sk-runtime-secret");
    repository.findByCodeAndAlias.mockResolvedValue(
      makeRow({ encryptedKey, encryptionKeyId }),
    );

    expect(await service.resolveKey("doubao", "primary")).toBe(
      "sk-runtime-secret",
    );
  });
});

describe("ProviderKeyService.list", () => {
  it("maps rows to metadata-only admin records", async () => {
    const { service, repository } = makeService();
    repository.list.mockResolvedValue([makeRow()]);

    const result = await service.list("doubao");
    expect(repository.list).toHaveBeenCalledWith("doubao");
    expect(result).toEqual([
      {
        id: "key-1",
        providerCode: "doubao",
        keyAlias: "primary",
        keyScope: "shared",
        state: "active",
        lastRotatedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});
