-- ═══════════════════════════════════════════════════════════════════════════
-- 00_baseline.sql — Atlas DB baseline (vx_atlas_db)
-- Single-file DDL baseline, per the org product-repo DDL convention
-- (00_baseline + 97_service_role + 98_column_locks + incr/, product_240
-- section 2.4 E). States the complete structure - see ADR-006.
--
-- Five schemas, ALL physically isolated from the shared platform DB
-- (vxturestudio_platform_main) - zero cross-database FK (boundary #1).
-- Cross-database references are loose values (request_id, provider_code,
-- model_code, tenant_id) validated at the application layer via the C2/C3
-- network contract, never a DB constraint:
--   key          - provider API keys (AES-256-GCM ciphertext only, plaintext
--                  never leaves this schema)
--   reqlog       - high-frequency AI request/error logs, monthly RANGE
--                  partitions, append-only
--   model        - provider/model/grant/price_rule/policy registry (Atlas's
--                  own product data - moved here from the platform's `model`
--                  schema)
--   provisioning - Atlas's own receiving-side state for the platform's C3
--                  provisioning webhook (docs/30-design/identity/080-rp-integration.md
--                  section 4/5, wire contract already in production for
--                  arda) - added 2026-07-24, TD-003 batch. Atlas is the
--                  receiver here, not the platform's dispatcher; these two
--                  tables exist so idempotency/ordering survive a restart or
--                  multiple instances, per that doc's explicit requirement.
--
-- Design authority: docs/design/data_model_200_schema.md section 4 (platform
-- repo). Prisma schema (service/prisma/schema.prisma) is a client-generation
-- source only and MUST stay in lockstep with this file
-- (scripts/guardrails/check-data-architecture.mjs).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS key;           -- provider secrets (AES-256 ciphertext, plaintext never leaves this schema)
CREATE SCHEMA IF NOT EXISTS reqlog;        -- high-frequency AI request logs / error detail (monthly RANGE partitions, append-only)
CREATE SCHEMA IF NOT EXISTS model;         -- model governance config (provider/model/grant/price_rule/policy)
CREATE SCHEMA IF NOT EXISTS provisioning;  -- C3 provisioning webhook receiver state (workspace status + delivery idempotency)
CREATE SCHEMA IF NOT EXISTS audit;         -- operator change trail over every /capability write (append-only, product_250 M-5)

-- ═══ schema key ═══
-- Provider API key vault. Never store plaintext keys - only AES-256-GCM
-- ciphertext (encrypted_key bytea). Envelope encryption model:
--   encrypted_key      = nonce||ciphertext||auth-tag packed AES-256-GCM blob
--   encryption_key_id  = key-ref to the wrapping master key (KMS/DEK) version,
--                        not the key itself - allows master-key rotation
--                        without re-reading plaintext.
-- provider_code is a cross-database logical reference (no FK, boundary #1).
CREATE TABLE IF NOT EXISTS key.provider_api_keys (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code     varchar(64)   NOT NULL,                     -- cross-db logical ref to model.model_providers.provider_code (no FK)
    key_alias         varchar(128)  NOT NULL,                     -- multi-key rotation / disambiguation
    encrypted_key     bytea         NOT NULL,                     -- AES-256 ciphertext (nonce||ciphertext||tag); decrypted in memory only
    encryption_key_id varchar(128)  NOT NULL,                     -- key-ref to the wrapping master key (KMS/DEK) version
    key_scope         varchar(32)   NOT NULL DEFAULT 'shared',    -- shared / dedicated
    is_active         boolean       NOT NULL DEFAULT true,
    last_rotated_at   timestamptz,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_provider_api_keys_code_alias UNIQUE (provider_code, key_alias),
    CONSTRAINT chk_provider_api_keys_key_scope CHECK (key_scope IN ('shared','dedicated')),
    deleted_at       timestamptz                              -- soft delete (incr/10); history lives in audit.change_records, not in an unremovable row
);
CREATE INDEX IF NOT EXISTS idx_provider_api_keys_provider_code ON key.provider_api_keys (provider_code);
CREATE INDEX IF NOT EXISTS idx_provider_api_keys_is_active     ON key.provider_api_keys (is_active);
CREATE INDEX IF NOT EXISTS idx_provider_api_keys_deleted_at    ON key.provider_api_keys (deleted_at);

-- Key-rotation audit (append-only). provider_api_key_id is a domain FK (same
-- database, real FK). rotated_by is a bare value referencing the platform's
-- admin.operator_accounts (cross-database/cross-realm, no FK, boundary #1/#2).
-- Append-only guard in 95_triggers.sql equivalent (see the modelruntime
-- reference implementation) - UPDATE only; DELETE remains for parent-key purge.
CREATE TABLE IF NOT EXISTS key.key_rotation_logs (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_api_key_id uuid          NOT NULL REFERENCES key.provider_api_keys(id) ON DELETE CASCADE,
    rotated_by          uuid,                                     -- bare value -> admin.operator_accounts (boundary #1/#2, no FK)
    reason              varchar(512),
    rotated_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_key_rotation_logs_key ON key.key_rotation_logs (provider_api_key_id, rotated_at);

-- Gateway caller API keys (vxture-atlas#144, TD-029) - the REVERSE direction
-- from provider_api_keys above: credentials Atlas issues to whoever calls
-- the Atlas gateway itself (internal services, future external partners),
-- not credentials Atlas presents outward to upstream model providers.
-- CRUD-only for now - these keys are not yet accepted by any auth path
-- (S2sAuthGuard still only verifies OIDC bearer tokens); this table is
-- inventory/lifecycle management, issued ahead of that wiring landing.
-- One-way hashed (key_hash), never encrypted/reversible - the full secret is
-- returned to the caller exactly once, at create/rotate time, and never
-- stored or re-displayed; key_prefix is the masked value shown in listings.
-- status is a one-way-terminal tri-state: active <-> disabled is reversible,
-- revoked is not (enforced at the application layer, not the DB - see
-- GatewayApiKeyService).
CREATE TABLE IF NOT EXISTS key.gateway_api_keys (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    name          varchar(128)  NOT NULL,
    kind          varchar(16)   NOT NULL DEFAULT 'external',   -- `internal` retired in incr/08: sibling products already authenticate with a short-lived OIDC token, so an internal key would only replace a stronger mechanism with a weaker one
    owner         varchar(128),
    key_prefix    varchar(24)   NOT NULL,
    key_hash      varchar(128)  NOT NULL,
    status        varchar(16)   NOT NULL DEFAULT 'active',
    last_used_at  timestamptz,
    expires_at    timestamptz,                             -- fixed-term credential; `expired` is DERIVED from this at read time, never stored (incr/09)
    deleted_at    timestamptz,
    created_by    uuid,
    updated_by    uuid,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_gateway_api_keys_key_hash UNIQUE (key_hash),
    CONSTRAINT chk_gateway_api_keys_kind   CHECK (kind = 'external'),   -- `internal` is retired. Stated VALID here, unlike the increment that introduced it: that one ran against a live database holding already-issued internal keys and had to be NOT VALID to avoid rewriting what those rows said they were. A database built from this file has no such rows, so the constraint is enforced from the first insert
    CONSTRAINT chk_gateway_api_keys_status CHECK (status IN ('active','disabled','revoked'))
);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_status ON key.gateway_api_keys (status);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_kind   ON key.gateway_api_keys (kind);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_expires_at ON key.gateway_api_keys (expires_at);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_deleted_at ON key.gateway_api_keys (deleted_at);

-- ═══ schema reqlog ═══
-- High-frequency AI request log (one row per call) + error detail, monthly
-- RANGE partitions (partition key in the composite PK). Cleanup is via DROP
-- PARTITION, not row DELETE, so there is no updated_at/deleted_at - a row is
-- immutable once written. Cross-database correlation keys (request_id,
-- tenant_id/workspace_id/product_id/user_id/application_id, model_code,
-- provider_code) are bare values, no FK (boundary #1). Failed calls
-- (status=error/timeout) land only here - they never trigger consume or write
-- a usage event on the platform side.
CREATE TABLE IF NOT EXISTS reqlog.request_records (
    id                       uuid          NOT NULL DEFAULT gen_random_uuid(),
    request_id               varchar(128)  NOT NULL,             -- cross-db correlation key -> platform metering.usage_events.request_id (no FK)
    tenant_id                uuid,                               -- attribution dimension (cross-db bare value, audit retained)
    workspace_id             uuid,
    product_id                uuid,
    user_id                  uuid,
    application_id           uuid,
    application_type         varchar(32),                        -- agent/workflow/api_client/internal_service
    agent_id                 uuid,
    feature_id               uuid,
    downstream_identity_hash varchar(128),
    model_code               varchar(128),                       -- cross-schema logical ref -> model.models.model_code (no FK, same DB but decoupled by design)
    provider_code            varchar(64),                        -- cross-schema logical ref -> model.model_providers.provider_code (no FK)
    endpoint_code            varchar(128),                       -- which entry point routed this call; NULL when the caller named a model/taskProfile directly
    product_code             varchar(64),                        -- which product called (act.sub on the verified S2S token); the resolvable form of product_id, which is a cross-database uuid and stays NULL
    task_id                  varchar(128),                       -- product_251 X-2: the agent TASK this call belongs to, stable across every product and model the task touches. varchar and not uuid ON PURPOSE: the id belongs to the caller's task system, and a uuid column writes a non-conforming value as NULL, which is exactly how tenant_id traffic vanished from every tenant-dimension report. Stored verbatim, never coerced
    input_tokens             bigint,
    output_tokens            bigint,
    total_tokens             bigint,
    latency_ms               int,
    usage_type               varchar(16),                        -- normal|retry|test
    status                   varchar(32),                        -- success|error|timeout
    business_id              varchar(128),
    billed_metric_key        varchar(64),
    billed_amount            bigint,
    cost_unit                varchar(16),                        -- what billed_amount COUNTS. One column carried three units with nothing on the row saying which, so SUM(billed_amount) over a mixed window added tokens to pages and returned a number that looked entirely reasonable. The CHECK is the load-bearing half: writing 'token' on a rerank row is the easy mistake, and a plausible wrong value nothing rejects is worse than the NULL it replaced
    usage_event_id           uuid,                               -- cross-db ref -> platform usage_events.id (no FK, boundary #1)
    created_at               timestamptz   NOT NULL DEFAULT now(),
    cached_input_tokens      bigint,                             -- TD-047 (incr/01): input tokens served from the upstream prompt cache, billed at the cached rate (1/30 of uncached on DeepSeek). Subset of input_tokens; the uncached half is the difference. Declared AFTER created_at on purpose - ALTER TABLE appends, so a database built from this baseline keeps the same column ordinals as one migrated by the increment
    reasoning_tokens         bigint,                             -- TD-047 (incr/01): completion tokens spent on a reasoning chain. Subset of output_tokens and billed at the output rate, kept apart because it is the one output cost an operator can switch off (config.wire.extraBody). NULL means unreported, never zero - a fabricated 0 makes an unmeasured call look free
    PRIMARY KEY (id, created_at),                                -- partition key must be in the PK
    CONSTRAINT chk_request_records_usage_type CHECK (usage_type IS NULL OR usage_type IN ('normal','retry','test')),
    CONSTRAINT chk_request_records_status     CHECK (status IS NULL OR status IN ('success','error','timeout')),
    CONSTRAINT chk_request_records_cost_unit  CHECK (cost_unit IS NULL OR cost_unit IN ('token','candidate','page'))
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS idx_request_records_request_id     ON reqlog.request_records (request_id);
CREATE INDEX IF NOT EXISTS idx_request_records_usage_event_id ON reqlog.request_records (usage_event_id);
CREATE INDEX IF NOT EXISTS idx_request_records_tenant_id      ON reqlog.request_records (tenant_id);
CREATE INDEX IF NOT EXISTS idx_request_records_endpoint_code  ON reqlog.request_records (endpoint_code);
CREATE INDEX IF NOT EXISTS idx_request_records_product_code   ON reqlog.request_records (product_code);
CREATE INDEX IF NOT EXISTS idx_request_records_task_id        ON reqlog.request_records (task_id);
-- These three used to be withheld from the baseline and owned by their
-- increments, because `CREATE TABLE IF NOT EXISTS` is a no-op against an
-- already-existing table: indexing a column the increments had not added yet
-- failed the whole baseline before any increment could run. ADR-006 removes
-- that constraint - every environment is rebuilt from this file, so the table
-- above is always the one this file just created.

CREATE TABLE IF NOT EXISTS reqlog.error_records (
    id            uuid          NOT NULL DEFAULT gen_random_uuid(),
    request_id    varchar(128),
    provider_code varchar(64),
    model_code    varchar(128),
    endpoint_code varchar(128),
    error_code    varchar(64),
    error_message text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS idx_error_records_request_id ON reqlog.error_records (request_id);
CREATE INDEX IF NOT EXISTS idx_error_records_error_code ON reqlog.error_records (error_code);

-- Bootstrap partitions for a fresh install: a fixed window starting 2026-07 +
-- a DEFAULT catch-all so a missed pre-build never silently drops writes.
--
-- This window is deliberately NOT the whole story - it is create-once and its
-- start date is frozen. Ongoing roll-forward and expiry live in
-- `incr/02_reqlog_partition_maintenance.sql` (TD-018), which installs
-- `reqlog.ensure_partitions()` / `reqlog.drop_expired_partitions()` and
-- extends the runway from the *current* month on every db-init apply. Do not
-- widen the window below instead of running that - `/readyz`'s
-- `reqlogPartitions` check reports the real remaining runway.
DO $$
DECLARE
  parts text[] := ARRAY['reqlog.request_records', 'reqlog.error_records'];
  qname text; sch text; tbl text; child text; mn date; nm date; i int;
BEGIN
  FOREACH qname IN ARRAY parts LOOP
    sch := split_part(qname, '.', 1);
    tbl := split_part(qname, '.', 2);
    FOR i IN 0..6 LOOP
      mn := (date '2026-07-01') + (i * interval '1 month');
      nm := mn + interval '1 month';
      child := tbl || '_y' || to_char(mn, 'YYYY') || 'm' || to_char(mn, 'MM');
      IF to_regclass(format('%I.%I', sch, child)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
          sch, child, sch, tbl, mn, nm);
      END IF;
    END LOOP;
    child := tbl || '_default';
    IF to_regclass(format('%I.%I', sch, child)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I DEFAULT', sch, child, sch, tbl);
    END IF;
  END LOOP;
END $$;

-- ═══ schema model ═══
-- Model governance config (provider/model/grant/price_rule/policy) - Atlas's
-- own product data, in Atlas's own physical database.
-- tenant_id on model_grants/model_policies is a bare value with NO FK: the
-- tenant lives in another product's database, and a foreign key cannot cross
-- one (physical database separation, boundary #1). Consistency is enforced at
-- the application layer against the C2/C3 contract payload, not by the DB.
CREATE TABLE IF NOT EXISTS model.model_providers (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code varchar(64)   NOT NULL,
    provider_type varchar(32)   NOT NULL DEFAULT 'online',
    provider_name varchar(128)  NOT NULL,
    description   varchar(512),
    description_key varchar(128),
    logo_url      text,
    homepage_url  text,
    console_url   text,
    billing_url   text,
    is_active     boolean       NOT NULL DEFAULT true,
    is_customer_visible  boolean      NOT NULL DEFAULT true,
    is_workforce_visible boolean      NOT NULL DEFAULT true,
    config        jsonb,                                        -- non-sensitive connection metadata; keys never live here
    created_by    uuid,                                         -- bare value -> platform admin.operator_accounts (boundary #2, no FK)
    updated_by    uuid,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    CONSTRAINT uq_model_providers_provider_code UNIQUE (provider_code),
    CONSTRAINT chk_model_providers_provider_type CHECK (provider_type IN ('online','self_hosted','private'))
);
CREATE INDEX IF NOT EXISTS idx_model_providers_is_active ON model.model_providers (is_active);
CREATE INDEX IF NOT EXISTS idx_model_providers_type      ON model.model_providers (provider_type);
CREATE INDEX IF NOT EXISTS idx_model_providers_deleted_at ON model.model_providers (deleted_at);

CREATE TABLE IF NOT EXISTS model.models (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id       uuid          REFERENCES model.model_providers(id) ON DELETE SET NULL,
    model_code        varchar(128)  NOT NULL,
    model_type        varchar(32)   NOT NULL DEFAULT 'chat',   -- chat/embedding/rerank... (open set, no CHECK)
    protocol          varchar(64)   NOT NULL,
    model_name        varchar(128)  NOT NULL,
    description       varchar(512),
    description_key   varchar(128),
    endpoint_url      text          NOT NULL,
    context_window    int,
    max_output_tokens int,
    capabilities      text[]        NOT NULL DEFAULT '{}',
    supports_streaming boolean      NOT NULL DEFAULT true,
    is_active         boolean       NOT NULL DEFAULT true,
    is_customer_visible  boolean      NOT NULL DEFAULT true,
    is_workforce_visible boolean      NOT NULL DEFAULT true,
    sort              int           NOT NULL DEFAULT 999,
    config            jsonb,
    created_by        uuid,
    updated_by        uuid,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    deleted_at        timestamptz,
    deprecated_at     timestamptz,                             -- product_251 X-4: still resolvable, no longer recommended. A timestamp and not a state column because it carries WHEN, which a retention window needs and a state cannot express. Deliberately independent of is_active: a deprecated model KEEPS SERVING, and collapsing the two is what left consumers with no warning before a 404
    CONSTRAINT uq_models_model_code UNIQUE (model_code)
);
CREATE INDEX IF NOT EXISTS idx_models_deprecated_at ON model.models (deprecated_at) WHERE deprecated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_models_is_active   ON model.models (is_active);
CREATE INDEX IF NOT EXISTS idx_models_model_type  ON model.models (model_type);
CREATE INDEX IF NOT EXISTS idx_models_provider_id ON model.models (provider_id);
CREATE INDEX IF NOT EXISTS idx_models_deleted_at  ON model.models (deleted_at);

CREATE TABLE IF NOT EXISTS model.model_grants (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id         uuid          NOT NULL REFERENCES model.models(id) ON DELETE CASCADE,
    tenant_id        uuid          NOT NULL,                  -- cross-db bare value, app-layer validated (boundary #1, no FK)
    application_id   uuid,
    application_type varchar(32),
    agent_id         uuid,                                    -- [retiring] = application_id WHERE type='agent'
    task_profile     varchar(64),                             -- NULL = ordinary grant; set = tenant's preferred model for this task profile (docs/70-workplan)
    priority         int           NOT NULL DEFAULT 100,
    is_active        boolean       NOT NULL DEFAULT true,
    reason           varchar(512),
    expires_at       timestamptz,
    created_by       uuid,
    updated_by       uuid,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT chk_model_grants_application_type
        CHECK (application_type IN ('agent','workflow','api_client','internal_service'))
);
CREATE INDEX IF NOT EXISTS idx_model_grants_model            ON model.model_grants (model_id);
CREATE INDEX IF NOT EXISTS idx_model_grants_tenant           ON model.model_grants (tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_grants_application      ON model.model_grants (application_id);
CREATE INDEX IF NOT EXISTS idx_model_grants_application_type ON model.model_grants (application_type);
CREATE INDEX IF NOT EXISTS idx_model_grants_agent            ON model.model_grants (agent_id);
CREATE INDEX IF NOT EXISTS idx_model_grants_is_active        ON model.model_grants (is_active);
CREATE INDEX IF NOT EXISTS idx_model_grants_task_profile     ON model.model_grants (task_profile);

-- Product-scoped authorization (incr/06). A product is granted ENTRY POINTS,
-- not models: repointing an endpoint is supposed to be invisible to callers,
-- and model-scoped grants would break exactly that at the authorization layer.
-- A direct modelCode call is checked against the models reachable through the
-- endpoints a product holds. See incr/06 for the full reasoning.
CREATE TABLE IF NOT EXISTS model.product_endpoint_grants (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    product_code     varchar(64)   NOT NULL,                -- act.sub on the verified S2S token; unforgeable, unlike tenant_id
    endpoint_code    varchar(128)  NOT NULL,                -- logical ref to model_endpoints.code, no FK (bare-value discipline)
    application_id   uuid,                                  -- optional narrowing to one of the PRODUCT's own agents
    application_type varchar(32),
    is_active        boolean       NOT NULL DEFAULT true,
    reason           varchar(512),
    expires_at       timestamptz,
    created_by       uuid,
    updated_by       uuid,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT chk_product_endpoint_grants_application_type
        CHECK (application_type IN ('agent','workflow','api_client','internal_service'))
);
CREATE INDEX IF NOT EXISTS idx_product_endpoint_grants_product    ON model.product_endpoint_grants (product_code);
CREATE INDEX IF NOT EXISTS idx_product_endpoint_grants_endpoint   ON model.product_endpoint_grants (endpoint_code);
CREATE INDEX IF NOT EXISTS idx_product_endpoint_grants_deleted_at ON model.product_endpoint_grants (deleted_at);
-- One grant per scope. Without it, deactivating a grant would not reliably
-- revoke access - the runtime authorizes on ANY matching active row, so a
-- duplicate keeps serving after the operator switched off the one they saw.
-- NULLS NOT DISTINCT is load-bearing: application_id is NULL on a
-- product-wide grant, and default NULL semantics would permit two of those.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_endpoint_grants_scope
  ON model.product_endpoint_grants (product_code, endpoint_code, application_id)
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS model.model_price_rules (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id           uuid          NOT NULL REFERENCES model.models(id) ON DELETE CASCADE,
    billing_mode       varchar(32)   NOT NULL DEFAULT 'token',
    currency           varchar(16)   NOT NULL DEFAULT 'CNY',
    unit_tokens        int           NOT NULL DEFAULT 1000000,
    input_unit_price   numeric(18,8) NOT NULL DEFAULT 0,
    output_unit_price  numeric(18,8) NOT NULL DEFAULT 0,
    request_unit_price numeric(18,8) NOT NULL DEFAULT 0,
    is_active          boolean       NOT NULL DEFAULT true,
    effective_at       timestamptz   NOT NULL DEFAULT now(),
    expires_at         timestamptz,
    created_by         uuid,
    updated_by         uuid,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_model_price_rules_billing_mode CHECK (billing_mode IN ('token','request')),
    deleted_at       timestamptz                              -- soft delete (incr/10); history lives in audit.change_records, not in an unremovable row
);
CREATE INDEX IF NOT EXISTS idx_model_price_rules_model     ON model.model_price_rules (model_id);
CREATE INDEX IF NOT EXISTS idx_model_price_rules_effective ON model.model_price_rules (effective_at);
CREATE INDEX IF NOT EXISTS idx_model_price_rules_is_active ON model.model_price_rules (is_active);
CREATE INDEX IF NOT EXISTS idx_model_price_rules_deleted_at ON model.model_price_rules (deleted_at);

CREATE TABLE IF NOT EXISTS model.model_policies (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id           uuid          NOT NULL REFERENCES model.models(id) ON DELETE CASCADE,
    tenant_id          uuid,                                   -- cross-db bare value (boundary #1, no FK); NULL = platform default
    name               varchar(128),
    priority           int           NOT NULL DEFAULT 100,
    max_concurrent     int,
    rate_limit_rpm     int,
    rate_limit_tpm     bigint,
    rate_limit_tpd     bigint,
    max_context_tokens int,
    is_active          boolean       NOT NULL DEFAULT true,
    effective_at       timestamptz   NOT NULL DEFAULT now(),
    expires_at         timestamptz,
    created_by         uuid,
    updated_by         uuid,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_model_policies_model_tenant UNIQUE (model_id, tenant_id),
    deleted_at       timestamptz                              -- soft delete (incr/10); history lives in audit.change_records, not in an unremovable row
);
CREATE INDEX IF NOT EXISTS idx_model_policies_model     ON model.model_policies (model_id);
CREATE INDEX IF NOT EXISTS idx_model_policies_tenant    ON model.model_policies (tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_policies_is_active ON model.model_policies (is_active);
CREATE INDEX IF NOT EXISTS idx_model_policies_deleted_at ON model.model_policies (deleted_at);

-- Logical capability entry point (vxture-atlas#143): a caller-facing stable
-- `code` (e.g. "chat/default") that indirects to a primary/fallback
-- model_code pair, so callers depend on a capability name instead of a
-- concrete modelCode. fallback_model_code NULL = single routing, set =
-- failover routing. Deliberately unrelated to the dead routing.model_routes /
-- routing.fallback_rules tables (never wired into any service code - see
-- docs/60-operations/10-tech-debt.md) - those are keyed by model_code
-- directly and shaped for weighted multi-provider routing, not a named
-- indirection layer; reusing them would have meant restructuring a table
-- with a different job. primary_model_code / fallback_model_code are logical
-- refs to model.models.model_code, no FK - same reasoning as reqlog/routing's
-- existing model_code references (98_column_locks.sql): model_code is a
-- stable identity that outlives soft-delete, and an endpoint pointing at a
-- since-deactivated model is a legible operator-visible state, not
-- corruption.
CREATE TABLE IF NOT EXISTS model.model_endpoints (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    code                varchar(128)  NOT NULL,
    category            varchar(32)   NOT NULL DEFAULT 'chat',
    primary_model_code  varchar(128)  NOT NULL,
    fallback_model_code varchar(128),
    is_active           boolean       NOT NULL DEFAULT true,
    created_by          uuid,
    updated_by          uuid,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT uq_model_endpoints_code UNIQUE (code)
);
CREATE INDEX IF NOT EXISTS idx_model_endpoints_is_active           ON model.model_endpoints (is_active);
CREATE INDEX IF NOT EXISTS idx_model_endpoints_deleted_at          ON model.model_endpoints (deleted_at);
CREATE INDEX IF NOT EXISTS idx_model_endpoints_primary_model_code  ON model.model_endpoints (primary_model_code);

-- ═══ schema provisioning ═══
-- Atlas's receiving side of the platform's C3 provisioning webhook
-- (docs/30-design/identity/080-rp-integration.md section 4/5 - already live in
-- production for arda, this is the same wire contract). Atlas is single-product
-- here (it never dispatches provisioning events itself), so product_code is
-- carried for payload/audit fidelity but is always 'atlas' in practice.
--
-- workspace_provisionings: current status per workspace (upserted on every
-- valid event) + the monotonic `seq` (= payload.seq) used to ignore stale/
-- out-of-order deliveries, per the wire contract's explicit requirement that
-- delivery order is not guaranteed.
CREATE TABLE IF NOT EXISTS provisioning.workspace_provisionings (
    id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     uuid         NOT NULL,
    tenant_id        uuid,                                    -- rollup reverse-lookup only, cross-db bare value (boundary #1)
    product_code     varchar(64)  NOT NULL DEFAULT 'atlas',
    status           varchar(32)  NOT NULL DEFAULT 'pending',
    seq              bigint       NOT NULL DEFAULT 0,          -- = payload.seq, monotonic per (workspace_id, product_code)
    provisioned_at   timestamptz,
    deprovisioned_at timestamptz,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_workspace_provisionings_workspace_product UNIQUE (workspace_id, product_code),
    CONSTRAINT chk_workspace_provisionings_status CHECK (status IN ('pending', 'provisioned', 'deprovisioned'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_provisionings_status ON provisioning.workspace_provisionings (status);

-- webhook_deliveries: append-only idempotency ledger keyed on delivery_id
-- (= X-Vxture-Delivery = payload.id). At-least-once delivery means retries of
-- the SAME delivery_id are expected and must be recognized even when they
-- would not change workspace_provisionings.seq.
CREATE TABLE IF NOT EXISTS provisioning.webhook_deliveries (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id  varchar(128) NOT NULL,
    workspace_id uuid         NOT NULL,
    product_code varchar(64)  NOT NULL DEFAULT 'atlas',
    event_type   varchar(64)  NOT NULL,
    seq          bigint       NOT NULL,
    received_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_webhook_deliveries_delivery_id UNIQUE (delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace ON provisioning.webhook_deliveries (workspace_id, seq);


-- ============================================================================
-- audit - who changed what, on the operator plane (product_250 M-5)
-- ============================================================================
--
-- M-5 requires a provider-domain audit table recording the operator `sub`
-- passed in by M-1. Until this table existed the answer to "who deactivated
-- this provider, and when" was simply not recorded anywhere - the operator
-- identity was verified on every request and then discarded.
--
-- Append-only, like reqlog: an audit trail the service can rewrite is not an
-- audit trail. 98_column_locks.sql revokes UPDATE and DELETE (reqlog gets to
-- keep DELETE because its cleanup is DROP PARTITION; here nothing may remove a
-- row at all).
--
-- Not partitioned, deliberately. Operator actions are human-paced - a few
-- thousand a year, not the millions/month reqlog handles - so the partition
-- machinery would cost more than it saves.
--
-- VALUES ARE NOT RECORDED, only the NAMES of the fields a write touched
-- (`changed_fields`). Two reasons, and the first is the hard one: request
-- bodies on this plane carry provider API keys and gateway key secrets, and an
-- audit table that quietly becomes a second, unencrypted copy of the key vault
-- is a worse security problem than the gap it closes. The second is that field
-- names already answer the operational question ("someone changed the rate
-- limit on this policy"); recovering old values is what append-versioning of
-- price_rules/policies is for.
CREATE TABLE IF NOT EXISTS audit.change_records (
    id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    -- What was touched. `resource_type` is the /capability path segment
    -- (providers, models, endpoints, grants, price-rules, policies,
    -- provider-keys, api-keys), kept as the caller-facing name rather than a
    -- table name so the trail stays readable against the HTTP surface.
    resource_type  varchar(64)  NOT NULL,
    resource_id    varchar(128),                      -- NULL for a create: the id does not exist until the write lands
    action         varchar(32)  NOT NULL,             -- create|update|delete|activate|deactivate|revoke|rotate|probe
    -- Who did it. `operator_sub` is the M-1 operator identity (`sub`, of the
    -- form opr_<uuid>) as a STRING, not a uuid column - the prefix is part of
    -- the identity and stripping it to fit a uuid type would silently merge
    -- two different principals that happen to share a uuid.
    operator_sub   varchar(128) NOT NULL,
    actor_client_id varchar(128),                     -- act.sub: the workforce RP that minted the OBO exchange
    changed_fields text[],                            -- field NAMES only - never values, see above
    request_id     varchar(128),                      -- correlates to reqlog / upstream tracing
    outcome        varchar(16)  NOT NULL DEFAULT 'success',
    occurred_at    timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_change_records_outcome CHECK (outcome IN ('success','failure'))
);
-- "what happened to THIS provider" - the question M-5 exists to answer.
CREATE INDEX IF NOT EXISTS idx_change_records_resource
  ON audit.change_records (resource_type, resource_id, occurred_at DESC);
-- "what has this operator been doing" - the other direction, for review.
CREATE INDEX IF NOT EXISTS idx_change_records_operator
  ON audit.change_records (operator_sub, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_records_occurred_at
  ON audit.change_records (occurred_at DESC);

-- ═══ reqlog partition maintenance ═══
-- Folded in from incr/02 by ADR-006. Creating the runway and dropping expired
-- partitions are FUNCTIONS, not statements: db-init calls `ensure_partitions`
-- on every apply so the runway rolls forward, and `drop_expired_partitions` is
-- never called from here. Dropping data is a separate, deliberate act, not a
-- side effect of applying DDL.

CREATE OR REPLACE FUNCTION reqlog.ensure_partitions(months_ahead int DEFAULT 12)
RETURNS TABLE (partition_name text, action text)
LANGUAGE plpgsql
AS $$
DECLARE
  parts text[] := ARRAY['request_records', 'error_records'];
  tbl text; child text; mn date; nm date; i int;
BEGIN
  IF months_ahead < 1 THEN
    RAISE EXCEPTION 'months_ahead must be >= 1 (got %)', months_ahead;
  END IF;

  FOREACH tbl IN ARRAY parts LOOP
    FOR i IN 0..months_ahead LOOP
      mn := date_trunc('month', now())::date + (i * interval '1 month');
      nm := mn + interval '1 month';
      child := tbl || '_y' || to_char(mn, 'YYYY') || 'm' || to_char(mn, 'MM');

      IF to_regclass(format('reqlog.%I', child)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE reqlog.%I PARTITION OF reqlog.%I FOR VALUES FROM (%L) TO (%L)',
          child, tbl, mn, nm);
        partition_name := child; action := 'created'; RETURN NEXT;
      ELSE
        partition_name := child; action := 'exists'; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- drop_expired_partitions: detach then drop any monthly partition entirely
-- older than `retain_months`. DETACH first so a concurrent reader is not
-- holding a lock on the parent when the DROP lands.
--
-- Deliberately never touches the DEFAULT partition: rows there are, by
-- definition, ones whose proper partition was missing, and silently dropping
-- them would destroy exactly the evidence needed to notice that happened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reqlog.drop_expired_partitions(
  retain_months int,
  dry_run boolean DEFAULT true
)
RETURNS TABLE (partition_name text, action text)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff date;
  rec record;
BEGIN
  IF retain_months < 1 THEN
    RAISE EXCEPTION 'retain_months must be >= 1 (got %)', retain_months;
  END IF;

  cutoff := (date_trunc('month', now()) - (retain_months * interval '1 month'))::date;

  FOR rec IN
    SELECT c.relname AS child, parent.relname AS parent
    FROM pg_inherits inh
    JOIN pg_class c      ON c.oid = inh.inhrelid
    JOIN pg_class parent ON parent.oid = inh.inhparent
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    WHERE n.nspname = 'reqlog'
      AND parent.relname IN ('request_records', 'error_records')
      AND c.relname ~ '_y[0-9]{4}m[0-9]{2}$'
    ORDER BY c.relname
  LOOP
    -- Reconstruct the partition's month from its own name; the suffix is
    -- generated by ensure_partitions above, so this is a closed loop.
    IF to_date(right(rec.child, 8), '"y"YYYY"m"MM') < cutoff THEN
      IF dry_run THEN
        partition_name := rec.child; action := 'would_drop'; RETURN NEXT;
      ELSE
        EXECUTE format('ALTER TABLE reqlog.%I DETACH PARTITION reqlog.%I',
                       rec.parent, rec.child);
        EXECUTE format('DROP TABLE reqlog.%I', rec.child);
        partition_name := rec.child; action := 'dropped'; RETURN NEXT;
      END IF;
    END IF;
  END LOOP;
END $$;

-- Extend the runway now, so applying this file is itself a maintenance pass.
-- 12 months ahead means a missed cadence degrades slowly and visibly (the
-- readiness check reports remaining runway) instead of falling off a cliff.
-- The runway is NOT created here; see the tail of 98_column_locks.sql for why
-- it has to happen after the grant files.

-- Expiry is NOT invoked here. Dropping data is a separate, deliberate act,
-- not a side effect of applying DDL.
--
-- There is no db-init action for it either. db-init.yml's `action` input is
-- apply|verify, and nothing in deploy/, service/ or .github/ ever calls
-- reqlog.drop_expired_partitions - an earlier version of this comment named a
-- db-init `partitions-prune` run that has never existed, so anyone who went
-- looking for it found nothing. Until the housekeeping item in
-- docs/70-workplan/00-index.md moves these functions onto the platform's
-- db-maintenance.yml, the 6-month retention is a hand-run statement against
-- the database (SELECT * FROM reqlog.drop_expired_partitions(6, false)):
-- expired months stay on disk until someone runs it, and the /readyz runway
-- alarm does not report over-retention.
