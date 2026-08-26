-- 03_reqlog_attempt_index.sql - which attempt this row is.
--
-- TD-037. The two request surfaces have written `request_records` at different
-- grains since they were built. The chat path writes ONE row per logical
-- request: candidates that failed on the way to a success appear in logs and in
-- Prometheus counters and nowhere else. The S2S path writes a `status:error`
-- row per failed attempt plus a final row, all sharing one `requestId`.
--
-- Same table, two grains. Anything counted across both is not comparable, and
-- chat's failed upstream attempts - which cost real provider money and real
-- latency - are absent from the only durable record Atlas keeps.
--
-- The fix is one row per attempt on both surfaces, which needs the ordinal to
-- be written rather than inferred. Inferring it from `created_at` ordering
-- almost works, and "almost" is the problem: two attempts inside the same
-- microsecond order arbitrarily, and a rollup that silently mislabels which
-- attempt succeeded is worse than one that cannot tell.
--
-- 0 is the first attempt, matching `fallbackAttempt` in the routing loop, which
-- has carried this number in logs since the failover chain was built. Rows
-- written before this column existed stay NULL: they are single-row logical
-- requests under the old chat grain, and a fabricated 0 would assert they were
-- first attempts of a chain that was never recorded.
--
-- `usage_type` already reserves 'retry' for non-first attempts (TD-024's
-- closing row) and nothing has ever written it. This is what activates it.
--
-- NO COLUMN GRANT IS NEEDED, and that is not an oversight - the same argument
-- as incr/01: 98_column_locks.sql revokes UPDATE on reqlog.request_records
-- wholesale because the table is append-only (cleanup is DROP PARTITION), and
-- INSERT is granted at table level in 97_service_role.sql, covering every
-- column present and future. Writable on insert, unwritable thereafter.
--
-- smallint, not int: a failover chain is a handful of candidates. A column
-- four times wider than the value can ever need is a small permanent cost on
-- the highest-volume table in the database.
--
-- Adding a column to the partitioned parent propagates to every existing
-- partition; ADD COLUMN IF NOT EXISTS makes the file idempotent, which db-init
-- requires because it re-runs on every deploy.

ALTER TABLE reqlog.request_records
  ADD COLUMN IF NOT EXISTS attempt_index smallint;

COMMENT ON COLUMN reqlog.request_records.attempt_index IS
  'Zero-based position of this attempt within one logical request; rows of the same attempt chain share request_id. 0 is the first attempt, matching fallbackAttempt in the routing loop. NULL = written before the column existed, i.e. a single-row logical request under the old chat grain.';
