# 200 - S2S provider surface (embedding / parse / rerank)

The endpoints Atlas exposes as a **supplier**: karda / arda / varda obtain a
credential by token exchange and call these. A4 (generation, `ChatRequest`)
is contracted in this repo's `docs/20-specs/10-http-surface.md` and is not
restated here. (This line used to point at a section 7 of the platform's
`40-model-platform.md`; that document is retired and itself names this repo as
the authority for Atlas's HTTP contract. Corrected 2026-09-30.)

All three are implemented: zhipu serves A1 and A3 in production; A2 is
implemented behind a vision gate (section 3). Design input was karda's
field-level requirements
(`vxture-karda/docs/80-liaison/100-2607240931-karda-atlas-capability-requirements.md`).
The contract-layer-first boundary is
[ADR-002](decisions/ADR-002-s2s-provider-surface-contract-layer-only.md).

## 1. Semantics shared by all three

### 1.1 Rate limit and quota exhaustion are different answers

- **Rate limit** (a technical rate gate, from `model.model_policies`) ->
  HTTP `429`, body `{ "code": "RATE_LIMITED", "retryable": true,
  "retryAfterMs": <int> }`, plus a standard `Retry-After` header (integer
  seconds, RFC 9110 sec.10.2.3, always rounded UP - the body keeps the precise
  ms). The caller should back off and retry. The header was promised here from
  the start and did not exist until 2026-08-16: nothing set it, because an
  `HttpException` carries a status and a body and nothing else. It is now added
  by `RetryAfterFilter`, which rebuilds the identical body so the X-1 envelope
  is unchanged.
- **Quota exceeded** (a commercial limit, from the platform's C2 envelope) ->
  HTTP `403`, body `{ "code": "QUOTA_EXCEEDED", "retryable": false }`. Not 429:
  retrying on a commercial limit only floods the caller's own pending queue.
  The caller should suspend the task and resume when quota returns.
- Both share the envelope of product_251 X-1: `{ code, message, retryable }`
  plus `requestId` where one exists. A given (`code`, HTTP status) pair is
  **never reused**, so callers branch on the pair and never parse message text.

> **Corrected 2026-08-16.** This section previously specified
> `QUOTA_EXHAUSTED` with a `resetAt` timestamp. Neither was ever real:
> `quota.service.ts` has always thrown `QUOTA_EXCEEDED`, `QUOTA_EXHAUSTED` was
> thrown nowhere, and `resetAt` was never populated by anything - the C2
> `QuotaPoolView` (`@vxture/shared`) carries `metric`/`limit`/`remaining`/
> `priority` and **no reset time at all**, so Atlas has nothing to put there.
> The docs-only spelling had been repeated to karda in
> `docs/80-liaison/10-2607241030-atlas-reply-to-karda-capability-requirements.md`,
> which meant karda's "suspend the task until quota returns" branch keyed on a
> code that could never arrive. `QUOTA_EXCEEDED` is also the spelling
> product_251 X-1 makes canonical across all three L1 products, so the code was
> right and the documentation was wrong. Getting a reset time to callers needs a
> C2 change first and is not promised here until it exists.

### 1.2 Attribution and the single metering entry point

- Every A1-A4 request carries `workspaceId` (the owning or triggering
  workspace, per capability below), `tenantId` (rollup only) and
  `applicationId`/`applicationType` - the same field names A4 already uses, not
  a parallel vocabulary.
- **`taskId`** (product_251 X-2): the agent TASK the call belongs to, minted by
  the caller and stable for the task's whole life - the same value the caller
  sends runos. Atlas records it verbatim in `reqlog.request_records.task_id` and
  it is queryable at `GET /capability/logs?taskId=`. `requestId` identifies one
  call and therefore relates a call to nothing; `taskId` is what makes "what did
  this agent task cost, and where did it fail" answerable when the task used
  both a model and a capability. Optional today because karda and vxtpl predate
  it; X-2 makes it mandatory, and that step needs the callers, not Atlas.
- Atlas is the **sole inference-metering entry point**: token and call
  consumption is accounted here and reported to the platform via C3 consume.
  Callers do not report model token usage themselves.
- Attribution is taken from verified token claims, never from the request body.

### 1.3 Credentials

- Background batch work (karda's processing pipeline: A1, A2) uses a
  service-mode token (product_210 token exchange), `aud=atlas`, `act.sub` =
  the calling service identity - not an end-user OBO token.
- Online retrieval (A3, user-triggered) may use either mode; metering records
  the workspace that issued the request.

### 1.4 Request size, and a request the upstream refuses

Applies to every `/v1` surface, generation included.

- **Body ceiling: 16 MiB** (`MAX_REQUEST_BODY_BYTES`, bytes; an unusable value
  stops the process at startup). It protects this process - the parser buffers
  the whole body and parses it synchronously - and is not a statement about how
  much a model can read. It is checked before routing, so it is one number for
  every route and model. Over it: `413`, `{ "code": "PAYLOAD_TOO_LARGE",
  "retryable": false }`, the message naming the received size and the limit.
  An unparseable body: `400 REQUEST_BODY_MALFORMED`. Neither reaches routing,
  so neither has a `requestId` or a reqlog row; both are counted in
  `model_request_rejections_total{code, product="unknown"}` (the product is
  unknown because the token has not been read yet).
- **The body is read before S2S auth.** Parsing is HTTP middleware, the token
  check is a route guard, so a caller with no token can still make the
  process buffer and parse up to the ceiling. A body declared larger than the
  ceiling (`Content-Length`) is refused before it is read. Accepted because
  Atlas is reachable only inside the tailnet, so every caller that can reach
  it is already a known host; if Atlas ever gets a public host
  (`atlas.vxture.com` is reserved, not bound), this has to be revisited.
- **What a model can read is its context window**, a per-model registry fact.
  Atlas does not estimate tokens and never truncates input.
- **The upstream refused the content** (it answered `400`/`413`/`422` - over
  its context window, over its own size cap, a parameter it rejects) ->
  `422`, `{ "code": "UPSTREAM_REJECTED_REQUEST", "retryable": false }`, with the
  vendor's wording (first 300 characters) in `message`. The fallback chain is
  still tried, since a fallback may have a larger window. It does **not** count
  toward the circuit breaker: it describes the request, not the model's health,
  and counting it would let one caller's retries take the model offline for
  every product. When the refusal is recognisably a context-window overflow
  (per-vendor signatures, ADR-008), the code is the narrower
  `CONTEXT_LENGTH_EXCEEDED` - same status, same handling - and the caller
  should split its input.
- **The upstream stopped for length before any answer** (`finish_reason=length`
  / `stop_reason=max_tokens` with nothing produced - on a thinking model,
  usually the whole `maxTokens` spent on reasoning) -> `422
  OUTPUT_BUDGET_EXHAUSTED`, `retryable: false`, same breaker exemption. Raise
  `maxTokens`, or send `thinking: "off"`.
- Upstream `401`/`403`/`404` (Atlas's own key or model mapping)
  and `408`/`429`/`5xx` stay `PROVIDER_UNAVAILABLE` and do count.

## 2. A1 - Embedding

| Item | Contract |
|---|---|
| Endpoint | `POST /v1/embed` |
| Request | `{ modelCode, texts: string[], workspaceId, tenantId?, applicationId?, applicationType? }` |
| Response | `{ modelCode, modelVersion, dimension, vectors: number[][] }` - `vectors` matches `texts` in length and order |
| Version pinning | `modelCode` is itself the versioned identifier (e.g. `embed-bge-m3-v2`); no `latest` alias is exposed. `dimension` is immutable for a given `modelCode` - a new algorithm or dimension is registered as a **new** `modelCode`, and existing vector stores keep using the old one |
| Batching | one `texts` array per request; provisional ceiling 256, to be confirmed against a real model |
| Idempotency | no server-side cache; callers de-duplicate if they need to |
| Metering | C3 consume `metric = atlas.embed`, amount = upstream-reported total tokens; when the provider reports no usage, nothing is consumed and the reqlog row's NULL `billed_amount` is the reconciliation signal - a number is never invented |

## 3. A2 - Parse (layout / OCR / table / formula)

| Item | Contract |
|---|---|
| Endpoint | `POST /v1/parse` |
| Request | `{ modelCode, task: "layout"\|"ocr"\|"table"\|"formula", pages: [{ pageIndex, imageRef\|imageBase64, regions?: [...] }], workspaceId, tenantId?, applicationId?, applicationType? }` |
| Response | shaped by `task`: `layout` -> `blocks: [{bbox, blockType}]`; `ocr` -> `spans: [{bbox, text}]`; `table` -> `{rows, cols, cells: [{rowSpan, colSpan, text, bbox}]}`; `formula` -> `{latex, bbox}` |
| Batching | one `pages` array carries multiple pages/regions in one request. The adapter still makes one upstream call per page - the round trip is saved for the CALLER, not upstream - and the response carries one entry per page: `{task, pages:[{pageIndex, ...structure}]}`. Until 2026-08-16 the response had no page dimension at all and the adapter returned only the first page while billing for every one; see `ProviderParseResponse`. The whole batch counts against the 16 MiB body ceiling (section 1.4); base64 adds a third to each image, so a batch of scanned pages should use `imageRef` or be split |
| Deployment affinity | satisfied: Atlas and karda are both allocated to worker-02 on the same tailnet, so parse calls do not cross a public path. Re-confirm if either side moves host |
| Attribution | `workspaceId` = the library owner |

Implemented on `OpenAiCompatibleProvider` over any OpenAI-compatible vision
model, gated on the model's `config.supportsVision`. Until a vision-capable
model is registered, the endpoint answers an in-contract `501` and
`atlas.parse` is withheld from capability discovery; activation is a registry
action, not a code change.

## 4. A3 - Rerank

| Item | Contract |
|---|---|
| Endpoint | `POST /v1/rerank` |
| Request | `{ modelCode, query: string, candidates: [{id, text}], workspaceId, tenantId?, applicationId?, applicationType? }` |
| Response | `{ modelCode, scores: [{id, score}] }` - scores are globally comparable within a `modelCode`, so no cross-index normalization is required of the caller |
| Candidate ceiling | hard server-side check `candidates.length <= 100`; over that is `400 CANDIDATE_POOL_TOO_LARGE`, never a silent truncation |
| Latency budget | measured 2026-08-10 in production (worker-02, zhipu `rerank`, 100-candidate pool, 100 sequential runs after 5 warmups, on-host caller, 0 failures): P50 425ms / P90 532ms / **P95 550ms** / P99 805ms / max 983ms. Callers should budget ~600ms at P95 and treat >1s as their degrade threshold (`vxture-atlas`#36) |
| Score distribution | measured range is heavily compressed at the top (a fully unrelated candidate can score 0.998 vs 1.0 for a relevant one): ORDER is reliable, absolute-score thresholds are NOT - do not build "score > X means relevant" cutoffs on this model |
| Degradation | when rerank is unavailable, fail fast with `503 PROVIDER_UNAVAILABLE` (`retryable: true`) rather than hanging, so the caller can fall back to its own ordering and mark the result degraded. This row promised `RERANK_UNAVAILABLE` until 2026-08-16; that code was declared, never thrown, and has been removed. A rerank-specific alias would be a second word for a meaning that already has one, and the caller's action is identical either way - X-4 |
| Attribution | `workspaceId` = the workspace that triggered the request, not the asset owner |
| Metering | C3 consume `metric = atlas.rerank`, amount = candidate pool size (the cross-encoder cost driver; deterministic even when the upstream reports no token usage). Upstream token usage still lands in reqlog when reported |

## 5. Tenant model list and task-profile routing

Two consumer-side prerequisites, both purely additive (new query parameters,
new optional fields, a new nullable column - no existing caller changes).

**Tenant-filtered model list.** `GET /v1/models` takes optional
`tenantId`/`applicationId`/`applicationType`. Without `tenantId` it returns all
enabled models (ops use). With it, it returns the models that tenant actually
holds a valid grant for - the direct dependency of a user-facing model picker.

`/tenancy/models` supersedes this for tenant-facing callers: it derives scope
from the token instead of accepting a caller-asserted `tenantId`.

**Task-profile routing.** All four request types take an optional
`taskProfile: string`, and `modelCode` becomes optional - **at least one of the
two is required**, neither is a 400. A caller can send only
`taskProfile: "summarization"` without knowing a `modelCode`.

- `model.model_grants.task_profile` (nullable) tags a grant as the preferred
  model for that tenant/application under that profile. Several grants may
  share a profile; the highest-priority active, unexpired match wins (lower
  `priority` number first).
- An exact application-scope match beats a tenant-wide wildcard grant - the
  same precedence the entitlement lookup already uses, not a second set of
  rules.
- No match is `404 TASK_PROFILE_NOT_ROUTABLE`, never a silent fallback to some
  default model.
- Operators configure it through the existing `/capability/tenant-model-grants` CRUD; no new
  admin endpoint.
