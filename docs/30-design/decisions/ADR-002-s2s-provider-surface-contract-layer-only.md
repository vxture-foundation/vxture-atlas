# ADR-002: ship the embed/parse/rerank contract layer, leave a 501 boundary

**Status**: Accepted
**Date**: 2026-07-24
**Related**: TD-003, TD-019, `docs/30-design/200-s2s-provider-surface.md`

## Context

Atlas served only generation (`ChatRequest`). karda had submitted field-level
requirements for embedding, parse and rerank (priority A1 > A3 > A2). Which
upstream model to buy for each is a product and cost decision, outside the
scope of an engineering batch.

## Options

**A. Contract layer and real provider calls together.** Picking a model just to
"deliver something complete" would likely be reversed later, and binds a
product decision to an engineering schedule.

**B. Contract layer only, 501 at the provider boundary.** `POST /v1/embed`,
`/v1/rerank` and `/v1/parse` land as real endpoints: request validation, model
resolution, grant and quota gating, provider routing - all identical to the
chat path. The only stub is `BaseProvider`'s default `embed`/`rerank`/
`parseDocument`, which throws `ProviderCapabilityNotImplementedError` and maps
to `501 MODEL_NOT_IMPLEMENTED`.

**C. Build nothing until the product decision lands.** The contract layer is
independent of model selection and valuable on its own; waiting buys nothing.

## Decision

Option B. Auth, validation, gating, routing and error codes are fully real;
provider integration is separate follow-on work gated on a product decision.
A 501 states honestly that no model is wired, rather than faking a response.

## Consequences

- Callers can develop against the real HTTP contract immediately.
- The parts that will not change with model selection are production-correct
  now.
- The three endpoints are unusable until a provider lands - an expected state,
  not a defect. The contract layer is complete; the A2 implementation now
  exists, gated on the model's `config.supportsVision`, so activation is a
  registry action, not further code.
- `RATE_LIMITED` (policy-driven throttling) ships with the real provider - it
  needs something real to throttle. It is now thrown.
- `RERANK_UNAVAILABLE` was to ship the same way and did not. The provider
  landed, the fast-fail behavior landed with it, and the condition surfaces as
  `503 PROVIDER_UNAVAILABLE` - the generic code, thrown from the shared
  failover path, with the same status and the same caller action. So the code
  was removed rather than added: X-4 does not allow a second word for a
  meaning that already has one, and a per-capability alias would have to be
  repeated for embed and parse next. Corrected 2026-08-16, together with the
  `200-s2s-provider-surface.md` row that promised it to consumers.
- Advertising a defined-but-unimplemented capability through capability
  discovery turned out to need its own answer; see TD-019.
