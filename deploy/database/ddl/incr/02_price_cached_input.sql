-- 02_price_cached_input.sql - a price for the cached half of the input.
--
-- TD-047, second half. incr/01 made Atlas RECORD how many input tokens the
-- upstream served from its prompt cache; this makes it possible to say what
-- they cost. Until now `model_price_rules` carried one input price, so the only
-- expressible answer was "cached and uncached cost the same" - and on DeepSeek
-- they differ by 30x (0.10 against 3.00 CNY per million at peak, flash).
--
-- NULLABLE, and NOT `NOT NULL DEFAULT 0`, which is the obvious-looking choice
-- and the wrong one. A 0 here reads as "cached input is free", which is a
-- specific and false claim about every provider, applied silently to every row
-- that already exists. NULL says the operator has not declared a cached rate,
-- which is the truth, and leaves whoever computes cost free to fall back to
-- `input_unit_price` - a fallback that can only ever OVERSTATE, never
-- understate. Same judgement the `cost_unit` column was given: a plausible
-- wrong value nothing rejects is worse than the NULL it replaced.
--
-- No column grant, deliberately. 98_column_locks.sql revokes UPDATE on this
-- table and grants back only the lifecycle columns (is_active, expires_at,
-- deleted_at, updated_by, updated_at), because a price rule is versioned by
-- APPEND: a new row supersedes the old one and `?asOf=` reads whichever was in
-- force. A value column that could be edited in place would rewrite history
-- that reqlog rows already cite. This column is a value column, so it stays
-- unwritable after insert - and `normalizeUpdatePriceRule` refuses it in the
-- API for the same reason, rather than letting it reach Postgres and come back
-- as a 500.
--
-- Idempotent: db-init re-runs on every deploy.

ALTER TABLE model.model_price_rules
  ADD COLUMN IF NOT EXISTS cached_input_unit_price numeric(18,8);

COMMENT ON COLUMN model.model_price_rules.cached_input_unit_price IS
  'Price per unit_tokens for input tokens the upstream served from its prompt cache (reqlog.request_records.cached_input_tokens). NULL = no cached rate declared; bill those tokens at input_unit_price, which overstates rather than understates.';
