# Atlas HTTP surface

Authoritative map of every route Atlas serves, and the source of truth for
other products integrating against it. Link to this file from liaison issues
rather than pasting a copy.

There are no legacy aliases: every path below is the only path.

Last verified against `service/src/**/*.controller.ts`: 2026-08-16.

## Data plane - S2S inference calls

Auth: `S2sAuthGuard` (RS256, `aud="atlas"`, `scope="tool:atlas"`, platform OIDC
issuer/JWKS).

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat` | Generation; `stream:true` for SSE |
| GET | `/v1/models` | `?tenantId=` filters to that tenant's granted models. Rows carry `behaviorVersion` (see below), `state` (`active`/`deprecated`/`inactive`) and `deprecatedAt` |
| GET | `/v1/endpoints` | The entry points THIS CALLER holds. Product comes from `act.sub` on the verified token, never a query parameter. `?applicationId=`/`?applicationType=` narrow to the same scope a call would use |
| POST | `/v1/embed` | A1 embedding - Zhipu only, other providers 501 |
| POST | `/v1/rerank` | A3 rerank - Zhipu only, other providers 501 |
| POST | `/v1/parse` | A2 parse - implemented on any OpenAI-compatible model with `config.supportsVision`; no vision model is registered yet, so it answers an in-contract `501 MODEL_NOT_IMPLEMENTED` (TD-003/TD-019) |

**Every list endpoint that takes filters refuses a query parameter it does not
recognise** (400) rather than ignoring it. Nest binds only the parameters a
handler asks for and discards the rest, so an unrecognised filter would
otherwise not be applied and the caller would receive an unfiltered page - 200,
well formed, and not the answer to the question asked. On an audit search that
is the worst available outcome ("what did opr_x change" returns somebody else's
changes); on `/capability/tenant-model-grants?productCode=x` it hands back every tenant's
grants as if they were x's. The refusal names both the rejected parameter and
the accepted list, because after a rename the caller is sending something that
was correct last week.

The code identifies the surface that refused:

| Surface | Code |
| --- | --- |
| `/v1/models`, `/v1/endpoints` | `UNKNOWN_FILTER` (runtime envelope, `retryable:false`) |
| `/capability/*` under the model-admin controller | `CAPABILITY_UNKNOWN_FILTER` |
| `/capability/logs`, `/capability/logs/summary`, `/capability/logs/cost` | `OBSERVABILITY_UNKNOWN_FILTER` |
| `/capability/audit-logs` | `AUDIT_UNKNOWN_FILTER` |
| `/capability/provider-keys` | `PROVIDER_KEY_UNKNOWN_FILTER` |
| `/tenancy/usage` | `TENANCY_UNKNOWN_FILTER` |

The `/v1` pair uses the runtime vocabulary rather than the operator plane's
envelope because X-1 requires every consumption-plane error to carry a code from
that vocabulary and a `retryable` flag; a shared `BadRequestException` would
have made these the only two `/v1` errors without them.

This is enforced, not documented-and-hoped: `scripts/guardrails/check-query-filters.mjs`
(quality-gate) fails the build if a filtered `GET` omits the guard, or if the
accepted list stops matching the parameters the handler declares. The second
half matters as much as the first - the list is a string array, so a renamed
parameter re-opens the hole with no type error anywhere.

`GET /v1/endpoints` exists because a caller that routes by `endpointCode` had
no way to learn which codes it may use: `/v1/models` covers models rather than
entry points, `/capability/model-routes` is the operator plane and answers a
`tool:atlas` token with `401`, and `.well-known` publishes tool shape rather
than endpoint codes. The catalog therefore lived hard-coded on the caller's
side with nothing to check it against, and a wrong code first surfaced as an end
user getting `404 ENDPOINT_NOT_ROUTABLE` in production (vxture-atlas#198).

`state` is `active` / `inactive` / `missing`, not a boolean (product_251 B-3,
which binds a new interface immediately per D-2). A granted endpoint that an
operator switched off, and a grant naming a code no endpoint has, are both
reported rather than omitted: at call time both are the same `404`, but only one
of them is the caller's to fix, and an omission reads as "never granted".

Capacity, for a caller that budgets its input before sending (tenderforge
letter 40 item 4). The response is `{ endpoints: [...], maxRequestBytes }`:

- `contextWindow` / `maxOutputTokens` on each route: the **smallest** value
  across the models a call on that route can land on - the primary and the
  route's fallback, following the call path exactly (an unusable primary fails
  the request, an unusable fallback is skipped). Per route, not per model: a
  caller knows only `endpointCode`, and an operator repointing the route
  changes these numbers with no caller release.
- `null` means **unknown**: no usable primary, or a model in the chain with no
  value recorded. It is never the minimum of only the known values - that can
  overstate, and a budget that overstates is worse than none. Treat `null` as
  "do not rely on a number", not as "unlimited".
- `maxRequestBytes` (top level): the body ceiling (`MAX_REQUEST_BODY_BYTES`,
  design doc 200 section 1.4). One number for every route, because the body
  is refused before routing; read from the same resolver the parser uses.
- Source is the model's `context_window` / `max_output_tokens` - what the
  model can take - not `model_policies.max_context_tokens`, which no code
  enforces (TD-054).
- `thinkingModes` on each route: the `thinking` values a call on it may ask
  for (the primary's; a fallback that cannot run a mode is skipped for that
  call, so it never narrows this). Empty means asking is refused.

### Thinking is a per-call field (ADR-009)

`POST /v1/chat` accepts `thinking: "off" | "on"`, and the response - the JSON
body, and the stream's `done` frame - carries `thinking`: the mode applied, or
`null` when none was asked and the upstream's own default ran.

- **Omitted** = the upstream model's default, exactly as before this field
  existed. Several upstreams default to ON (DeepSeek V4, Doubao Seed - the
  latter observed on a real request), so a caller that wants no reasoning must
  say `off`.
- **Translated per model** through `config.wire.thinking`
  (`docs/30-design/100-model-onboarding-and-protocol-adapters.md`). A caller
  never spells a vendor's field.
- **Refused, never dropped.** A value outside `off`/`on` is
  `400 CHAT_THINKING_INVALID`. A mode the routed primary cannot run is
  `422 THINKING_MODE_UNSUPPORTED` (`retryable: false`) before any upstream
  call; a fallback that cannot run it is skipped for that call. Check
  `thinkingModes` on `/v1/model-routes` first.

### A total deadline per call (B6)

`POST /v1/chat` accepts `timeoutMs` (whole milliseconds, 1000-600000): the
budget from the moment Atlas accepts the call to its last byte, shared by every
candidate in the chain.

- When it runs out, the upstream call is **cancelled** - no more tokens are
  generated or billed - and the caller gets `504 DEADLINE_EXCEEDED`
  (`retryable: false`: the identical request gets the identical budget; raise
  it or shrink the input). On a stream it arrives as the error frame, after any
  output already sent.
- It is the caller's budget, not a provider fault: it does not count toward the
  circuit breaker, and no further fallback is tried once it has run out.
- Omitted = no total deadline. A value outside the range is
  `400 CHAT_TIMEOUT_INVALID`.
- **How long Atlas waits for the upstream's response headers** depends on the
  kind of call, because the headers mean different things:
  - Streaming chat, embed, rerank: headers come at once; 30 s without them is
    a hung upstream (`PROVIDER_CONNECT_TIMEOUT_MS`).
  - **Non-streaming chat and parse: the upstream sends headers only after the
    whole answer is generated**, so the wait is the generation time. It is
    bounded by `timeoutMs` when sent, otherwise by 600 s
    (`PROVIDER_WHOLE_RESPONSE_TIMEOUT_MS`, equal to the largest `timeoutMs`,
    so a caller's deadline always comes first). Until v0.7.18 this used the
    30 s window too, and every non-streaming answer longer than 30 s failed
    as `PROVIDER_UNAVAILABLE` (tenderforge#69).

`GET /v1/models?tenantId=` accepts the tenant id as a caller-supplied filter by
design: `/v1` is a first-party product plane, and tenant privacy is not a
boundary between sibling vxture products. `/tenancy/*` supersedes it for
tenant-scoped reads; retire the query-param form once remaining callers move.

### Reasoning output never merges into `content`

A thinking model returns its chain separately from its answer -
`message.reasoning_content` on the OpenAI dialect. **Atlas never merges that
into `content`, and this is a contract clause, not an implementation detail.**

The reason is that the consumer cannot detect the violation. A caller receives
one string; nothing about a reasoning chain makes it look different from an
answer. karda's `ask()` writes `res.content` straight into `answer` and attaches
citations, so a merged chain would be presented to an end user as a
citation-backed answer - well formed, no error, no warning, nothing to notice
(karda's input, given on the thread that is now `vxture-platform/vxture-platform#50`).

The same rule already existed for the streaming side, where it is *less* severe:
a stream consumer can at least see the event type. On the non-streaming body
there is no such handle, so the clause binds hardest exactly where it is easiest
to break.

### The reasoning payload is an envelope, not a string

Delivered since 2026-09-12 (TD-046 closed) as `message.reasoning` - **an opaque
envelope, not a passage of prose**:

| Key | Meaning |
|---|---|
| `text?` | The readable projection. **For display only.** May be truncated or not shown. Some providers give none (OpenAI o-series returns no readable chain). |
| anything else | Provider-specific continuation material. A caller **MUST NOT** parse it. |

Two rules bind the caller:

1. **Echo the whole object back, verbatim, including keys you do not
   recognise.** The common mistake is rebuilding it - `{ text: msg.reasoning.text }`
   - which drops keys such as Anthropic's `signature`. That looks correct on
   DeepSeek and is a 400 on Anthropic.
2. **`text` is not the basis for the round trip.** The object is.

Absent means the upstream reported none - not an empty string, and not "the
model did not think".

**Why not `reasoningContent: string`.** DeepSeek requires the chain to be
returned *in full* on every subsequent interaction when `tools` are present, or
it answers 400. That makes the field an obligation rather than content - and
content is the kind of thing a caller displays, truncates, summarises or drops
when it grows. Each of those breaks the round trip, and the resulting 400
surfaces on the *caller's* side with nothing to explain it. A `string` also fits
exactly one vendor: Anthropic's thinking blocks carry a `signature` (and there
is `redacted_thinking`), and OpenAI's o-series returns no readable text at all.
One string field would force either JSON-inside-a-string or a second field, and
the second is what product_251 P2 / X-4 forbid.

The **cost** of reasoning has its own outlet and is not in this envelope:
`usage.reasoningTokens` (TD-047).

On the streaming side the split follows the two consumers: `reasoning` events
carry display deltas, and the `done` frame carries the whole envelope for the
round trip. A caller is never asked to assemble one from deltas - it could not,
because `signature` never appears in them.

### Deprecation: retiring a model with notice (product_251 X-4)

`POST /capability/models/:id/deprecate` marks a model **still resolvable, no
longer recommended**, and `:id/undeprecate` takes it back. It deliberately does
not touch `isActive`: a deprecated model keeps serving, which is the entire
point - *"stop building on this"* is a different statement from *"this stopped
working"*, and collapsing them is what left a consumer with no warning before a
404.

`GET /capability/models` carries the same `state` (`active`/`inactive`/
`deprecated`) and `deprecatedAt`. That is not symmetry for its own sake: the
operator plane is where deprecation is PERFORMED, and until 2026-08-17 it was
the one plane that could not read the result - the admin record reported a
two-value state, so an operator could deprecate a model and then not see it in
the console list. The console's own `isActive` -> `state` work sat blocked on
exactly this.

`GET /v1/models` carries `state` and `deprecatedAt`, which is where the signal
actually reaches a caller. Before this, that list carried no state at all: the
only notice a consumer ever got about a model going away was its **absence**,
which arrives as a `404` at call time, after they have built on it. A supplier
changing what sits behind a `model_code` is routine rather than exceptional, so
"no signal" was the normal case, not an edge one.

`deprecatedAt` is a timestamp rather than a state column because it carries
WHEN, which a retention window needs and a state cannot express - "deprecated"
alone gives a caller nothing to plan against.

### `behaviorVersion` - noticing that a model moved under a stable code

`modelCode` IS the version identifier: a new version means a new code, never a
silent `latest` drift. That is Atlas's position, sent to karda 2026-07-27 and
accepted by the platform in vxture-atlas#205, and it is why there is no `version`
column - two independently writable statements of one fact drift, and a consumer
then has to ask which is authoritative.

It left one thing unobservable. An operator may repoint a registered model at a
different upstream - `endpointUrl`, `providerId`, `config.wire` - while the code
stays the same. The symptom is "the same prompt worked yesterday and is wrong
today", with nothing to attribute it to. Worse than a delete, which at least
404s.

**Repointing stays allowed.** A supplier changes their base URL and gateway
migrations happen; forcing delete-plus-recreate would drop every grant that
references the model. The fix is a signal, not a lock:

```jsonc
// GET /v1/models, and GET /capability/models
{
  "modelCode": "doubao-seed-2-0-lite-260428",
  "state": "active",
  "deprecatedAt": null,
  "behaviorVersion": "b1-9f2c1a4b7e30"   // opaque
}
```

Compare it to the last value seen for the same `modelCode`. Equal means the
upstream and wire configuration are unchanged; different means the behaviour may
have moved and a golden-output check is worth re-running. It is **opaque** - not
ordered, not a semver, and carrying no claim about how big the change was.
Whether an agent surfaces it to a human is the agent's decision; Atlas's
obligation is to make the fact observable.

**It is not a second source of truth.** It is a pure function of the fields it
describes, computed at the mapping boundary and stored nowhere - the same
technique M-B3 uses for `state`. A fingerprint cannot disagree with what it
fingerprints, because there is no write path that could set it wrong.

What moves it: `providerId`, `endpointUrl`, `protocol`, `modelType`,
`contextWindow`, `maxOutputTokens`, `capabilities`, `supportsStreaming`, the
model's `config` and the provider `config` it inherits wire defaults from.

What does NOT: `modelName`, `description`, `sort`, `isActive`, `deprecatedAt`,
the audit columns, and **key rotation** (`config.keyReference`). A signal that
fires on a display-name typo or a key rotation gets filtered out, and the real
repoint is filtered out with it.

The `b1-` prefix is a scheme tag. If the inputs or the algorithm change, every
model's version changes at once, and a consumer has to be able to tell that
apart from "every model was repointed" - same scheme with a different digest is
a real change; a different scheme is ours, and comes with a liaison note.

`modelCode` itself is refused on `PATCH` (400), and `98_column_locks.sql` grants
no `UPDATE` on the column. Both, because the lock alone made the refusal a
database error surfacing as a 500. A rename would also split the model's own
metering history: `reqlog.request_records.model_code` stores it by value with no
foreign key.

There is deliberately no `sunsetAt` that stops resolution on a date. Nothing
would enforce it today, and a column promising a deadline the runtime ignores is
worse than no column: the caller plans against an end that never arrives. It
lands with the code that honours it.

### `resolvedWire` - what the fingerprint was pointing at

`behaviorVersion` says THAT the configuration moved. Until 2026-08-24 the only
way to see WHAT it moved to was `POST /capability/models/:id/probe`, which makes
a real upstream call and spends tokens. A cheap signal pointing at an expensive
answer is a signal nobody follows, so `GET /capability/models` now carries the
merged descriptor directly:

```jsonc
{
  "behaviorVersion": "b1-9f2c1a4b7e30",
  "config":        { "wire": { "chatPath": "/v4/chat/completions" } },  // declared
  "resolvedWire":  { "schemaVersion": 1, "chatPath": "/v4/chat/completions",
                     "authStyle": "bearer", "headers": {}, "streamUsage": "stream_options",
                     "supports": { }, "paramMap": { } }                 // effective
}
```

Three layers, in this order: **protocol defaults → the provider's `config.wire`
→ the model's own**. It is the same `resolveWireFor()` the runtime and the probe
call - a pure config merge, no upstream call, so it costs nothing per row.

**`config` and `resolvedWire` are both present on purpose.** They answer
different questions: `config` is what THIS model declares (so a console can show
which layer set a key, and it is also where secret redaction happens),
`resolvedWire` is what runs. A caller must not merge them itself: `applyOverlay`
merges per key - `headers` is a string-map merge, `authStyle` is an enum read
that silently falls back on an unknown value - so a second implementation would
be a second source of truth for the same fact, and it would fail silently by
rendering a descriptor no request ever used.

Like `behaviorVersion`, it is computed at the mapping boundary and stored
nowhere. Writes still go through `config.wire`, which is validated strictly
(unknown keys rejected at `/capability/*`, ignored at runtime - see section 6 of
`docs/30-design/100-model-onboarding-and-protocol-adapters.md`).

### The vault is the only source of an upstream key

`config.apiKeyEnvVar` and `keyReference.source: "env"` are retired (ADR-003,
enforced 2026-08-17). A model's key comes from `key.provider_api_keys` via
`keyReference: { source: "managed", name: "<alias>" }`, and nothing else -
`POST /capability/models` refuses the retired input with a 400 naming the
replacement rather than accepting it and ignoring it.

**A model with no key source is refused, not served with an empty key.** It
used to resolve to `""` and call upstream anyway; the 401 that came back was
reported as `503 PROVIDER_UNAVAILABLE`, so a configuration hole arrived wearing
an upstream outage's face. It is now refused before the request is made, naming
the model and the route that fixes it.

`/readyz`'s `providerKeys` check was rewritten with it. It used to count
`apiKeyEnvVar` references and compare them against `process.env` - the vault
was outside its field of view entirely, so `checkedKeys: 0` meant "no model
uses an env var" and was easy to misread as "no model has a key". It now
reports `checkedAliases`, `dangling` (aliases with no active vault key behind
them) and `keylessModels` (models that will refuse every call). None of them
fails readiness: one misconfigured model must not take the healthy ones out of
the load balancer.

Resolved keys are cached in process. Every operator mutation - create, rotate,
delete, activate/deactivate - drops the cache entry **before it returns**, so a
revoked key cannot answer one more request; the TTL is only a backstop for what
invalidation cannot see.

### `taskId` is required on every `/v1` call (product_251 X-2)

All four entry points refuse a request without one: `400 TASK_ID_REQUIRED`,
`retryable: false`. Any stable non-empty string up to 128 characters, sent as a
top-level `taskId` on the request body, stored verbatim in
`reqlog.request_records.task_id` and queryable at `GET /capability/logs?taskId=`.

Deliberately **not** a `uuid` column. A `uuid` column writes a non-conforming
value as NULL, which is exactly how `tenantId` traffic became visible under
`product_code` and absent from every tenant-dimension report with nothing
raised. The id belongs to the caller's task system; coercing it would discard
the value for callers who sent a correct one.

Required rather than optional because Atlas is the sole inference-metering
entry point for every other vxture product: one agent task fans out across
several products and models, and `taskId` is the only key that totals it back
up. Missing here is missing everywhere - there is no second place to recover it
from. An optional attribution key yields a rollup that returns a plausible
number with the unattributed calls simply absent from it.

Refusals are counted as `model_request_rejections_total{code,product}`. That is
the only place they are visible: validation runs before anything is logged, so
a refused call leaves no reqlog row by construction, and "who is still not
sending it" would otherwise be unanswerable.

Consumers were asked before the requirement landed (`vxture-karda`#101,
`vxture-vxtpl`#50). The conformance matrix had listed this as waiting on their
adoption, which was circular - neither had been asked, and neither would send a
field nothing required.

### `tenantId` must be a UUID

Refused at the boundary with `400 INVALID_TENANT_ID`, distinct from
`TENANT_ID_REQUIRED` for an absent one - two different caller mistakes get two
different codes, because collapsing them sends someone who forgot the field
looking for a formatting bug.

Accepting a non-UUID was never harmless. The attribution column is `uuid`, so
the value was written NULL: the traffic then existed under `product_code` and
was **absent from every tenant-dimension report**, with nothing raised. It
surfaced only much later wearing a different error's face - once a product grant
stopped matching, the tenant axis answered `400 INVALID_TENANT_ID`, pointing at
the one thing that had not changed (vxture-atlas#198 §4).

Validation runs before anything is logged, so a refusal leaves no reqlog row by
construction. `model_request_rejections_total{code,product}` exists for exactly
that: it makes "who is still sending this" answerable from `/metrics` rather
than making the traffic disappear a second way.

### `state`, not `isActive` (product_251 M-B3)

Every operator and tenancy record reports `state: "active" | "inactive"`. The
database keeps `is_active boolean` - the rename happens at the mapping boundary,
so there is no DDL, no db-init and no deploy ordering, and a rollback needs
nothing. A physical column would have required a backfill and a dual-write
window whose failure mode is the worst on offer: writes landing in `state` while
some reader still reads `is_active`, so an operator deactivates a model, the
console shows it inactive, **and the model keeps serving traffic**.

A boolean also cannot carry the states that already exist: `GET /v1/endpoints`
needed a third value on the day it was written (`missing`, for a grant naming an
endpoint code nothing has), and a version lifecycle needs `deprecated` - still
resolvable, no longer recommended - which is neither true nor false.

`state` is settable at **create** and not on update. The named actions
(`POST :id/activate` / `:id/deactivate`) are the only way to change it
afterwards, and the reason is the audit trail rather than tidiness: the audit
`action` is derived from the path, so a deactivation done through the update
route records `action='update'` while the identical operation through the named
route records `action='deactivate'`. An auditor filtering `?action=deactivate`
silently misses every one of the former.

`/capability/api-keys` reports `state` (`active`/`inactive`/`revoked`) and
`effectiveState` (the same plus `expired`, derived from the clock at read time).
The COLUMN keeps its own spelling, `disabled`, and the two are reconciled at the
record boundary rather than by migrating the data: `rollback.yml` swaps the
image and never touches DDL, so rewriting the stored value would leave a
rolled-back image reading a word its own switch does not handle. The gain would
have been one word; the cost is a rollback that half-works.

### Verbs on the operator plane (product_251 M-B1 / M-B3)

`PATCH` for an object update, `POST` for a named action, and no `PUT` anywhere.

The seven object routes are **partial updates** - a body that omits a field
leaves it unchanged - and wore `PUT`, which promises the opposite. Two callers
holding opposite beliefs about the same route both appeared to work until one
of them did not, so the verb moved to match the behaviour rather than the
behaviour moving to match the verb (one line per route against 70 conditional
assignments plus every caller).

The five action routes on `provider-keys` and `api-keys` (`activate` /
`deactivate` / `revoke`) also wore `PUT`, while the fourteen equivalent actions
on the registry routes were already `POST` - the same operation spelled two
ways on one plane. They are `POST` now.

There is no compatibility window, and could not be a cheap one: Nest writes
`METHOD_METADATA` onto the handler's descriptor, so stacking `@Put` and
`@Patch` on one method registers exactly one route and reports nothing. A
window would need duplicate handlers. A residual `PUT` therefore gets a bare
`404`; it is also recorded in `audit.change_records` as
`action='update', outcome='failure'`, because `AuditMiddleware` runs on every
path and still treats `PUT` as mutating - which makes "has the console
finished migrating" a query rather than a guess.

### Naming the model: three inputs, one precedence

`modelCode` > `endpointCode` > `taskProfile`. At least one required; passing
more than one is not an error, the narrower wins.

| Field | Resolves via | Axis | Scope |
|---|---|---|---|
| `modelCode` | direct | either | exact model |
| `endpointCode` | `model.model_endpoints` | **product** | global stable name, e.g. `chat/default` |
| `taskProfile` | `model_grants.task_profile` | **tenant (legacy)** | a label matched against tenant grants |

**A product integrating today wants `endpointCode`.** The three are not
equivalent choices: naming a `taskProfile` requires a `tenantId` the caller may
have no reason to hold, and lands on the axis
`model_grant_authorizations_total{axis}` exists to count down to zero. How a
consumer came to be steered onto it is TD-052.

**Why the tenant axis is the wrong shape for this, not merely the older one.**
Label routing was only ever built on it, so asking for a label drags a tenant
along - but the tenant is not what decides the answer. Binding models to
tenants makes tenancy a routing dimension: every new customer becomes a routing
config change, O(tenants). And repointing costs a grant row per tenant, where
repointing an endpoint costs nothing at all - every product holding it follows.

**If "different customers get different tiers" is ever needed, it is not a
tenant grant.** It is a business MODE the product selects - cost-first,
quality-first, latency-first - with operators deciding what serves each. That
is O(modes), and it keeps the property that matters: **the label states what
the caller needs**, and tenant identity does not carry that intent. So
`taskProfile` is not extended; the mode idea lands on the product axis.

On endpoint routing the endpoint's `fallbackModelCode` is the only chain (the
model's own `config.fallbackModelCodes` does not stack); an endpoint may point
at any model regardless of `category`; naming one never widens access, since
entitlement is checked against the resolved model. Reasoning:
[`20-product-definition.md`](./20-product-definition.md).

`404 ENDPOINT_NOT_ROUTABLE` when the code names nothing live - a deactivated
endpoint and a nonexistent one are deliberately indistinguishable.

**Which model answered is always reported back, on every surface.** Routing by
`endpointCode` or `taskProfile` means the caller did not name a model - that is
the point of it, and it is why an operator can repoint a task profile and the
product ships nothing. The cost of that decoupling is that the product cannot
otherwise notice it was repointed: same request, different model, no error, no
version change, and the symptom is "the same prompt worked yesterday".

So the resolved `modelCode` comes back in the response - `ChatResponse`,
`EmbedResponse`, `RerankResponse`, `ParseResponse`, and on a stream the final
`done` frame. **That echo IS the repoint signal**: compare it with what you saw
last time. It reports what actually served, so after a failover it names the
fallback rather than the model that was tried first.

Paired with `behaviorVersion` it answers the two separate questions a consumer
has: the echo says *which model I am talking to*, `behaviorVersion` says
*whether that model has moved underneath its code*. Neither substitutes for the
other - a repoint changes the first and not the second.

Whether any of this is surfaced to an end user is the consumer's decision. That
it reaches the consumer is not: karda already treats the `/v1/embed` echo as
vector-space identity and refuses to store vectors without it, and every other
routed capability owes the same fact for the same reason.

### The error vocabulary is published, not described

`GET /.well-known/vxture-contract` (`S2sAuthGuard`, the same guard a consumer's
`/v1` calls already pass) returns every code `/v1` can put in an error envelope,
each with its `retryable` class, plus an opaque `fingerprint`.

The same document is committed at `contract/atlas-contract.json` for vendoring
and pinning. **The two answer different questions**: the file says what `main`
declared, the endpoint says what the instance you are calling declares. A
consumer pinning only the file re-creates version skew, which is the failure
this exists to remove.

Diff the `fingerprint` against the last value you saw. Equal means the
vocabulary is byte-identical. It is derived from the content and stored nowhere,
so it cannot be forgotten the way a hand-maintained version can - TD-044 is the
receipt for that failure mode, where a version field that does not track change
tells a polling consumer "nothing moved" through a field that cannot move.

The same document carries `requests`: per surface, which fields are required
and the code that refuses a request without them. **It is not generated from the
TypeScript interfaces, on purpose.** `ChatRequest.taskId` is declared optional
there and is rejected by every surface at runtime, so a generated schema would
publish the opposite of the truth - the same class of statement as the letter
that promised `QUOTA_EXHAUSTED`.

Read it before assuming the four surfaces are alike: **`/v1/chat` attributes by
`tenantId`, and the three S2S capabilities attribute by `workspaceId`.** A
caller that assumes one shape across all four gets a 400 on three of them.

Two things hold it to the runtime, in opposite directions. Every published rule
is exercised by a test that omits the field on that surface and asserts the
declared code comes back; and `check-request-contract.mjs` requires every
`*_REQUIRED` code in the vocabulary to be published by some surface, so a new
requirement cannot be enforced without also being announced.

`retryable` is published as a fact. What to do with it - back off, fail the
task, surface it - is the consumer's decision; Atlas does not model retry
policy on anyone's behalf.

Why this exists at all: four consumers each hand-copied the same table out of a
liaison letter. One of those copies said `QUOTA_EXHAUSTED` where the code has
always thrown `QUOTA_EXCEEDED`, the branch never fired, both sides' CI stayed
green, and it took months to surface - because the symptom of a dead branch is
that nothing happens (`vxture-atlas#21`).

## Capability plane - operator/registry surface

Carries two operator jobs behind one prefix and one guard: **configuration**
(registry and key CRUD - changes intended state, every write audited) and
**runtime** (health, probes, logs, usage, audit reads - observes the running
system). The split, what it exposes, and the gaps per plane:
[`20-product-definition.md`](./20-product-definition.md).

Auth: `OperatorAuthGuard` - RS256, same issuer/JWKS as the S2S guard, requiring
`aud="atlas"` · `realm="workforce"` · `userType="operator"` ·
`scope="mgmt:atlas"`. Structurally disjoint from the data plane's `tool:atlas`:
an S2S token 401s here and an operator token 401s on `/v1` and `/tenancy`, by
design (product_250 §2). Do not point a service-identity caller at this plane.

Both directions are enforced, and by two independent claims each. The data
plane requires `scope="tool:<audience>"` AND `mode` in `{obo, service}`;
`mode` names the kind of exchange, `scope` the surface it was minted for, so
neither restates the other.

**Verify the source, do not re-judge the person.** Every check this guard
makes answers *"is this instruction genuine, current and addressed to me"* -
including the redundant ones, since `realm`/`userType` partly re-assert what
`scope` implies at the cost of one string comparison. None of them answer
*"is this person allowed to do this"*, which belongs to console / admin-bff /
opera-bff.

**There is therefore no provider-side step-up check.** The step-up criterion
lives in the platform RBAC catalogue
(`admin.operator_permission.requires_step_up`) and the ceremony runs in
opera-bff, which a backend API cannot do - it has no UI, so it could only ever
refuse. `amr` and `operator_role` are never read; `sub` and
`act.sub` are read for the audit trail and never evaluated. Reasoning:
[`20-product-definition.md`](./20-product-definition.md); our operation-code
vocabulary for that catalogue is
`docs/80-liaison/40-2608131600-atlas-operation-code-vocabulary.md`.

What remains here is a record rather than a refusal: every mutating
`/capability/*` request lands in `audit.change_records` with the operator
`sub`, and `rotate` derives `key_rotation_logs.rotated_by` from that same
verified `sub`, never from the body.

| Method | Path | Notes |
|---|---|---|
| GET | `/capability/protocols` | Wire-protocol vocabulary + each protocol's `config.wire` defaults - the management UI's dropdown source. Static, no tenant data (`docs/30-design/100-model-onboarding-and-protocol-adapters.md` §5/§10) |
| GET/POST/PATCH/DELETE | `/capability/providers[/:id[/activate\|deactivate]]` | Provider registry. Rows carry `modelCount` - see "Lifecycle: deactivate, then delete" below |
| GET | `/capability/providers/performance` | Gateway performance since process start: `inFlightRequests` plus per-provider cumulative attempts/successes/errors/`errorRate` and avg/p50/p95 latency. Prometheus-counter semantics - diff two polls to get a rate |
| POST | `/capability/providers/:id/probe` | Provider connectivity self-check. Runs the model probe below through the provider's lowest-`modelCode` active model and names which one in `probedModel`. Exists because `health` on the provider list is traffic-derived, so a provider that has never carried traffic reads `unknown` forever and cannot be verified before it is given load. **On demand only - no periodic active probing.** `409 MODEL_ADMIN_PROVIDER_NOT_PROBEABLE` when the provider has no active model (it exists, so not a 404; probing a deactivated model and calling the provider healthy would be worse than no verdict). Shares the per-model cooldown, so this route cannot be used to bypass it |
| GET/POST/PATCH/DELETE | `/capability/model-routes[/:id[/activate\|deactivate]]` | Logical endpoint directory. Filters: `includeInactive`/`modelCode`. Each row carries derived `resolution` (`serving`/`degraded`/`unresolvable`/`inactive`) and per-model `availability` (`available`/`model_inactive`/`provider_inactive`/`missing`) - see "Lifecycle: deactivate, then delete" below. Create takes `code`, `category` (default `chat`), `primaryModelCode`, optional `fallbackModelCode`; model codes are validated against non-deleted models; `code` is immutable; delete requires deactivation first |
| GET/POST/PATCH/DELETE | `/capability/models[/:id[/activate\|deactivate]]` | Model registry. `?providerId=` filters. Rows carry `grantCount` and `endpointRefCount` |
| POST | `/capability/models/:id/probe` | Connectivity self-check. **Makes a real upstream call** (capped at 16 output tokens, non-streaming + streaming). Reports reachability, the resolved adapter/protocol/`wire`, and **whether usage came back** - the signal that the model would otherwise go unmetered. Usage is attributed to the platform sentinel with `usage_type='test'`; no quota is consumed and nothing reaches the metering kernel. Rate-limited to one probe per model per 10s (`429 MODEL_ADMIN_PROBE_COOLDOWN` with `retryAfterMs`); no second-factor check on this plane at all (see above), and it would not have applied here anyway - this is diagnostic, not a credential mutation |
| GET/POST/PATCH/DELETE | `/capability/product-endpoint-grants[/:id[/activate\|deactivate]]` | **Product-scoped authorization** - which entry points a product holds. Filters: `productCode`/`endpointCode`/`includeInactive`. `productCode` and `endpointCode` are immutable (repointing is a revoke plus a create, so both stay in the audit trail); delete requires deactivation first. One grant per (product, endpoint, application scope) - enforced by a unique index, because without it deactivating a grant would not reliably revoke access |
| GET/POST/PATCH/DELETE | `/capability/tenant-model-grants[/:id[/activate\|deactivate]]` | Model access grants on the **tenant axis only**. `tenantId` is required at create and `model_grants` has no product column, so a grant can never name `productCode`; a body carrying one is ignored rather than refused. The product axis is the separate `/capability/product-endpoint-grants` resource - see "Authorization is moving to (product, endpoint)" below. Filters: `tenantId`/`modelId`/`applicationId`/`applicationType`; `productCode` is refused with `400 CAPABILITY_UNKNOWN_FILTER` (it was listed here in error) |
| GET/POST/PATCH/DELETE | `/capability/price-rules[/:id[/activate\|deactivate]]` | Pricing - unit semantics below. Delete is soft and requires deactivation first |
| GET/POST/PATCH/DELETE | `/capability/policies[/:id[/activate\|deactivate]]` | Policy. Delete is soft and requires deactivation first |

### Renamed operator resources, and when the old names stop answering

Three resources were renamed under `product_251` X-4 (one word, one meaning),
agreed in vxture-atlas#206. `grants` had named three different things across the
fleet's operator console - two of them here - and `endpoints` two. The new names
state the object rather than only that a relation exists.

| Retired | Canonical | What it actually is |
|---|---|---|
| `/capability/product-grants` | `/capability/product-endpoint-grants` | a product's access to an ENTRY POINT |
| `/capability/grants` | `/capability/tenant-model-grants` | a tenant's access to a MODEL |
| `/capability/endpoints` | `/capability/model-routes` | a route to a primary/fallback model |

**Both spellings are served.** One Nest handler registers both paths, so no
client has to move on Atlas's deploy and Atlas does not wait on a client's. That
answers #206's objection directly: there is no coexistence period between a proxy
and the thing it proxies *if the change is a cutover*, and this one is not.

A call on a retired path returns the resource unchanged plus:

```
Deprecation: true
Sunset: Tue, 16 Sep 2026 00:00:00 GMT
Link: </capability/model-routes>; rel="successor-version"
```

RFC 9745 and RFC 8594. A client learns it is on a retired path from its own
response, not from a message somebody has to remember to send.

**The audit trail stays single-valued.** `audit.change_records.resource_type` is
derived from the resource path segment, so serving two spellings would file one
operation under two resource types and "who granted this tenant access to this
model" would answer with half the trail, silently - the defect X-4 exists to
remove, reintroduced by the fix for it. The audit derivation folds a retired
spelling back to the canonical name, so the recorded resource does not depend on
which spelling the caller used. Historical rows written before the rename keep
the old value; they are not rewritten, because an audit record states what was
recorded at the time.

**Removal is gated on evidence, not the date.** Every retired-path call
increments `capability_legacy_path_requests_total{path,operator}`. The old names
are deleted once that reads zero - the sunset date is a floor, not a trigger, so
an operator still on an old path in October gets a conversation rather than an
outage. Same discipline as `model_grant_authorizations_total`. Nothing reads the
counter on a schedule yet, which is TD-041.

### The same rename on the data plane (TD-042)

`GET /v1/endpoints` and `GET /tenancy/grants` carried the same words on the DATA
plane, where the consumers are products rather than one console. #206 deferred
them to "a separate window". **A window nobody opened is not a deferral, it is a
drop**, so TD-042 recorded the exclusion and this section closes it.

| Retired | Canonical | What it actually is |
|---|---|---|
| `/v1/endpoints` | `/v1/model-routes` | the routes this CALLER may use |
| `/tenancy/grants` | `/tenancy/tenant-model-grants` | what this TENANT may call |

What is being fixed is **consistency, not a defect**: these carry the SAME
meaning as their operator-plane counterparts, so no word here ever carried an
Nth meaning and the X-4 obligation was already met. What was left is that the
operator console and the agent-facing list used two words for one thing.

Same additive shape, for the same reason - both spellings are served by one
handler, so neither Atlas nor a product has to move on the other's deploy. A
retired path answers with `Deprecation: true`, its own `Sunset`, and a `Link`
naming its own successor.

Two deliberate differences from the operator plane:

- **A later sunset** (`2026-12-16`, versus `2026-09-16`). That window moves one
  console on this repo's release train; this one moves karda and vxtpl, who
  schedule independently and were not part of the #206 conversation. Equal dates
  would give the wider blast radius the shorter notice.
- **No audit fold.** The data plane is not written into `audit.change_records`,
  so the single-valued-resource problem above has no counterpart here. Said out
  loud because the alternative is the next reader diffing the two modules to
  work out whether the omission was an oversight.

Removal is gated the same way: `data_plane_legacy_path_requests_total{path,product}`
must read zero. It is labelled by calling **product** (`act.sub`, the one
identity a caller cannot forge) rather than only by path, because the question
removal has to answer is *whom to talk to*, and "some traffic" does not answer
it. Nothing reads this counter on a schedule either - the same gap TD-041 names
for the operator plane, now covering two counters.

**Why this did not wait on karda and vxtpl to agree the names**: the shape is
additive, so nothing breaks on anyone's deploy, and the interface rules say a
rename does not need three parties to agree - a name that states its object
cannot collide with someone else's, and waiting costs a day of silent misreading
per day spent. What the consumers do have to agree on is **removal**, and that
is exactly what the counter gates.

| GET | `/capability/quotas` | **501** - the platform exposes only a single-workspace C2 read, no bulk endpoint, so this cannot be answered honestly. Use `/tenancy/quotas` per workspace |
| GET | `/capability/usage-summaries` | Read-only reqlog rollup. `groupBy` selects the axis: `tenant` (default) / `provider` / `model` / `endpoint` / `product` - see below. Filters: `tenantId`/`applicationId`/`applicationType`/`cycleMonth`/`providerCode`/`modelCode`/`productCode` |
| GET | `/capability/provider-keys` | Read-only |
| POST/DELETE | `/capability/provider-keys[/:id/rotate\|activate\|deactivate]` | Envelope-encrypted key vault - credentials Atlas presents OUTWARD. Operator auth only, see above |
| GET | `/capability/api-keys` | Inbound gateway keys - who may call Atlas. Rows carry both `state` (what the operator SET: active/inactive/revoked) and `effectiveState` (that plus the clock: active/**expired**/inactive/revoked). `expired` is derived at read time and never stored - a sweeper flipping rows when a timestamp passes would rewrite history to make a schedule true, and would be a lie for as long as it lagged; same reason price rules and policies evaluate expiry on read. Precedence is terminal-first, then the operator's own switch: an inactive key reads `inactive`, not `expired`, because that is the state they chose and can undo. Soft-deleted keys are omitted. Opposite direction to provider-keys. List shows a masked `keyPrefix` only. **Only `kind: "external"` is creatable**: sibling vxture products authenticate with a short-lived OIDC S2S token whose `act.sub` is the product identity `product_endpoint_grants` authorizes against - an internal key would swap a signed 300-second identity for a long-lived shared secret. Legacy rows keep `kind: "internal"`, are revoked, and stay readable; the DB constraint is `NOT VALID` so those rows stay as issued |
| POST/DELETE | `/capability/api-keys[/:id[/rotate\|activate\|deactivate\|revoke]]` | Six actions: create, rotate, activate, deactivate, revoke, delete. One-way hashed (sha256) - the full secret is returned once, on create and rotate, and never retrievable after. `revoked` is terminal (`409` on any further change). **Delete is a soft delete and requires the key to be deactivated or revoked first** - nothing goes from live to gone in one action. `expiresAt` is set at create and reissued by rotate; extending a term without changing the secret would leave a credential that was exposed for its whole original life still valid. **These keys authenticate nothing yet** - `/v1/*` accepts only S2S OIDC tokens, so `lastUsedAt` is always null (TD-034) |
| GET | `/capability/logs` | Request/error log search over `reqlog.request_records`/`error_records` (`tenantId`/`modelCode`/`providerCode`/`endpointCode`/`status`/`requestId`/`taskId`/`from`/`to`/`cursor`/`limit` filters). Cursor pagination - see below |
| GET | `/capability/audit-logs` | Operator change trail (product_250 M-5). Filters: `objectType`/`objectId`/`actorId`/`action`/`outcome`/`from`/`to`/`cursor`/`limit`. Cursor pagination, same shape as `/capability/logs`. **Read-only by construction** - see "The change trail is append-only" below |
| GET | `/capability/logs/summary` | Aggregated QPS/error-rate/latency (avg + p95) and `totalTokens`, overall and grouped by `modelCode`/`providerCode`/`endpointCode`, over a `window` (`1h`/`24h`/`7d`, default `24h`). Filters: `modelCode`/`providerCode`/`endpointCode`. A group with `endpointCode: null` is real - see the note on the endpoint axis above - and is reported rather than dropped, so the groups still add up to `overall`. `overall.totalTokens` is `0`: it comes from a separate aggregate that carries no token sum, and re-deriving it by summing the groups would create a second source of truth for one number |
| GET | `/capability/logs/cost` | **Estimated cost for the internal pool (TD-047). Atlas meters, it does not bill** - this is not an invoice and not the tenant-facing token quota. Token quantities grouped by `(modelCode, providerCode, priceRuleId)` over a `window` (`1h`/`24h`/`7d`, default `24h`), each priced with the rule whose `effectiveAt`/`expiresAt` window contains the request's `createdAt`. Filters: `modelCode`/`providerCode` - no `endpointCode`, because prices attach to models and a per-endpoint cost is not a number the price table can produce. Three things the response states rather than assumes, carried in `basis`: `reasoningTokens` are **reported and never added** (they are a subset of `outputTokens`, already charged at the output rate); an undeclared `cachedInputUnitPrice` falls back to `inputUnitPrice`, which overstates rather than understates; and requests with no rule in force are counted in `coverage.requestsWithoutPriceRule` and contribute **no** cost rather than zero. Money is a decimal string, never a JSON number, and `totalsByCurrency` is a list - summing across currencies would invent a figure. `isActive` is deliberately not part of rule selection: it is a present-tense switch, and letting it decide history would make last month's number change today. **Off-peak**: requests are bucketed by UTC hour-of-week and priced at the provider's off-peak multiplier when they fall outside its declared peak windows (`config.pricing.offPeak` on the provider row - which hours count as peak is configuration, not something the query hard-codes). On DeepSeek that is roughly **79% of the week** (peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri). Each item reports `peakRequests`/`offPeakRequests` and `offPeakPolicyApplied`; a provider that has declared no policy is priced entirely at peak rates, which **overstates** it, and those requests are counted in `coverage.requestsWithoutPricingWindow` rather than presented as exact. A malformed policy is refused rather than ignored - silently dropping it would bill a whole provider at full rate while the operator believes a discount is configured - and the refusal is a **coded 400** naming the provider (`OBSERVABILITY_INVALID_PRICING_POLICY`, with `providerCode`), not a bare 500: a config row is operator data, and an uncoded server error tells the one person who can fix it nothing |

