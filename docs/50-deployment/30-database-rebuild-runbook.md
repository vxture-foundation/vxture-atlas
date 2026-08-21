# Production database rebuild (ADR-006)

The consolidated baseline is `CREATE TABLE IF NOT EXISTS` throughout, so it
**cannot** converge an existing database - applying it to one fails loudly
(`column "task_id" does not exist`) rather than diverging silently. Verified on
the dev database 2026-08-17. A rebuild is therefore the delivery path, not an
optimisation.

This runbook exists because the rebuild is irreversible and touches the one
database karda is served from.

## Correction to ADR-006's cost section

ADR-006 lists the envelope-encrypted provider credentials as **"gone - must be
re-entered from each supplier's console. Atlas cannot recover them; they exist
nowhere else in plaintext."**

**That is the worst case written as if it were the default, and this runbook
supersedes it.** Atlas has a vault, and the vault survives a rebuild.

ADR-003 chose envelope encryption with **custody deliberately split from
storage**: `key.provider_api_keys` holds `encrypted_key` + `encryption_key_id`,
and the master key set lives in the environment
(`PROVIDER_KEY_ENCRYPTION_KEYS`, `{keyId: base64Key}`). The database never
holds a master key, and the environment never holds a provider secret.

Two consequences that decide this whole runbook:

- **The ciphertext is portable.** Dump it, restore it into the rebuilt
  database, and it decrypts exactly as before - the drop never touched the
  half that does the decrypting. Rebuilding the database does not lose a single
  credential.
- **Re-entering from each supplier's console is the fallback for one specific
  situation**: no usable dump AND the master key set changed or was lost. It is
  not what a rebuild costs; it is what losing both halves at once costs.

The same holds for everything else in the database. Nothing here is
unrecoverable **if a dump is taken first**, which makes taking one the whole
job rather than a precaution.

What the vault genuinely does not give back, in any scenario, is the upstream
plaintext: `/capability/provider-keys` returns it exactly once, at create and
at rotate. A restored key keeps working because Atlas decrypts it on the call
path - but nobody can read it back out to copy it somewhere else. That is the
design, not a gap.

## Step 0 - inventory, before anything is dropped

Run on worker-02. These are reads; none of them changes anything. Save the
output - it is both the re-entry list if a restore is skipped, and the
comparison set for verifying the rebuild.

```
CONT=vx-atlas-postgres-db-prod
DB=vx_atlas_db

# What has to come back, and how much of it
docker exec $CONT psql -U postgres -d $DB -c "
SELECT 'providers'  t, count(*) FROM model.model_providers          WHERE deleted_at IS NULL
UNION ALL SELECT 'models',        count(*) FROM model.models         WHERE deleted_at IS NULL
UNION ALL SELECT 'endpoints',     count(*) FROM model.model_endpoints WHERE deleted_at IS NULL
UNION ALL SELECT 'tenant_grants', count(*) FROM model.model_grants   WHERE deleted_at IS NULL
UNION ALL SELECT 'product_grants',count(*) FROM model.product_endpoint_grants WHERE deleted_at IS NULL
UNION ALL SELECT 'price_rules',   count(*) FROM model.model_price_rules WHERE deleted_at IS NULL
UNION ALL SELECT 'policies',      count(*) FROM model.model_policies  WHERE deleted_at IS NULL
UNION ALL SELECT 'provider_keys', count(*) FROM key.provider_api_keys WHERE deleted_at IS NULL
UNION ALL SELECT 'gateway_keys',  count(*) FROM key.gateway_api_keys  WHERE deleted_at IS NULL
UNION ALL SELECT 'reqlog_rows',   count(*) FROM reqlog.request_records
UNION ALL SELECT 'audit_rows',    count(*) FROM audit.change_records;"
```

**The one question this answers that nothing else can**: how the five active
models resolve their upstream key. `/readyz` reports `checkedKeys: 0` and
`envVarModels: []`, which says neither a vault key reference nor
`config.apiKeyEnvVar` is set on any of them - so either the key arrives some
third way, or those five cannot actually serve. Settle it before the rebuild,
not after:

```
docker exec $CONT psql -U postgres -d $DB -c "
SELECT m.model_code, m.provider_id IS NOT NULL AS has_provider,
       m.config ? 'apiKeyEnvVar'      AS uses_env_var,
       m.config -> 'keyReference'      AS key_reference,
       m.is_active, m.deprecated_at
FROM model.models m WHERE m.deleted_at IS NULL ORDER BY m.model_code;"
```

Also capture the two things a restore cannot reconstruct from the registry
alone, because they are how consumers reach it:

```
# Which product holds which entry point - this is what karda's calls authorize against
docker exec $CONT psql -U postgres -d $DB -c "
SELECT product_code, endpoint_code, application_type, is_active, expires_at
FROM model.product_endpoint_grants WHERE deleted_at IS NULL ORDER BY 1,2;"

# Endpoint -> model routing, including the fallback chain
docker exec $CONT psql -U postgres -d $DB -c "
SELECT code, category, primary_model_code, fallback_model_code, is_active
FROM model.model_endpoints WHERE deleted_at IS NULL ORDER BY code;"
```

## Step 1 - dump, and prove the dump is readable

