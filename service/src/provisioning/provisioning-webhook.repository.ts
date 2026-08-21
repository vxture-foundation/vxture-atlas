import { Injectable } from "@nestjs/common";

import { prisma } from "../prisma";
import type { AtlasPrismaClient } from "../prisma";

const PRODUCT_CODE = "atlas";
const PRISMA_UNIQUE_VIOLATION = "P2002";

/**
 * The workspace_provisionings row was created by a concurrent delivery between
 * this transaction's conditional update and its create. The unique violation
 * aborts the surrounding Postgres transaction, so the ordering decision cannot
 * be finished inside it - the whole transaction must roll back and rerun.
 */
class ConcurrentProvisioningCreate extends Error {}

/** What the atomic write actually did - the service derives its outcome from this. */
export type ProvisioningApplyResult = "applied" | "stale";

@Injectable()
export class ProvisioningWebhookRepository {
  /** Idempotency check - has this delivery_id already been processed? */
  async findDelivery(deliveryId: string): Promise<{ id: string } | null> {
    return prisma.webhookDelivery.findFirst({ where: { deliveryId } });
  }

  /**
   * Ordering decision + state write + delivery record, atomically.
   *
   * The seq compare must not be a separate read: two concurrent deliveries for
   * one workspace can both pass a check-then-write and let the lower seq win
   * the upsert while both delivery ids get recorded - after which the
   * platform's redelivery of the higher seq short-circuits as a duplicate and
   * the correct state is never applied. The update is therefore conditional on
   * `seq < newSeq` inside one transaction with the webhook_deliveries insert,
   * so a crash between the two writes cannot record a delivery whose effect
   * never landed.
   */
  async applyProvisioning(input: {
    deliveryId: string;
    eventType: string;
    workspaceId: string;
    tenantId: string | null;
    status: "provisioned" | "deprovisioned";
    seq: number;
    occurredAt: Date;
  }): Promise<ProvisioningApplyResult> {
    try {
      return await this.applyOnce(input, true);
    } catch (error) {
      if (!(error instanceof ConcurrentProvisioningCreate)) {
        throw error;
      }
      // Loser of the create race: the row exists now, so the conditional
      // update alone decides applied vs stale on the single retry.
      return this.applyOnce(input, false);
    }
  }

  private async applyOnce(
    input: {
      deliveryId: string;
      eventType: string;
      workspaceId: string;
      tenantId: string | null;
      status: "provisioned" | "deprovisioned";
      seq: number;
      occurredAt: Date;
    },
    retryOnCreateRace: boolean,
  ): Promise<ProvisioningApplyResult> {
    const seq = BigInt(input.seq);
    const timestampField =
      input.status === "provisioned" ? "provisionedAt" : "deprovisionedAt";

    return prisma.$transaction(async (tx: AtlasPrismaClient) => {
      // Conditional write: under READ COMMITTED a concurrent updater's commit
      // re-evaluates this predicate on the updated row, so only a genuinely
      // newer seq ever counts as applied.
      const updated = await tx.workspaceProvisioning.updateMany({
        where: {
          workspaceId: input.workspaceId,
          productCode: PRODUCT_CODE,
          seq: { lt: seq },
        },
        data: {
          status: input.status,
          seq,
          [timestampField]: input.occurredAt,
        },
      });

      let applied = updated.count > 0;

      if (!applied) {
        // Zero rows means either no row exists yet (first delivery for this
        // workspace) or the stored seq is already >= this one (stale).
        const existing = await tx.workspaceProvisioning.findFirst({
          where: { workspaceId: input.workspaceId, productCode: PRODUCT_CODE },
        });

        if (!existing) {
          try {
            await tx.workspaceProvisioning.create({
              data: {
                workspaceId: input.workspaceId,
                tenantId: input.tenantId,
                productCode: PRODUCT_CODE,
                status: input.status,
                seq,
                [timestampField]: input.occurredAt,
              },
            });
            applied = true;
          } catch (error) {
            if (
              retryOnCreateRace &&
              (error as { code?: string }).code === PRISMA_UNIQUE_VIOLATION
            ) {
              throw new ConcurrentProvisioningCreate();
            }
            throw error;
          }
        }
      }

      // Same transaction as the state write on purpose: recording the
      // delivery id without its effect would make the platform's redelivery
      // short-circuit as duplicate and the state would never be applied.
      await tx.webhookDelivery.create({
        data: {
          deliveryId: input.deliveryId,
          workspaceId: input.workspaceId,
          productCode: PRODUCT_CODE,
          eventType: input.eventType,
          seq,
        },
      });

      return applied ? "applied" : "stale";
    });
  }
}
