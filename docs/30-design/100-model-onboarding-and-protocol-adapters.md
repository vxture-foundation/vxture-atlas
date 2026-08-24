# 100 - Model onboarding and protocol adapters

Adding a provider or a model is a **data** operation (admin page / admin API),
not a code change and a release.

Prerequisite: [ADR-004](decisions/ADR-004-reject-portkey-gateway-dependency.md)
(no Portkey dependency; borrow its declarative adapter structure, build it here).
Landing sequence: `docs/70-workplan/00-index.md`.

## 1. Scope

Not a goal: zero-code onboarding of *any* upstream. An upstream whose wire
format genuinely differs must get code. That is deliberate - pushing protocol
differences into configuration grows a DSL nobody can debug. The value is in
drawing the boundary, not erasing it.

Also not a goal: **Atlas meters, it does not bill.** Atlas records how many
tokens a call burned and whose it was. Unit
prices are an operations concern living in `model_price_rules`. Nothing on the
request path computes money, and everything below discusses **quantities** only.

## 2. Three concepts one word conflates

The word `provider` conflates three jobs, which this design keeps apart:

| Concept | Question | Home | Example |
|---|---|---|---|
| **Who** | which commercial entity | a `model_providers` row (data) | Volcengine, Zhipu, Anthropic, an internal vLLM |
| **How it speaks** | which wire format | `protocol` (closed vocabulary in code) | OpenAI Chat Completions, Anthropic Messages |
| **Quirks** | parameter differences within one wire format | `config.wire` jsonb (data) | endpoint suffix, auth header style, whether `stream_options` is needed |

Onboarding then touches only the first and third.

## 3. The criterion

> **Different wire format -> code. Same wire format, different
> parameters/endpoint/switches -> data.**

| Difference | Home | Reason |
|---|---|---|
| Endpoint suffix `/chat/completions` vs `/v1/chat` | data | same request body |
| Auth `Authorization: Bearer` vs `x-api-key` | data | same request body |
| Needs `stream_options.include_usage` | data | one extra switch |
| Supports tool calling / `top_p` | data | capability declaration, decides which fields are sent |
| Vendor switch with no canonical equivalent (`thinking`, `reasoning_effort`, `response_format`) | data | a field to pass through, not a shape change - `wire.extraBody` |
| `max_tokens` vs `max_completion_tokens` | data | a rename, not a shape change |
| Model id differs from `model_code` | data | already `config.upstreamModel` |
| Response is `choices[].message` vs `content[]` blocks | **code** | different response shape |
| Streaming is `delta` chunks vs `content_block_delta` events | **code** | different event model |
| Request is `messages[]` vs `contents[]` | **code** | different request shape |
| usage in a final frame vs spread across two event types | **code** | different aggregation |

## 4. The `protocol` vocabulary (closed, enumerated in code)

**Named after the wire format, not the vendor.** `protocol='doubao'` is wrong -
that is a vendor. `protocol='openai-chat-completions'` is a protocol.

| Value | Adapter | Covers |
|---|---|---|
| `openai-chat-completions` | generic OpenAI-dialect adapter | doubao, zhipu, deepseek, qwen, moonshot, siliconflow, vLLM, Ollama shim, any OpenAI-compatible gateway |
| `anthropic-messages` | Claude adapter | Anthropic and compatible proxies |

Reserved, unimplemented (code lands with the value):
`gemini-generate-content`, `bedrock-converse`.

Normalization accepts a few aliases (`openai` / `openai-compatible` fold into
`openai-chat-completions`) and is insensitive to case and hyphenation.

## 5. The quirk descriptor: `config.wire`

Both `model_providers.config` and `model.models.config` are jsonb columns, so
this layer costs **zero DDL**. A `wire` sub-object carries the quirks:

