-- 11_health_atlas_components.sql - Atlas's own components as health subjects
-- (ADR-013, design 120 section 4.6, F3b-A).
--
-- subject_kind 'atlas': usage_reporting (C3 consume accepted or not),
-- request_log (reqlog writes), partitions (reqlog partition runway).
-- New states: 'failing' (the component is not working) and 'at_risk' (it will
-- stop working unless someone acts - a partition runway under two months).
--
-- Idempotent: the constraints are dropped and re-added as supersets, so every
-- existing row passes. Mirrored into 00_baseline.sql in the same PR.

ALTER TABLE health.subject_states DROP CONSTRAINT IF EXISTS chk_health_subject_states_kind;
ALTER TABLE health.subject_states ADD CONSTRAINT chk_health_subject_states_kind
  CHECK (subject_kind IN ('model','route','vendor','atlas'));
ALTER TABLE health.subject_states DROP CONSTRAINT IF EXISTS chk_health_subject_states_state;
ALTER TABLE health.subject_states ADD CONSTRAINT chk_health_subject_states_state CHECK (state IN
  ('ok','rate_limited','account_refused','unavailable','unreachable','model_missing','unknown',
   'degraded','down','balance_low','not_supported','failing','at_risk'));

ALTER TABLE health.events DROP CONSTRAINT IF EXISTS chk_health_events_kind;
ALTER TABLE health.events ADD CONSTRAINT chk_health_events_kind
  CHECK (subject_kind IN ('model','route','vendor','atlas'));
