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

Format `{product_code}.{resource}.{action}`, one code per HTTP operation that
changes something. Reads are deliberately absent: the catalogue gates actions,
and Atlas's operator reads are already covered by `mgmt:atlas` scope plus the
operator realm check.

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

No `delete` on either, and that is structural rather than an oversight: both
tables are versioned by append and the database withholds the grant. Please do
not register `atlas.price_rule.delete` or `atlas.policy.delete` - a code with
no route behind it is a permission that can be granted and never used.

These rules feed downstream billing, so the argument for step-up is real. We
suggest no because the change is fully reversible (write a new row, expire it)
and every version stays queryable via `?asOf=`. Platform's call.

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
