import type { ObjectState } from "../object-state";
/** Metadata-only view of a provider key - never carries plaintext or ciphertext. */
export interface ProviderKeyAdminRecord {
  id: string;
  providerCode: string;
  keyAlias: string;
  keyScope: string;
  state: ObjectState;
  lastRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderKeyBody {
  providerCode?: string;
  keyAlias?: string;
  /** Write-only: accepted once here, never echoed back by any read endpoint. */
  plaintextKey?: string;
  keyScope?: string;
}

export interface RotateProviderKeyBody {
  /** Write-only: the new secret value replacing the current one under the same alias. */
  plaintextKey?: string;
  /**
   * Set by `ProviderKeyController` from the verified operator token, never
   * accepted from the client (M-5) - a caller-supplied
   * value here would be exactly the "service sentinel, not operator
   * attribution" gap M-5 exists to close. Optional only because the field is
   * absent for a request that somehow reaches `ProviderKeyService` without
   * having gone through the guard (defensive typing, not an expected path).
   */
  rotatedBy?: string;
  reason?: string;
}
