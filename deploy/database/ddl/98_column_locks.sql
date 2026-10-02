-- Column-level UPDATE whitelist (governance section 7). REVOKE table UPDATE, then
-- GRANT only the writable columns. Anchor columns (id, *_id reference keys,
-- created_at, and identity/provenance columns) are never writable. Append-only
-- tables get no UPDATE at all. Adding a writable column requires updating this
-- whitelist, or the service write fails with permission denied.

-- --- key ---
-- provider_api_keys: rotation updates the ciphertext + key-ref in place; the
-- key's identity (provider_code, key_alias) is immutable - a rename is a new key.
REVOKE UPDATE ON key.provider_api_keys FROM atlas_svc;
GRANT UPDATE (encrypted_key, encryption_key_id, key_scope, is_active, last_rotated_at, updated_at,
              deleted_at)
  ON key.provider_api_keys TO atlas_svc;

-- key_rotation_logs: append-only rotation audit -> no UPDATE.
REVOKE UPDATE ON key.key_rotation_logs FROM atlas_svc;

-- gateway_api_keys (vxture-atlas#144): kind is fixed at issuance - never
-- writable, reclassifying internal<->external is a new key, not an edit.
REVOKE UPDATE ON key.gateway_api_keys FROM atlas_svc;
GRANT UPDATE (name, owner, key_prefix, key_hash, status, last_used_at, updated_by, updated_at,
              expires_at, deleted_at)
  ON key.gateway_api_keys TO atlas_svc;
-- expires_at / deleted_at used to be granted by incr/09 rather than here,
-- because this file runs before incr/ and naming a column only a migration
-- adds aborted the whole apply on an already-provisioned database. ADR-006
-- removes that ordering trap: the baseline creates every column, so every
-- grant can be stated once, in the file whose job is stating grants.

-- --- reqlog ---
-- request_records / error_records: append-only (cleanup is DROP PARTITION, not
-- row DELETE or UPDATE) -> no UPDATE at all.
REVOKE UPDATE ON reqlog.request_records FROM atlas_svc;
REVOKE UPDATE ON reqlog.error_records FROM atlas_svc;

-- --- audit ---
-- change_records: append-only in the strictest sense - no UPDATE, and 97 also
-- withholds DELETE. A row, once written, is the record.
REVOKE UPDATE ON audit.change_records FROM atlas_svc;

-- --- health (ADR-013, incr/08) ---
-- subject_states: the identity (subject_kind, subject_key) is never written.
REVOKE UPDATE ON health.subject_states FROM atlas_svc;
GRANT UPDATE (provider_code, state, since, upstream_status, detail, updated_at)
  ON health.subject_states TO atlas_svc;
-- events: append-only.
REVOKE UPDATE ON health.events FROM atlas_svc;
-- probe_settings (incr/09): the subject is never written; the values are.
REVOKE UPDATE ON health.probe_settings FROM atlas_svc;
GRANT UPDATE (probe_interval_minutes, probe_enabled, updated_by, updated_at)
  ON health.probe_settings TO atlas_svc;
-- balance_min_amount / balance_min_days / balance_poll_minutes: granted in
-- incr/10, which adds them (98 runs before incr/).
-- balance_samples (incr/10): append-only.
REVOKE UPDATE ON health.balance_samples FROM atlas_svc;

-- --- model (authority = docs/design/data_model_200_schema.md section 1, platform repo) ---
-- provider_code / model_code are the visible-code identity - never writable;
-- renaming one is a new provider/model, not an edit.
--
-- description_key, is_customer_visible and is_workforce_visible are absent
-- from BOTH whitelists below - model_providers here and models further down.
-- The columns exist and keep their DDL default; nothing in service/src reads
-- or writes them and none of them is in the Prisma model, so the service
-- cannot write them even by accident. A column-level GRANT states that a
-- column is part of the service's write surface, so granting UPDATE on one no
-- code can write has the database asserting a capability that does not exist,
-- and it is read downstream as a feature awaiting a UI (vxture-atlas#193).
-- The columns are kept - dropping a column on a live table is a destructive
-- migration for a cosmetic gain - and incr/12 narrows the same two grants on
-- an already-provisioned database. Wiring any of them is one change: the
-- write path, the Prisma model, and the column back into these lists.
REVOKE UPDATE ON model.model_providers FROM atlas_svc;
GRANT UPDATE (provider_name, description, logo_url, homepage_url,
              console_url, billing_url, is_active, config,
              updated_by, updated_at, deleted_at)
  ON model.model_providers TO atlas_svc;

-- models: the writable set is a rule, not a list. A column belongs to exactly
-- one of four groups, and the group decides.
--
--   identity        model_code - never writable, AND never reusable. Deleting a
--                   model is a soft delete, and uq_models_model_code is a plain
--                   UNIQUE (not partial), so a deleted code stays taken forever.
--                   That is deliberate: reqlog.request_records / error_records
--                   reference a model by model_code as
--                   plain text with no FK, so re-issuing a retired code would
--                   silently re-attribute months of retained usage history to a
--                   different model.
--   upstream binding provider_id, endpoint_url, protocol, config - writable AS A
--                   SET. They answer one question ("which upstream, reached how")
--                   and repointing a model at a new upstream routinely means
--                   changing several of them at once. Locking any one of them
--                   makes a mis-onboarded model unrepairable - and because the
--                   identity rule above forbids recreating it under the same
--                   code, unrepairable means gone. `protocol` was missing from
--                   this set until 2026-08-06 (TD-025); it was an omission from
--                   before protocol became the dispatch key, not a decision.
--                   Garbage input is kept out at the write path instead, where
--                   the error is legible: the admin API validates protocol
--                   against the closed vocabulary and config.wire against its
--                   schema, and POST /capability/models/:id/probe verifies the
--                   change against the real upstream.
--   presentation    model_name, description, capabilities, context_window,
--                   max_output_tokens, supports_streaming, sort.
--                   description_key and the two *_visible columns are the
--                   exception, and are excluded - see the note above
--                   model_providers, which carries the same three.
--   lifecycle       is_active, deleted_at, updated_by, updated_at.
--
-- model_type is in none of them: it selects which capability contract the model
-- answers (chat / embedding / rerank), so changing it turns the row into a
-- different kind of thing while its grants and price rules stay pointed at it.
REVOKE UPDATE ON model.models FROM atlas_svc;
GRANT UPDATE (provider_id, endpoint_url, protocol, config,
              model_name, description, capabilities,
              context_window, max_output_tokens, supports_streaming, sort,
              is_active, deleted_at, updated_by, updated_at,
              deprecated_at)
  ON model.models TO atlas_svc;

-- product_endpoint_grants: productCode and endpointCode are the grant's
-- IDENTITY - repointing one is a different grant, so revoke it and create the
-- one you want rather than editing this row. Owned by incr/06 before ADR-006.
REVOKE UPDATE ON model.product_endpoint_grants FROM atlas_svc;
GRANT UPDATE (application_id, application_type, is_active, reason, expires_at,
              updated_by, updated_at, deleted_at)
  ON model.product_endpoint_grants TO atlas_svc;

-- model_endpoints (vxture-atlas#143): code is the identity - never writable,
-- same rule as provider_code/model_code (a rename is a new endpoint, not an
-- edit).
REVOKE UPDATE ON model.model_endpoints FROM atlas_svc;
GRANT UPDATE (category, primary_model_code, fallback_model_code, is_active,
              updated_by, updated_at, deleted_at)
  ON model.model_endpoints TO atlas_svc;

-- model_grants: model_id / tenant_id / application_id / application_type are the
-- grant's identity - changing any of them would silently re-point an existing
-- grant at a different model/tenant/application rather than creating a new one.
-- task_profile intentionally NOT in this base whitelist: on an already-existing
-- production table (00_baseline.sql's CREATE TABLE IF NOT EXISTS is a no-op
-- there), granting UPDATE on a column that doesn't exist yet would fail before
-- incr/ ever runs to add it - same hazard as the index in 00_baseline.sql, see
-- that file's comment. Granted instead by
-- deploy/database/ddl/incr/01_model_grants_task_profile.sql, right after its
-- ALTER TABLE ADD COLUMN, which is safe for both a fresh install (runs after
-- CREATE TABLE) and an existing one (runs after the ALTER TABLE).
-- ORDER MATTERS BOTH WAYS: the REVOKE below strips that increment's grant, so
-- re-running this file ALONE silently removes task_profile from the writable
-- set. db-init.yml applies 98 before incr/, which is what keeps it correct -
-- do not "just re-apply the column locks" by hand.
REVOKE UPDATE ON model.model_grants FROM atlas_svc;
GRANT UPDATE (priority, is_active, reason, expires_at, updated_by, updated_at, deleted_at,
              task_profile)
  ON model.model_grants TO atlas_svc;

-- model_price_rules: versioned by append (new row + expires_at on the old one),
-- not in-place value edits - only the lifecycle columns are writable.
REVOKE UPDATE ON model.model_price_rules FROM atlas_svc;
GRANT UPDATE (is_active, expires_at, updated_by, updated_at, deleted_at)
  ON model.model_price_rules TO atlas_svc;

REVOKE UPDATE ON model.model_policies FROM atlas_svc;
GRANT UPDATE (name, priority, max_concurrent, rate_limit_rpm, rate_limit_tpm,
              rate_limit_tpd, max_context_tokens, is_active, expires_at,
              updated_by, updated_at, deleted_at)
  ON model.model_policies TO atlas_svc;

-- --- provisioning ---
-- workspace_provisionings: upserted on every valid webhook event - status/seq/
-- timestamps are writable, identity (workspace_id, product_code) and created_at
-- are not (a change there would silently re-point the row at a different
-- workspace rather than recording a new event for the same one).
REVOKE UPDATE ON provisioning.workspace_provisionings FROM atlas_svc;
GRANT UPDATE (status, seq, provisioned_at, deprovisioned_at, updated_at)
  ON provisioning.workspace_provisionings TO atlas_svc;

-- webhook_deliveries: append-only idempotency ledger -> no UPDATE at all.
REVOKE UPDATE ON provisioning.webhook_deliveries FROM atlas_svc;

-- ═══ partition runway ═══
-- Deliberately the LAST statement of the three-part DDL, and deliberately not
-- in 00_baseline.sql where the functions it calls are defined.
--
-- 97_service_role.sql grants `ON ALL TABLES IN SCHEMA`, which is evaluated at
-- the moment it runs. Creating the runway before it therefore hands every
-- partition its own explicit privileges, while every partition created later -
-- by the next db-init, or by this function at runtime - gets none. Both work,
-- because access goes through the partitioned parent, but the two halves of
-- one table would carry different grants, and a privilege audit would have to
-- know which db-init created which month to make sense of it.
--
-- Creating it after the grant files keeps every partition identical: none of
-- them carries its own grant, all of them are reached through the parent.
--
-- Idempotent: months that already exist are skipped, so every db-init apply
-- rolls the runway forward another 12 months.
SELECT * FROM reqlog.ensure_partitions(12);
