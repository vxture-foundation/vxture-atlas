# Management plane design

The rules that govern `/capability/*` and why they are what they are. Route
signatures are `docs/20-specs/10-http-surface.md`; what Atlas is as a product
is `docs/20-specs/20-product-definition.md`. This file is the reasoning.

## The plane carries two different jobs

| | Changes intended state? | Audited | Examples |
|---|---|---|---|
| **Configuration** | yes | every write | providers, models, endpoints, grants, price rules, policies, keys |
| **Runtime** | no | reads are not | health, probes, logs, usage, audit reads |

They share one prefix and one guard. That is a fact about the implementation,
not a design position. Four consequences of the split worth keeping visible:

- The runtime job is answered behind **two different auth models**: `logs` and
  `logs/summary` under the operator token, `metrics` and `status` under
  `InternalDiagnosticsGuard`. Same question, different doors.
- **Probes are the only runtime action with an external side effect** -
  everything else there is a read, and a probe spends real money.
- **`audit-logs` is the runtime job observing the configuration job**, and the
  only place the two connect.
- **Authorization does not know the split**: the operation-code vocabulary
  submitted to the platform catalogue covers configuration writes only, so
  "may read the audit trail" cannot be granted separately from "may rotate a
  key".

## Six rules

### 1. Derive, do not cascade

State that follows from something else is computed at read time, never written
onto the dependent row - a written cascade overwrites operators' own
decisions and leaves reactivation with no way to tell what to restore.

Deactivating a model does not deactivate the endpoints pointing at it. Instead
an endpoint reports `disabled` / `unresolvable` / `degraded` / `serving`,
derived from the models it names. `degraded` - primary down, fallback carrying
it, calls still succeeding - is the state worth alerting on.

### 2. A count on a row is the number that blocks the delete

`modelCount`, `grantCount`, `endpointRefCount` come from the same source the
delete precondition reads. A column showing `0` while the delete returns `409`
is worse than no column, because it teaches an operator to distrust the page.

The corollary is that every count must be **clickable**, which is why
`?providerId=` and `?modelCode=` exist. A number that leads nowhere is a
number nobody can act on.

Dependents are counted **non-deleted regardless of active state**: a
deactivated endpoint still references its model, and deleting the model leaves
a dangling route the moment someone reactivates it.

### 3. Deactivate, then delete - and refuse, do not cascade

Two preconditions on every delete: the resource is already deactivated, and it
has no dependents. The `409` names the blockers rather than only refusing,
because an operator told "you cannot" has to go hunting for what to remove.

Making the caller empty a resource before deleting it turns removal into a
sequence that is visible and reversible at each step - a cascade would be one
click silently revoking access the tenants never agreed to give up. Nothing
goes from serving traffic to gone in a single action.

### 4. Verify the source, do not re-judge the person

Atlas verifies that an instruction is genuine, current and addressed to it, and
records who sent it. It does not re-derive whether the sender may do the thing:
redundant verification of the **credential** is cheap defence, while redundant
adjudication of the **person** is a contradiction waiting to fire.

All seven token checks stay, including `realm`/`userType`, which partly
re-assert what `scope` implies - one string comparison against a mis-minted
token reaching a management plane. But `amr` and `operator_role` are not read
at all: one describes an authentication ceremony Atlas was never present for,
the other is an input to an evaluation the platform owns.

### 5. Record, do not refuse

The plane keeps a **record**, not a gate - step-up and any other adjudication
of the operator belong to the platform. `audit.change_records` captures every
mutating `/capability/*` request with the operator `sub`.

Three properties, each load-bearing:

- **Append-only in the database**, not by convention - `atlas_svc` holds INSERT
  and SELECT and nothing else. Unlike the other append-only tables it has no
  DELETE either, because `reqlog` cleans up by dropping partitions and this
  does not clean up at all.
- **Derived from the route**, not called per handler. Explicit calls would
  audit the routes someone remembered to annotate, and forgetting one fails
  silently. A new write route is audited the moment it exists.
- **Field names, never values.** Bodies here carry provider API keys and
  gateway secrets; an audit table that becomes a second unencrypted copy of the
  key vault is a worse problem than the gap it closes.

The write is deliberately non-fatal. Losing the record of a deactivation is
bad; refusing to let an operator deactivate a failing provider mid-incident is
worse.

### 6. Revoke must mean revoke

Authorization rows are unique per scope. The runtime authorizes on **any**
matching active grant, so a duplicate keeps serving after an operator switches
off the one they were looking at - **an action that appears to have worked.**

`uq_product_endpoint_grants_scope` is `NULLS NOT DISTINCT`, which is the whole
point: `application_id` is NULL on a product-wide grant, and default NULL
semantics would have permitted two of those.

Identity is immutable - repointing a grant is a revoke plus a create, so both
decisions stay in the trail where an in-place edit would leave only the
destination.

## What the configuration plane is FOR

Authorization is `(product, endpoint)`, because what is sold is a product
service. The design consequence for this plane:

- The operator configures **capabilities** (endpoints) and **who holds them**
  (products), not per-customer model lists. There is no per-tenant screen to
  maintain and none should be added.
- Repointing an endpoint is invisible to callers, and that has to hold at the
  authorization layer too - which is why a grant names an entry point rather
  than a model. Model-scoped grants would break the abstraction at
  exactly the layer that must not break, and would leave an endpoint's
  fallback needing a second grant before it could fire.
- A tenant's only model-level freedom is choosing among what its product's
  endpoints already reach. That set is derived, never stored.

## Deliberately absent

- **No cascade delete option.** It would be the silent cascade of rule 3 back
  under a different name.
- **No dry run.** Repointing takes effect on the next request with no
  "what routes through this today" query first. A real gap, not yet needed.
- **No batch operations.** Onboarding twenty models is twenty calls.
- **No per-tenant configuration anywhere.** Tenant is a metering dimension, not
  an authorization one.
- **No alerting.** Atlas exposes facts - `registryDrift`, provider health,
  `degraded` endpoints. Nothing evaluates them, and nobody has claimed that.

## Migration in flight

The tenant authorization axis (`model_grants`, `taskProfile`) is still live
alongside the product axis. It is removed only once
`model_grant_authorizations_total{axis="tenant"}` shows nothing depends on it -
not on the belief that the migration finished.

That counter is process-local and resets on deploy, so a zero reading
immediately after a release is evidence of nothing.
