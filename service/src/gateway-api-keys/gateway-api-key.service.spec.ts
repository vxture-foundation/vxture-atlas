import { describe, it, expect, vi } from "vitest";

import { GatewayApiKeyService } from "./gateway-api-key.service";
import { GatewayApiKeyException } from "./gateway-api-key.errors";
import type { GatewayApiKeyRow } from "../prisma";

function makeRow(overrides: Partial<GatewayApiKeyRow> = {}): GatewayApiKeyRow {
  return {
    id: "key-1",
    name: "runos-engine",
    kind: "external",
    owner: "runos",
    keyPrefix: "vxk_ext_xxxxxxxx",
    keyHash: "a".repeat(64),
    status: "active",
    lastUsedAt: null,
    expiresAt: null,
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeService() {
  const repository = {
    findById: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const service = new GatewayApiKeyService(repository as never);
  return { service, repository };
}

describe("GatewayApiKeyService.create", () => {
  it("rejects a missing name", async () => {
    const { service } = makeService();
    await expect(
      service.create({ kind: "internal" }),
    ).rejects.toBeInstanceOf(GatewayApiKeyException);
  });

  it("rejects an invalid kind", async () => {
    const { service } = makeService();
    await expect(
      service.create({ name: "x", kind: "partner" }),
    ).rejects.toBeInstanceOf(GatewayApiKeyException);
  });

  it("rejects the retired internal kind, and says why", async () => {
    // Not a generic "invalid value": someone reaching for `internal` is
    // reaching for a mechanism that exists in a stronger form, and the message
    // has to say so or they will file it as a bug.
    const { service } = makeService();
    await expect(
      service.create({ name: "x", kind: "internal" }),
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining("OIDC"),
        field: "kind",
      },
    });
  });

  it("defaults kind to external - the only kind that can still be issued", async () => {
    const { service, repository } = makeService();
    repository.create.mockImplementation(
      (data: Record<string, unknown>) =>
        Promise.resolve(makeRow(data as Partial<GatewayApiKeyRow>)),
    );

    await service.create({ name: "runos-engine" });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "external" }),
    );
  });

  it("returns the full secret exactly once, and only the prefix/hash are written through", async () => {
    const { service, repository } = makeService();
    repository.create.mockImplementation(
      (data: Record<string, unknown>) =>
        Promise.resolve(makeRow(data as Partial<GatewayApiKeyRow>)),
    );

    const result = await service.create({
      name: "runos-engine",
      kind: "external",
      owner: "runos",
    });

    expect(result.secret.startsWith("vxk_ext_")).toBe(true);
    expect(result).not.toHaveProperty("keyHash");

    const createArgs = repository.create.mock.calls[0]![0] as {
      keyPrefix: string;
      keyHash: string;
    };
    expect(result.secret.startsWith(createArgs.keyPrefix)).toBe(true);
    expect(createArgs.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(createArgs.keyHash);
  });

  it("attributes createdBy from the caller-supplied operator id", async () => {
    const { service, repository } = makeService();
    repository.create.mockImplementation(
      (data: Record<string, unknown>) =>
        Promise.resolve(makeRow(data as Partial<GatewayApiKeyRow>)),
    );

    await service.create({ name: "runos-engine" }, "operator-1");

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: "operator-1" }),
    );
  });
});

describe("GatewayApiKeyService.rotate", () => {
  it("throws not-found for an unknown id", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(null);

    await expect(service.rotate("missing-id")).rejects.toBeInstanceOf(
      GatewayApiKeyException,
    );
  });

  it("rejects rotating a revoked key", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "revoked" }));

    await expect(service.rotate("key-1")).rejects.toBeInstanceOf(
      GatewayApiKeyException,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("issues new key material, reactivates a disabled key, and returns the new secret", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "disabled" }));
    repository.update.mockImplementation(
      (id: string, data: Record<string, unknown>) =>
        Promise.resolve(makeRow({ id, ...data } as Partial<GatewayApiKeyRow>)),
    );

    const result = await service.rotate("key-1", "operator-1");

    expect(result.state).toBe("active");
    expect(result.secret.startsWith("vxk_ext_")).toBe(true);
    expect(repository.update).toHaveBeenCalledWith(
      "key-1",
      expect.objectContaining({ status: "active", updatedBy: "operator-1" }),
    );
  });
});

describe("GatewayApiKeyService.setState", () => {
  it("throws not-found for an unknown id", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(null);

    await expect(
      service.setState("missing-id", "inactive"),
    ).rejects.toBeInstanceOf(GatewayApiKeyException);
  });

  it("toggles active <-> disabled freely", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "active" }));
    repository.update.mockResolvedValue(makeRow({ status: "disabled" }));

    const result = await service.setState("key-1", "inactive");
    expect(result.state).toBe("inactive");
    expect(repository.update).toHaveBeenCalledWith("key-1", {
      status: "disabled",
      updatedBy: null,
    });
  });

  it("revokes an active key", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "active" }));
    repository.update.mockResolvedValue(makeRow({ status: "revoked" }));

    const result = await service.setState("key-1", "revoked", "operator-1");
    expect(result.state).toBe("revoked");
    expect(repository.update).toHaveBeenCalledWith("key-1", {
      status: "revoked",
      updatedBy: "operator-1",
    });
  });

  it("revoked is terminal: rejects activate/deactivate on an already-revoked key", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "revoked" }));

    await expect(
      service.setState("key-1", "active"),
    ).rejects.toBeInstanceOf(GatewayApiKeyException);
    await expect(
      service.setState("key-1", "inactive"),
    ).rejects.toBeInstanceOf(GatewayApiKeyException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("re-revoking an already-revoked key is idempotent, not an error", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "revoked" }));
    repository.update.mockResolvedValue(makeRow({ status: "revoked" }));

    const result = await service.setState("key-1", "revoked");
    expect(result.state).toBe("revoked");
  });
});

