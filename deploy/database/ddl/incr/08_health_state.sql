-- 08_health_state.sql - service health as durable state (ADR-013, design 120, F1).
--
-- On 2026-09-30/10-01 a DeepSeek balance ran out and a Volcengine usage cap
-- paused a Doubao model; chat/fast had both as its candidates and 180 of 188
-- calls failed one evening. Nobody was told. Atlas's only signals were
-- in-memory counters that reset on restart and that nothing read.
--
-- 1. health.subject_states - the CURRENT state of each vendor model and each
--    route, one row per subject, updated in place on a transition. Kept
--    durable so a restart does not forget that an account is refused.
-- 2. health.events - every transition, append-only. The platform pulls these
--    by cursor (created_at, id) to notify admin; a failing model produces one
--    event when it starts failing and one when it recovers, not one per call.
--
-- uuid keys, as everywhere else in this database: no sequence, so no sequence
-- grant (none exists in this schema set).
--
-- Idempotent: CREATE ... IF NOT EXISTS, constraints declared inline, grants
-- re-issued. Mirrored into 00_baseline.sql, 97_service_role.sql and
-- 98_column_locks.sql in the same PR.

CREATE SCHEMA IF NOT EXISTS health;

CREATE TABLE IF NOT EXISTS health.subject_states (
    subject_kind     varchar(8)    NOT NULL,                   -- model | route
    subject_key      varchar(128)  NOT NULL,                   -- model_code | endpoint code
    provider_code    varchar(64),                              -- the vendor, for a model subject
    state            varchar(24)   NOT NULL,
    since            timestamptz   NOT NULL,                   -- when the subject entered this state
    upstream_status  smallint,                                 -- the vendor's HTTP status behind a failing state
    detail           varchar(500),                             -- the vendor's own words, bounded
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_health_subject_states PRIMARY KEY (subject_kind, subject_key),
    CONSTRAINT chk_health_subject_states_kind CHECK (subject_kind IN ('model','route')),
    CONSTRAINT chk_health_subject_states_state CHECK (state IN
      ('ok','rate_limited','account_refused','unavailable','model_missing','unknown','degraded','down'))
);

CREATE TABLE IF NOT EXISTS health.events (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at       timestamptz   NOT NULL DEFAULT now(),
    subject_kind     varchar(8)    NOT NULL,
    subject_key      varchar(128)  NOT NULL,
    provider_code    varchar(64),
    from_state       varchar(24)   NOT NULL,
    to_state         varchar(24)   NOT NULL,
    severity         varchar(8)    NOT NULL,                   -- info | warning | critical
    upstream_status  smallint,
    detail           varchar(500),
    affected_routes  text[],                                   -- for a model event: the routes it serves
    CONSTRAINT chk_health_events_kind CHECK (subject_kind IN ('model','route')),
    CONSTRAINT chk_health_events_severity CHECK (severity IN ('info','warning','critical'))
);

CREATE INDEX IF NOT EXISTS idx_health_events_cursor
  ON health.events (created_at, id);

GRANT USAGE ON SCHEMA health TO atlas_svc;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA health TO atlas_svc;

-- subject_states is updated in place; the identity columns never are.
REVOKE UPDATE ON health.subject_states FROM atlas_svc;
GRANT UPDATE (provider_code, state, since, upstream_status, detail, updated_at)
  ON health.subject_states TO atlas_svc;
-- events: append-only - no UPDATE, and no DELETE (97 grants none here).
REVOKE UPDATE ON health.events FROM atlas_svc;
