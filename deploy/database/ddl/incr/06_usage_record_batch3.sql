-- 06_usage_record_batch3.sql - the remaining dimensions, and a price for cache writes.
--
-- ADR-010 / usage-record checklist batch 3 (P2).
--
-- reqlog.request_records - facts for analysis and anomaly tracing:
--   token_jti               the S2S token's jti: which exchanged credential made
--                           the call (product_code says which product).
--   deploy_stage            the stage the row was written by (the same value
--                           /healthz reports), so a row copied or restored into
--                           another environment still says where it came from.
--   model_behavior_version  the model's behaviour fingerprint when it served -
--                           an operator repointing an upstream under the same
--                           model_code shows up as a different value.
--   tool_count              tool definitions sent (they cost input tokens),
--   tool_calls_made         tool calls the model made in its answer,
--   message_count           messages in the request (conversation rounds).
--   vector_count            embed: vectors returned,
--   vector_dimension        and their dimension.
--
-- model.model_price_rules - TD-057. Cache WRITES are priced above plain input
-- (Anthropic: 1.25x for the 5-minute TTL, 2x for 1-hour) and a rule had no rate
-- for them, so they were costed as plain input - an understatement, the one
-- direction the cached-read fallback was designed never to take.
--   cache_write_unit_price     per unit_tokens, 5-minute (default) TTL writes,
--   cache_write_1h_unit_price  per unit_tokens, 1-hour TTL writes.
-- NULLABLE: NULL = not declared, and the cost falls back to the input rate,
-- exactly as before this increment. Value columns of an append-versioned table:
-- UPDATE stays revoked (98_column_locks.sql), INSERT is table-level - so no
-- grant is needed, and none is issued.
--
-- ADD COLUMN IF NOT EXISTS: db-init re-runs this on every deploy.

ALTER TABLE reqlog.request_records
  ADD COLUMN IF NOT EXISTS token_jti              varchar(128),
  ADD COLUMN IF NOT EXISTS deploy_stage           varchar(16),
  ADD COLUMN IF NOT EXISTS model_behavior_version varchar(64),
  ADD COLUMN IF NOT EXISTS tool_count             smallint,
  ADD COLUMN IF NOT EXISTS tool_calls_made        smallint,
  ADD COLUMN IF NOT EXISTS message_count          smallint,
  ADD COLUMN IF NOT EXISTS vector_count           int,
  ADD COLUMN IF NOT EXISTS vector_dimension       int;

ALTER TABLE model.model_price_rules
  ADD COLUMN IF NOT EXISTS cache_write_unit_price    numeric(18,8),
  ADD COLUMN IF NOT EXISTS cache_write_1h_unit_price numeric(18,8);

COMMENT ON COLUMN reqlog.request_records.deploy_stage IS
  'The stage that wrote the row, as /healthz reports it.';
COMMENT ON COLUMN reqlog.request_records.model_behavior_version IS
  'The model behaviour fingerprint at call time; changes when an upstream is repointed under the same model_code.';
COMMENT ON COLUMN model.model_price_rules.cache_write_unit_price IS
  'TD-057: price per unit_tokens for 5-minute-TTL cache writes. NULL = not declared; costed at input_unit_price.';
COMMENT ON COLUMN model.model_price_rules.cache_write_1h_unit_price IS
  'TD-057: price per unit_tokens for 1-hour-TTL cache writes. NULL = not declared; falls back to cache_write_unit_price, then input_unit_price.';
