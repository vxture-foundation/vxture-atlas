-- 10_health_balance.sql - vendor balance warnings and the unreachable state
-- (ADR-013, design 120 sections 4.1 and 4.3, P1).
--
-- 1. A vendor is a health subject too (subject_kind 'vendor'): its balance
--    state is ok / balance_low / not_supported (no balance API reachable with
--    the credential Atlas holds) / unknown.
-- 2. 'unreachable' (DNS / TLS / connect - the path from Atlas) is a model
--    state of its own, apart from 'unavailable' (the vendor answered badly or
--    late): different people fix them.
-- 3. Balance thresholds on the vendor's settings row: minimum amount (>= 0,
--    0 = do not warn on amount), minimum projected days (0-30, 0 = do not warn
--    on days), poll interval (15-1440 minutes). NULL = inherit (.env, then
--    built-in). Owner, 2026-10-02: warn when EITHER is crossed.
-- 4. health.balance_samples: one row per balance read, append-only. Projected
--    days come from the balance's own decline over the trailing 7 days, with
--    increases (top-ups) left out.
--
-- Idempotent: constraints are dropped and re-added (the new definitions are
-- supersets, so existing rows pass), columns are ADD ... IF NOT EXISTS.
-- Mirrored into 00_baseline.sql, 97 and 98 in the same PR.

ALTER TABLE health.subject_states DROP CONSTRAINT IF EXISTS chk_health_subject_states_kind;
ALTER TABLE health.subject_states ADD CONSTRAINT chk_health_subject_states_kind
  CHECK (subject_kind IN ('model','route','vendor'));
ALTER TABLE health.subject_states DROP CONSTRAINT IF EXISTS chk_health_subject_states_state;
ALTER TABLE health.subject_states ADD CONSTRAINT chk_health_subject_states_state CHECK (state IN
  ('ok','rate_limited','account_refused','unavailable','unreachable','model_missing','unknown',
   'degraded','down','balance_low','not_supported'));

ALTER TABLE health.events DROP CONSTRAINT IF EXISTS chk_health_events_kind;
ALTER TABLE health.events ADD CONSTRAINT chk_health_events_kind
  CHECK (subject_kind IN ('model','route','vendor'));

ALTER TABLE health.probe_settings ADD COLUMN IF NOT EXISTS balance_min_amount   numeric(14,2);
ALTER TABLE health.probe_settings ADD COLUMN IF NOT EXISTS balance_min_days     smallint;
ALTER TABLE health.probe_settings ADD COLUMN IF NOT EXISTS balance_poll_minutes smallint;
ALTER TABLE health.probe_settings DROP CONSTRAINT IF EXISTS chk_health_probe_settings_balance;
ALTER TABLE health.probe_settings ADD CONSTRAINT chk_health_probe_settings_balance CHECK (
  (balance_min_amount IS NULL OR balance_min_amount >= 0)
  AND (balance_min_days IS NULL OR balance_min_days BETWEEN 0 AND 30)
  AND (balance_poll_minutes IS NULL OR balance_poll_minutes BETWEEN 15 AND 1440)
  -- balance thresholds belong to a vendor, not a model
  AND (subject_kind = 'provider'
       OR (balance_min_amount IS NULL AND balance_min_days IS NULL AND balance_poll_minutes IS NULL))
);

CREATE TABLE IF NOT EXISTS health.balance_samples (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code  varchar(64)   NOT NULL,
    sampled_at     timestamptz   NOT NULL DEFAULT now(),
    currency       varchar(8)    NOT NULL,
    total_balance  numeric(18,4) NOT NULL,
    is_available   boolean
);
CREATE INDEX IF NOT EXISTS idx_health_balance_samples_provider
  ON health.balance_samples (provider_code, sampled_at);

GRANT SELECT, INSERT ON health.balance_samples TO atlas_svc;
REVOKE UPDATE ON health.balance_samples FROM atlas_svc;
GRANT UPDATE (probe_interval_minutes, probe_enabled, balance_min_amount, balance_min_days,
              balance_poll_minutes, updated_by, updated_at)
  ON health.probe_settings TO atlas_svc;
