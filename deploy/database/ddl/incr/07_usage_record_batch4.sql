-- 07_usage_record_batch4.sql - the last dimensions, and why any of them is empty.
--
-- ADR-010 / usage-record checklist batch 4 (owner, 2026-09-30): "this is a base
-- platform - build all of them; an uncollected value stays empty, with a mark
-- that tells 'we have no mechanism' from 'the other side has none' from 'not
-- integrated yet'."
--
-- 1. The dimensions (all nullable):
--   upstream_host            C6  which upstream endpoint host served the call
--   service_tier             C7  the vendor's service tier, when it states one
--   is_batch                 C8  batch vs realtime (Atlas has realtime only)
--   reasoning_budget_tokens  D2  a reasoning budget (Atlas has no such knob)
--   input_image_count        D7  images / audio seconds / files in the input
--   input_audio_seconds
--   input_file_count
--   input_image_tokens       E7  input tokens by modality
--   input_audio_tokens
--   output_audio_tokens      E8  output tokens by modality
--   output_image_tokens
--   tool_use_prompt_tokens   E9  tool-use prompt tokens (Gemini's split)
--   web_search_requests      F4  vendor-side tool calls billed per call
--   generated_image_count    F5  generated media
--   generated_media_seconds
--   content_filtered         H5  the answer was cut by content filtering
--   queue_wait_ms            I4  time spent queued before the upstream call
--
-- 2. dimension_status: for every usage dimension that is NULL on this row, the
--    reason it is NULL. A value present needs no mark. The vocabulary is closed
--    and each word names who acts on it:
--      not_integrated   Atlas has no mechanism to collect it          (Atlas dev)
--      not_supported    the other side does not offer it at all       (nobody)
--      not_reported     the other side should have, this time did not (investigate)
--      not_configured   the mechanism exists, operator config missing (operator)
--      capture_failed   given, but Atlas failed to take it            (Atlas: defect)
--      not_specified    the caller did not specify it; default used   (caller)
--      not_applicable   this kind of call has no such thing           (nobody)
--      not_reached      the request never reached the other side      (error code)
--    "The other side" is whoever owns the fact: the model vendor, or the
--    platform. A row written before this column existed has NULL here - the
--    mechanism did not exist yet, which is itself the answer.
--
-- The CHECK calls an IMMUTABLE function because a CHECK cannot hold a subquery:
-- every value must be one of the eight words, and the whole thing an object.
--
-- NO COLUMN GRANT IS NEEDED - request_records is append-only (incr/01..06).
-- ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / conditional CHECK: db-init
-- re-runs this on every deploy.

ALTER TABLE reqlog.request_records
  ADD COLUMN IF NOT EXISTS upstream_host           varchar(255),
  ADD COLUMN IF NOT EXISTS service_tier            varchar(32),
  ADD COLUMN IF NOT EXISTS is_batch                boolean,
  ADD COLUMN IF NOT EXISTS reasoning_budget_tokens int,
  ADD COLUMN IF NOT EXISTS input_image_count       int,
  ADD COLUMN IF NOT EXISTS input_audio_seconds     numeric(10,3),
  ADD COLUMN IF NOT EXISTS input_file_count        int,
  ADD COLUMN IF NOT EXISTS input_image_tokens      bigint,
  ADD COLUMN IF NOT EXISTS input_audio_tokens      bigint,
  ADD COLUMN IF NOT EXISTS output_audio_tokens     bigint,
  ADD COLUMN IF NOT EXISTS output_image_tokens     bigint,
  ADD COLUMN IF NOT EXISTS tool_use_prompt_tokens  bigint,
  ADD COLUMN IF NOT EXISTS web_search_requests     int,
  ADD COLUMN IF NOT EXISTS generated_image_count   int,
  ADD COLUMN IF NOT EXISTS generated_media_seconds numeric(10,3),
  ADD COLUMN IF NOT EXISTS content_filtered        boolean,
  ADD COLUMN IF NOT EXISTS queue_wait_ms           int,
  ADD COLUMN IF NOT EXISTS dimension_status        jsonb;

CREATE OR REPLACE FUNCTION reqlog.dimension_status_valid(s jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT s IS NULL
      OR (jsonb_typeof(s) = 'object'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(s) e
             WHERE jsonb_typeof(e.value) <> 'string'
                OR e.value #>> '{}' NOT IN ('not_integrated','not_supported','not_reported',
                                             'not_configured','capture_failed','not_specified',
                                             'not_applicable','not_reached')));
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_request_records_dimension_status'
       AND conrelid = 'reqlog.request_records'::regclass
  ) THEN
    ALTER TABLE reqlog.request_records
      ADD CONSTRAINT chk_request_records_dimension_status
      CHECK (reqlog.dimension_status_valid(dimension_status));
  END IF;
END $$;

COMMENT ON COLUMN reqlog.request_records.dimension_status IS
  'For each usage dimension NULL on this row, why: not_integrated | not_supported | not_reported | not_configured | capture_failed | not_specified | not_applicable | not_reached. NULL = written before the mechanism existed.';