### Authorization is moving to (product, endpoint)

**What is sold is a product service, not a model service.** A customer buys
karda; which capabilities karda needs is product engineering, not per-customer
commerce.

| Relationship | Nature | Owner |
|---|---|---|
| tenant <-> product | commercial | the platform, via C2 entitlement |
| product <-> endpoint | engineering | **Atlas - `model.product_endpoint_grants`** |
| tenant <-> model | should not exist | - |

The bottom row is what `model_grants` was: a per-tenant per-model table an
operator maintained, encoding a commercial decision in a technical registry.

**A grant names an ENTRY POINT, not a model.** Repointing an endpoint is
supposed to be invisible to callers - that is what an endpoint is - so
model-scoped grants would break the abstraction at exactly the layer that must
not break, and would leave an endpoint's fallback needing its own grant before
it could ever fire. Endpoints are also a curated namespace (30) where models
are not (131 and growing).

A direct `modelCode` call is authorized against the **derived** set: models
reachable as primary or fallback of an endpoint the product holds. That is what
"choose a cheaper model, within what the product is authorized for" means -
the product's reach is its endpoints, and the choosable models fall out of
them. Every model code that has ever been called is reachable this way.

`productCode` is `act.sub` on the verified token: unlike `tenantId`, which
partly arrives in the request body, a caller cannot forge it.

