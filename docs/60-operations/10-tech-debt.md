# Tech-debt register (TD-NNN)

Append-only IDs, never reused. Path pinned by the org taxonomy section 4.

Per the platform's deviation discipline
(`140-repo-governance-standard.md`, execution model): a standard clause that
cannot yet be met because an upstream dependency is not ready must be
(1) annotated at the implementation site, (2) registered here by name
(clause / reason / recovery condition), and (3) reported to the platform line.
Silent deviation fails self-rectify acceptance.

This file records the debt, not how it was found or fixed. **A closed entry
keeps its row in the table below and nothing else** - the investigation, the
options weighed and the fix all live in the commit that closed it, which is
where git already keeps them. Detail sections exist only for OPEN entries,
because those are the ones still needing a decision.

## Open

| ID | Title | Opened |
|----|-------|--------|
| [TD-001](#td-001) | Beta tier dormant - no beta host, so `beta-*` tags deploy nothing | 2026-07-24 |
| [TD-003](#td-003) | A1/A3 served by Zhipu only; A2 parse implemented but no vision model registered | 2026-07-24 |
| [TD-004](#td-004) | S2S caller half (platform BFFs, varda) not evidenced as wired to Atlas | 2026-07-24 |
| [TD-009](#td-009) | Grant admin UI has no `taskProfile` field | 2026-07-27 |
| [TD-016](#td-016) | Quota gate stays permissive for uncovered workspaces | 2026-07-28 |
| [TD-019](#td-019) | `atlas.parse` cannot be advertised honestly | 2026-07-28 |
| [TD-034](#td-034) | Gateway API keys authenticate nothing, and have no consumer to wire them to | 2026-08-14 |
| [TD-037](#td-037) | `request_records` attempt semantics differ between the chat and S2S surfaces | 2026-08-16 |
| [TD-038](#td-038) | `model_policies` has no history - value columns are overwritten in place and the read has no `asOf` | 2026-08-16 |
| [TD-039](#td-039) | Nothing checks that a column a repository writes is a column `atlas_svc` may write | 2026-08-16 |
| [TD-040](#td-040) | A partition's grants depend on how many times db-init has run | 2026-08-17 |
| [TD-041](#td-041) | The retired `/capability` path names have a sunset date and nothing that reads it | 2026-08-17 |
| [TD-042](#td-042) | `/v1/endpoints` and `/tenancy/grants` keep the words X-4 renamed everywhere else | 2026-08-17 |
| [TD-043](#td-043) | Two grant resources, two rules on whether the application scope may be edited | 2026-08-17 |
| [TD-044](#td-044) | The tool-descriptor `version` field never moves, so its drift signal is dead | 2026-08-18 |
| [TD-045](#td-045) | `codeql.yml` disabled - code scanning on a private repo needs GitHub Advanced Security | 2026-08-24 |
| [TD-046](#td-046) | Reasoning-model output (`reasoning_content`) is parsed for diagnostics but never delivered | 2026-08-24 |
| [TD-047](#td-047) | Token splits are recorded but cost is still not computable - no cached-input price, and the splits are not readable through the API | 2026-08-24 |

## Closed

| ID | Title | Closed |
|----|-------|--------|
| TD-002 | Usage-metering write path was a no-op | 2026-07-28, by TD-017 |
| TD-005 | Service code referenced Prisma models removed by the DB split | 2026-07-28 |
| TD-006 | Provider API keys were env-var only; rotation required a redeploy | 2026-07-26, see [ADR-003](../30-design/decisions/ADR-003-provider-key-vault-envelope-encryption.md) |
| TD-008 | No `GET /.well-known/vxture-tools` capability-discovery endpoint | 2026-07-27 |
| TD-010 | A non-UUID `tenantId`/`applicationId` crashed as an unhandled 500 | 2026-07-27 |
| TD-011 | `model_grants.task_profile` shipped baseline-only; production never got the column | 2026-07-28 |
| TD-012 | `model_code` was sent verbatim as the upstream `model` field | 2026-07-28, `config.upstreamModel` |
| TD-013 | `model-platform` route prefix and package identity retired in favour of `atlas` | 2026-07-28 |
| TD-014 | Build provenance never reached the image; `/healthz` reported `version:"dev"` | 2026-07-28 |
| TD-015 | Capability discovery could not convey endpoint paths | 2026-07-28, product_210 §4.1a |
| TD-017 | Atlas recorded no usage anywhere | 2026-07-28, `reqlog` writes + C3 consume |
| TD-018 | `reqlog` partitions ran out 2027-01, then retention broke silently | 2026-07-28 |
| TD-020 | Branch protection was advisory for repo admins | 2026-07-28 for atlas/platform |
| TD-021 | `/capability/*` had no operator-identity verification | 2026-07-29 |
| TD-022 | Embed / parse / rerank looked up grants by workspace id in the tenant column | 2026-08-06 |
| TD-025 | The model admin API accepted `protocol` on update, which the database refused | 2026-08-06, `98_column_locks.sql` states the `model.models` rule |
| TD-007 | Provider-key vault had no operator UI | 2026-08-12, opera `atlas/providers` page wired live to `/capability/provider-keys*` |
| TD-028 | No Endpoint / Router management API | 2026-08-12, `/capability/endpoints*` shipped |
| TD-029 | No management API for gateway-caller API keys | 2026-08-12, `/capability/api-keys*` shipped, CRUD-only |
| TD-030 | No provider health data / gateway performance metrics | 2026-08-12, both A and B shipped |
| TD-031 | `GET /capability/usage-summaries` was a permanent empty stub, not "no usage yet" | 2026-08-12, rewired to aggregate `reqlog.request_records` |
| TD-032 | ACR image push failed on the attestation manifest - first real deploy never completed | 2026-08-12, `v0.3.1` deployed to production and verified live |
| TD-027 | Sonar had never scanned Atlas: org private-LOC quota full, wrong project key | 2026-08-10 |
| TD-023 | Nothing stopped the esbuild decorator-metadata trap recurring | 2026-08-13, DI guardrail + boot smoke |
| TD-026 | Third-party actions on mutable tags in the credential path | 2026-08-16, all seven `docker/*` + Sonar refs pinned to full SHAs; dependabot raises them by the version comment |
| TD-036 | S2S guard read `scope` and never compared it | 2026-08-14, `verifyS2sToken` asserts scope; rejection `S2S_TOKEN_WRONG_SCOPE` |
| TD-024 | `reqlog.request_records.usage_type` was never written by the request paths | 2026-08-16, chat/S2S writes default to `normal`, probe writes `test`; `retry` stays a reserved value with no emitter |
| TD-033 | `created_by`/`updated_by` unpopulated on six registry tables | 2026-08-16, decided: `audit.change_records` is the authoritative attribution; the columns stay, documented as superseded |
| TD-035 | Body `workspaceId` on embed/rerank/parse was validated as required, then ignored | 2026-08-16, body value is now the fallback when the token carries no `workspace_id` claim; token claim always wins |
| TD-038 | `model_providers`/`models` carried three columns the service cannot write | 2026-08-16, column locks narrowed to what the service actually writes (incr/12); columns kept, retiring them is a destructive migration for a cosmetic gain |

TD-020 remains open in karda / arda / template, tracked in those repos
(`karda`#82, `arda`#187, `template`#37) - outside this repo's write-scope.

---

## TD-001

**Clause not met**: `140-repo-governance-standard.md` section 4 - product repos
run two tag-to-env tiers, `beta-*` to beta and `v*.*.*` to production.

**State**: production runs on worker-02:3100 (`/srv/md0/atlas`, tailnet class
2). The beta tier has no host, so a `beta-*` tag would deploy nothing and fail
confusingly; it stays out entirely.

**Recovery**: a dedicated beta host is assigned, then wire a `beta` GitHub
Environment (no reviewer gate) and a beta port pair.

**Annotated at**: `.github/workflows/deploy.yml` header, `docs/50-deployment/00-index.md`.

## TD-003

**Missing**: `POST /v1/embed` and `POST /v1/rerank` are served by Zhipu only -
any other provider returns `501 MODEL_NOT_IMPLEMENTED`. `POST /v1/parse` is
implemented provider-agnostically (`OpenAiCompatibleProvider.parseDocument`,
gated on `config.supportsVision: true`) but no registered model carries that
flag, so the endpoint answers an in-contract 501.

**Why deferred**: which upstream model to buy is a product/cost decision, not
an engineering one (owner 2026-08-10: parse deferred for the MVP; atlas stays
focused on language capabilities). The contract layer is deliberately complete
without it - see
[ADR-002](../30-design/decisions/ADR-002-s2s-provider-surface-contract-layer-only.md).

**Recovery**: for A1/A3, a second provider lands when procurement decides one.
For A2, zero code: register a genuinely vision-capable model
(`config.supportsVision: true` + working credentials + correct upstream model
id), verify a real parse call, then publish `atlas.parse` (TD-019).

## TD-004

**Missing**: the caller half of S2S auth. Atlas verifies inbound tokens
(`S2sAuthGuard`, product_210 §3.3), and `console-bff` has cut over to
`/tenancy/*`. Still outstanding: `admin-bff` and `agent-server/varda` pointing
at Atlas's network address with minted S2S tokens - no closing evidence names
either caller, so the debt stays open until verified against them.

**Why not fixed here**: those callers live in `vxture-platform`, out of this
repo's write-scope.

**Recovery**: `vxture-platform` wires and evidences the two named callers;
then close this entry.

## TD-009

**Missing**: the opera grants page has no `taskProfile` input, though the
grant CRUD API accepts and returns it. Operators can only configure
task-profile routing by calling the API directly.

**Why not fixed here**: no `portals/` in this repo; the operator UI lives in
`vxture-platform`'s opera portal. Owner decision 2026-08-10: model management
moves to the opera product later, deliberately not scheduled in atlas.

**Recovery**: opera adds the field via the same interim `/capability/*`-proxy
pattern used for provider-keys, or the future opera-side model-management
module carries it.

## TD-016

**State**: `PlatformEntitlementClient` exists and the quota gate can deny when
the platform reports a workspace's pools exhausted. What stays permissive is the
*uncovered* case - a workspace the platform has no entitlement record for.

**Why**: the platform's `atlas` plan catalog is still a draft skeleton with no
published `plan_version`. Denying on "uncovered" today would deny everyone.
The fail-open doctrine itself is
[ADR-001](../30-design/decisions/ADR-001-fail-open-quota-usage-doctrine.md).

**Recovery**: the platform publishes a real `atlas` plan_version; the uncovered
branch then flips from permit to deny.

## TD-019

**Wrong**: `ToolDescriptor` (product_210 §4.1) can express `deprecated`
(retiring) but not "defined, not yet served". `atlas.parse` is in the second
state - the code path is complete but no vision-capable model is registered -
and publishing it as formally identical to the three served capabilities
would tell a consumer it is available, which it learns otherwise by 501.

**Interim**: `atlas.parse` is withheld from the published manifest. The
descriptor stays in source behind a flag, so restoring it is a one-line change.

**Recovery**: a registered, verified vision model (see TD-003), or a maturity
field on the descriptor (`vxture-platform`#159).

## TD-034

**Wrong**: `key.gateway_api_keys` supports issue / rotate / activate /
deactivate / revoke, and the keys authenticate nothing. `/v1/*` accepts only an
OIDC S2S bearer token. `last_used_at` can therefore never be anything but NULL.

Not scheduled because **there is no caller to wire it for**: the `internal`
kind is retired (sibling products hold OIDC clients - a long-lived shared
secret would be a downgrade), and the `external` kind's only real case is a
third-party partner, which does not exist while Atlas is tailnet-only and
`atlas.vxture.com` stays unbound. Whether one exists is a business decision.

**Recovery**: when an external partner is signed, wire `external` keys to
`/v1/*` authentication and populate `last_used_at` in the same change -
without it an operator cannot identify a dormant key, so rotation and
revocation have no evidence to act on. Until then the surface stays
management-only and says so.

**Not a candidate for deletion**: the management surface is complete and
correct, and rebuilding it when a partner arrives would be pure churn.

## TD-037

**Wrong**: the two request surfaces write different `request_records`
semantics for failover. The chat path writes ONE row per logical request -
intermediate failed candidates appear only in logs and Prometheus counters -
while the S2S path (`withRequestLog` inside `runWithS2sFailover`) writes a
`status: error` row per failed attempt plus the final row, sharing one
`requestId` when the caller supplied one. Same table, different grain:
count-based rollups are not comparable across surfaces, and chat's failed
upstream attempts (which burned provider spend) are invisible to reqlog.

**Recovery**: pick one grain and apply it to both surfaces. Candidate: one
row per attempt with the attempt index carried explicitly, so per-provider
error rates come from reqlog rather than metrics. Wants its own change with
rollup queries reviewed together (`usage_type = 'retry'` is the reserved
vocabulary for non-first attempts, see TD-024's closing row).

## TD-038

**Wrong**: `model_policies` has no history. Every value column
(`priority`, `max_concurrent`, `rate_limit_rpm`/`tpm`/`tpd`,
`max_context_tokens`, `name`) is granted UPDATE and is overwritten in place,
and `GET /capability/policies` has no `asOf` filter. The sibling table
`model_price_rules` is the opposite - UPDATE is revoked on every value column
and reads accept `?asOf=` - and the two were described as one thing
("append-versioned") in the operation-code letter to platform, which is how a
step-up recommendation ended up resting on a property only one of them has.

The prior values are not lost - `audit.change_records` has them - but they are
reachable only by reading an audit trail, not by asking the policy surface what
was in force at a time. A rate limit raised and lowered back leaves the row
identical and the incident window unanswerable from the resource itself.

**Recovery**: either give policies the price-rule treatment (revoke UPDATE on
the value columns, append a new version, add `asOf` to the read) or state
plainly that policies are current-state-only and point the history question at
`audit.change_records`. The first is the consistent answer and costs a DDL
increment plus an append-on-write path; the second costs a paragraph. Not
decided - it changes what an operator can do, so it is the owner's call.

**Do not** close this by adding `asOf` to the read alone. There would be
nothing behind it: with in-place UPDATE there is only ever one version per row,
so the filter would answer every `asOf` with the current values and look like
history.

## TD-039

**Wrong**: nothing checks that a column a repository writes is a column
`atlas_svc` may write. `98_column_locks.sql` narrows UPDATE per column, Prisma
call arguments are `Record<string, unknown>` throughout this repo, and the two
meet only at runtime as `permission denied for table ...` - a 500 on an
operator route, with no type error, no test failure and no lint warning
anywhere upstream of it.

That is not hypothetical: `PATCH /capability/price-rules/:id` accepted seven
value fields the database grants UPDATE on none of, from the day the column
locks landed until 2026-08-16, and no test covered it because the tests mock
the repository. Found by reading the DDL against the service, then confirmed
against postgres:18 with the full sequence applied.

**Recovery**: DONE 2026-08-17 - `scripts/guardrails/check-column-writes.mjs`,
in CI. It resolves every `Update*Input` property through the TypeScript checker
(four of the six are `Partial<Pick<...>>`, so a regex would be wrong exactly
where a mistake hides) and compares against the grants parsed from
`98_column_locks.sql` + `incr/`.

Measuring it found **seven live 500s** nobody had hit: `models.model_type`,
`models.provider` (not a column at all - derived on read),
`model_grants.agent_id`/`application_id`/`application_type`, and
`model_policies.tenant_id`/`effective_at`. All seven now refuse with a 400.
Two existing tests were ASSERTING the broken behaviour and passed the whole
time, because the service tests mock the repository away.

**Still open**, which is why this entry stays: repositories writing untyped
object literals are invisible to the check - only named `Update*Input` types
are covered. The admin surface is done; the rest of the write surface is not.
Also note the scope asymmetry it surfaced - TD-043.

**Related**: TD-013's note that `PrismaArgs` erases field names is the same
root cause seen from the rename side rather than the permission side.

## TD-040

**Wrong**: whether a reqlog partition carries its own privileges depends on how
many times db-init has been applied, not on anything anyone decided.

`97_service_role.sql` grants `ON ALL TABLES IN SCHEMA`, evaluated at the moment
it runs. On a first apply the partitions do not exist yet, so they get none. On
every apply after that they do exist, so they get explicit `SELECT`/`INSERT`/
`DELETE` of their own - 749 snapshot rows' worth. Partitions created later, by
`ensure_partitions` at runtime between db-init runs, again get none.

So one table's months carry different grants, and reading a privilege audit
means knowing which db-init created which month. Nothing breaks: access goes
through the partitioned parent, which is where the check happens. But "these
two months have different grants" is not an answer anyone can act on.

Measured 2026-08-17 while proving ADR-006's fold equivalent: the old chain
(baseline + 15 increments) and the consolidated baseline drift by exactly the
same 749 rows on a second apply, so this is pre-existing and shared, not
introduced by the fold. Steady state is identical between the two.

**Recovery**: either grant on the parent only and stop relying on
`ON ALL TABLES` sweeping partitions in, or have `ensure_partitions` issue the
grants it needs when it creates a partition, so every month is identical
whenever it was made. The second is closer to how the rest of this DDL treats
grants - stated with the thing they cover.

**Not** a reason to stop re-applying db-init. Re-apply is how the partition
runway rolls forward, and the drift is additive.

## TD-041

**Wrong**: the retired operator path names carry a sunset date that lives in a
code constant and one sentence of prose, and nothing reads either.

#206 renamed three resources and serves both spellings for a window. Deleting
the old ones is gated on `capability_legacy_path_requests_total{path,operator}`
reading zero - deliberately, so an operator still calling an old path gets a
conversation rather than an outage. `CAPABILITY_PATH_SUNSET` is 2026-09-16, and
the design says that date is a floor, not a trigger.

Which leaves the actual removal depending on somebody remembering, in September,
that there is a counter worth looking at. Nothing scrapes it, nothing alarms on
it, and no checklist names the date.

This is the same shape this repo reported against itself twice in the same week:
a correction written down and never sent, and a release promise made in an issue
and never kept through three versions. Both failed the same way - the obligation
existed, and nothing tracked its due date. Recording that here is the minimum
that makes this one different.

**Recovery**: either an alert on the counter (non-zero after the sunset date is
the interesting condition, not zero before it), or a dated entry in the workplan
that says "read the counter, then decide". The alert is better - it answers
"has opera cut over" continuously, where a checklist answers it once.

**Not** urgent, and not a reason to delete early. Both spellings serving is the
correct state until the counter says otherwise; the debt is that nobody will be
told when that is.

## TD-042

**Wrong**: `GET /v1/endpoints` and `GET /tenancy/grants` still carry the words
that product_251 X-4 renamed on the operator plane, and the "separate window"
they were deferred to does not exist.

#206 renamed `endpoints` -> `model-routes` and `grants` ->
`tenant-model-grants` on `/capability/*`. The same words remain on the data
plane, deliberately excluded from that change and named as excluded in
`docs/20-specs/10-http-surface.md`, because the consumers there are products
rather than one console - a wider blast radius that deserved its own window.

Deferring to a window nobody opened is not deferring, it is dropping. So the
exclusion is registered here rather than left as a sentence in a spec.

The X-4 obligation is met either way: the clause forbids one word carrying an
Nth meaning, and these two carry the SAME meaning as their operator-plane
counterparts. What is left is consistency, not a defect - the operator console
and the agent-facing list use two words for one thing.

**Recovery**: the same additive shape #206 used - serve both spellings, stamp
`Deprecation`/`Sunset` on the retired one, gate removal on a counter. The audit
fold does not apply (the data plane is not audited into
`audit.change_records`), so this is the smaller half of what #206 did.

**Blocked on nothing.** It needs a liaison round with karda and vxtpl first,
because unlike opera they were not part of the #206 conversation and have not
agreed to the names.

## TD-043

**Wrong**: `model_grants` and `product_endpoint_grants` disagree about whether a
grant's application scope may be edited, and nothing says which is intended.

Measured 2026-08-17 from `information_schema.column_privileges`:

```
product_endpoint_grants   application_id, application_type   UPDATE granted
model_grants              application_id, application_type   no UPDATE
```

Two resources of the same kind, on the same console, with opposite rules. The
tenant-axis half was worse than merely inconsistent: the service accepted the
fields and handed them to Prisma, so the request came back
`permission denied for table model_grants` - a 500 (TD-039). That half is fixed;
the fields are now refused with a 400 saying to deactivate and re-create.

**What is NOT decided**: whether that refusal is the right rule. The
product-axis sibling permits the edit, and the argument for immutability -
"repointing is a revoke plus a create, so both stay in the audit trail" - is the
one this repo already made for `product_endpoint_grants`'s OWN identity fields,
while deliberately leaving its scope editable. So the precedent cuts both ways.

**Recovery**: pick one and make both match.

- If scope should be editable on both, a db-init increment grants
  `application_id` / `application_type` on `model_grants`, mirrored into
  `98_column_locks.sql`, and the guard added today is removed.
- If it should be immutable on both, an increment REVOKEs them on
  `product_endpoint_grants` and that resource gets the same guard.

Either is a small change. The reason this is registered rather than decided is
that it is a product question about what an operator is allowed to do, not a
technical one - and picking the answer that happened to match the current DDL
would be deciding it by accident.

## TD-044

**Wrong** was the first draft of this entry, not the situation it described.
It said D-1 has no pull channel for a not-yet-registered consumer, and
proposed building one. **Checked before building: a pull channel already
exists, was already correct, and yucer already had the credentials to reach
it.**

Reported by yucer (vxture-atlas#248): `taskId` becoming mandatory
(product_251 X-2, #230) was announced to every registered consumer - karda
(#101), vxtpl (#50). yucer was mid-onboarding and not on that list, so every
call to `/v1/*` answered `400 TASK_ID_REQUIRED` for seven point releases,
undetected because yucer's own CI never touches a real Atlas.

`.well-known/vxture-tools` (product_210 discovery, `S2sAuthGuard`) is the
same guard yucer's `/v1/chat` calls already pass - they were getting 400s,
not 401s, so their credentials were never the blocker. Its
`atlas.chat.input_schema.required` has listed `taskId` since #231, **which
shipped in the same PR window as #230 and the same release, v0.15.0**. Every
tag since (through v0.22.0) carries both. There is no released version where
polling this endpoint would have disagreed with what the runtime actually
enforced. yucer could have caught this on day one by reading a response they
were already authorized to fetch.

**So the real gap is narrower than "no channel exists" - it is two things:**

1. Nothing tells an integrating consumer that this endpoint is the thing to
   poll before depending on a contract. It is documented as a discovery
   surface, not advertised as a drift check.
2. `ToolDescriptor.version` is dead weight: every tool has shipped `"1.0.0"`
   since introduction (`tool-descriptors.ts`), including through the taskId
   change. A consumer diffing that one field - the cheap check yucer actually
   asked for - would see no change and be told nothing moved. Only a full
   schema diff would have caught it, which is the expensive check nobody
   wants to run per release.

**Recovery**: no new endpoint. Bump the affected tool's `version` on every
breaking change to its schema, as part of the same PR that makes the change -
same discipline X-1's error vocabulary already gets. Point yucer (and the
onboarding docs) at polling `.well-known/vxture-tools` and diffing
`input_schema` against their last-pinned copy, not just the version field,
until the version field can be trusted.

**Also registered against this repo's own process**: `docs/40-implementation/
40-l1-api-conformance.md` marks D-1 `process` rather than `met`. This is
consistent with what was found, not evidence of a missing channel - the
channel worked; nobody was told to use it, and its cheapest signal was never
maintained.

---

## TD-045 - `codeql.yml` disabled (Advanced Security required on a private repo)

**Clause:** `codeql.yml` runs SAST over the service source on every PR, every
push to `main`, and a weekly schedule - informational rather than one of the
required checks, but expected to run and report to the Security tab.

**Reason:** on `vxture-foundation/vxture-atlas` (private), `codeql-action/analyze`
completes the analysis every time and generates the SARIF; the **upload** is
then refused:

    Advanced Security must be enabled for this repository to use code scanning.

The workflow's `permissions:` block was also missing `actions: read` - a real
bug, fixed in the same commit - but fixing it only unmasks this. Code scanning
on a private repo requires GitHub Advanced Security, an Enterprise-tier licence
add-on that GitHub Team does not unlock. The old public repo ran this workflow
clean the entire time: code scanning is free on any public repo regardless of
plan, which is what the workflow's own header comment was asserting.

**Why disabled rather than left red:** it had failed on *every* run since the
repo went private - `main` pushes and unrelated dependabot PRs included. A
check that is permanently red teaches people to read red as normal, and the
next genuinely broken check inherits that habit. Registering the deviation
keeps the fact visible without spending the signal.

Same finding, same resolution as runos TD-021 - both repos moved to the same
private org in the same migration, and both carried the public-repo assumption
across in a comment nobody re-checked.

**Recovery:** either the org adds GitHub Advanced Security (Enterprise-tier),
or the repo goes public again. Either condition lets `codeql.yml` be
re-enabled with `gh api -X PUT .../actions/workflows/{id}/enable` and no
further changes - the `actions: read` fix in this commit is the only thing
that was actually wrong with the file.

## TD-046

**Reasoning-model output (`reasoning_content`) is parsed for diagnostics but
never delivered.**

`openai-compatible.ts` now reads `message.reasoning_content` (and the streaming
`delta.reasoning_content` is typed) for exactly one purpose: telling an operator
*why* a response came back empty. Nothing carries it any further - not to the
`/v1/chat` response body, not as a stream frame, not into `ChatMessage`.

Two consequences, one of them a hard failure:

1. A caller talking to a thinking model sees the answer but never the chain.
   That is a product decision Atlas has not made yet, and defaulting to "drop
   it" is defensible.
2. **DeepSeek rejects a multi-round tool-calling conversation whose assistant
   turns do not echo `reasoning_content` back** (api-docs.deepseek.com, 思考模式:
   "携带 tools 参数时必须在所有后续交互中完整回传，否则返回 400"). So function
   calling over more than one round against a thinking model is not merely
   degraded, it is unavailable - and it fails at the caller, not here.

**Why it is not fixed in the same change:** the field has to land somewhere in
the product_251 A-4 response shape, which is a three-party contract
(`docs/40-implementation/40-l1-api-conformance.md`), not a unilateral addition.
The streaming half additionally needs a new `StreamEvent` variant and a new
published error/event name.

**Recovery:** agree the field position with the platform line and karda, then
carry it through `ProviderChatResponse` -> `ChatResponse` and as a stream event.

## TD-047

**Token splits are recorded but cost is still not computable - no cached-input
price, and the splits are not readable through the API.**

The recording half is done. `reqlog.request_records` now carries
`cached_input_tokens` and `reasoning_tokens` (incr/01), both adapters read them
where the upstream reports them, and absent stays NULL rather than 0 - because
"the upstream said nothing" and "it cost nothing" are different facts. That half
was done first on purpose: **a price can be backfilled at any time, a token
count that was never written cannot.**

What remains is turning those numbers into money.

1. **`model_price_rules` has no cached-input price.** It carries
   `input_unit_price` / `output_unit_price` / `request_unit_price`, so the
   cached rate - 1/30 of the uncached one on DeepSeek, 0.10 vs 3.00 CNY per
   million at peak - cannot be expressed at all. The column was deliberately
   NOT added in the same change: a price column with no write path behind it is
   a column nothing fills, and its admin surface (create/update input, DTO
   validation, the column-write guard) is its own piece of work.

2. **Nothing reads the splits back out.** `/capability/logs` returns
   `RequestLogRecord`, which does not include them, so today the only way to see
   the numbers is SQL against `reqlog`. Adding them changes a published response
   shape (product_251 A-4), which is a three-party decision rather than a
   unilateral one.

3. **Peak/off-peak is not modelled.** DeepSeek bills the idle window at 50%
   (Beijing time, outside Mon-Fri 09:00-12:00 and 14:00-18:00). The window is
   derivable from `created_at` and needs no column, but it does need a home -
   provider `config.pricing` is the natural one, and that is data, not DDL.

**Recovery:** the cached-input price column plus its admin surface, then a cost
rollup that joins the splits against the rule effective at the row's
`created_at`. Cost stays a rollup, never a column on the request row: prices
change, and a money value frozen per request cannot be re-derived when they do.
Atlas meters, it does not bill - the rollup reports a derived estimate for the
internal cost pool and is separate from the tenant-facing token quota.
