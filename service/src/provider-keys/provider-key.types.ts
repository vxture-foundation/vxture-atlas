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

/**
 * What a client is allowed to send to `POST .../rotate`.
 *
 * `rotatedBy` is deliberately ABSENT. It used to live here carrying a comment
 * that said it is "never accepted from the client" - and the comment was the
 * only thing saying so. `@Body()` hands the controller whatever JSON arrived,
 * so a type alone cannot keep a field out at runtime; the controller has to
 * name the fields it forwards. Both halves are needed, and neither is
 * decorative:
 *
 * - this type stops the field being reintroduced by a future edit,
 * - `ProviderKeyController.rotate` copies `plaintextKey`/`reason` by name
 *   rather than spreading, so an extra key on the wire is dropped.
 */
export interface RotateProviderKeyBody {
  /** Write-only: the new secret value replacing the current one under the same alias. */
  plaintextKey?: string;
  reason?: string;
}

/**
 * What `ProviderKeyService.rotate` receives: the client's body plus the
 * operator identity the controller resolved from the verified token.
 *
 * `rotatedBy` is optional because `toOperatorAccountUuid` returns `undefined`
 * when the token `sub` is not an `opr_<uuid>` - and THAT is the case the old
 * shape got wrong. The override was spread after the body, so it won only when
 * it had a value; with no value the caller's own `rotatedBy` survived into
 * `key.key_rotation_logs`, a table with no FK to check it. Attribution absent
 * is a gap; attribution forged is a false record, which is worse (M-5).
 */
export interface RotateProviderKeyInput extends RotateProviderKeyBody {
  rotatedBy?: string;
}