describe("GatewayApiKeyService.list", () => {
  it("reports expired as an EFFECTIVE status while stored status stays active", async () => {
    // Nothing writes "expired" - a sweeper flipping rows when a timestamp
    // passes would rewrite history to make a schedule true, and would be a lie
    // for as long as it lagged. The operator set `active`; the clock decides
    // the rest.
    const { service, repository } = makeService();
    repository.list.mockResolvedValue([
      makeRow({ status: "active", expiresAt: new Date("2020-01-01T00:00:00Z") }),
    ]);

    const [row] = await service.list();
    // `state` is what the operator set; `effectiveState` folds in the clock.
    // They disagree exactly here, which is the case worth seeing.
    expect(row).toMatchObject({ state: "active", effectiveState: "expired" });
  });

  it("prefers the operator's own switch over the clock", async () => {
    // A disabled key reads `disabled`, not `expired` - that is the state they
    // chose and can undo, and naming the clock would send them to fix the
    // wrong thing.
    const { service, repository } = makeService();
    repository.list.mockResolvedValue([
      makeRow({ status: "disabled", expiresAt: new Date("2020-01-01T00:00:00Z") }),
    ]);

    expect((await service.list())[0]?.effectiveState).toBe("inactive");
  });

  it("refuses to delete a key that is still active", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "active" }));

    await expect(service.remove("key-1")).rejects.toMatchObject({
      response: { code: "GATEWAY_API_KEY_MUST_DEACTIVATE_FIRST" },
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("deletes a disabled key by stamping deletedAt", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "disabled" }));
    repository.update.mockResolvedValue(makeRow({ status: "disabled" }));

    await service.remove("key-1");
    expect(repository.update).toHaveBeenCalledWith(
      "key-1",
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it("rejects an unparseable expiresAt rather than treating it as no term", async () => {
    const { service } = makeService();
    await expect(
      service.create({ name: "x", expiresAt: "next tuesday" }),
    ).rejects.toMatchObject({ response: { field: "expiresAt" } });
  });

  it("maps rows to metadata-only admin records", async () => {
    const { service, repository } = makeService();
    repository.list.mockResolvedValue([makeRow()]);

    const result = await service.list();

    expect(result).toEqual([
      {
        id: "key-1",
        name: "runos-engine",
        kind: "external",
        owner: "runos",
        keyPrefix: "vxk_ext_xxxxxxxx",
        state: "active",
        effectiveState: "active",
        expiresAt: null,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("a".repeat(64));
  });
});

// product_251 M-B3. The API vocabulary and the stored vocabulary differ by one
// word, and the whole design rests on that difference never leaking either way:
// the column keeps `disabled` so a rollback is safe, the API says `inactive`
// because that is the minimum vocabulary.
describe("the state vocabulary boundary", () => {
  it("reports `inactive` while storing `disabled`", async () => {
    const { service, repository } = makeService();
    repository.findById.mockResolvedValue(makeRow({ status: "active" }));
    repository.update.mockResolvedValue(makeRow({ status: "disabled" }));

    const result = await service.setState("key-1", "inactive");

    // What the caller sees.
    expect(result.state).toBe("inactive");
    // What actually goes to the column - unchanged, which is what makes
    // rollback.yml (image-only, never DDL) safe.
    expect(repository.update).toHaveBeenCalledWith(
      "key-1",
      expect.objectContaining({ status: "disabled" }),
    );
  });

  it("never puts `disabled` on the wire, for any stored value", async () => {
    const { service, repository } = makeService();
    for (const stored of ["active", "disabled", "revoked"] as const) {
      repository.list.mockResolvedValue([makeRow({ status: stored })]);
      const [row] = await service.list();
      expect(row?.state).not.toBe("disabled");
      expect(row?.effectiveState).not.toBe("disabled");
    }
  });

  it("never puts `inactive` in the column, for any API value", async () => {
    const { service, repository } = makeService();
    for (const state of ["active", "inactive", "revoked"] as const) {
      repository.findById.mockResolvedValue(makeRow({ status: "active" }));
      repository.update.mockResolvedValue(makeRow({ status: "active" }));
      await service.setState("key-1", state);
      const [, patch] = repository.update.mock.calls.at(-1) as [
        string,
        { status: string },
      ];
      // The column is CHECK-constrained to active|disabled|revoked; writing
      // `inactive` would be rejected by Postgres, not by anything here.
      expect(["active", "disabled", "revoked"]).toContain(patch.status);
    }
  });
});