Managed at `/capability/product-endpoint-grants`. A grant is unique per (product,
endpoint, application scope): the runtime authorizes on ANY matching active
grant, so a duplicate would keep serving after an operator deactivated the one
they were looking at - an action that appears to have worked and did not.

**Transitional: both axes are live.** A call is allowed if a product grant
reaches the model OR a legacy tenant grant matches, so nothing that worked
stops working. Which axis authorized is counted in
`model_grant_authorizations_total{axis}`; `model_grants` is dropped only once
traffic shows nothing still authorizes through it.

`taskProfile` retires with the tenant axis: it is a per-tenant stable name
resolving to a model, which is what `endpointCode` already does globally.

### Lifecycle: deactivate, then delete

`isActive` is the operator's intent. **No action on a parent ever writes it on
a child** - deactivating a model does not deactivate the endpoints pointing at
it. Cascading that write would kill endpoints whose fallback still works,
overwrite an operator's own decision to disable one, and leave reactivation
unable to tell which endpoints it should switch back on.

Instead the consequence is **derived at read time**. Every endpoint row carries:

| `resolution` | Meaning |
|---|---|
| `inactive` | the operator switched it off; no model state overrides this |
| `unresolvable` | neither primary nor fallback can serve - calls fail |
| `degraded` | the primary cannot serve, the fallback can - **calls still succeed** |
| `serving` | the primary can serve |

