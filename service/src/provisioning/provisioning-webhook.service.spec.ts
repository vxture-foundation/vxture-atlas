import { createHmac } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProvisioningWebhookService } from "./provisioning-webhook.service";
import type { ProvisioningWebhookPayload } from "./provisioning.types";

const SECRET = "test-secret";

function sign(t: number, rawBody: Buffer): string {
  const signedPayload = Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]);
  const hex = createHmac("sha256", SECRET).update(signedPayload).digest("hex");
  return `t=${t},v1=${hex}`;
}

function makePayload(
  overrides: Partial<ProvisioningWebhookPayload> = {},
): ProvisioningWebhookPayload {
  return {
    id: "delivery-1",
    type: "tenant.provisioned",
    occurred_at: 1_700_000_000,
    seq: 1,
    workspace_id: "ws-1",
    tenant_id: "tenant-1",
    application: "atlas",
    ...overrides,
  };
}

function makeService(overrides: {
  findDelivery?: ReturnType<typeof vi.fn>;
  applyProvisioning?: ReturnType<typeof vi.fn>;
}) {
  const repository = {
    findDelivery: overrides.findDelivery ?? vi.fn().mockResolvedValue(null),
    applyProvisioning:
      overrides.applyProvisioning ?? vi.fn().mockResolvedValue("applied"),
  };

  const service = new ProvisioningWebhookService(repository as never);
  return { service, repository };
}

describe("ProvisioningWebhookService.handle", () => {
  beforeEach(() => {
    process.env["PROVISION_WEBHOOK_SECRET"] = SECRET;
  });

  afterEach(() => {
    delete process.env["PROVISION_WEBHOOK_SECRET"];
    delete process.env["PROVISION_WEBHOOK_SECRET_NEXT"];
  });

  it("rejects an invalid signature before touching the repository", async () => {
    const { service, repository } = makeService({});
    const payload = makePayload();
    const rawBody = Buffer.from(JSON.stringify(payload));

    await expect(
      service.handle(rawBody, "t=1700000000,v1=deadbeef", payload),
    ).rejects.toThrow();
    expect(repository.findDelivery).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload after a valid signature", async () => {
    const { service } = makeService({});
    const payload = makePayload({ workspace_id: "" });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    await expect(service.handle(rawBody, sig, payload)).rejects.toThrow();
  });

  it("rejects a non-integer seq as a 400, not an unhandled BigInt throw", async () => {
    // BigInt(4.5) throws RangeError - without the integer gate a correctly
    // signed delivery would 500 and the platform would retry it forever.
    const { service, repository } = makeService({});
    const payload = makePayload({ seq: 4.5 });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    await expect(service.handle(rawBody, sig, payload)).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.findDelivery).not.toHaveBeenCalled();
    expect(repository.applyProvisioning).not.toHaveBeenCalled();
  });

  it("rejects a negative seq as a 400", async () => {
    const { service, repository } = makeService({});
    const payload = makePayload({ seq: -1 });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    await expect(service.handle(rawBody, sig, payload)).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.applyProvisioning).not.toHaveBeenCalled();
  });

  it("short-circuits a duplicate delivery without re-executing", async () => {
    const { service, repository } = makeService({
      findDelivery: vi.fn().mockResolvedValue({ id: "existing" }),
    });
    const payload = makePayload();
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    const outcome = await service.handle(rawBody, sig, payload);

    expect(outcome).toBe("duplicate_delivery");
    expect(repository.applyProvisioning).not.toHaveBeenCalled();
  });

  it("maps a stale atomic write to stale_or_out_of_order", async () => {
    // The ordering decision is the repository transaction's, not a pre-read
    // here - the service only translates what the transaction actually did.
    const { service, repository } = makeService({
      applyProvisioning: vi.fn().mockResolvedValue("stale"),
    });
    const payload = makePayload({ seq: 3 });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    const outcome = await service.handle(rawBody, sig, payload);

    expect(outcome).toBe("stale_or_out_of_order");
    // The delivery record rides inside the same atomic call.
    expect(repository.applyProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: payload.id, seq: 3 }),
    );
  });

  it("processes a fresh tenant.provisioned event", async () => {
    const { service, repository } = makeService({});
    const payload = makePayload({ seq: 1 });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    const outcome = await service.handle(rawBody, sig, payload);

    expect(outcome).toBe("processed");
    expect(repository.applyProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-1",
        eventType: "tenant.provisioned",
        workspaceId: "ws-1",
        status: "provisioned",
        seq: 1,
      }),
    );
  });

  it("processes a fresh tenant.deprovisioned event", async () => {
    const { service, repository } = makeService({});
    const payload = makePayload({ type: "tenant.deprovisioned", seq: 2 });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(Math.floor(Date.now() / 1000), rawBody);

    const outcome = await service.handle(rawBody, sig, payload);

    expect(outcome).toBe("processed");
    expect(repository.applyProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deprovisioned", seq: 2 }),
    );
  });

  it("accepts a signature from the rotation secret when set", async () => {
    process.env["PROVISION_WEBHOOK_SECRET_NEXT"] = "next-secret";
    const { service } = makeService({});
    const payload = makePayload();
    const rawBody = Buffer.from(JSON.stringify(payload));
    const t = Math.floor(Date.now() / 1000);
    const signedPayload = Buffer.concat([
      Buffer.from(`${t}.`, "utf8"),
      rawBody,
    ]);
    const hex = createHmac("sha256", "next-secret")
      .update(signedPayload)
      .digest("hex");
    const sig = `t=${t},v1=${hex}`;

    await expect(service.handle(rawBody, sig, payload)).resolves.toBe(
      "processed",
    );
  });
});
