# ADR-009: Thinking is a per-call request parameter, mapped per model as data

- Status: Proposed
- Date: 2026-09-30
- Deciders: owner

## Context

tenderforge letter 30 (answered in `vx-agent-tenderforge`#69) needs thinking
off on `chat/deterministic` and `chat/fast`, on for `chat/reasoning`. It
pushed that onto routes because a caller "cannot pass per-operation
parameters" - which is only true because Atlas has no such parameter yet.

What production shows (B1, 2026-09-30):

- `ChatRequest` has no thinking field and Atlas never sends one. The only lever
  is an operator's static per-model `config.wire.extraBody`, and no production
  model sets it, so every route runs on its upstream's default.
- Those defaults are ON for the models in use (DeepSeek V4: `thinking.type`
  defaults to `enabled`; Doubao Seed: thinking-capable models default to
  enabled). So `chat/deterministic` and `chat/fast` very likely run with
  thinking on - the opposite of what letter 30 asks, paid for in reasoning
  tokens and latency. Documented defaults, not yet confirmed by a real request.
- `chat/deterministic` (wants off) and `chat/reasoning` (wants on) share the
  primary `deepseek-v4-pro`. A per-model switch cannot tell them apart; only a
  second model row for the same upstream could, and that is a route/registry
  workaround for what is really a per-call choice.

A route answers "which tier of model" - operator-owned, rarely changing. Thinking
answers "how should THIS call be answered" - caller-owned, per call, the same
kind of thing as `temperature` and `maxTokens`, which are already request
fields. Encoding it in routes multiplies them (tiers x modes) and still fails
when two routes share a model.

### How upstreams take it (researched 2026-09-30)

| Upstream | Field | Default | Limits |
|---|---|---|---|
| DeepSeek V4 | `thinking: {type: enabled\|disabled}`; also `reasoning_effort` none/low/high/max | enabled | V4 made thinking a request parameter |
| Doubao Seed | `thinking: {type: enabled\|disabled\|auto}` | enabled on thinking-capable models | Seed 2.1 rejects `auto` |
| Zhipu GLM | `thinking: {type: enabled\|disabled}`; `reasoning_effort` from 5.2 | enabled | GLM-5.3 is always-on and rejects `disabled` |
| Claude | adaptive thinking + effort | per model | Opus 5.5 and others are always-on; `disabled` is a 400 |

Field names differ, and some models cannot turn it off.

## Decision

1. **`ChatRequest.thinking?: "off" | "on"`.** A vendor-neutral word, per call.
   Omitted means exactly today's behaviour - the upstream's default - so no
   existing caller changes. `auto` is left out: one vendor has it and one of
   its own models rejects it. Effort levels are left for later; the field can
   grow an `effort` without changing the meaning of `off`/`on`.

2. **The translation is per-model DATA in the wire descriptor**:
   `config.wire.thinking: { off?: <body fragment>, on?: <body fragment> }`,
   merged into the upstream body after `extraBody` (per call beats per model).
   The same write-path validation as `extraBody` applies - a fragment may not
   touch the adapter's reserved keys. This is the wire design's own rule:
   parameter differences are data, not a code change per vendor. It is also
   what lets one model serve both routes: `deepseek-v4-pro` carries both
   fragments, and each call picks.

3. **A missing fragment means the model does not support that mode, and the
   request is refused, never silently served.** Primary without the requested
   fragment -> `422 THINKING_MODE_UNSUPPORTED`, `retryable: false`, naming the
   model and the mode. A fallback without it is skipped, exactly as an unusable
   fallback is skipped today. An always-on model gets an `on` fragment of `{}`
   and no `off`.

4. **Discoverable before the call**: each route on `GET /v1/model-routes`
   carries `thinkingModes` - the modes its primary supports (fallbacks that do
   not support a mode are skipped, so they do not narrow it).

5. **Echoed after the call**: the chat response states the mode that was
   applied (`"off"`, `"on"`, or `null` for the upstream default), so a caller
   and an operator reading reqlog can tell which behaviour a call actually had.

## Consequences

- New X-1 code `THINKING_MODE_UNSUPPORTED`; new optional request field; two new
  response fields. All in the contract artifact and `10-http-surface.md`.
- Operators fill `config.wire.thinking` for the routed models. Until a model
  has it, a call that asks for a mode is refused with the new code - loud, not
  inert. Starting data: DeepSeek V4, Doubao Seed 2.x and Zhipu GLM-5.2
  `{off: {thinking: {type: "disabled"}}, on: {thinking: {type: "enabled"}}}`;
  always-on models `{on: {}}` only.
- tenderforge sends `thinking` per operation on the routes it already has; no
  route is created or split.
- Before relying on the defaults above, one real request per upstream on the
  dev stack confirms "omitted = on" and "`off` = no reasoning content" - the
  response's reasoning envelope (TD-046) is the observable.
- This is layer 1 of the call interface. Layer 2 - an optional `requirements`
  block resolved by an operator-configured policy - is a separate decision,
  opened as a cross-product discussion on the platform line because its
  vocabulary should mean the same on every L1.

## Alternatives rejected

- **New routes per thinking mode**: multiplies routes, and cannot separate two
  routes that share a model.
- **Pass-through of vendor fields** (`extraBody` per request): puts vendor
  spelling in the caller, which is what an L1 exists to hide; a caller would
  branch on which model served it.
- **Silently ignoring an unsupported mode**: configured-but-inert, and the
  caller would pay for thinking it asked to turn off without being told.
