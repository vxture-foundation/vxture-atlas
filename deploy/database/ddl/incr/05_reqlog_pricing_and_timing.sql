-- 05_reqlog_pricing_and_timing.sql - enough on each row to re-price it alone.
--
-- ADR-010 / usage-record checklist batch 2 (P1). Batch 1 kept what the vendor
-- said. This batch keeps what Atlas knew at the moment of the call, so any row
-- can be priced and reconciled on its own, without joining back to state that
-- has since changed (a price rule superseded, a model repointed, a key rotated):
--
--   started_at          when the attempt began. Off-peak pricing is decided by
--                       WHEN a call ran; created_at is when the row was
--                       written, which trails by the consume round-trip.
--                       Completion = started_at + latency_ms.
--   first_token_at      first streamed event, for streams. Time to first token
--                       = first_token_at - started_at. NULL for non-stream.
--   selector_kind       what the caller named: model / endpoint / task_profile,
--   selector_value      and its value - which is not always what served.
--   provider_key_alias  the vault key (with provider_code) the call went out
--                       on, i.e. which vendor account it lands on.
--   thinking_mode       off / on as requested. ADR-009 guarantees a requested
--                       mode is honoured or refused, never silently dropped, so
--                       requested IS effective; NULL = upstream default.
--   max_tokens          the caller's output budget.
--   streamed            stream vs single response.
--   cancelled_by        client / deadline, when the call was cut short.
--   upstream_cost       what the vendor charged by the price rule in force at
--   cost_currency       started_at, the rule's currency,
--   price_rule_id       which rule, and
--   pricing_window      peak / off_peak. NULL cost = unpriced (no rule, or no
--                       usage reported), never "free".
--
-- NO COLUMN GRANT IS NEEDED - request_records is append-only (incr/01, 03, 04).
-- ADD COLUMN IF NOT EXISTS + CHECKs added only when absent: db-init re-runs it.

ALTER TABLE reqlog.request_records
  ADD COLUMN IF NOT EXISTS started_at         timestamptz,
  ADD COLUMN IF NOT EXISTS first_token_at     timestamptz,
  ADD COLUMN IF NOT EXISTS selector_kind      varchar(16),
  ADD COLUMN IF NOT EXISTS selector_value     varchar(128),
  ADD COLUMN IF NOT EXISTS provider_key_alias varchar(128),
  ADD COLUMN IF NOT EXISTS thinking_mode      varchar(8),
  ADD COLUMN IF NOT EXISTS max_tokens         int,
  ADD COLUMN IF NOT EXISTS streamed           boolean,
  ADD COLUMN IF NOT EXISTS cancelled_by       varchar(16),
  ADD COLUMN IF NOT EXISTS upstream_cost      numeric(18,8),
  ADD COLUMN IF NOT EXISTS cost_currency      varchar(16),
  ADD COLUMN IF NOT EXISTS price_rule_id      uuid,
  ADD COLUMN IF NOT EXISTS pricing_window     varchar(8);

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('chk_request_records_selector_kind',  'selector_kind IS NULL OR selector_kind IN (''model'',''endpoint'',''task_profile'')'),
      ('chk_request_records_thinking_mode',  'thinking_mode IS NULL OR thinking_mode IN (''off'',''on'')'),
      ('chk_request_records_cancelled_by',   'cancelled_by IS NULL OR cancelled_by IN (''client'',''deadline'')'),
      ('chk_request_records_pricing_window', 'pricing_window IS NULL OR pricing_window IN (''peak'',''off_peak'')')
    ) AS t(name, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = c.name AND conrelid = 'reqlog.request_records'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE reqlog.request_records ADD CONSTRAINT %I CHECK (%s)', c.name, c.expr);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN reqlog.request_records.started_at IS
  'When the attempt began; off-peak pricing is decided by this, not created_at. Completion = started_at + latency_ms.';
COMMENT ON COLUMN reqlog.request_records.first_token_at IS
  'First streamed event. TTFT = first_token_at - started_at. NULL for non-stream calls.';
COMMENT ON COLUMN reqlog.request_records.selector_kind IS
  'model | endpoint | task_profile - what the caller named (selector_value), which is not always what served (model_code).';
COMMENT ON COLUMN reqlog.request_records.provider_key_alias IS
  'The vault key alias the call went out on; with provider_code it names the vendor account.';
COMMENT ON COLUMN reqlog.request_records.thinking_mode IS
  'off | on as requested; ADR-009 makes requested = effective. NULL = the upstream default.';
COMMENT ON COLUMN reqlog.request_records.upstream_cost IS
  'Vendor charge by the price rule in force at started_at (price_rule_id, cost_currency, pricing_window). NULL = unpriced, never free.';
