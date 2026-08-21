/**
 * provisioning-webhook.service.ts - C3 provisioning webhook receiver.
 * Authority: docs/30-design/identity/080-rp-integration.md §4 - processing
 * order is a hard requirement (verify -> idempotency -> ordering -> execute),
 * not a style choice: skipping idempotency/ordering causes duplicate
 * initialization or state corruption under the platform's documented
 * at-least-once, possibly-out-of-order delivery behavior.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";

import { verifyWebhookSignature } from "./provisioning-signature";
import { ProvisioningWebhookRepository } from "./provisioning-webhook.repository";
import type { ProvisioningWebhookPayload } from "./provisioning.types";

export type ProvisioningOutcome =
  | "processed"
  | "duplicate_delivery"
  | "stale_or_out_of_order";

@Injectable()
export class ProvisioningWebhookService {
  private readonly logger = new Logger(ProvisioningWebhookService.name);

  constructor(
    @Inject(ProvisioningWebhookRepository)
    private readonly repository: ProvisioningWebhookRepository,
  ) {}

  async handle(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    payload: ProvisioningWebhookPayload,
  ): Promise<ProvisioningOutcome> {
    // 1. Verify - before anything else, over the raw bytes, both secrets.
    const secrets = [
      process.env["PROVISION_WEBHOOK_SECRET"],
      process.env["PROVISION_WEBHOOK_SECRET_NEXT"],
    ];
    if (!verifyWebhookSignature(rawBody, signatureHeader, secrets)) {
      throw new UnauthorizedException("Invalid provisioning webhook signature");
    }

    this.validatePayload(payload);

    // 2. Idempotency - a retried delivery_id is expected under at-least-once
    // delivery and must short-circuit to "already handled", not re-execute.
    const existingDelivery = await this.repository.findDelivery(payload.id);
    if (existingDelivery) {
      this.logger.log(
        `provisioning webhook: duplicate delivery ${payload.id}, skipping`,
      );
      return "duplicate_delivery";
    }

    // 3+4. Ordering + execute - per-workspace seq must be monotonic; a
    // stale/out-of-order delivery is acknowledged (200) but ignored, never
    // applied backwards. The seq compare, the state write, and the delivery
    // record are ONE atomic repository transaction: a pre-read compare here
    // would let two concurrent deliveries both pass and the lower seq win
    // while both delivery ids get recorded, after which the platform's
    // redelivery of the higher seq short-circuits as duplicate forever.
    // Execute is record-only: Atlas has no per-workspace
    // schema to create/tear down (model/grant/quota data is global, not
    // workspace-scoped like an asset-face product's business schema) - this
    // just persists status for Atlas's own future gating logic to consume.
    const status =
      payload.type === "tenant.provisioned" ? "provisioned" : "deprovisioned";
    const result = await this.repository.applyProvisioning({
      deliveryId: payload.id,
      eventType: payload.type,
      workspaceId: payload.workspace_id,
      tenantId: payload.tenant_id ?? null,
      status,
      seq: payload.seq,
      occurredAt: new Date(payload.occurred_at * 1000),
    });

    if (result === "stale") {
      this.logger.log(
        `provisioning webhook: stale seq ${payload.seq} for workspace ${payload.workspace_id}, ignoring`,
      );
      return "stale_or_out_of_order";
    }

    return "processed";
  }

  private validatePayload(payload: ProvisioningWebhookPayload): void {
    if (typeof payload.id !== "string" || !payload.id.trim()) {
      throw new BadRequestException("id is required");
    }

    if (
      payload.type !== "tenant.provisioned" &&
      payload.type !== "tenant.deprovisioned"
    ) {
      throw new BadRequestException(
        'type must be "tenant.provisioned" or "tenant.deprovisioned"',
      );
    }

    if (
      typeof payload.workspace_id !== "string" ||
      !payload.workspace_id.trim()
    ) {
      throw new BadRequestException("workspace_id is required");
    }

    // Integer required, not just finite: the repository converts via
    // BigInt(seq), which throws RangeError on fractions - a correctly signed
    // delivery would otherwise become an unhandled 500 the platform retries
    // forever instead of a 400.
    if (
      typeof payload.seq !== "number" ||
      !Number.isInteger(payload.seq) ||
      payload.seq < 0
    ) {
      throw new BadRequestException("seq must be a non-negative integer");
    }

    if (
      typeof payload.occurred_at !== "number" ||
      !Number.isFinite(payload.occurred_at)
    ) {
      throw new BadRequestException("occurred_at must be an epoch-seconds number");
    }
  }
}