```jsonc
// model_providers.config - provider-level defaults
{
  "wire": {
    "schemaVersion": 2,
    "chatPath": "/chat/completions",
    "auth": { "style": "bearer" },          // bearer | x-api-key | header
    "streamUsage": "stream_options",        // stream_options | native | none
    "supports": { "tools": true, "toolChoice": true, "topP": true },
    "paramMap": { "maxTokens": "max_tokens" },  // only names that differ
    "extraBody": {                              // vendor switches, sent verbatim
      "thinking": { "type": "disabled" }
    }
  }
}

// model.models.config - model-level override, deep-merged over the provider's
{
  "upstreamModel": "doubao-seed-1-6-250615",
  "wire": { "supports": { "tools": false } }
}
```

Merge order: **adapter defaults <- provider `config.wire` <- model
`config.wire`**.

Two config keys sit outside or alongside `wire`: `upstreamModel` stays
top-level (it is a model identifier, not a wire quirk); the Anthropic API
version lives in `wire.headers["anthropic-version"]`, with the legacy
top-level `anthropicVersion` key still honoured for existing rows.

`extraBody` is merged into the request body verbatim, under the keys the
adapter owns (`model`, `messages`, `stream`, `stream_options`, `system`), which
it may not override - those are rejected on write. It exists because `paramMap`
can only *rename* a parameter Atlas already sends, while every vendor switch is
a **new** field: DeepSeek's `thinking` / `reasoning_effort`, `response_format`,
`stop`, `logprobs`. Without it, section 3's own criterion ("parameters differ ->
data") had no home and the difference went back into code.

**`wire` is a closed schema, not a free dictionary.** Unknown keys are rejected
on write - otherwise this becomes a second dumping ground. Validation lives on
the `/capability/providers` and `/capability/models` write paths, not at
runtime.

**Strict on write, lenient at runtime.** Operators change configuration faster
than the service ships, so an older service reading a newer key must ignore it
and warn, never take a running model out of service. `wire.schemaVersion` is
the carrier of that rule: an optional integer, currently `2` (`2` added
`extraBody`). Write validation
checks it only when it is present - it must be an integer, and a version newer
than the running build is rejected - so a `wire` written without the key is
accepted and resolves to the adapter's base version. At runtime an adapter
reading a higher version ignores what it does not recognize and logs a WARN.

## 6. Dispatch resolution

```
resolve(model: AiModelRecord): IModelProvider
  1. specializations[model.provider]                 // special-case layer
  2. byProtocol[normalizeProtocol(model.protocol)]   // generic layer
  3. throw 503 MODEL_NOT_ROUTABLE
```

There is no per-provider-code fallback below the protocol layer: the write
path validates `protocol` against the closed vocabulary, `normalizeProtocol`'s
alias table (a permanent feature, §4) folds the dialect spellings in, and a
protocol that cannot be normalized is an explicit `503 MODEL_NOT_ROUTABLE` -
never a silent guess.

Layer 1 exists because `ZhipuProvider` implements `embed` and `rerank` (real
Zhipu Embedding-3 / rerank APIs), which are **not** part of the OpenAI Chat
Completions protocol. Its meaning is "this vendor supports capabilities beyond
the generic protocol", not "this vendor's chat is a bit different" - the latter
is what §5's `wire` is for.

`resolve()` takes the whole `AiModelRecord` rather than
`(providerName, modelCode)`, because dispatch needs `protocol` and
`config`. The generic adapter has no class-level `providerName` constant - it
serves several vendors, so the provider code arrives on
`ProviderChatRequest.providerCode` and is used for error messages and metric
labels.

**Metric-label constraint**: `provider` is a registry-driven runtime value.
Provider codes come from the registry (a controlled set); `model_code` or any
caller-controlled string must never become a metric label. Re-evaluate the
cardinality question above roughly 100 registered providers.

## 7. Streaming usage