plus `models[]`, each with `availability`: `available` / `model_inactive` /
`provider_inactive` / `missing`.

**A model is usable only if it AND its provider are active**, on the data plane
as well as here - deactivating a provider stops its traffic, not just its
listing. A model with no provider row is excluded for the same reason: it
cannot resolve an upstream, and `GET /v1/models` does not advertise it.

**Delete has two preconditions**, both refusals rather than cascades:

1. **The resource must already be deactivated** (`409
   MODEL_ADMIN_MUST_DEACTIVATE_FIRST`). Nothing goes from serving traffic to
   gone in one action.
2. **It must have no dependents** (`409 MODEL_ADMIN_HAS_DEPENDENTS`, with a
   `blockedBy` list naming them). Provider: no non-deleted models. Model: no
   grants and no endpoint references, counting **fallback references too** -
   severing a failover chain silently is the same class of problem as breaking
   a primary, only quieter. Endpoint: **this precondition does not apply** -
   the delete checks deactivation only. `model.product_endpoint_grants.endpoint_code`
   does reference an endpoint, but nothing counts those grants, so deleting an
   endpoint leaves every product grant naming it dangling: they read
   `state: "missing"` on `GET /v1/endpoints` and `404 ENDPOINT_NOT_ROUTABLE` at
   call time. The earlier wording here - that nothing inside Atlas references an
   endpoint - stopped being true when product grants landed (incr/06).

