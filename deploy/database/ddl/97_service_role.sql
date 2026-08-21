-- Least-privilege service role (data_platform_100 section 2.2.4 / governance
-- section 7). The runtime connects as atlas_svc, NOT the DB owner.
-- SELECT/INSERT/DELETE on the four schemas; NO DDL; NO blanket UPDATE
-- (column-level UPDATE is granted per the whitelist in 98_column_locks.sql).
-- The password is injected at bootstrap (never in the repo).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_svc') THEN
    CREATE ROLE atlas_svc LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA key, reqlog, model, provisioning, audit TO atlas_svc;

GRANT SELECT, INSERT, DELETE ON ALL TABLES IN SCHEMA key, reqlog, model, provisioning
  TO atlas_svc;

-- audit is the one schema that gets no DELETE. Every other append-only table
-- here keeps it because its cleanup is a row or partition drop; an audit trail
-- the service can erase is not an audit trail, so the service can only append
-- and read. Retention, if it ever comes, is an owner-run DDL operation.
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO atlas_svc;
