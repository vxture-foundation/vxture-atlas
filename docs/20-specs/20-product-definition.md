# Atlas product definition

What Atlas is, what it owns, and what it deliberately does not do.

The product definition is Atlas's to own (CLAUDE.md rigid/blank split), so it
lives here; opera links to it rather than maintaining a copy.

Route-level detail is `10-http-surface.md`. This file is the shape, not the
signatures.

## What Atlas is

The single model egress for every vxture product. Registration, routing,
proxying, quota gating, metering, observability. **No business logic, no UI**
- headless, consumed over S2S by karda / arda / varda and operated through
opera's pages.

```
business app ──▶ Atlas ──▶ Doubao / Zhipu / DeepSeek / Claude / private
```

## The eight domains, and their real state

| Domain | What it is | State |
|---|---|---|
| **Provider** | An upstream vendor account. CRUD + health. | Health is **derived from real traffic**, not polled - no upstream cost on page load. A provider that has never carried traffic reads `unknown`, so `POST /capability/providers/:id/probe` exists for on-demand verification. Deliberately no periodic probing. |
| **Model Registry** | A callable model under a provider, with capability tags. CRUD. | Complete. `modelCode` immutable after creation. |
| **Endpoint** | A stable capability name (`chat/default`) that business systems bind to instead of a model. CRUD. | Complete; routing runs through it, including its fallback chain. |
| **Router** | **Not a resource.** Primary/fallback live on the endpoint record. | There is no Router table, API or page, and none is planned for 1.0. Weight and canary routing are 2.0. |
| **API Gateway** | The `/v1/*` data plane: chat (+SSE), embed, rerank, parse. | chat complete. embed/rerank Zhipu only. parse is implemented on `OpenAiCompatibleProvider` behind a vision gate (`config.supportsVision`); with no vision model registered it answers an in-contract 501 and `atlas.parse` is withheld from discovery. |
| **API Key** | Inbound keys authenticating callers of Atlas itself. CRUD + rotate + revoke. | Management complete; **the keys authenticate nothing** - `/v1/*` accepts only S2S OIDC tokens (TD-034). Issuing one does not make it usable. |
| **Metering** | Per-request facts, rolled up. | Requests, tokens, latency, errors, on five axes. **No cost** - see below. |
| **Observability** | Log search and windowed aggregates. | Complete, including the endpoint dimension. |
| **Audit** | Who changed what on the operator plane. | `audit.change_records` + `GET /capability/audit-logs`, append-only at the database level. |

## Two operator planes: configuration and runtime

Operators do two different jobs and the product has to cover both. They share
`/capability/*` and one guard today, which is a fact worth stating rather than
a design:

**Configuration plane** - changes intended state. Every *write* here lands in
`audit.change_records`; the list reads do not.

| Resource | Operations |
|---|---|
| providers / models / endpoints / grants | list, create, update, activate, deactivate, delete |
| price-rules / policies | list, create, update, activate, deactivate, delete (soft delete) |
| provider-keys | list, create, rotate, activate, deactivate |
| api-keys | list, create, rotate, activate, deactivate, revoke |
| protocols | list only - the vocabulary the config UI builds its dropdowns from |

**Runtime plane** - observes or acts on the running system without changing
intended state. Not audited (reads), except the probes.

| Surface | Answers |
|---|---|
| `providers` `health` field, `providers/performance` | is each upstream working, how fast |
| `providers/:id/probe`, `models/:id/probe` | is this one reachable *right now* |
| `logs`, `logs/summary` | what happened, what is failing |
| `usage-summaries` | who consumed what, on five axes |
| `audit-logs` | who changed the configuration plane |
| `quotas` | **501** - no bulk entitlement read exists upstream |
| `healthz`, `readyz`, `status`, `metrics`, `internal/diagnostics` | is Atlas itself alive |

Neither plane: `/v1/*` (data), `/tenancy/*` (tenant self-service),
`/provisioning/webhook` (inbound), `/.well-known/vxture-tools` (discovery).

The split, what naming it exposed, and the six rules that govern this plane:
[`../30-design/110-management-plane.md`](../30-design/110-management-plane.md).

### Known gaps, per plane

**Runtime** - no TTFT (only total latency, which is the wrong number for
streaming); counters are process-local and reset on restart; nothing evaluates
the data into a threshold or an alert; `quotas` is 501 so "who is near their
limit" is unanswerable across tenants.

