-- 09_health_probe_settings.sql - active-probe settings per model and vendor
-- (ADR-013 point 5, design 120 section 4.5, F1b).
--
-- Owner, 2026-10-02: every monitoring setting is editable (from opera), and an
-- unset one falls back to a default. One row per model or vendor that has an
-- override; a NULL column means "inherit": model -> vendor -> the server's
-- .env -> built-in (10 minutes, on). A subject with no row inherits entirely.
--
-- The interval range is enforced here as well as on write, so a value outside
-- it cannot exist whichever path wrote it.
--
-- Idempotent; mirrored into 00_baseline.sql, 97 and 98 in the same PR.

CREATE TABLE IF NOT EXISTS health.probe_settings (
    subject_kind            varchar(8)    NOT NULL,             -- model | provider
    subject_key             varchar(128)  NOT NULL,             -- model_code | provider_code
    probe_interval_minutes  smallint,                           -- NULL = inherit
    probe_enabled           boolean,                            -- NULL = inherit
    updated_by              varchar(128),                       -- the operator (token sub)
    updated_at              timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_health_probe_settings PRIMARY KEY (subject_kind, subject_key),
    CONSTRAINT chk_health_probe_settings_kind CHECK (subject_kind IN ('model','provider')),
    CONSTRAINT chk_health_probe_settings_interval
      CHECK (probe_interval_minutes IS NULL OR probe_interval_minutes BETWEEN 5 AND 60)
);

GRANT SELECT, INSERT ON health.probe_settings TO atlas_svc;
REVOKE UPDATE ON health.probe_settings FROM atlas_svc;
GRANT UPDATE (probe_interval_minutes, probe_enabled, updated_by, updated_at)
  ON health.probe_settings TO atlas_svc;
