# `incr/` - numbered increments against a database that must survive

ADR-006 (2026-08-17) folded the pre-rebaseline `incr/01`..`incr/15` into
`00_baseline.sql`, `97_service_role.sql` and `98_column_locks.sql`, and every
environment was rebuilt from the consolidated baseline. Numbering then restarted
at `01`; the files here are post-rebaseline increments (TD-048 covers the
ambiguity this creates for older references).

That was a one-time act with the data loss accepted in front of the owner. It
is **not** the standing rule, and this file exists so the next person does not
read the empty directory as permission.

## The rule from here

1. **A structure change is a new increment**, numbered from `01` again, applied
   by `db-init` after the three-part baseline. Governance standard section 7
   requires it in the same batch as the DDL change: a PR touching
   `ddl/[0-9]*.sql` without a matching idempotent increment must not merge,
   because the new database gets the structure and the live one does not -
   while the code is written for the new structure, so it breaks in production
   with no build or test failure anywhere.

2. **Never edit an applied increment.** Add the next number. An increment that
   has run somewhere is a record of what that database was given.

3. **Mirror the change into `00_baseline.sql` in the same PR.** A new database
   must not have to replay history to reach the current structure. This is the
   half that rots first, and `check-data-architecture.mjs` only compares the
   baseline against Prisma - it cannot see an increment you forgot to mirror.

4. **A grant belongs with the column it covers.** `98_column_locks.sql` revokes
   table-level `UPDATE` and grants it back per column, so a column added by an
   increment is **not** writable until its grant is issued. State it in the
   increment AND mirror it into `98`. Getting this wrong produces
   `permission denied for table ...` at runtime, on an operator route, with no
   type error, no test failure and no lint warning upstream of it - which is
   exactly how `PATCH /capability/price-rules/:id` answered 500 from the day
   the column locks landed until 2026-08-16.

5. **Ordering is a hazard, not a convenience.** Increments apply in filename
   order and each may re-issue a table's whole grant list. `incr/12` once
   re-granted `UPDATE ON model.models` without `deprecated_at` while `incr/15`
   granted it with - correct end state in order, and re-applying `12` alone
   silently stripped the grant. Do not hand-apply a single DDL file.

## Verifying a change

`scripts/dev/schema-snapshot.sql` dumps columns, types, defaults, constraints,
indexes, partitions, routines and column-level privileges in a diffable form.
Apply both chains to throwaway `postgres:18` containers and diff:

```
docker run -d --name a -e POSTGRES_PASSWORD=x -e POSTGRES_DB=vx_atlas_db postgres:18
docker exec a psql -U postgres -d vx_atlas_db -c "CREATE ROLE atlas_svc LOGIN PASSWORD 'x';"
# apply 00 / 97 / 98 / incr, then:
docker exec -i a psql -U postgres -d vx_atlas_db -q < scripts/dev/schema-snapshot.sql > a.txt
```

Reviewing a fold by eye misses the column grants. That is not a hypothetical
failure mode - it is the one this repo has already paid for twice.