The counts on the list rows (`modelCount`, `grantCount`, `endpointRefCount`)
are **the same numbers that block the delete**, read from the same source. A
column showing 0 while the delete returns 409 would be worse than no column.
They count non-deleted dependents regardless of active state: a deactivated
endpoint still references its model.

### Which axis a usage rollup is grouped on

`/capability/usage-summaries` takes `groupBy`, and every row states which axis
produced it in `dimension`. Identity fields that do not belong to that axis are
`null` - a provider row has no tenant, because it sums across all of them.

| `groupBy` | Grouped by | Answers |
|---|---|---|
| `tenant` (default) | **tenant x workspace x product** x month x application | "what did this customer consume, in which workspace, and through which product" |
| `provider` | provider x month | "which provider's volume is climbing" |
| `model` | model x month | "which model burned the most tokens" |
| `endpoint` | endpoint x month | "how much traffic went through this entry point" |
| `product` | product x month | "what does karda cost to run" |

**The billing subject is the (tenant, workspace) pair, not either alone.**
tenant:workspace is 1:N, so grouping by tenant hides which workspace burned the
spend and grouping by workspace loses which customer to bill. The default axis
groups on both, and `workspaceId` is on every tenant-axis row.

`product` is an aggregation axis, not a subject: it answers what serving a
product costs, which is the number a product service is priced from. It reads
`product_code` (`act.sub` on the verified S2S token, so not caller-asserted).
The older `product_id` column is a cross-database uuid and stays permanently
NULL - `product_code` is the resolvable form (incr/05).

