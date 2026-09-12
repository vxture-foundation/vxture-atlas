# Atlas operation-code vocabulary (product_250 M-2)

Submitted to platform in response to `vxture-atlas`#165 request 2.

M-2's division of labour: **the vocabulary is the provider's** (it evolves with
our capabilities and platform does not draft it for us); **evaluation, grant,
step-up policy and audit are platform's**. So what follows is the complete list
of operation codes Atlas asks to have registered in the operator RBAC
catalogue. The `requires_step_up` column is platform's to set - the "suggested"
column below is input, not a decision.

## Why splitting is needed

The catalogue currently holds two coarse codes:

| Code | Covers |
|---|---|
| `model:provider.manage` | editing a provider's description AND rotating its API key |
| `model:model.manage` | editing a model's sort order AND deleting it |

Marking either one `requires_step_up` would put a second-factor prompt in front
of harmless edits - which is precisely why #165 says platform did not mark
them. Splitting is what makes the flag usable at all.

## The vocabulary

One code per HTTP operation that changes something. Reads are deliberately
absent: the catalogue gates actions, and Atlas's operator reads are already
covered by `mgmt:atlas` scope plus the operator realm check.

> **Naming, settled 2026-09-13 (`vxture-platform#49`).** The codes below are
> written `{product_code}.{resource}.{action}`, which is *not* the form they are
> registered under. The platform catalogue is `{domain}:{object}.{action}`
> throughout - 14 domains, ~50 codes - and Atlas's existing four
> (`model:provider.read/.manage`, `model:model.read/.manage`) already sit in the
> `model:` domain. These codes SPLIT those four, so they stay in that domain:
> `atlas.price_rule.delete` registers as **`model:price_rule.delete`**.
>
> The dotted form is left in this letter rather than rewritten, because the
> letter is a record of what was asked. Read the platform catalogue for what a
> code is actually called.

### Credential material - the reason this split exists

These eight touch key material. `create` and `rotate` return plaintext exactly
once; `revoke` is terminal and irreversible.

| Code | Route | Suggested step-up |
|---|---|---|
| `atlas.provider_key.create` | `POST /capability/provider-keys` | yes |
| `atlas.provider_key.rotate` | `POST /capability/provider-keys/:id/rotate` | yes |
| `atlas.provider_key.activate` | `PUT /capability/provider-keys/:id/activate` | yes |
| `atlas.provider_key.deactivate` | `PUT /capability/provider-keys/:id/deactivate` | yes |
| `atlas.gateway_api_key.create` | `POST /capability/api-keys` | yes |
| `atlas.gateway_api_key.rotate` | `POST /capability/api-keys/:id/rotate` | yes |
| `atlas.gateway_api_key.activate` | `PUT /capability/api-keys/:id/activate` | no |
| `atlas.gateway_api_key.deactivate` | `PUT /capability/api-keys/:id/deactivate` | no |
| `atlas.gateway_api_key.revoke` | `PUT /capability/api-keys/:id/revoke` | yes - terminal, no undo |

Two of these are marked "no" on purpose: `activate`/`deactivate` on a gateway
key is a reversible on/off switch that reveals no material. Grouping them with
`revoke` would train operators to click through the prompt, which is how a
prompt stops meaning anything.

### Registry - routing and access, no credential material

| Code | Route | Suggested step-up |
|---|---|---|
| `atlas.provider.create` / `.update` / `.activate` / `.deactivate` | `/capability/providers[...]` | no |
| `atlas.provider.delete` | `DELETE /capability/providers/:id` | yes - cascades to that provider's models and grants |
| `atlas.provider.probe` | `POST /capability/providers/:id/probe` | no - diagnostic, but see the note below |
| `atlas.model.create` / `.update` / `.activate` / `.deactivate` | `/capability/models[...]` | no |
| `atlas.model.delete` | `DELETE /capability/models/:id` | no |
| `atlas.model.probe` | `POST /capability/models/:id/probe` | no - see below |
| `atlas.endpoint.create` / `.update` / `.activate` / `.deactivate` / `.delete` | `/capability/endpoints[...]` | no |
| `atlas.grant.create` / `.update` / `.activate` / `.deactivate` / `.delete` | `/capability/grants[...]` | no |

