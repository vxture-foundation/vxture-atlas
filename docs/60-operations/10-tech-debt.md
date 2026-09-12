# Tech-debt register (TD-NNN)

Append-only IDs, never reused. Path pinned by the org taxonomy section 4.

Per the platform's deviation discipline
(`140-repo-governance-standard.md`, execution model): a standard clause that
cannot yet be met because an upstream dependency is not ready must be
(1) annotated at the implementation site, (2) registered here by name
(clause / reason / recovery condition), and (3) reported to the platform line.
Silent deviation fails self-rectify acceptance.

**An entry blocked on another repo must name the issue there, by number.**
Point (3) above says "reported to the platform line"; what it did not say is
that the report has to be findable from here afterwards. It does now, because
the difference is not cosmetic: TD-009 was annotated "not fixed here, belongs
to opera" on 2026-08-10 and no issue was ever opened in the repo that has to
act. For sixteen days it was recorded on our side and absent from the queue
where it would have been scheduled, while two consumer requests waited on it.
An entry that says "belongs to X" without a number is indistinguishable from
one that was reported - which is the shape this repo keeps producing.

Recorded so far: TD-009 -> `vxture-platform/vxture-platform#52`,
TD-047 -> `#47`. **Still carrying no number: TD-004, TD-016,
TD-034.** Those three are named here rather than left to be noticed, because a
convention stated without its current exceptions reads as already satisfied.
TD-034 arguably has nothing to file (it waits for a consumer to exist at all);
TD-004 and TD-016 do, and have not been.

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
| [TD-053](#td-053) | `model_policies` has no history - value columns are overwritten in place and the read has no `asOf` | 2026-08-16 |
| [TD-039](#td-039) | Nothing checks that a column a repository writes is a column `atlas_svc` may write | 2026-08-16 |
| [TD-040](#td-040) | A partition's grants depend on how many times db-init has run | 2026-08-17 |
| [TD-041](#td-041) | The retired `/capability` path names have a sunset date and nothing that reads it | 2026-08-17 |
| [TD-042](#td-042) | `/v1/endpoints` and `/tenancy/grants` keep the words X-4 renamed everywhere else | 2026-08-17 |
| [TD-043](#td-043) | Two grant resources, two rules on whether the application scope may be edited | 2026-08-17 |
| [TD-044](#td-044) | The tool-descriptor `version` field never moves, so its drift signal is dead | 2026-08-18 |
| [TD-045](#td-045) | `codeql.yml` disabled - code scanning on a private repo needs GitHub Advanced Security | 2026-08-24 |
| [TD-047](#td-047) | Cost and its off-peak window are modelled; the splits are still unreadable outside SQL, and no provider carries a policy row yet | 2026-08-24 |
| [TD-048](#td-048) | `incr/NN` means two different files depending on which side of the rebaseline you read | 2026-08-26 |
| [TD-050](#td-050) | A credential exposure is tracked only in a published document, so no release checklist can see it | 2026-08-26 |
| [TD-051](#td-051) | The published contract states what is required, not what a surface accepts or can refuse with | 2026-08-26 |
| [TD-052](#td-052) | Label routing exists only on the retiring tenant axis, so asking for a label drags a tenant along | 2026-08-26 |

## Closed

| ID | Title | Closed |
|----|-------|--------|
| TD-046 | Both protocol adapters drop reasoning output, which makes multi-round tool calling structurally impossible on either | 2026-09-12, `ChatMessage.reasoning` as an opaque envelope carried through both adapters plus a `reasoning` stream event; `done` carries the whole envelope so a caller never has to rebuild one (platform#50) |
| TD-049 | `chat()` and `chatStream()` are parallel implementations of one routing loop | 2026-08-26, the shared steps extracted; duplication on new code 16.1% -> 0.0% |
| TD-037 | `request_records` attempt semantics differ between the chat and S2S surfaces | 2026-08-26, one row per attempt on both surfaces; `attempt_index` (incr/03_reqlog_attempt_index) carries the ordinal |
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

**Recovery, as first written**: opera adds the field via the same interim
`/capability/*`-proxy pattern used for provider-keys, or the future opera-side
model-management module carries it.

**2026-08-27: that recovery is withdrawn, and the entry is downgraded.** Adding
a `taskProfile` input would be building operator UI for the tenant axis that
`model_grant_authorizations_total{axis}` is counting down to removal. A product
integrating today wants `endpointCode`, and the product axis
(`product_endpoint_grants`) already has full CRUD - list, create, patch,
activate/deactivate, delete - so nothing is blocked on this.

Withdrawn on `vxture-platform#52`, which this repo had opened the day before
without questioning the axis. Root cause TD-052; the correction to the consumer
that was steered here is `vxture-atlas#47`.

**What remains true**: task-profile routing is configurable only through the
API, not the console. That is now a property of a retiring feature rather than
a gap to close, and it closes when the axis does. If opera turns out to lack a
management surface for the PRODUCT axis, that is a separate and real gap - not
this one, and not asserted here, because opera's surface is not this repo's to
describe.

**Filed 2026-08-26: `vxture-platform/vxture-platform#52`.** It had been marked
"not fixed here, belongs to opera" since 2026-08-10 and was never opened in the
repo that has to act - so for sixteen days it was recorded on our side and
absent from the queue where it would have been scheduled. Two consumer requests
were waiting on it the whole time (vxture-atlas#4, #39), and one of them is now
taking a `404 TASK_PROFILE_NOT_ROUTABLE` in production on every call by the
consumer's own decision, which turns this from dormant debt into someone
actively waiting.

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

## TD-053

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

**Now two counters, two dates** (2026-08-29): TD-042 closed its own half by
serving both data-plane spellings, which added
`data_plane_legacy_path_requests_total{path,product}` with a sunset of
2026-12-16. Nothing reads that one either. Recorded here rather than as a second
entry because it is one gap, not two - and a gap that grows a second instance
while still unfixed is worth saying out loud: the mechanism this entry asks for
is now the difference between two renames landing and two renames finishing.

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

**Done 2026-08-29**: `data-plane-route-names.ts` +
`runtime/legacy-data-plane-path.ts`; both spellings registered on
`ModelRuntimeController` and `TenancyController`; sunset `2026-12-16` (later
than the operator plane's, because this window moves karda and vxtpl rather than
one console on our own release train); counter
`data_plane_legacy_path_requests_total{path,product}`. Surface documented in
`docs/20-specs/10-http-surface.md`.

**Still open, and this is now the whole of it**: the retired spellings are still
served. Removal needs the counter to read zero, and *that* is the point karda
and vxtpl have to agree on.

The earlier note here said this "needs a liaison round with karda and vxtpl
first". **That was wrong about the first half.** A liaison round is needed to
REMOVE a name, not to ADD one: the additive shape breaks nobody, and the
interface rules say plainly that a rename does not need three parties to agree,
because a name stating its object cannot collide with someone else's. Requiring
agreement to start is how this entry sat for twelve days as a "deferral" that
was really a drop - the exact failure its own first paragraph names.

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

## TD-047

**Cost and its off-peak window are modelled; the splits are still unreadable
outside SQL, and no provider carries a policy row yet.**

**Item 1 of three closed 2026-08-26:** `GET /capability/logs/cost` exists;
the arithmetic lives in `computeCostRollup`, outside SQL, and its three failure
modes are assertions with pinned mutations in `scripts/audit`. How that was
built is in the commit.

**The remaining operational write is filed as
`vxture-platform/vxture-platform#47`** (2026-08-26): no provider row carries
`config.pricing.offPeak`, and the operator console has nowhere to set it. Until
it is set, cost is computed at peak price for the whole week - on DeepSeek about
79% of the hours are overstated by roughly double. It is not silently wrong:
`coverage.requestsWithoutPricingWindow` reports how many rows had no window.

The two items below remain, and the original text is kept because both are still
exactly as described.

Both halves of the recording are done. `reqlog.request_records` carries
`cached_input_tokens` and `reasoning_tokens` (incr/01) and both adapters fill
them where the upstream reports them; `model_price_rules` carries
`cached_input_unit_price` (incr/02), accepted on create and refused on update
like every other value column, because a price rule is versioned by append.

Recording was done first because it is the irreversible half: a price can be
backfilled at any time, a token count that was never written cannot.

What remains is the arithmetic, and three things it needs.

1. ~~**No cost rollup exists.**~~ **Closed 2026-08-26** - see above. The
   principle it rested on still holds and is worth keeping visible: cost stays a
   rollup and never becomes a column on the request row, because prices change
   and a money value frozen per request cannot be re-derived when they do.

2. ~~**Peak/off-peak is not modelled.**~~ **Code closed 2026-08-26; the data
   action is not.** The window is verified rather than assumed - DeepSeek's own
   page states it in UTC ("Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC,
   Monday through Friday (all other hours are off-peak)"), which is the same set
   of instants as the Beijing phrasing below, and is what is stored because a
   timezone conversion is a place to be wrong that the UTC form does not have.
   35 peak hours of 168 means roughly **79% of the week is discounted**, so this
   was never a rounding correction.

   The window lives in `config.pricing.offPeak` on the provider row and is
   applied in `pricing-window.ts`; SQL only buckets requests by UTC hour-of-week
   (bounded at 168 groups per rule) so that which hours count as peak stays
   configuration rather than a query edit.

   **What remains is operational, and until it happens the number is still
   wrong in the same direction:** no provider row carries a policy yet, so
   every request is priced at peak. The response says so in
   `coverage.requestsWithoutPricingWindow` rather than presenting the total as
   exact. `DEEPSEEK_OFF_PEAK` in `pricing-window.ts` is the exact policy to
   copy, so the operator is not re-deriving it from prose.

   **That operational step has a foot-gun, added 2026-08-26 after the fact:**
   `PATCH /capability/providers/:id` sets `config` WHOLESALE - the repository
   passes the object to Prisma, which replaces the JSON column rather than
   merging. PATCHing `{ config: { pricing: ... } }` alone deletes the rest of
   that provider's config, and on DeepSeek the rest is `config.wire` - chat
   path, auth style, `streamUsage`, and the `extraBody` that switches thinking
   off. That is an outage, not a mis-estimate. Read the provider, merge
   `pricing` into its existing config, PATCH the whole object back. The hazard
   is now stated beside the exported constant as well, because a constant
   published "to copy" is what invites the unsafe copy.

   The original text, kept because it is what the code now implements:

   DeepSeek bills its idle window at 50%
   (Beijing time, outside Mon-Fri 09:00-12:00 and 14:00-18:00). The window is
   derivable from `created_at` and needs no column, but it needs a home:
   provider `config.pricing` is the natural one, and that is data, not DDL. It
   was deliberately not added while nothing read it - a configured switch that
   does nothing is the shape this repo keeps banning. **That reason expired on
   2026-08-26**: there is now a rollup to read it, so this is next, and until it
   lands every off-peak request is being estimated at twice its real rate.

3. **Nothing reads the splits back out.** `/capability/logs` returns
   `RequestLogRecord`, which does not include them, so today the only way to see
   the numbers is SQL against `reqlog`.

   **The reason this is still open was overstated, and is corrected here
   (2026-08-26).** It said adding them "changes a published response shape
   (product_251 A-4), which is a three-party decision". Checked rather than
   assumed: `/capability/*` has ONE consumer, the platform's BFFs, and
   `opera-bff/src/routers/atlas.router.ts` reads the body as
   `JSON.parse(text) as TResponse` - a TypeScript cast, no runtime schema, no
   `.strict()`. An additive nullable field cannot break it. Compatibility is
   not what holds this back.

   What does is a product question, and only for these two fields: whether
   cost-adjacent numbers belong in an operator's log view at all. That is a
   conversation, not a compatibility risk, and it does not generalise to every
   field. `attemptIndex` (TD-037) was let through on the same reasoning: it is
   an operational fact about routing, on the plane operations reads.

**Recovery:** a `config.pricing.offPeak` row on each provider that discounts
(the code to read it is in place as of 2026-08-26);
and a three-party decision on whether `/capability/logs` starts returning the
splits (product_251 A-4 governs that shape). The route chosen for the rollup was
its own (`/capability/logs/cost`) rather than extra fields on
`/capability/logs/summary`, for the same A-4 reason: adding a route is
unilateral, changing a published shape is not.

Atlas meters, it does not bill - what the rollup reports is a derived estimate
for the internal cost pool, separate from the tenant-facing token quota. It is
labelled as such in the response itself (`basis`), not only here: a reader who
does not know reasoning tokens are excluded from the sum will reconcile against
the provider's invoice and conclude the meter is broken.

## TD-048

**Wrong**: `incr/NN` identifies two different files. ADR-006 folded
`incr/01`..`incr/15` into the baseline and the directory restarted at `01`
(`deploy/database/ddl/incr/README.md` states the restart explicitly, so the
numbering is correct). What did not restart is the prose: comments across the
service still cite the OLD numbers - `request-log.service.ts` points at
"incr/03_reqlog_endpoint_code.sql" while `incr/03_reqlog_attempt_index.sql` is
what exists, and `incr/01`, `incr/02`, `incr/05`, `incr/12`, `incr/13`,
`incr/14`, `incr/15` appear in the same ambiguous bare form elsewhere.

This is TD-038's shape one directory over: a stable identifier that means two
things depending on when it was written. Nothing breaks; a reader follows the
reference to the wrong file and reasons from it.

**Interim**: new references use the full slug (`incr/03_reqlog_attempt_index`),
never the bare number.

**Recovery**: rewrite the historical citations to name what the change WAS
rather than which file carried it ("the increment that added endpoint_code"),
since those files no longer exist to be pointed at. A guardrail could enforce
the slug form on new references; whether that earns its place is a judgement
about how often this is written, not a certainty.

## TD-050

**A credential exposure is tracked only in a published document, so no release
checklist can see it.**

The exposure itself is not new and is not in dispute. On 2026-08-17 a container
environment dump was caught by `git add -A`, committed and pushed. Four secrets
were in it: the vault master key SET (`PROVIDER_KEY_ENCRYPTION_KEYS`), an
upstream provider key, the C3 webhook secret, and the database password. The
branch was deleted and the PR closed, but GitHub retains a PR head ref
indefinitely, so the commit remains fetchable. Per this repo's secret
discipline the remedy is revocation and reissue at each source console, never
history rewriting.

**What this entry is about is the second failure, found on 2026-08-26 while
re-checking the published documents against the repo.** The full account of the
incident lives in one artifact - the produce-status document, section 08. There
is no row for it here, and `docs/` contains no other mention. The consequence is
specific rather than theoretical: the pre-release checks are assembled from this
register, so **every release since has been cut without the exposure appearing
anywhere in front of the person cutting it**, v0.7.0 included. An unregistered
open item and a closed one produce the same silence.

**Rotation status is unconfirmed.** This entry deliberately does not claim the
credentials are still live, and does not claim they have been rotated: neither
can be established from a developer machine. It is answerable in one of two
places - the issue timestamp on each credential in its own source console, or a
successful decrypt of existing ciphertext under a new `keyId`. Recording
"unknown" is the honest state; recording either alternative would be a fresh
instance of the defect this register exists to catch.

**The master key has a prerequisite that outlives this entry.**
`PROVIDER_KEY_ENCRYPTION_KEYS` is a `{keyId: key}` set. Rotation means ADDING a
new `keyId` and re-encrypting, never substituting the value: a straight
replacement leaves every stored ciphertext undecryptable, which takes the
service down rather than securing it.

**Already done, and its limit.** Three `.gitignore` patterns (`*.tmp`,
`.devenv*`, `*.env.dump`) were added and tested against the real file. That
narrows recurrence; it does not close this. `gitleaks` runs in CI after a push,
so it demonstrated on this very incident that it can report a leak but cannot
prevent one.

**Closing condition**: each of the four revoked and reissued at its source, with
the vault set handled by add-then-re-encrypt - or, if a check shows a credential
was already rotated, that check recorded here with its date and how it was
established.

## TD-051

**The published contract states what is REQUIRED, not what a surface accepts
or can refuse with.**

Atlas is the fleet's sole model egress, so `contract/atlas-contract.json` is
not one service's README - it is the interface standard every other product
builds against. Judged as a standard rather than as a bug report, it is
half-shaped in two ways, both found on 2026-08-26 while answering a consumer's
question about `/v1/parse`:

1. **`errorCodes` is one flat global list; `requests` is per surface.** A
   consumer of `/v1/embed` receives all 43 codes with nothing saying which of
   them that endpoint can actually emit. The artifact can answer "what must I
   send" per surface and cannot answer "what can this refuse me with".

2. **Only required fields are published.** `EmbedRequest`, `RerankRequest` and
   `ParseRequest` all accept an optional `tenantId`; `ChatRequest` does not
   have the field at all and requires `tenantId` where the other three require
   `workspaceId`. None of that is readable from the artifact. The asymmetry may
   well be correct - the gate keys grants by tenant and entitlement by
   workspace - but a standard that leaves its own asymmetry to be inferred is
   how two consumers end up implementing it two ways.

**Why this is not folded into the fix that found it.** Closing it changes the
contract's SHAPE, which moves the fingerprint and asks every consumer to
re-pin. That is a coordination decision with the platform line and the
consumers, not a detail to smuggle into a defect fix - and the defect
(`PARSE_TASK_REQUIRED`, 2026-08-26) had a consumer waiting on it.

**Not the same as the `task` defect.** That one was a published document
contradicting enforced behaviour - false, and now checked by
`check-request-contract` reading the throw sites. This entry is about a true
document that is incomplete as a standard. Filing them together would blur a
distinction worth keeping.

**Recovery**: decide the target shape with the platform line, then publish it
in one fingerprint move rather than several - per-surface `errorCodes`, and
`accepts` alongside `requires`. Consumers pin the fingerprint, so the cost is
paid once per change, not once per field.

## TD-052

**Label routing exists only on the retiring tenant axis, so asking for a label
drags a tenant along.**

Two mechanisms wear the word `grant`, and only one of them can route:

- `product_endpoint_grants` - a PRODUCT holds ENDPOINTS; the models it may name
  are whatever those endpoints reach. No tenant. Repointing an endpoint costs
  nothing: every product holding it follows, with no grant row to update.
- `model_grants` - a TENANT holds MODELS, and this table alone carries
  `task_profile`. It is the axis `model_grant_authorizations_total{axis}` is
  counting down to zero.

So a product that wants "fixed label, operators pick the model, zero caller
change" has two ways to get it, and the one it is likely to find first requires
a `tenantId` it has no reason to hold. **The tenant is not what decides the
answer; it is an artefact of where the feature was built.**

**This shipped as bad advice, which is the part that cost something.** karda was
pointed at `taskProfile` (vxture-atlas#4, #39) and blocked on a tenant uuid it
does not have, while it already holds product-axis endpoint grants. Corrected in
vxture-atlas#47 and vxture-platform#55. The doc that steered it -
`docs/20-specs/10-http-surface.md` - listed the three selectors as equivalent
rows, called `taskProfile` a *per-tenant preference*, and named no axis, in the
same file that already said authorization was moving to (product, endpoint).

**`taskProfile` is not extended, and the reason is not just that its axis is
retiring.** Binding models to tenants makes tenancy a routing dimension: every
new customer becomes a routing config change, O(tenants). The need it appears
to serve - "different customers get different tiers" - is properly a business
MODE the product selects (cost-first / quality-first / latency-first) with
operators deciding what serves each: O(modes), and it preserves the property
that matters, that **the label states what the caller needs**. Tenant identity
does not carry that intent. Owner ruling, 2026-08-26.

**Recovery**: the mode concept lands on the product axis when a second tier is
actually wanted; `taskProfile` is left to the countdown already in place. No
code change is required for the correction itself - `endpointCode` has always
worked and needs no tenant.
