# product_251 conformance - the Atlas column

Atlas's self-declaration against the L1 API convention (`product_251`, whose
normative body is the shared artifact linked from
`vxture-platform/docs/30-design/product_251_management-api-conventions.md`).
D-3 requires each product owner to declare their own column and keep it current
when interfaces change.

This document states **status**, not reasoning. Where a clause is not met, the
reason it is not met yet is here; the design behind the clause is in
`product_251` and is not restated.

## Two facts the spec's own text gets wrong for Atlas

Both were established from source and production, and both are reported
upstream rather than worked around locally.

**X-1 names Atlas as the compliant baseline for the error envelope. It was
not.** Twenty-five errors on `/v1` carried no `code` at all - bare-string
`BadRequestException`s, which Nest renders as `{statusCode, message, error}`.
The published vocabulary also disagreed with the thrown one in both directions:
three codes were declared and never thrown (including `QUOTA_EXHAUSTED`, which a
liaison letter had promised karda), and two were thrown and never declared.
Fixed in #199; the guardrail below keeps it fixed.

**P4's premise - "zero users, zero debt, so breaking existing callers costs
nothing" - does not hold for Atlas's consumption plane.** `/v1/*` has live
callers: karda in production, and vxtpl integrating. They are internal, so a
change is coordinable rather than impossible, but it is a coordinated change
with a window, not a free one. This does not weaken any clause; it changes
sequencing, and product_251's own two-tier effectivity rule already provides for
it ("new interfaces immediately, existing interfaces at their next breaking
change").

## Status

| Clause | Status | Notes |
|---|---|---|
| **X-1** error envelope + rejection vocabulary | **met** | `{code, message, retryable}` on every `/v1` error. `retryable` derives from one exhaustive `Record` over the vocabulary, so an unclassified code fails type-check. `QUOTA_EXCEEDED` and `NOT_ENTITLED` canonical. See exemptions for `APPROVAL_REQUIRED` and `POLICY_DENIED`. |
| **X-2** `task_id` attribution | **met** | Required on all four `/v1` entry points (`TASK_ID_REQUIRED`, 400), recorded verbatim on success and failure, queryable at `GET /capability/logs?taskId=`. `varchar(128)`, stored without coercion - deliberately not `uuid`, because a `uuid` column silently NULLs a non-conforming value and that is how `tenantId` traffic vanished from every tenant-dimension report (#198 section 4). Refusals are counted as `model_request_rejections_total{code,product}`, which is the only place they can be seen: validation runs before anything is logged, so reqlog cannot answer "who is still not sending it" by construction. |
| **X-3** audit + metering record | **met** | Audit fields renamed via Prisma `@map` (no DDL). `costUnit` records what `billed_amount` counts - `token`/`candidate`/`page`, CHECK-constrained in `incr/14` and derived from the C3 metric so the two cannot disagree. `outcome` and `taskId` were already there. |
| **X-4** one word one meaning; version + deprecation | **met** | Deprecation: `POST :id/deprecate`, `state: deprecated` with `deprecatedAt` on both planes, and the model keeps serving. Naming: three operator resources renamed with both spellings served and the audit derivation folded, so one operation files under one `resource_type` (#206). Versioning: `modelCode` IS the version identifier - no `version` column, because a second writable statement of one fact drifts - and `modelCode` is refused on `PATCH` (the column carries no UPDATE grant, so without the guard the refusal was a 500). Repointing a live model stays allowed and is now observable: `behaviorVersion` is a fingerprint of the upstream + wire configuration, derived at the mapping boundary and stored nowhere, reported on `/v1/models` and `/capability/models`. |
| **M-A2** filter by query parameter | **met** | No filtering by path segment. |
| **M-A3** pagination and batch limits | **met** | Observability uses `cursor` + clamped `limit`; management-plane objects are bounded and return whole. `CANDIDATE_POOL_TOO_LARGE` rejects rather than truncating. |
| **M-B1** verb matches semantics | **met** | The seven object routes are `PATCH` (partial updates, 70 conditional assignments left untouched - the verb moved to match the behaviour). No `PUT` remains on the operator plane. |
| **M-B2** writes are distinguishable | **n/a** | Create and update are separate routes; the silent-no-op pattern does not occur. |
| **M-B3** `state` enum, not a boolean | **met** | Every API record reports `state`, derived at the mapping boundary so the database keeps `is_active boolean` / `status varchar` and no DDL is involved. Actions are `POST :id/activate`/`:id/deactivate` everywhere. `state` is create-only - the named actions are the sole post-create path, so the audit `action` matches the real operation. Gateway keys report `state`/`effectiveState`; the column keeps `disabled`, reconciled at the boundary because `rollback.yml` never reverses DDL, and the mapping is exhaustive in both directions with an unknown value failing CLOSED. The word `inactive` is used for the same condition even where the field is derived rather than an object state (`EndpointResolutionState`), because two words for one condition in one console is what the clause exists to remove. |
| **M-B4** `DELETE` means removal | **met** | `DELETE` is a soft delete throughout; state transitions use named routes. |
| **G-1** request metadata | **met** | Identity chain is enforced from the token; `task_id` required as per X-2. |
| **G-2** error carriage follows the transport | **met** | HTTP body for HTTP; the SSE error frame carries the identical envelope. |
| **D-1** breaking changes and deprecation | **process** | Applied to this round: the `QUOTA_EXHAUSTED` correction went to karda as a letter rather than a silent edit. |
| **D-2** new products comply on day one | **process** | Applied to `GET /v1/endpoints`, which took `state` rather than copying the surrounding `isActive`. |
| **D-3** keep the matrix current | **met** | This document, plus `scripts/guardrails/check-error-codes.mjs` in CI for the machine-checkable half of X-1. |

## Scope: which surfaces X-1 governs

Atlas has four planes, and the consumption plane is the one product_251 G/X-1
governs. Excluded **with reason, not by oversight**:

- **`/capability/*`** (operator plane) - the consumer is a console, not an
  agent. It keeps `OPERATOR_TOKEN_*` codes and its own envelope.
- **`/provisioning/webhook`** (C3) - the caller is the platform's outbox. Its
  wire contract is the platform's to define.
- **`/metrics`, `/status`, `/internal/diagnostics`** - no external consumer.

The S2S guard codes (`S2S_TOKEN_*`, `AUTH_ISSUER_NOT_CONFIGURED`) **are** in the
consumption vocabulary: they are delivered to the same caller on the same
surface, and were previously spelled only inside the guard, which is why a
consumer had to treat the guard's body as a third envelope shape (#198).

## Registered exemptions

| Deviation | Reason |
|---|---|
| No `POLICY_DENIED` code | Atlas has no policy-denial branch. `NOT_ENTITLED` is thrown only when neither the product-endpoint grant nor the tenant grant matched; rate limits are `RATE_LIMITED` and quota is `QUOTA_EXCEEDED`. So this was never two meanings conflated into one code - it is one condition, and X-1's `NOT_ENTITLED` names it exactly. |
| No `APPROVAL_REQUIRED` code | Atlas has no approval flow. Publishing a code nothing can emit is the "configured but inert" antipattern - a consumer would write a branch that can never run, which is the exact defect X-1's vocabulary rule exists to prevent. It gets added when an approval path does. |
| Metering unit is tokens, not calls | Already registered in product_251's own exemption list: domain nature. Only the **unit** is exempt; the record shape is X-3's, still owed. |
| No `resetAt` on `QUOTA_EXCEEDED` | Not deferred - **unimplementable** as the C2 contract stands. `QuotaPoolView` (`@vxture/shared`) carries `metric`/`limit`/`remaining`/`priority` and no reset time, so Atlas has nothing to forward. Needs a C2 change first; not promised until it exists. |

## What is left, and what each one waits on

Three items left this list on 2026-08-16 and the list did not notice, which is
its own defect - the matrix above said `met` for two of them while this section
still said they were pending, in the same file:

- **M-B1 `PUT` -> `PATCH`** and **X-3 audit field names** shipped in v0.12.0 and
  v0.13.0. They were listed here as needing a D-1 window that had already been
  run.
- **X-2 mandatory `task_id`** was listed as waiting on karda and vxtpl adopting
  the field. That was circular: neither had ever been asked to send it, and
  neither would start sending a field nothing required and nobody had raised.
  The precondition had no cause. The order is ask, then require - and the asking
  is `vxture-karda`#101 and `vxture-vxtpl`#50, sent before the requirement
  merged.


1. **X-4 `grants` naming** - **done 2026-08-17.** Left this list the same day
   its stale precondition was corrected, so the correction is recorded here
   rather than silently overwritten.

   Three resources renamed - `product-endpoint-grants`, `tenant-model-grants`,
   `model-routes` - with both spellings served, because an addition has a
   coexistence period and a cutover does not. The retired name answers with
   RFC 9745 / RFC 8594 headers and feeds
   `capability_legacy_path_requests_total{path,operator}`, which is what gates
   deleting it: the 2026-09-16 sunset is a floor, not a trigger. Nothing reads
   that counter on a schedule - TD-041.

   The part worth recording is what nearly shipped without it. `resource_type`
   in `audit.change_records` is derived from the resource path segment, so
   serving two spellings files ONE operation under TWO resource types - a fresh
   instance of the defect X-4 exists to remove, introduced by the fix for it.
   A first attempt passed 913 tests carrying it, because nothing tied
   `objectType` to the route table. Now `audit.middleware.ts` folds the retired
   spelling to the canonical one, and `describeMutation` is tested on both
   spellings of all three resources - removing the fold turns 4 tests red.

   A second defect came out of writing those tests: the fold was
   `map[segment] ?? segment`, and `segment` comes from the URL, so
   `POST /capability/constructor` resolved to `Object.prototype.constructor` and
   would have written a **function** into `resource_type`. Guarded with
   `Object.hasOwn`.

   Historical audit rows keep the old value. They are not rewritten - an audit
   record states what was recorded at the time.

   Not in this window: `GET /v1/endpoints` and `GET /tenancy/grants` carry the
   same words on the data plane, where consumers are products rather than one
   console - TD-042.

2. **X-4 model versioning** - **done 2026-08-17.** The shape changed twice
   while working on it, and both corrections matter more than the outcome.

   First: this was recorded as "a design task, not a rename", holding a slot for
   a mechanism that would BLOCK repointing. That would have been wrong. A
   supplier changing their base URL is routine, and delete-plus-recreate drops
   every grant referencing the model. Repointing must stay allowed; what was
   missing was a signal, not a lock. Owner decision 2026-08-17: consumers need a
   version, whether an agent displays it is the agent's business, the capability
   must exist.

   Second: "an operator can rename a live `model_code`" was wrong on the facts.
   `98_column_locks.sql` grants atlas_svc INSERT/SELECT on the column and no
   UPDATE - verified as atlas_svc, `permission denied for table models`, while
   the same statement on `endpoint_url` succeeds. The rename was already
   impossible. The real defect was the REFUSAL: no guard in
   `normalizeUpdateModel`, so the attempt reached Postgres and surfaced as an
   unhandled 500 - the identical defect `PATCH /capability/price-rules/:id`
   carried from the day the column locks landed until 2026-08-16. Now a 400.

   `behaviorVersion` is the signal: a fingerprint over the fields that decide
   what a call DOES, derived at the mapping boundary and stored nowhere, so it
   cannot drift from what it describes - the objection to a `version` column
   does not apply to a function of the thing itself. Excluded on purpose:
   display fields, lifecycle (already `state`), and key rotation, because a
   signal that fires on a key rotation gets filtered out and takes the real
   repoint with it.

   Not built: a `sunsetAt` that stops resolution on a date, and any ordering
   claim on `behaviorVersion`. Both would promise something nothing enforces.