-- schema-snapshot.sql - a comparable dump of everything db-init is supposed to
-- produce, so "the consolidated baseline is equivalent to baseline + incr/" can
-- be PROVEN rather than reviewed.
--
-- Run against two throwaway databases - one built the old way, one the new -
-- and diff the two outputs. Ordering is fully deterministic and every value a
-- schema change could move is included: columns with type/nullability/default,
-- CHECK and other constraints, indexes, partitions, and the column-level
-- privileges that 98_column_locks.sql exists to set.
--
-- Deliberately NOT pg_dump: pg_dump emits CREATE TABLE without IF NOT EXISTS,
-- reorders freely between versions, and drops every comment - and the comments
-- in this repo's DDL carry the reasoning, which is most of their value.

\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'

SELECT '## COLUMNS';
SELECT table_schema, table_name, column_name, data_type,
       coalesce(character_maximum_length::text, ''),
       is_nullable, coalesce(column_default, '')
FROM information_schema.columns
WHERE table_schema IN ('model', 'reqlog', 'key', 'provisioning', 'audit')
ORDER BY table_schema, table_name, column_name;

SELECT '## CONSTRAINTS';
SELECT n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid)
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('model', 'reqlog', 'key', 'provisioning', 'audit')
ORDER BY n.nspname, c.relname, con.conname;

SELECT '## INDEXES';
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname IN ('model', 'reqlog', 'key', 'provisioning', 'audit')
ORDER BY schemaname, tablename, indexname;

-- Table-level grants. The role is what db-init sets up; anything else here
-- would mean a privilege leaked to a grantee nobody declared.
SELECT '## TABLE PRIVILEGES';
SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema IN ('model', 'reqlog', 'key', 'provisioning', 'audit')
  AND grantee = 'atlas_svc'
ORDER BY table_schema, table_name, grantee, privilege_type;

-- The column locks themselves. This is the half a table-level check misses:
-- 98_column_locks.sql revokes UPDATE and grants it back per column, so a
-- column added later is silently NOT covered.
SELECT '## COLUMN PRIVILEGES';
SELECT table_schema, table_name, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema IN ('model', 'reqlog', 'key', 'provisioning', 'audit')
  AND grantee = 'atlas_svc'
ORDER BY table_schema, table_name, column_name, privilege_type;

SELECT '## SCHEMAS';
SELECT nspname FROM pg_namespace
WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
ORDER BY nspname;

SELECT '## PARTITIONS';
SELECT n.nspname, c.relname, pg_get_expr(c.relpartbound, c.oid)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relispartition AND n.nspname IN ('reqlog')
ORDER BY n.nspname, c.relname;

SELECT '## ROUTINES';
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('model', 'reqlog', 'key', 'provisioning', 'audit', 'public')
ORDER BY n.nspname, p.proname;
