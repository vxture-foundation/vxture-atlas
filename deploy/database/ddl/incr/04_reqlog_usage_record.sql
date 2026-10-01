-- 04_reqlog_usage_record.sql - the raw facts a usage record cannot be rebuilt without.
--
-- ADR-010 / usage-record checklist batch 1 (P0). Atlas reports raw usage to the
-- platform, and the platform prices it with rules operators change at will. A
-- fact that was never written cannot be re-derived when a rule changes, so the
-- first batch is exactly the facts that are lost for good with every call that
-- does not write them:
--
--   upstream_request_id          the vendor's own id for the call (chatcmpl-...,
--                                msg_...). Reconciling against a vendor bill or
--                                disputing a charge needs it; nothing else joins.
--   upstream_model               the model name the vendor says answered. Vendors
--                                alias and roll versions under one name, and
--                                price follows what actually served.
--   cache_write_input_tokens     input tokens written to the upstream prompt
--                                cache (Anthropic cache_creation_input_tokens).
--                                Priced ABOVE plain input, so leaving it out
--                                under-counts exactly the expensive half.
--   cache_write_1h_input_tokens  the part of the above written with the 1-hour
--                                TTL, priced higher than the 5-minute default.
--                                NULL when the upstream does not split it: the
--                                split is unknown, not zero.
--   usage_source                 whether the counts on this row came from the
--                                upstream: 'reported', 'absent' (nothing
--                                reported - a stream cut short, a deadline
--                                cancel, an upstream that sends no usage) or
--                                'partial'. A NULL token count on an 'absent'
--                                row is "unknown", never "free".
--   upstream_usage               the upstream's usage object, verbatim. Every
--                                normalized column above is derived from it;
--                                when a vendor adds a field, history can be
--                                re-derived instead of being lost.
--   finish_reason                why generation stopped, normalized:
--                                stop / length / tool_calls / content_filter /
--                                other.
--   native_finish_reason         the vendor's own word for it, unmapped.
--
-- Token convention (fixed by this increment, applied in the adapters):
-- input_tokens counts EVERY input token - uncached, cache read and cache write.
-- cached_input_tokens and cache_write_input_tokens are subsets of it, so the
-- uncached part is input_tokens - cached_input_tokens - cache_write_input_tokens.
-- OpenAI-compatible upstreams already report prompt_tokens this way; Anthropic
-- reports input_tokens EXCLUDING both cache kinds, and before this change Atlas
-- stored it as-is, so a Claude row's "uncached = input - cached" came out short
-- or negative.
--
-- NO COLUMN GRANT IS NEEDED - the same argument as incr/01 and incr/03:
-- request_records is append-only, 98_column_locks.sql revokes UPDATE on it
-- wholesale, and INSERT is granted at table level in 97_service_role.sql.
-- Writable on insert, unwritable thereafter.
--
-- ADD COLUMN IF NOT EXISTS on the partitioned parent propagates to every
-- partition and makes the file idempotent; db-init re-runs it on every deploy.
-- A CHECK is added only when absent, for the same reason.

ALTER TABLE reqlog.request_records
  ADD COLUMN IF NOT EXISTS upstream_request_id         varchar(200),
  ADD COLUMN IF NOT EXISTS upstream_model              varchar(200),
  ADD COLUMN IF NOT EXISTS cache_write_input_tokens    bigint,
  ADD COLUMN IF NOT EXISTS cache_write_1h_input_tokens bigint,
  ADD COLUMN IF NOT EXISTS usage_source                varchar(16),
  ADD COLUMN IF NOT EXISTS upstream_usage              jsonb,
  ADD COLUMN IF NOT EXISTS finish_reason               varchar(16),
  ADD COLUMN IF NOT EXISTS native_finish_reason        varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_request_records_usage_source'
       AND conrelid = 'reqlog.request_records'::regclass
  ) THEN
    ALTER TABLE reqlog.request_records
      ADD CONSTRAINT chk_request_records_usage_source
      CHECK (usage_source IS NULL OR usage_source IN ('reported','absent','partial'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_request_records_finish_reason'
       AND conrelid = 'reqlog.request_records'::regclass
  ) THEN
    ALTER TABLE reqlog.request_records
      ADD CONSTRAINT chk_request_records_finish_reason
      CHECK (finish_reason IS NULL OR finish_reason IN ('stop','length','tool_calls','content_filter','other'));
  END IF;
END $$;

COMMENT ON COLUMN reqlog.request_records.upstream_request_id IS
  'The upstream vendor''s own id for this call (chatcmpl-..., msg_...). For reconciling against the vendor bill. NULL when the upstream returned none.';
COMMENT ON COLUMN reqlog.request_records.upstream_model IS
  'The model name the upstream says answered - may differ from the registry model_code when the vendor aliases or rolls versions.';
COMMENT ON COLUMN reqlog.request_records.cache_write_input_tokens IS
  'Input tokens written to the upstream prompt cache. Subset of input_tokens. NULL = not reported.';
COMMENT ON COLUMN reqlog.request_records.cache_write_1h_input_tokens IS
  'Part of cache_write_input_tokens written with the 1-hour TTL. NULL = the upstream did not split the write, not zero.';
COMMENT ON COLUMN reqlog.request_records.usage_source IS
  'reported | absent | partial - whether the token counts came from the upstream. NULL = written before the column existed.';
COMMENT ON COLUMN reqlog.request_records.upstream_usage IS
  'The upstream usage object verbatim; the normalized token columns are derived from it.';
COMMENT ON COLUMN reqlog.request_records.finish_reason IS
  'stop | length | tool_calls | content_filter | other - normalized; the vendor''s own word is native_finish_reason.';
COMMENT ON COLUMN reqlog.request_records.native_finish_reason IS
  'The upstream''s finish/stop reason, unmapped.';