**Configuration** - no dry run before repointing an endpoint; no batch
operations; `taskProfile` has no directory, so an operator cannot see the set
they are choosing from.

None block the 1.0 surface. They are written down so the next "is this
covered?" has an answer that is not a guess.

## Naming a model: three inputs, one precedence

`modelCode` > `endpointCode` > `taskProfile`. At least one required; passing
several is not an error, the narrower wins.

**Precedence is not advice.** It says which one wins when several are present;
it does not say which to reach for. A PRODUCT integrating wants `endpointCode`:
it resolves from a single string on the product authorization axis, needs no
tenant, and repoints for free - every product holding the code follows.
`taskProfile` resolves through `model_grants`, the tenant axis being counted
down to removal, so naming a label there requires a `tenantId` the caller may
have no reason to hold and repointing costs a grant row per tenant. See
TD-052; the correction to a consumer steered the wrong way is vxture-atlas#47.

Two contracts, not implementation details:

- **The endpoint owns its failover chain.** On endpoint routing, the
  endpoint's `fallbackModelCode` is the only chain - the resolved model's own
  `config.fallbackModelCodes` does not stack on top. One route, one authority.
- **An endpoint may point at any model.** The registry does not check its
  `category` against the target's `modelType`. Whether the upstream implements
  the call is answered at call time, not guessed by the registry: by `501` when
  the adapter lacks the capability, and by the vendor's own refusal when it has
  it (a Zhipu chat model named on a rerank route reaches Zhipu's rerank API and
  is refused there). Not refused at write time, but **reported**: a route of a
  typed category (`chat` / `embedding` / `rerank`) naming a model of another
  type is listed in `/capability/health` `routes[].configIssues`, and that
  model counts as not serving the route (design 120 section 4.4). Whether to
  refuse such a write is an open owner decision.

Naming an endpoint never widens authority: grants are still checked against
the *resolved model*.

## Metering: five axes, and no cost

`?groupBy=tenant|product|provider|model|endpoint`, each grouped by month; the
default rollup is tenant x workspace.

Two properties that look like bugs and are not:

- **The endpoint axis totals less than the other axes.** The difference is
  traffic that named a model or task profile directly - it went through no
  entry point, so it belongs to none. Excluded rather than bucketed;
  attributing it would be a false report.
- **Endpoint history starts at the `incr/03` deploy.** The endpoint that served
  an older request was never recorded anywhere. Inferring one from the model
  would be a guess printed as a fact.

`logs/summary` does the opposite and *reports* its null endpoint group, because
there the groups must sum to `overall`.

**Cost is not Atlas's** (ADR-004, owner decision 2026-08-13: it belongs to
platform-opera). Atlas holds both factors and guarantees they line up -
`GET /capability/price-rules?asOf=` answers "what was the rate at time T", and
the usage axes answer "how much was consumed" - but nothing on the request path
multiplies them.

Not recorded at all today: TTFT (only total `latency_ms`), and any
per-provider currency amount.

## Authorization: verify the source, do not re-judge the person

console / admin-bff / opera-bff authenticate the operator, evaluate the role,
and run whatever step-up the platform catalogue demands. Atlas verifies that
the instruction is genuine, current and addressed to it - and records who sent
it. It does not re-derive permission.

Redundant verification of the **credential** is cheap defence; redundant
adjudication of the **person** is a contradiction waiting to fire. Atlas
therefore runs no step-up adjudication of its own and does not interpret `amr`
or `operator_role` - it has no standing to.

## Principles

- **Provider decoupling** - business systems never name a vendor. Holds.
- **Endpoint first** - business systems bind to an entry point, not a model.
  Holds.
- **Metering first** - every request is recorded. Holds: request paths write
  `usage_type = normal`, the operator probe writes `test` (excluded from
  rollups), and gate refusals / usage-less streams land as rows too.
- **Observable first** - every request is searchable. Holds.
- ~~**Router driven**~~ - retired as a principle. There is no Router. Model
  selection is the precedence chain above.

## Roadmap

**2.0** - weight routing, canary routing, multi-region, SLA engine.
(Quota is *not* 2.0: gating against platform C2 already runs, fail-open for
uncovered workspaces by doctrine - ADR-001/TD-016.)

**3.0** - intelligent routing, cost optimization, model evaluation, benchmark
center, marketplace.

Per-module status is `docs/40-implementation/00-index.md`; open gaps are
`docs/60-operations/10-tech-debt.md`; the done/to-do list is
`docs/70-workplan/00-index.md`.