The `provider`/`model` axes deliberately do NOT split by application the way
the tenant axis does. They exist to answer a cost/volume question across all
callers, and splitting would multiply the row count without serving it.

**The endpoint axis excludes NULLs rather than bucketing them.** A row has no
`endpoint_code` in two cases: the caller named a `modelCode`/`taskProfile`
directly (a real routing mode, not a gap), or the row predates
`incr/03_reqlog_endpoint_code.sql`. Neither is an entry point, so neither is
reported as one. Two consequences to state plainly:

- **Endpoint-axis totals do not sum to the tenant/provider/model totals.** They
  cover endpoint-routed traffic only, and that is the honest number.
- **Endpoint history starts at the deploy date of incr/03.** The endpoint that
  served an older request was never recorded anywhere, so there is no backfill
  - only a guess, which is worse than a stated gap.

An endpoint that has since been deactivated still appears with its historical
traffic. Deactivating an entry point stops it routing; it does not rewrite what
it already routed.

### The change trail is append-only

`audit.change_records` records every mutating `/capability/*` request:
resource, id, action, the M-1 operator `sub`, the workforce RP (`act.sub`),
the field NAMES a write touched, and whether it succeeded.

Three properties, each load-bearing:

- **Append-only in the database, not by convention.** `atlas_svc` holds INSERT
  and SELECT on this table and nothing else - no UPDATE, and unlike every other
  append-only table here, no DELETE either (`reqlog` keeps DELETE because its
  cleanup is DROP PARTITION). A trail the service can rewrite is not a trail.
  Retention, if it is ever wanted, is an owner-run DDL operation.
- **Derived from the route, not from a call in each handler.** The record comes
  from middleware that reads `POST /capability/providers/:id/deactivate` as
  resource, id and action. Explicit per-handler calls would audit exactly the
  routes someone remembered to annotate, and forgetting one fails silently. A
  new write route is audited the moment it exists.
- **Field names, never values.** Request bodies here carry provider API keys
  and gateway key secrets. An audit table that becomes a second, unencrypted
  copy of the key vault is a worse problem than the gap it closes. Names answer
  the operational question on their own; recovering old values is what
  append-versioning of price rules and policies is for.

Rejected attempts are recorded with `outcome: "failure"`, including ones the
guard turned away before any handler ran (`operator_sub: "unknown"`) - a write
attempt with no attributable operator is exactly what an auditor looks for.