Most OpenAI-compatible upstreams return **no usage on streaming responses
unless explicitly opted in**, and usage is only recorded when the terminal
event carries it. Therefore `wire.streamUsage` has three values - request it
via `stream_options`, expect it natively, or accept that there is none. The
third value is not "estimate": nothing in Atlas estimates tokens, so a
streaming call on a model configured `none` is recorded with NULL token
columns and no C3 consume - unreported must never be written as a number.
Only `stream_options` changes the request body; `native` and `none` differ
only in what they record about the upstream. This is the clearest case of a
quirk belonging in data: three
upstream behaviours become three config values, not three `if` branches.

## 8. Admin surface

Atlas has no `portals/`; the operator UI lives in `vxture-platform` and calls
Atlas over the network. This is therefore an **interface requirement** - the
pages are the platform line's work.

The onboarding surface:

| Endpoint | Purpose |
|---|---|
| `/capability/providers`, `/capability/models`, `/capability/tenant-model-grants`, `/capability/price-rules`, `/capability/provider-keys` | CRUD for the registry itself |
| `GET /capability/protocols` | dropdown source: the vocabulary plus each protocol's `wire` defaults and schema version |
| `POST`/`PUT /capability/models` | `protocol` is validated against the vocabulary (through the alias table) and `config.wire` is strictly schema-validated on write (§5) - unknown keys are rejected |
| `POST /capability/models/:id/probe` | connectivity self-check: one minimal non-streaming and (when the model declares streaming) one streaming call, reporting reachability, key resolution, the effective merged `wire`, whether usage came back, and whether any content actually arrived |
| `POST /capability/providers/:id/probe` | the same check through one deterministic active model of the provider |

`probe` is what makes this design genuinely page-driven. Without it, a model
configured through a page is only proven correct by production traffic; with
it, a wrong `wire` is caught at save time.

**A check passes only when content actually arrived.** `contentReceived` is
reported per check and a stream without a single text or tool-call frame is a
failure, not a pass. The streaming leg used to assert nothing but "no exception
was thrown", so a thinking model that emits only `reasoning_content` - HTTP 200,
usage complete, not one deliverable token - was reported green while real
callers got an empty stream. A self-check that can return a false pass is worse
than none: it is trusted.

**The probe's output budget is sized to let a model finish, not to be small.**
A reasoning chain is charged as completion tokens, so a budget picked to make
the check cheap (16) guarantees a false negative on every thinking model -
`finish_reason: length`, empty content, indistinguishable from a broken
upstream. The budget is 2048, capped by the model's own declared
`max_output_tokens`.

**Probe usage is attributed to the platform, not to any tenant.** A probe
writes `reqlog.request_records` with `usage_type='test'` and the all-zero
`COMMERCE_SENTINEL_UUID` for `tenant_id`/`workspace_id`, and is excluded from
quota deduction and from C3 consume. It is Atlas's own operational act, so it
must not appear in any tenant's usage view.

## 9. Pricing is a manual onboarding step for half of Atlas's providers

Registering a model does not price it. A `model_price_rules` row is authored
separately through `/capability/price-rules`, and the field semantics that
govern it (unit basis, the USD-vs-CNY-default trap, the three vendor fields
Atlas has no column for) are in `docs/20-specs/10-http-surface.md`.

What onboarding needs to know is **where the number comes from**, because it
differs by provider. Public aggregate price tables (LiteLLM's and its kin)
cover the western vendors well and the Chinese ones badly: Doubao appears with
rows but no prices, Zhipu has no first-party rows at all, and self-hosted
private models are unpriced by definition.

So for **Doubao and Zhipu, onboarding must read the price off the vendor's own
console.** There is no aggregate to copy from, and a partially-populated
aggregate is the dangerous case: it looks like coverage.

A zero price is never an acceptable placeholder. A rule charging nothing is
indistinguishable from a rule that works, and nothing on the request path
computes money (§1), so the error surfaces only when someone tries to bill.
Leave the model unpriced instead - an absent rule is a question, a zero rule is
a wrong answer.
