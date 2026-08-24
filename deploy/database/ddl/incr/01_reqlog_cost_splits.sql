-- 01_reqlog_cost_splits.sql - record the two token splits that decide cost.
--
-- TD-047. Upstreams report more than three numbers, and Atlas kept three.
-- DeepSeek returns `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and
-- `completion_tokens_details.reasoning_tokens`; OpenAI and Anthropic report the
-- same two facts under their own names. Atlas read prompt/completion/total and
-- discarded the rest.
--
-- The split is not a nicety. A cached input token costs 1/30 of an uncached one
-- on DeepSeek (0.10 vs 3.00 CNY per million at peak, flash), and a reasoning
-- token is billed at the OUTPUT rate - measured on the live API 2026-08-24, one
-- self-check cost 864 tokens with thinking on and 168 with it off. Two months
-- of traffic with identical `input_tokens` can differ by an order of magnitude
-- in real spend, and nothing downstream can tell them apart, because Atlas is
-- where the distinction was available.
--
-- Atlas is the sole inference-metering entry point for every vxture product
-- (product_240 section 3), so a fact lost here is lost company-wide - and it is
-- lost irreversibly: a price can be backfilled later, a token count that was
-- never written cannot.
--
-- NULL means "the upstream did not report it", never zero. Same discipline as
-- the existing token columns: unreported and free are different facts, and a
-- fabricated 0 would make cached traffic look free rather than unmeasured.
--
-- NO COLUMN GRANT IS NEEDED, and that is not an oversight: 98_column_locks.sql
-- revokes UPDATE on reqlog.request_records wholesale because the table is
-- append-only (cleanup is DROP PARTITION, not DELETE). INSERT is granted at
-- table level in 97_service_role.sql and covers every column, present and
-- future. A new column here is writable on insert and unwritable thereafter,
-- which is exactly the intended shape.
--
-- Adding a column to the partitioned parent propagates to every existing
-- partition; ADD COLUMN IF NOT EXISTS makes the whole file idempotent, which
-- db-init requires because it re-runs on every deploy.

ALTER TABLE reqlog.request_records
  ADD COLUMN IF NOT EXISTS cached_input_tokens bigint,
  ADD COLUMN IF NOT EXISTS reasoning_tokens    bigint;

COMMENT ON COLUMN reqlog.request_records.cached_input_tokens IS
  'Input tokens served from the upstream prompt cache, billed at the cached rate. Subset of input_tokens, so the uncached half is input_tokens - cached_input_tokens. NULL = upstream reported no cache split.';

COMMENT ON COLUMN reqlog.request_records.reasoning_tokens IS
  'Completion tokens spent on a reasoning chain. Subset of output_tokens and billed at the output rate - kept separately because it is the one output cost an operator can switch off (config.wire.extraBody). NULL = upstream reported none.';
