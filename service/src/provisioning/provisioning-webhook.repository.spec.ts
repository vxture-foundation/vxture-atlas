/**
 * provisioning-webhook.repository.spec.ts - atomic ordering write
 * @package @atlas/service
 * @layer Domain
 * @category test
 *
 * @description
 *   Pins the shape of the transaction, not just its return value: the defect
 *   being guarded against was a check-then-write outside a transaction, so the
 *   assertions verify the seq compare is a conditional `updateMany` predicate
 *   and that the webhook_deliveries insert happens inside the same
 *   transaction callback - a mocked "returns applied" alone would pass with
 *   the race still present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const provisioningUpdateMany = vi.fn();
const provisioningFindFirst = vi.fn();
const provisioningCreate = vi.fn();
const deliveryCreate = vi.fn();
const transaction = vi.fn();

const tx = {
  workspaceProvisioning: {
    updateMany: (...args: unknown[]) => provisioningUpdateMany(...args),
    findFirst: (...args: unknown[]) => provisioningFindFirst(...args),
    create: (...args: unknown[]) => provisioningCreate(...args),
  },
  webhookDelivery: {
    create: (...args: unknown[]) => deliveryCreate(...args),
  },
};

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (fn: (t: unknown) => Promise<unknown>) => transaction(fn),
  },
}));

const { ProvisioningWebhookRepository } = await import(
  "./provisioning-webhook.repository"
);

function makeInput(overrides: Partial<{
  deliveryId: string;
  eventType: string;
  workspaceId: string;
  tenantId: string | null;
  status: "provisioned" | "deprovisioned";
  seq: number;
  occurredAt: Date;
}> = {}) {
  return {
    deliveryId: "delivery-1",
    eventType: "tenant.provisioned",
    workspaceId: "ws-1",
    tenantId: "tenant-1",
    status: "provisioned" as const,
    seq: 5,
    occurredAt: new Date("2026-08-16T00:00:00Z"),
    ...overrides,
  };
}

describe("ProvisioningWebhookRepository.applyProvisioning", () => {
  let repository: InstanceType<typeof ProvisioningWebhookRepository>;

  beforeEach(() => {
    provisioningUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    provisioningFindFirst.mockReset().mockResolvedValue(null);
    provisioningCreate.mockReset().mockResolvedValue({});
    deliveryCreate.mockReset().mockResolvedValue({});
    transaction
      .mockReset()
      .mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
    repository = new ProvisioningWebhookRepository();
  });

  it("applies via a conditional update guarded by seq < newSeq", async () => {
    provisioningUpdateMany.mockResolvedValue({ count: 1 });

    const result = await repository.applyProvisioning(makeInput());

    expect(result).toBe("applied");
    // The predicate IS the ordering decision - no pre-read compare exists to race.
    expect(provisioningUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", productCode: "atlas", seq: { lt: 5n } },
      data: expect.objectContaining({
        status: "provisioned",
        seq: 5n,
        provisionedAt: new Date("2026-08-16T00:00:00Z"),
      }),
    });
    expect(provisioningCreate).not.toHaveBeenCalled();
    // Delivery is recorded inside the same transaction as the state write.
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: {
        deliveryId: "delivery-1",
        workspaceId: "ws-1",
        productCode: "atlas",
        eventType: "tenant.provisioned",
        seq: 5n,
      },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("reports stale when the row exists with seq >= new seq, still recording the delivery", async () => {
    provisioningFindFirst.mockResolvedValue({ seq: 9n, status: "provisioned" });

    const result = await repository.applyProvisioning(makeInput({ seq: 3 }));

    expect(result).toBe("stale");
    expect(provisioningCreate).not.toHaveBeenCalled();
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ deliveryId: "delivery-1", seq: 3n }),
    });
  });

  it("creates the row when no state exists yet", async () => {
    const result = await repository.applyProvisioning(
      makeInput({ status: "deprovisioned" }),
    );

    expect(result).toBe("applied");
    expect(provisioningCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        tenantId: "tenant-1",
        productCode: "atlas",
        status: "deprovisioned",
        seq: 5n,
        deprovisionedAt: new Date("2026-08-16T00:00:00Z"),
      },
    });
    expect(deliveryCreate).toHaveBeenCalledTimes(1);
  });

  it("resolves a concurrent-create P2002 by retrying, letting the winner's seq decide", async () => {
    // First attempt: no row yet, create loses the race (P2002 aborts the tx).
    // Retry: the row now exists with a higher seq -> stale, delivery recorded
    // exactly once (the first attempt's transaction rolled back).
    provisioningCreate.mockRejectedValueOnce({ code: "P2002" });
    provisioningFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ seq: 9n, status: "provisioned" });

    const result = await repository.applyProvisioning(makeInput({ seq: 5 }));

    expect(result).toBe("stale");
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(provisioningCreate).toHaveBeenCalledTimes(1);
    expect(deliveryCreate).toHaveBeenCalledTimes(1);
  });

  it("applies on retry when the concurrently created row carries a lower seq", async () => {
    provisioningCreate.mockRejectedValueOnce({ code: "P2002" });
    provisioningUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await repository.applyProvisioning(makeInput({ seq: 5 }));

    expect(result).toBe("applied");
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-P2002 create failure without recording the delivery", async () => {
    provisioningCreate.mockRejectedValueOnce({ code: "P2010" });

    await expect(repository.applyProvisioning(makeInput())).rejects.toEqual({
      code: "P2010",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deliveryCreate).not.toHaveBeenCalled();
  });
});
