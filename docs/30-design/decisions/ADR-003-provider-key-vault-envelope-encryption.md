# ADR-003: envelope-encrypted provider-key vault; master key stays in env

**Status**: Accepted
**Date**: 2026-07-26
**Related**: TD-006, TD-007

## Context

Provider API keys could only be resolved through `model.config.apiKeyEnvVar` -
a reference to an environment variable. Adding a provider or rotating a key
therefore meant editing deployment environment variables and redeploying.
Provider governance is meant to be a routine, operator-driven action; forcing a
deployment per key change contradicts that.

The `key` schema (`key.provider_api_keys`, `key.key_rotation_logs`) was
designed for envelope encryption from the start - ciphertext plus a master-key
version reference, never the key itself - but no service code had ever used it.

## Options

**A. Keep the env-var status quo.** This is the problem being solved.

**B. Envelope encryption inside the Atlas process, master key from env.**
AES-256-GCM in `service/src/provider-keys/`. The master key set
(`PROVIDER_KEY_ENCRYPTION_KEYS` / `..._ACTIVE_KEY_ID`) stays env-configured,
but it is a single rarely-rotated **master** key, not one per provider. Adding
or rotating a provider key becomes a DB write through
`/capability/provider-keys*` - no restart, no redeploy. Requests resolve
`config.managedKeyAlias` (`keyReference.source: "managed"`, alongside the
existing `"env"`) across all four capability paths.

**C. Put the master key in an external KMS/Vault immediately.** A repo-wide
search confirmed the organization operates no Vault, KMS or SOPS-style
infrastructure. Documented practice (`150-security.md` §1.3) is GitHub Actions
Secrets for CI/deploy plus chmod-600 plaintext `.env` files at runtime.
Introducing one KMS for one key would be the only such system in the
organization, inconsistent with how every other secret is handled.

## Decision

Option B. Ciphertext storage and master-key custody are decoupled: the stored
shape (`encrypted_key` + `encryption_key_id`) is right now, and the master-key
source can change later without touching the data layer. Option C is rejected,
not deferred - if shared key-management infrastructure ever exists for other
reasons, only the master-key loader changes.

## Consequences

- Adding or rotating a provider key is a DB write, not a deployment.
- Admin responses return metadata only; plaintext is write-only and never
  echoed by any read endpoint.
- Leaking the master-key env is equivalent to being able to decrypt every
  provider key. That risk sits at the same trust level as the organization's
  other secrets - not a new weak point, but not stronger than the status quo.
- The vault has no operator UI, because Atlas has no `portals/` (TD-007).