Reads are never recorded: auditing GETs would bury the writes that matter under
the list calls a dashboard makes on every refresh.

**`created_by`/`updated_by` on the registry tables are NOT the trail.** Those
columns exist on seven tables and only `gateway_api_keys` populates them. They
are superseded rather than fixed: they hold one last-writer, while this table
holds the history, and maintaining both would create two answers to one
question. Tracked as TD-033.

### Pricing and policy rows are versioned by append

`model_price_rules` and `model_policies` change by writing a new row and
expiring the old one, never by editing it. `98_column_locks.sql` grants UPDATE
on the lifecycle columns only, so the database enforces it.

Both are queryable as of a moment - policies via `findApplicablePolicy` (the
rate limiter really reads it), price rules via
`GET /capability/price-rules?asOf=<ISO>|now`, same predicate.

**No expiry sweeper, deliberately.** Nothing flips `is_active` when
`expires_at` passes - a scheduled job rewriting rows would destroy the history
this table exists to hold. Expiry is evaluated at READ time, so "expired but
still active" is a real state and `asOf` is the only thing that distinguishes
it. Omitting `asOf` returns the whole ledger; an invalid value is a 400.

**Delete exists and is soft.** History does not depend on the row:
`audit.change_records` records who removed what and when, append-only.
Deactivation is required first, as everywhere else.

### Cursor pagination

`/capability/logs` and `/capability/audit-logs` paginate by cursor; every
other `/capability/*` list endpoint is `includeInactive` + an unpaginated
`findMany`, which works because the registry tables
(providers/models/policies/...) are finite; `reqlog` volume is not. The cursor is opaque (base64 JSON of `{createdAt, id}`, the
same pair the query orders by DESC) - treat it as a token, not a format to
hand-construct. A response's `nextCursor` is `null` once there is no further
page.

### Response shape: bare array vs envelope

**Authority is `product_251` A-4, not this file.** Recorded here only because
this repo has to implement it; if it ever disagrees with A-4, A-4 wins. It was
this section inventing its own answer that created the divergence A-4 exists to
close - runos independently invented a different one, and both were internally
consistent.

The test is **whether the server resolved something the caller must be told
about**, not what kind of resource it is:

| Case | Shape | Here |
|------|-------|------|
| Nothing resolved | bare JSON array | `providers`, `models`, `model-routes`, `provider-keys`, `api-keys`, `product-endpoint-grants` |
| Cursor | `{items, nextCursor}` | `/capability/logs`, `/capability/audit-logs` |
| Resolved window or axis | `{from, to, dimension?, items, ...}` | `/capability/logs/summary`, `/capability/logs/cost`, `/capability/usage-summaries` |

Three rules that are easy to get wrong:

- The collection key is **`items`**, never `rows` / `data` / `byGroup`. Internal
  layers may keep their own words - the repository still returns `byGroup` - but
  the wire says `items`.
- **The resolved value goes on the envelope, never on every row.** It was on the
  row for `usage-summaries` and that is a defect, not a style: `groupBy` defaults
  to `tenant` server-side, so with zero rows the echo vanished and a caller
  holding `[]` could not tell which axis it had queried.
- **Only resolved values are echoed, not the query string.** `cycleMonth` is a
  pass-through filter with no server default, so it is not on the envelope.
  `dimension` and the summary window are, because the server picked them.

### Price-rule unit semantics

**A price rule is the vendor's price to Atlas** - what the upstream charges,
transcribed from its published price table (ADR-012). It is not a sales price:
what a tenant pays, and the token-to-`ai.credit` conversion, belong to the
platform. Rules are written from the admin console's model platform page
(through admin-bff); Atlas has no form of its own.

A price is three fields that only mean something together, and two of them have
defaults that read as assertions but are not. Anyone authoring a rule - through
the admin console or the API - needs this before typing a number.

| Field | Meaning |
|---|---|
| `unit_tokens` | the **basis** the price is quoted per, not a cap or a quota. Default `1000000`, i.e. `input_unit_price` is a price *per million tokens* |
| `currency` | **The currency the vendor quotes in, set explicitly.** The column's `CNY` default is a Postgres column default, not a statement about the row |
| `input_unit_price` / `output_unit_price` / `request_unit_price` | `numeric(18,8)`, price per `unit_tokens`. `billing_mode` selects which apply: `token` uses input/output, `request` uses request |

A vendor quoting per million tokens converts one to one. A vendor quoting per
single token converts as `price x 1e6`, rounded to 8 decimal places. Either way
`currency` is set explicitly.

`cached_input_unit_price` (TD-047, `incr/02`) prices the input tokens an upstream
served from its prompt cache - `reqlog.request_records.cached_input_tokens`
records how many there were. It is **nullable, and null does not mean free**: it
means no cached rate was declared, and a cost calculation falls back to
`input_unit_price`, which overstates rather than understates. Never fold a
cache-read discount into `input_unit_price` itself - that silently mis-prices
every uncached call.

`cache_write_unit_price` / `cache_write_1h_unit_price` (TD-057, `incr/06`) price
the input tokens written to the upstream's prompt cache, 5-minute and 1-hour TTL
(`reqlog.request_records.cache_write_input_tokens` /
`cache_write_1h_input_tokens`). Same null rule: undeclared 1-hour falls back to
the 5-minute rate, undeclared 5-minute to `input_unit_price`.

**No column exists** for per-model input caps or per-model output caps. Vendor
tables carry these; Atlas cannot express them.

