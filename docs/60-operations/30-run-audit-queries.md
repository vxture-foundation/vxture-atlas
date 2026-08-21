# Audit queries an operator actually needs

`audit.change_records` records every mutating operator request. The rows are
useful; the queries that make them useful were not written down anywhere, which
is how "the audit cannot distinguish X from Y" got reported as a gap when the
discriminating data was already in the row.

Run these as `postgres` on the stack's database container:

```
docker exec vx-atlas-postgres-db-prod psql -U postgres -d vx_atlas_db -c "..."
```

## The row

| Column | What it holds |
|---|---|
| `resource_type` | the resource segment of the path, **folded to its canonical name** (#206) - a call on `/capability/grants` and one on `/capability/tenant-model-grants` both record `tenant-model-grants` |
| `resource_id` | the id in the path, or NULL for a create |
| `action` | `create` / `update` / `delete`, or the named action segment (`activate`, `deactivate`, `deprecate`, `undeprecate`, `revoke`, `rotate`, `probe`) |
| `changed_fields` | the top-level keys of the request body, sorted |
| `operator_sub` | who |
| `actor_client_id` | which console |
| `outcome` | derived from the status the client actually got |
| `occurred_at` | when |

`changed_fields` is the column most of these queries turn on, and it is the one
that is easy to forget exists.

## Who repointed a model at a different upstream

The question opera raised in vxture-atlas#205: a repoint and a description edit
are both `action='update'`, so `action` alone cannot separate them. It does not
have to - the fields are recorded:

```sql
SELECT occurred_at, resource_id, operator_sub, changed_fields, outcome
FROM audit.change_records
WHERE resource_type = 'models'
  AND changed_fields && ARRAY['endpointUrl','providerId','config']
ORDER BY occurred_at DESC;
```

`&&` is "overlaps" - any one of those three fields is a behaviour change.

Repointing is deliberately ALLOWED (a supplier changes their base URL, a gateway
migration happens; forcing delete-plus-recreate would drop every grant that
references the model). What makes it safe is that it is observable: consumers
watch `behaviorVersion` on `GET /v1/models`, and operators have this query. See
`service/src/model-behavior-version.ts`.

To confirm nothing renamed a model, which would split its metering history:

```sql
SELECT count(*) FROM audit.change_records
WHERE resource_type = 'models' AND changed_fields @> ARRAY['modelCode'];
```

Expected: 0. `modelCode` is refused with a 400 and the column carries no UPDATE
grant, so a non-zero count means one of those two stopped being true.

## Everything one operator did

```sql
SELECT occurred_at, resource_type, action, resource_id, changed_fields, outcome
FROM audit.change_records
WHERE operator_sub = '<sub>'
ORDER BY occurred_at DESC LIMIT 100;
```

## Everything that happened to one object

`resource_id` is the id from the path, so this follows an object across
activate/deactivate/update/delete:

```sql
SELECT occurred_at, action, operator_sub, changed_fields, outcome
FROM audit.change_records
WHERE resource_type = 'models' AND resource_id = '<uuid>'
ORDER BY occurred_at;
```

## Refused attempts

`outcome` is derived from the status the client actually got, so failures are
recorded rather than dropped. "Who keeps trying something they are not allowed
to do" is answerable:

```sql
SELECT operator_sub, resource_type, action, count(*)
FROM audit.change_records
WHERE outcome <> 'success' AND occurred_at > now() - interval '7 days'
GROUP BY 1,2,3 ORDER BY 4 DESC;
```

## Grants, across the #206 rename

No special handling needed - `resource_type` is already folded, so one query
covers calls made under either spelling:

```sql
SELECT occurred_at, action, resource_id, operator_sub, outcome
FROM audit.change_records
WHERE resource_type IN ('tenant-model-grants','product-endpoint-grants')
ORDER BY occurred_at DESC;
```

Rows written BEFORE the rename carry the old values (`grants`,
`product-grants`) - they are not rewritten, because an audit record states what
was recorded at the time. A query spanning that boundary needs both:

```sql
WHERE resource_type IN ('tenant-model-grants','grants',
                        'product-endpoint-grants','product-grants')
```

That need disappears once the pre-rename retention window rolls off.

## What is NOT in here

- **Data-plane calls.** `/v1/*` traffic is in `reqlog.request_records`, keyed by
  `task_id` (product_251 X-2), not in the audit table. The audit table is the
  operator plane only.
- **Reads.** Only mutating methods are recorded. "Who looked at this" is not a
  question this table can answer.
- **Before/after values.** `changed_fields` names WHICH fields a request carried,
  not what they held. Bodies are not stored - they carry provider credentials on
  some routes, and a table that held them would be a second place to leak them.
