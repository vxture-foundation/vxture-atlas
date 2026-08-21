/**
 * provisioning.types.ts - C3 provisioning webhook wire contract.
 * Authority: docs/30-design/identity/080-rp-integration.md §4/§5 - already
 * live in production for arda; this is the same contract, Atlas as receiver.
 */

export type ProvisioningEventType = "tenant.provisioned" | "tenant.deprovisioned";

export interface ProvisioningWebhookPayload {
  /** Idempotency key, must equal the X-Vxture-Delivery header. */
  id: string;
  type: ProvisioningEventType;
  /** Epoch seconds. */
  occurred_at: number;
  /** = provisionings.version on the platform side, monotonic per (workspace, product). */
  seq: number;
  workspace_id: string;
  tenant_id?: string | null;
  /** = product.products.product_code - always "atlas" for this receiver. */
  application: string;
  plan?: string | null;
  data?: Record<string, unknown>;
}

export interface ParsedSignatureHeader {
  t: number;
  v1: string;
}