Atlas **meters, it does not bill** (`docs/30-design/100-model-onboarding-and-protocol-adapters.md`
§1). It does multiply: each reqlog row is priced at write time
(`upstream_cost`, by the rule in force at the call's `started_at`) and
`/capability/logs/cost` sums the same formula. The result is what the call cost
the platform - never what anyone is charged. A rule entered as a sales price
would make every such cost wrong with nothing raising an error, which is why
ADR-012 fixes the meaning.

## Service health (operator plane) - the platform watcher's contract

ADR-013, design `docs/30-design/120-service-health-monitoring.md`. Live from
v0.7.21 (F1a). This section is the contract the platform's server-side watcher
(vxture-platform#562) implements against; the design explains why.

### Auth

`OperatorAuthGuard`, like every `/capability/*` route: an RS256 token from the
platform issuer with `realm = "workforce"`, `userType = "operator"`,
`scope = "mgmt:atlas"`, a `sub` and an `act.sub`. A missing or wrong token is
`401` with one of `OPERATOR_TOKEN_MISSING` / `_INVALID` / `_WRONG_SCOPE` /
`_WRONG_REALM` / `_WRONG_USER_TYPE` / `_MISSING_SUB` / `_MISSING_ACT`.

**Open, and blocking for an unattended job:** these tokens are issued to
people. Which credential a server-side job uses is the platform's to settle on
#562 (a machine client with a read-only scope is the likely shape); Atlas will
accept what is agreed there. Until then the endpoints are callable with an
operator's own token, e.g. from opera.

### `GET /capability/health` - current state

No query parameters (any is `400 HEALTH_UNKNOWN_FILTER`).

```json
{
  "generatedAt": "2026-10-02T09:30:00.000Z",
  "models": [
    {
      "modelCode": "deepseek-v4-flash",
      "providerCode": "deepseek",
      "state": "account_refused",
      "since": "2026-10-01T16:47:11.424Z",
      "upstreamStatus": 402,
      "detail": "{\"error\":{\"message\":\"Insufficient Balance\"}}"
    }
  ],
  "routes": [
    {
      "code": "chat/fast",
      "state": "down",
      "severity": "critical",
      "primary": { "modelCode": "doubao-seed-2-0-lite-260428", "state": "account_refused" },
      "fallback": { "modelCode": "deepseek-v4-flash", "state": "account_refused" }
    },
    {
      "code": "rerank/default",
      "state": "ok",
      "severity": null,
      "primary": { "modelCode": "rerank", "state": "unknown" },
      "fallback": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `models[].state` | `ok` / `rate_limited` / `account_refused` / `unavailable` / `model_missing` / `unknown` |
| `models[]` | **only models with a recorded result** (a real call, or a probe from F1b on) since the state was first kept. It is not the model catalogue; a model absent here is `unknown` |
| `models[].upstreamStatus`, `detail` | present while the model is failing: the vendor's HTTP status and its own words (up to 300 characters). `detail` often says what to do ("adjust or close the Safe Experience Mode") |
| `routes[]` | **every active route as configured now**, evaluated at read time |
| `routes[].state` | `ok` (primary not failing) / `degraded` (primary failing, fallback serving) / `down` (nothing serving) |
| `routes[].severity` | `null` / `warning` / `critical` |
| times | ISO 8601, UTC |

`unknown` is not failing: a route whose primary has never been seen is `ok`.

### `GET /capability/health/events` - transitions, by cursor

| Query | Meaning |
|---|---|
| `after` | the `nextCursor` of the previous page; omit for the beginning |
| `limit` | 1-200, default 50 |

```json
{
  "items": [
    {
      "id": "5b0c...",
      "createdAt": "2026-10-01T16:47:11.430Z",
      "subjectKind": "model",
      "subjectKey": "deepseek-v4-flash",
      "providerCode": "deepseek",
      "from": "unknown",
      "to": "account_refused",
      "severity": "warning",
      "upstreamStatus": 402,
      "detail": "{\"error\":{\"message\":\"Insufficient Balance\"}}",
      "affectedRoutes": ["chat/fast"]
    },
    {
      "id": "8e21...",
      "createdAt": "2026-10-01T16:47:11.431Z",
      "subjectKind": "route",
      "subjectKey": "chat/fast",
      "providerCode": null,
      "from": "degraded",
      "to": "down",
      "severity": "critical",
      "upstreamStatus": null,
      "detail": null,
      "affectedRoutes": ["chat/fast"]
    }
  ],
  "nextCursor": "MjAyNi0xMC0wMVQxNjo0NzoxMS40MzFafDhlMjEuLi4"
}
```

- **Order**: oldest first, by (`createdAt`, `id`). The cursor is opaque - store
  it, never build it.
- **An empty page returns the cursor you sent**, so keeping `nextCursor` after
  every call is always correct.
- **One event per transition**, not per failed call: a model failing for a day
  produces one event when it starts and one when it recovers.
- **Recovery is an event**: `to: "ok"` with `severity: "info"`, for a model or
  a route. A route that improves without recovering (`down -> degraded`)
  carries the severity of where it landed (`warning`).
- A model's first sighting as healthy is stored without an event.
- Errors: `400 HEALTH_INVALID_CURSOR` (not a cursor this endpoint issued),
  `400 HEALTH_INVALID_LIMIT`, `400 HEALTH_UNKNOWN_FILTER`; envelope
  `{ "code", "message", "retryable": false }`.
- Retention: events are append-only and not pruned today.

### How the watcher is expected to consume it

1. **Every minute**: `GET /capability/health/events?after=<stored cursor>&limit=200`;
   while a page comes back full, fetch the next one at once. **Store the cursor
   only after the page has been handled** - delivery is at-least-once, so
   de-duplicate on `id`.
2. **Notify** (admin first, owner 2026-10-02):
   - `critical` (a route `down`): immediately;
   - `warning` (a model failing, a route `degraded`): yes;
   - `info` (a recovery to `ok`): close the open notice for the same
     `subjectKind` + `subjectKey` rather than raising a new alarm; a route
     going `down -> degraded` updates its notice to warning.
   One open notice per subject is enough; later events on it update it.
3. **First run** (no cursor): read from the beginning; whether to notify for
   events older than the watcher itself is the platform's choice.
4. **Watch Atlas itself**: `GET /healthz` on the same minute. Three failures in
   a row is "Atlas unreachable" (critical); the next success closes it. Atlas
   cannot report its own death - this is the only place it is seen.
5. `GET /capability/health` is for a status view (admin), or to rebuild state
   after the watcher has lost its cursor; it is not needed for notifications.
6. `/readyz` `checks.routeHealth` (`warn`, `routesDown: [...]`) repeats route
   `down` for anything that already polls `/readyz`; it is not a second
   notification source.

### Probe settings - `GET` / `PATCH /capability/health-settings`

Edited from opera (owner, 2026-10-02). Resolution: model -> vendor -> the
server's `.env` (`HEALTH_PROBE_INTERVAL_MINUTES`, `HEALTH_PROBES_ENABLED`) ->
built-in (60 minutes, on).

`GET /capability/health-settings` (no query parameters):

```json
{
  "global": { "intervalMinutes": 60, "enabled": true, "intervalSource": "default", "enabledSource": "default" },
  "overrides": [
    { "subjectKind": "model", "subjectKey": "deepseek-v4-pro", "probeIntervalMinutes": 30,
      "probeEnabled": null, "updatedBy": "opr_...", "updatedAt": "2026-10-02T10:00:00.000Z" }
  ],
  "targets": [
    { "modelCode": "deepseek-v4-pro", "providerCode": "deepseek", "state": "ok",
      "lastResultAt": "2026-10-02T10:05:00.000Z",
      "intervalMinutes": 30, "intervalSource": "model", "enabled": true, "enabledSource": "default" }
  ]
}
```

`targets` are the models probed: the active models a route names, plus any
model already seen. Each value carries the level it came from (`model` /
`provider` / `global` / `default`).

`PATCH /capability/health-settings/:subject`, `:subject` = `model:<model_code>`
or `provider:<provider_code>`:

```json
{ "probeIntervalMinutes": 30, "probeEnabled": false }
```

- Either field, or both. `probeIntervalMinutes` 5-60; `null` clears the
  override so the level above applies.
- Answers `{ "override": {...}, "effective": {...} }` - what is now stored, and
  what is now in effect for that model (or, for a vendor, for its models with
  no override of their own).
- `400 HEALTH_SETTING_INVALID` (range, type, unknown field, empty body, bad
  subject); `404 HEALTH_SETTING_UNKNOWN_SUBJECT` (no such model or vendor).
- The writer is taken from the verified operator token, never the body; the
  change is in `audit.change_records` as resource `health-settings`.

## Tenant self-service plane

Auth: `S2sAuthGuard` (`tool:atlas`). **Scope is derived from the token, never
from the caller**: `?scope=tenant` uses the `tenant_id` claim (falling back to
the legacy `org_id`), `?scope=workspace` (default) uses `workspace_id`. No
request field can widen it.

`?scope=tenant` is not universally available: the platform mints `org_id` only
when an organization is active, while every user has an auto-created `personal`
tenant, which therefore carries no tenancy claim and gets
`403 TENANCY_SCOPE_UNAVAILABLE`. `?scope=workspace` always works.

| Method | Path | Notes |
|---|---|---|
| GET | `/tenancy/models` | Models this **tenant** holds an active grant for. Keyed on the token's `tenant_id`/`org_id`, because `model_grants.tenant_id` is a tenant - a workspace uuid there matches nothing (TD-022). `403 TENANCY_SCOPE_UNAVAILABLE` when the token carries no tenant identity, rather than an empty list |
| GET | `/tenancy/grants` | The grants themselves, incl. `taskProfile`/`priority`; operator-only `reason` is not projected. Same tenant keying as above |
| GET | `/tenancy/quotas` | Entitlement from the platform's C2 envelope |
| GET | `/tenancy/usage` | `?scope=workspace\|tenant`, `?days=1..366` (default 30) |

Together these are the full replacement set for what console-bff previously
read from `/capability/*`, which is what made locking that plane to operator
tokens possible.

Two levels because the platform's model has two: workspace is the
cost-accounting unit, tenant is the rollup above it. The namespace is named
after the tenancy *dimension* rather than either level.

`/tenancy/quotas` reads the C2 envelope, and `status` separates `covered` /
`uncovered` (resolved, no coverage) / `unavailable` (could not ask) - otherwise
"no plan published" and "platform unreachable" would render identically.

`/tenancy/usage` is served from Atlas's own `reqlog.request_records`
(`source: "atlas.reqlog"`) - what actually ran. It is **not** a billing figure;
billing sums the platform's `usage_events` over the subscription period. See
`docs/30-design/210-usage-metering-and-history.md`.

## Infra / health

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | Liveness, zero dependencies |
| GET | `/readyz` | Readiness. Checks `database`/`modelRegistry`/`providerKeys`/`usageSummaryRead`/`reqlogPartitions`, plus `registryDrift` - config drift the lifecycle rules exist to prevent (models left active under a deactivated provider, which are unreachable rather than still serving - see "A model is usable only if it AND its provider are active" above; active endpoints that cannot resolve their primary). `registryDrift` reports counts and **never moves the overall status**: Atlas is healthy while a registry is misconfigured, and that is a thing to see rather than a reason to leave the load balancer |
| GET | `/internal/diagnostics` | `InternalDiagnosticsGuard` |
| GET | `/status` | Human-readable render of `/readyz` |
| GET | `/metrics` | `InternalDiagnosticsGuard` |

`/healthz` and `/readyz` are unauthenticated; the other three are guarded.

## Protocol-fixed - not Atlas's naming to change unilaterally

| Method | Path | Notes |
|---|---|---|
| GET | `/.well-known/vxture-tools` | Capability discovery manifest (product_210 §11), `S2sAuthGuard`. `atlas.parse` is withheld while no registered model can serve it - a descriptor is published only once a call would succeed (TD-019) |
| POST | `/provisioning/webhook` | C3 provisioning webhook, `x-vxture-signature` HMAC (not a guard) |

## Not implemented

OIDC RP (five endpoints) - an inherited services-profile obligation with no
controller in code. Atlas has no browser surface; the operator UI lives in
`vxture-platform`. Do not treat it as a live integration point.