**On the two probe codes.** They are diagnostic and reversible, so no step-up -
but they are the only operator actions that **spend real money**: each makes a
live upstream call (capped at 16 output tokens, charged to Atlas's own account,
never a tenant's). Worth a rate-limit or a distinct grant in the catalogue even
though it is not a step-up case. Atlas already enforces a 10-second per-model
cooldown; that is a hammering guard, not an authorization one.

### Commercial and policy - append-versioned, never deleted

| Code | Route | Suggested step-up |
|---|---|---|
| `atlas.price_rule.create` / `.update` / `.activate` / `.deactivate` | `/capability/price-rules[...]` | no |
| `atlas.policy.create` / `.update` / `.activate` / `.deactivate` | `/capability/policies[...]` | no |

> **Retracted 2026-08-26, and both halves now landed (`vxture-platform#49`).**
> This letter said "no `delete` on either, that is structural" and asked the
> platform *not* to register the delete codes. **Three of the facts behind that
> were wrong**, which is what #49 corrected:
>
> - `DELETE /capability/price-rules/:id` and `.../policies/:id` **both exist**
>   (soft delete: `is_active=false`, `deleted_at=now()`).
> - The database **does** grant it - `97_service_role.sql` grants `DELETE` on
>   the whole `model` schema, and `incr/10` grants `UPDATE (deleted_at)`.
> - Only `model_price_rules` is append-versioned. **`model_policies` is not** -
>   `priority` / `max_concurrent` / rate limits / `max_context_tokens` / `name`
>   all carry `UPDATE`, and `GET /capability/policies` has no `asOf` at all.
>
> Both codes are registered (`model:price_rule.delete`, `model:policy.delete`),
> and the platform added the two missing admin-bff proxies in the same batch -
> registering a code while its route stays unreachable is exactly the empty
> permission this letter warned about.

### `policy.update` requires step-up

The original "no" here rested on two claims that hold for price rules and
**not** for policies: that the change is reversible by writing a new row, and
that every version stays queryable via `?asOf=`. A policy update is an
**in-place overwrite** of rate/concurrency/context limits; the old value
survives nowhere but `audit.change_records`, and the policy surface has no
`asOf` to read back.

The deciding case: an operator raises a tenant's rate limit and lowers it
again. **The row ends up identical** - the incident window cannot be asked of
that resource. A change that leaves no trace on the resource should leave one
on the action, and step-up is that trace.

Settled 2026-09-13: `model:policy.update` carries `requires_step_up = true`.
Price rules stay `false` - since 2026-08-16 `PATCH price-rules/:id` refuses
every price field and accepts only `expiresAt`, so a price change really is
append-then-expire, and it really does have `asOf`.

**This is tied to TD-053** (not TD-038 - `vxture-platform#49` cited the wrong
number; TD-038 is a closed entry about three unwritable columns on
`model_providers`/`models`). If policies are given the price-rule treatment
(REVOKE on the value columns, append writes, `asOf` reads), the two become
isomorphic and this flag should be **withdrawn**. The criterion for withdrawing
it is recorded in the platform migration next to the flag, so it does not become
a marker nobody dares touch.

## What Atlas does on its side

`StepUpRequiredGuard` is gone as of 2026-08-13 - all nine key-mutation routes
now carry plain `OperatorAuthGuard`, per #165 request 1 and after your
confirmation that opera-bff's catalogue read plus ceremony had landed.

What remains on the provider side is a **record, not a refusal**:
`audit.change_records` captures every mutating `/capability/*` request with the
operator `sub`, the acting workforce RP (`act.sub`), the action, the field
names touched, and the outcome - readable at `GET /capability/audit-logs`.

Two consequences worth stating plainly:

1. **Between now and opera-bff enforcing, these nine operations have no second
   factor anywhere.** That was already true in practice, in the worse
   direction: `amr` never reached the operator access token
   (`vxture-platform`#252), so the guard rejected *all* of them. The change
   trades "always refuses" for "always allows, always recorded", and only the
   catalogue closes it properly.
2. **Atlas does not read `amr` at all, and will not start.** The first version
   of this letter said we would add it to `audit.change_records` once #252
   landed. That was wrong and is withdrawn.

   The reason is the one #252 itself states: MFA verification succeeds and
   **platform's own audit already records `amr` correctly** - the claim is only
   lost when the access token is signed. So the authoritative record exists,
   upstream, today. Atlas mirroring it would be a second copy of a fact
   platform owns, and the two would disagree the first time signing dropped it
   again. That is the same objection that keeps `created_by`/`updated_by`
   unpopulated on our registry tables (TD-033); we had applied it in one place
   and not the other.

   More basically: `amr` describes an authentication ceremony Atlas was not
   present for and cannot corroborate. Reading it never told us anything we
   were entitled to conclude.

   `operator_role` is dropped on the same reasoning - it is an input to
   authorization evaluation, and M-2 assigns evaluation to platform. Neither
   claim needs to change on your side; we simply stop reading them.

   **Nothing is expected of platform here.** #252 remains worth fixing for
   platform's own audit and risk use; it is no longer a dependency of ours.

If the deeper defence in #165 ("console carries a short-lived, operation-bound
marker proving it ran the ceremony; provider verifies that marker") becomes a
contract, Atlas will implement it. To be explicit about the shape we expect:
that marker is verified against the **operation**, not resurrected as an `amr`
check.
