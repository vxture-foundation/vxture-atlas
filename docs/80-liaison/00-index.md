# 80-liaison - Cross-org liaison

**Liaison goes through GitHub Issues, not files here**
(`140-repo-governance-standard.md` sec.10). Open the issue in the repo that has
to act, not the one that originated the ask - karda asking Atlas to change an
endpoint opens it in `vxture-atlas`. Label it `liaison`. Cross-repo references
use native `org/repo#N`.

Issue state is the source of truth; this file does not mirror it. Current open
threads are listed in `docs/60-operations/10-tech-debt.md` under the entry each
one blocks.

## Archived letters

The `NN-{YYMMDDHHMM}-{slug}.md` files here are the outbound record from the
file-based channel that preceded GitHub Issues. Only letters that were actually
sent or submitted are archived, and they are kept verbatim as history - not
migrated, not edited, not added to. Never-sent drafts are not archive material;
git history keeps them.

**This is an archive rule, not a theory about correcting letters.** A
correction does not happen in here at all - it happens in an issue, and the
"Superseded facts" section below records which statement is dead and which
issue carried the correction. `140-repo-governance-standard.md` sec.10 retired
this channel on 2026-07-27 for exactly this reason: an md letter has no
lightweight correction path, so the answer to "how do I correct a letter" is
"do not use letters". Editing an archived letter in place - even with a dated
withdrawal banner - re-opens the channel the standard closed, and reaches
nobody: the counterparty is not watching these files. Two such banners were
added on 2026-08-16 and have been reverted (`40-2608131600` in
`vxture-atlas`#227, `10-2607241030` here); their content lives below and in
`vxture-atlas`#226 / the karda correction issue.

One residual banner predates that: `10-2607241030` carries a 2026-07-27 status
note added during the channel transition. Left as found rather than rewritten
again.

**`40-2608131600` should not exist as a file.** It was created 2026-08-13,
seventeen days after sec.10 froze this directory, and should have been an issue
in `vxture-platform`. It is retained because it was genuinely submitted and is
the record platform decided against - but it is not a precedent, and
`scripts/guardrails/check-liaison-archive.mjs` now fails CI on any new file
here.

| Letter | To | Subject | State |
|--------|----|---------|-------|
| `10-2607241030-atlas-reply-to-karda-capability-requirements.md` | karda line | Answers on the G1 error split, A2.3 deployment affinity, A3.3 rerank latency (deferred to a real benchmark), plus tenant-filtered model list and `taskProfile` routing | Sent, `vxture-karda`#70 |
| `40-2608131600-atlas-operation-code-vocabulary.md` | platform line | Operation-code vocabulary for the operator RBAC catalogue (product_250 M-2), answering `vxture-atlas`#165 request 2 | Submitted; vocabulary is ours, `requires_step_up` marking is platform's. **Several statements superseded - see below; corrections sent as `vxture-atlas`#226** |

### Superseded facts

Sent letters are never edited, so statements inside them can go stale. Current
truth for the known-stale points:

- `10-2607241030`:
  - **The G1 quota-exhaustion contract it promises is wrong - do not implement
    from the letter.** It promises
    `403 {"code":"QUOTA_EXHAUSTED","resetAt":"<ISO8601|null>"}` and states the
    shape will not change again. `quota.service.ts` has thrown `QUOTA_EXCEEDED`
    since day one and nothing anywhere throws `QUOTA_EXHAUSTED`; `resetAt` was
    never assigned and cannot be under the current C2 contract
    (`QuotaPoolView` carries `metric`/`limit`/`remaining`/`priority` and no
    reset time). karda's `suspended_quota` branch keyed on the promised code
    therefore never fired. Correct shape is
    `403 {"code":"QUOTA_EXCEEDED","message":...,"retryable":false}`, where
    `retryable:false` is the machine-readable "suspend, do not retry" signal.
    Sent to karda as `vxture-karda`#100 - on 2026-08-16, and only after the
    banner claiming it had already been sent was found to be false. That banner
    was the third correction in two days that existed only inside this repo.
  - The `/model-platform/*` paths it cites were retired; the data plane is
    `/v1/*` (see `docs/20-specs/10-http-surface.md`).
  - The A3.3 promise (benchmark rerank at 100 candidates and write back) was
    delivered 2026-08-10: production P95 550 ms at 100 candidates
    (P50 425 / P90 532 / P99 805 / max 983 ms), reported in `vxture-karda`#89.
- `40-2608131600`:
  - The "no delete on price-rules/policies - do not register
    `atlas.price_rule.delete` / `atlas.policy.delete`" guidance is superseded:
    soft DELETE routes exist on both resources (since 2026-08-14), so those two
    codes SHOULD now be registered. **Told to platform 2026-08-16 in
    `vxture-atlas`#226** - it had been recorded here since 2026-08-14 and never
    sent, which is the failure this row now also documents: a correction that
    lives only in the sender's index has not been made.
  - The whole "Commercial and policy - append-versioned, never deleted" section
    rests on three claims, and only one holds. Verified 2026-08-16 against
    postgres:18 with the full DDL sequence applied, as `atlas_svc`:
    - `model_price_rules` IS append-versioned - UPDATE is revoked and granted
      back only on `is_active`/`expires_at`/`deleted_at`/`updated_by`/
      `updated_at`.
    - `model_policies` is NOT. UPDATE is granted on every value column
      (`priority`, `max_concurrent`, `rate_limit_rpm`/`tpm`/`tpd`,
      `max_context_tokens`, `name`), so a policy change is an in-place
      overwrite.
    - "the database withholds the grant" is wrong in general:
      `97_service_role.sql` grants `SELECT, INSERT, DELETE` across the whole
      `model` schema, and `incr/10` grants `UPDATE (deleted_at)` on both tables.
    - "every version stays queryable via `?asOf=`" holds for price rules only;
      `GET /capability/policies` has no history query at all.
  - Consequently the letter's `requires_step_up: no` INPUT for
    `atlas.policy.update` is withdrawn - it was argued from reversibility and
    `?asOf=`, and policies have neither. Revised input is `yes`, sent in #226.
    The marking remains platform's decision (M-2).
  - Five action routes are listed as `PUT` and are `POST`:
    `provider-keys/:id/activate|deactivate` and
    `api-keys/:id/activate|deactivate|revoke`. The operation codes are
    unaffected, so nothing already registered needs re-issuing.
  - `PATCH /capability/price-rules/:id` accepted every value field until
    2026-08-16 and now accepts only `expiresAt`; changing a price is `POST` a
    new version, then expire the old one. Before that it handed those fields to
    a database that grants UPDATE on none of them, so a price edit answered 500.
  - The submitted vocabulary predates `atlas.product_grant.*`,
    `atlas.provider_key.delete`, and `atlas.gateway_api_key.delete`; the list
    in the letter is no longer the complete set.

## Inbound

Inbound letters live in the sending repo - one subject, one master copy. Only
the receipt is recorded here.

| Letter | From | Subject | Local follow-up |
|--------|------|---------|-----------------|
| `vxture-karda/docs/80-liaison/100-2607240931-karda-atlas-capability-requirements.md` | karda line | Field-level requirements for A1 embedding / A2 parse / A3 rerank; priority A1 > A3 > A2 | Design input for `docs/30-design/200-s2s-provider-surface.md`; open provider work is TD-003 |
| `vxture-karda/docs/80-liaison/70-2607232158-karda-atlas-contract-request.md` | karda line | Earlier model-call contract request | Superseded by the above |
| `vxture-platform` product_210 v1.1 §11 + `41-atlas-integration-topology.md` §7 | platform line | Cross-repo fact-sync governance, authoring division, and a 7-item self-check for any L1 provider's new or breaking S2S contract change | Applies to every change to the supplier surface |
| `vxture-atlas`#165 (opened by platform) | platform line | step-up criterion and enforcement belong to platform/console; remove `StepUpRequiredGuard` and register an operation-code vocabulary | `StepUpRequiredGuard` removed (request 1); vocabulary submitted as `40-2608131600` (request 2) |
