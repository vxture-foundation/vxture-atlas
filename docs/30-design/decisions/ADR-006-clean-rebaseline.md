# ADR-006: The DDL is one create-once baseline; increment history is folded away

- Status: Accepted
- Date: 2026-08-17
- Deciders: owner

## Context

`deploy/database/ddl/` had accumulated fifteen numbered increments against a
530-line baseline - 1496 lines of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
index creation, re-issued column grants, and one `DROP SCHEMA`. A new database
reached the current structure only by replaying all of it in order, and the
baseline alone described a schema that has not existed since 2026-07-24.

That is not merely untidy. It produced a real class of defect twice in one week:

- `incr/12` re-issues `UPDATE` on `model.models` **without** `deprecated_at`,
  which `incr/15` adds. Name order saves the end state, so re-applying `incr/12`
  alone silently strips the grant and breaks `POST /capability/models/:id/deprecate`.
  The hazard exists only because the grant is stated in two files.
- `PATCH /capability/price-rules/:id` accepted seven value fields the database
  grants `UPDATE` on none of, and answered 500 from the day the column locks
  landed. Reading which columns `atlas_svc` may write required assembling
  `98_column_locks.sql` plus four increments in the right order.

The governance standard has no clause either way.
`140-repo-governance-standard.md` section 7 fixes the three-part DDL shape,
column locks, db-init exclusivity, and a same-batch idempotent-increment
requirement for PRs touching `ddl/[0-9]*.sql`. It says nothing about folding
increments back into the baseline. The gap is known and was formally reported
by `vxture-runos` (their TD-012 asked the platform line to add a pre-consumer
clause to section 7); the clause was never written.

## The precedent does not cover Atlas, and we are not appealing to it

`vxture-runos` ADR-011 folded its increments away and rebuilt its database. Its
authorisation is explicitly conditional:

> A rebaseline is legal exactly while no environment holds data anyone depends
> on. The moment a consumer is served from a live database, section 7's
> append-only increment rule governs again, without exception.

and it names this repo:

> Atlas is unaffected - it carries its own increments against its own database
> and no rule changes for it.

**That condition does not hold here.** `vx_atlas_db` is live on worker-02 and
karda is served from it. Copying runos's decision would be trading production
data for tidiness under an authorisation that was never granted to us.

So this is Atlas's own decision, taken with the cost stated rather than
inherited.

## Decision

1. **`00_baseline.sql` states the complete structure.** `incr/01`..`incr/15`
   fold into it; `97_service_role.sql` and `98_column_locks.sql` carry the full
   grant and lock set for that structure. `incr/` keeps only its README and is
   reserved for the next change against a database that must survive.

2. **Every environment is rebuilt from the consolidated baseline**, production
   included. The baseline is create-once and never alters an existing table, so
   a plain `apply` cannot converge an existing database onto it - a rebuild is
   the delivery path, not an optimisation.

3. **Equivalence is proven, not reviewed.** `scripts/dev/schema-snapshot.sql`
   dumps columns, types, defaults, constraints, indexes, partitions, routines
   and - critically - the 1085 column-level privileges the locks exist to set.
   Both chains are applied to throwaway databases and the two snapshots must
   diff to nothing. A hand-fold reviewed by eye would miss exactly the column
   grants, which is the half that has already bitten twice.

4. **A future rebaseline is a new ADR**, not an appeal to this one. This
   authorises one fold, at a moment when the cost below was accepted with the
   inventory in front of us.

## The cost, stated

Rebuilding `vx_atlas_db` destroys its contents. What that means concretely, read
from `/readyz` on 2026-08-17:

| What | State at decision time | After rebuild |
|---|---|---|
| Model registry | 5 active models, providers, endpoints, grants, price rules, policies | Gone - must be re-created |
| `key.provider_api_keys` | Envelope-encrypted upstream credentials | **Recoverable from a dump** - corrected 2026-08-17. ADR-003 keeps custody in the environment (`PROVIDER_KEY_ENCRYPTION_KEYS`), so restored ciphertext decrypts as before. Only losing the dump AND the master key set forces re-entry from each supplier's console |
| `reqlog.request_records` | Metering facts, 6-month retention | Gone - billing history for the retained window |
| `audit.change_records` | Operator change trail | Gone |
| `provisioning` receipts | Idempotency receipts | Gone - a replayed webhook would be processed again |

Two consequences worth naming separately:

- **karda is a live consumer.** Between the drop and the re-created grants,
  every call answers `NOT_ENTITLED`. This is an outage of the model plane, not a
  maintenance window with degraded service.
- **The metering history is the one thing with no re-entry path.** The registry
  can be re-created from the console and provider keys can be re-issued;
  consumed tokens already reported to C3 stay reported, but the local record of
  them is not reconstructible by hand.

**Corrected 2026-08-17.** The table above was written as if a rebuild
necessarily means data loss. It does not: `pg_dump` before the drop and a
data-only `pg_restore` after it preserves every row, and the vault's ciphertext
travels with it because the master key never lived in the database. The
schema still comes from the consolidated baseline, which is the whole point of
this ADR - the data riding along changes nothing about that. See
`docs/50-deployment/30-database-rebuild-runbook.md`; the table stands as the
cost of a rebuild taken WITHOUT a dump.

## Alternative considered and rejected

**Mirror only**: fold the increments into the baseline for new databases while
keeping `incr/` so the live database stays convergent. This gives a single file
describing the final structure with zero data risk, and is what runos's own
`incr/README.md` mandates as its ongoing rule.

Rejected by the owner in favour of the full rebuild: a baseline that new
databases reach one way and the live database reaches another is two paths to
one structure, and the whole point of this ADR is to stop having two.

## Consequences

- A structure change now forces a rebuild of every environment. That is the
  cost, and it is only acceptable while the owner accepts the data loss above.
- Section 7's same-batch idempotent-increment requirement resumes governing the
  moment the next increment lands - `incr/README.md` states this so the rule is
  written down where the next person will look.
- `check-data-architecture.mjs`'s "no baseline index depends on an incr/ column"
  rule becomes trivially satisfied, because there are no incr/ columns.
- The tech-debt entry that reports the standard gap upstream stays open until
  the platform line writes the section 7 clause runos asked for; until then two
  repos carry local ADRs for the same unwritten rule.