A dump nobody has restored is a claim, not a backup.

```
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker exec $CONT pg_dump -U postgres -d $DB -Fc -f /tmp/atlas-$STAMP.dump
docker exec $CONT sh -c "ls -l /tmp/atlas-$STAMP.dump"
docker cp $CONT:/tmp/atlas-$STAMP.dump ./atlas-$STAMP.dump

# Restore it into a THROWAWAY container and count the rows back.
docker run -d --name restorecheck -e POSTGRES_PASSWORD=x -e POSTGRES_DB=$DB postgres:18
docker cp ./atlas-$STAMP.dump restorecheck:/tmp/d.dump
docker exec restorecheck pg_restore -U postgres -d $DB --no-owner /tmp/d.dump
# rerun the Step 0 inventory here; the numbers must match
```

Only when the counts match is the rebuild reversible.

## Step 2 - `db-init.yml recreate`

Added 2026-08-17. db-init stays the sole structure-change path, so the drop
happens inside it rather than by hand.

```
gh workflow run db-init.yml   -f action=recreate   -f confirm=vx_atlas_db   -f expected_sha=<the sha you mean>
```

`confirm` is the **database name**, not `yes`. Every other destructive prompt
in this repo takes `yes`, which makes `yes` muscle memory - and muscle memory
must not be able to drop a production database. The `expected_sha` pin and the
`production` environment's required reviewer both still apply.

The action does Step 1 for you, in an order that cannot lose data:

1. `pg_dump -Fc` inside the db container
2. refuse if the dump is implausibly small
3. **restore it into a scratch database on the same container and count the
   tables back** - if this fails, nothing has been dropped yet
4. drop the scratch, then drop and recreate the real database
5. apply `00_baseline` + `97` + `98`
6. print the exact `pg_restore --data-only` command, with the dump path

It stops at 6 rather than restoring automatically: whether the rows come back
is a decision, and a workflow that makes it silently would be the wrong place
for it.

**Verified end to end on a throwaway `postgres:18` before shipping** - dump
(240KB, restores to 44 tables and its rows), drop, consolidated baseline
(all three files OK), then `pg_restore --data-only`: **zero errors**, rows
back. That is the proof for Step 3's claim that the two schemas are equivalent
enough for a data-only restore to have nowhere to fail.

## Step 3 - rebuild, restore, verify

```
# after `recreate` applies 00_baseline + 97 + 98 to a fresh database:
docker exec $CONT pg_restore -U postgres -d $DB --data-only --disable-triggers /tmp/atlas-$STAMP.dump
```

Data-only, because the schema must come from the consolidated baseline - that
is the entire point of the rebuild. The two schemas are equivalent (proven to a
four-line diff, and those four are the one intended change: the gateway-key
`kind` CHECK is VALID here and NOT VALID in the old chain), so a data-only
restore has nowhere to fail on shape.

Then verify, in this order:

1. `curl worker-02:3100/readyz` - `database`, `modelRegistry`,
   `usageSummaryRead`, `reqlogPartitions`, `registryDrift` all pass
2. rerun the Step 0 inventory and diff against the pre-rebuild capture
3. **decrypt one provider key through the app**, not by reading the column -
   that is the only proof `PROVIDER_KEY_ENCRYPTION_KEYS` still matches the
   restored ciphertext
4. one real `/v1/chat` from karda, or a `/v1/models?tenantId=` that returns a
   non-empty list, to confirm grants resolve

## If the restore is skipped

Then this is the re-entry list, in dependency order - each step needs the one
above it to exist:

| # | What | Route | Notes |
|---|---|---|---|
| 1 | Providers | `POST /capability/providers` | `provider_code` is identity, never editable afterwards |
| 2 | Provider keys | `POST /capability/provider-keys` | Only if the dump is unusable AND `PROVIDER_KEY_ENCRYPTION_KEYS` changed - otherwise the restored ciphertext still decrypts. Plaintext is returned **once**, so this step needs the real upstream secret from each supplier's console |
| 3 | Models | `POST /capability/models` | `model_code` is identity; carries `config.wire`, `supportsVision`, key reference |
| 4 | Endpoints | `POST /capability/model-routes` | `code` is identity; sets `primary_model_code` + `fallback_model_code` |
| 5 | Product grants | `POST /capability/product-endpoint-grants` | `(productCode, endpointCode)` is identity - **this is what unblocks karda** |
| 6 | Tenant grants | `POST /capability/tenant-model-grants` | `tenantId` required; may narrow by application/taskProfile |
| 7 | Price rules | `POST /capability/price-rules` | append-versioned; `PATCH` accepts only `expiresAt` |
| 8 | Policies | `POST /capability/policies` | rate limits, concurrency, context ceiling |
| 9 | Gateway keys | `POST /capability/api-keys` | TD-034: no consumer today |

Not recoverable by re-entry at all: `reqlog.request_records` (metering history
for the retained window), `audit.change_records`, and the provisioning
receipts - a replayed webhook would be processed a second time.

## Blast radius while it runs

karda answers `NOT_ENTITLED` on every call from the drop until step 5 of the
re-entry list, or until the data-only restore completes. This is a model-plane
outage, not degraded service. Tell karda before, not after.
