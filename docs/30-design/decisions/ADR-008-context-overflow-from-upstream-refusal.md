# ADR-008: Context overflow is recognised from the upstream's refusal, not estimated

- Status: Accepted (owner, 2026-09-29, with the amendment to decision 3)
- Date: 2026-09-29
- Deciders: owner

## Context

tenderforge letter 40 item 3 (`vx-agent-tenderforge`#69) asks for a structured
code when a request does not fit the routed model's context window:
`CONTEXT_LENGTH_EXCEEDED`, with the input tokens and the window, fallback
first, never a silent truncation. The letter's own proposal is for Atlas to
estimate the token count per route and refuse before calling the upstream.

What Atlas has today (v0.7.6):

- An upstream `400`/`413`/`422` is answered as `422 UPSTREAM_REJECTED_REQUEST`
  (`retryable: false`), with the vendor's wording in `message`. It does not
  count toward the circuit breaker, and the fallback chain is still tried
  (design doc 200 section 1.4).
- A caller can read each route's `contextWindow` / `maxOutputTokens` from
  `GET /v1/model-routes` (B2b), `null` when unknown.
- Nothing truncates input.

So a context overflow already reaches the caller as a non-retryable refusal.
What it cannot yet do is tell the caller that the reason was the context
window rather than any other content refusal, and that distinction decides the
caller's next move: split the input, or fix the request.

### How upstreams report it (researched 2026-09-29)

| Upstream | Status | What identifies it | Source |
|---|---|---|---|
| OpenAI dialect | 400 | `error.code = "context_length_exceeded"`; message "maximum context length is N tokens" | vendor-quoting third-party pages |
| DeepSeek | 400 | Two forms: the OpenAI-style message, **and** `"Input token exceed the limit"` with `code: "quota_limit_reached"` | public issue trackers |
| Zhipu | 400 | business code `1261`, "Prompt 超长" | docs.bigmodel.cn error-code table |
| Claude | 400 | `invalid_request_error` only; the message text is the sole distinguisher | platform.claude.com errors page (wording not documented) |
| Doubao (Ark) | 400 | `error.code = "InvalidParameter"` (generic) **and** "Total tokens of multi-modal content and text exceed max message tokens" | not documented; recorded from a real over-context request 2026-09-30 |

There is no shared signal. One vendor documents nothing. And one vendor's
overflow arrives spelled as a **quota** error: a classifier keyed on
`code` alone would file it as `QUOTA_EXCEEDED`-like and tell the caller to
wait for a reset that will never help.

## Decision

1. **No token estimation in the gateway.** Atlas holds no per-provider
   tokenizer, and Chinese tokenizes very differently across the providers it
   routes to. An estimate either refuses requests the model would have taken or
   passes ones it will refuse - and the upstream answers the question exactly,
   for free, a few hundred milliseconds later. The same reasoning is why
   `model_policies.max_context_tokens` stays unenforced (TD-054).

2. **Recognise the upstream's refusal.** A `ProviderHttpError` with status 400
   whose body matches a known context-overflow signature is answered as
   `CONTEXT_LENGTH_EXCEEDED` instead of `UPSTREAM_REJECTED_REQUEST`. Same HTTP
   status (`422`), same `retryable: false`, same breaker exemption, same
   fallback behaviour; only the code is narrower.

3. **Signatures are a table in code for now, one place, each entry pinned by
   a test built from a recorded vendor body - and they move to per-provider
   configuration later (owner, 2026-09-29; TD-055).** Every upstream spells
   the refusal differently, and a new provider should not need a release to
   be recognised. Until that lands, the table is kept as plain data objects
   (`providers/context-overflow.ts`), so moving it is moving data, not
   rewriting logic. Matching is on the parsed body: the vendor code when it is
   distinctive (`context_length_exceeded`, `1261`), otherwise a message
   pattern; a signature matches only when every field it declares matches, so
   DeepSeek's `quota_limit_reached` entry also requires the overflow message -
   that code alone means something else.

4. **An unrecognised overflow degrades safely.** It stays
   `UPSTREAM_REJECTED_REQUEST` - still non-retryable, still exempt from the
   breaker, still fallback-first, still carrying the vendor's words. So a
   missing signature (Doubao today) costs precision, never correctness. That
   is what makes a code table acceptable: the failure mode of an incomplete
   table is a less specific code, not a wrong action.

5. **The envelope does not grow.** X-1's envelope has no `details` field and
   this does not add one. `message` carries the numbers when the vendor
   reported them ("requested 301234 tokens, maximum 262144"); the caller's
   budget comes from `GET /v1/model-routes`, which it should have read before
   sending. The letter's `details.endpointCode` / `modelCode` are already in
   the envelope as `modelCode` / `provider` and the caller's own request.

6. **Fallback stays as it is.** The chain is tried in order; a fallback with a
   larger window may accept what the primary refused. The error returned when
   every candidate fails is the last one, unchanged: if the fallback failed
   for capacity reasons, `retryable: true` is the right answer, because the
   retry may reach the larger model.

## Consequences

- New code `CONTEXT_LENGTH_EXCEEDED` in the X-1 vocabulary and the contract
  artifact. X-4 search: no existing spelling in platform or runos.
- Doubao's signature is unknown until a real over-context request is sent to
  it - workplan C1 records the body, and the table gains an entry then.
- A vendor that changes its wording silently demotes its overflows to
  `UPSTREAM_REJECTED_REQUEST`. That is visible (the vendor text is in
  `message`) and harmless (same handling), and the per-vendor tests are
  where the change will show up first.
- The letter's request for `inputTokens` / `contextWindow` as structured
  fields is answered as "in `message` when known, and from
  `/v1/model-routes` in advance" - to be stated in the reply on #69.

## Alternatives rejected

- **Pre-flight estimation** (the letter's proposal): see decision 1.
- **Signatures as provider config now**: deferred, not rejected (decision 3,
  TD-055). The configuration needs validation that refuses a signature
  declaring no field - one such entry would relabel every content refusal as
  an overflow - and that is its own piece of work.
- **Matching `code` only**: misfiles DeepSeek's `quota_limit_reached`.
- **Matching message only**: needlessly fragile where a stable vendor code
  exists (OpenAI dialect, Zhipu).
