# ADR-010: Usage is reported to the platform as raw tokens, under the caller's product

- Status: Accepted (owner, 2026-09-30); implemented 2026-10-04 (receiving side
  vxture-platform ADR-013 / #581, reporting side Atlas v0.7.31)
- Date: 2026-09-30
- Deciders: owner

## Context

Atlas reports every served inference to the platform through C3
`POST /usage/consume` as `{ product: "atlas", metric: "atlas.chat" |
"atlas.embed" | "atlas.rerank" | "atlas.parse", amount }`.

On 2026-09-23 the platform removed atlas and runos from `product.products`
entirely (vxture-platform #469 / #472). Its consume handler resolves `product`
against that table first and answers `400 unknown_product` when the row is
missing, so every report Atlas sends has been refused since. Atlas logs a
refused consume and serves the request anyway, by design, so nothing failed
anywhere. The platform reported zero inference usage, and it surfaced only
because tenderforge read Atlas's production log (`vx-agent-tenderforge`#69).

The platform's catalog-exit migration aborts if any L1 product has a
`metering.usage_events` row. It ran, so in any environment where it did, atlas
had recorded no usage at all - the reports may never have been accepted.

The C2 entitlement read, `GET /platform/entitlements?product=atlas`, is broken
the same way. The quota gate reads an unresolvable view and falls open per
ADR-001.

## Decision

1. **L0 and L1 are not products.** L0 (console, website, opera, admin, arche) is
   the platform's management and operations plane. L1 (atlas, runos, ...) is the
   base environment agents run on. Neither is in `product.products` or offered
   to tenants.
2. **L0/L1 links are server `.env` configuration.** Unlike L2/L3, they do not
   need to be extended at runtime or configured from a page.
3. **Atlas reports raw usage, under the calling product.** The product a call
   counts against is the caller's product code from the S2S token (`act.sub`),
   never `atlas`. Chat and embed are reported as tokens in four dimensions:
   input, output, cache write and cache read.
4. **Atlas does not convert, price or pre-deduct.** `ai.credit` is the tenant-
   facing unit and the token-to-credit conversion is an operator setting that
   changes at will. It belongs to the platform. Atlas neither reports nor
   deducts `ai.credit`.

## Consequences

- The receiving shape is the platform's (ADR-013, #547 / #581): the same
  `POST /usage/consume`, with `tokens: {input, output, cache_write, cache_read}`
  + `request_id` + `attempt_index` (together the idempotency key) +
  `occurred_at` + `model_code` / `provider_code`, optional `reasoning_tokens`,
  `rerank_candidates`, `parse_pages`, `outcome`, `backfill`; a body carrying
  both this and the old `metric` + `amount` is refused. Atlas sends that shape
  (`PlatformEntitlementClient.reportTokens`) and reads C2 by the caller's
  product since 2026-10-04. The platform converts with an operator-set rate,
  carries the fraction per (workspace, product) and deducts whole `ai.credit`.
- Cache-write tokens are captured since usage-record batch 1 (`incr/04`), so
  the fourth dimension is real on every adapter that reports it.
- Calls served before the switch have a `reqlog` row with `usage_event_id IS
  NULL`; `scripts/ops/backfill-token-usage.mjs` replays them with `backfill:
  true`, which the platform records and deliberately does not charge
  (ADR-013 D7). A failed failover attempt is reported as `outcome: failed`
  and likewise recorded, never charged (D8).
- A report the platform recorded without a deduction (backfill, failed attempt,
  no rate in force, or only the fractional carry moved) has no event id to
  echo; the row's `dimension_status.usageEventId` says `not_applicable`, and
  the fact is correlated by `request_id` against
  `metering.token_usage_events`.
- A refused consume now names the platform's reason in the log and counts it in
  `platform_consume_outcomes_total{metric,outcome,reason}`. A refusal like this
  one is a non-zero `outcome="rejected"` series from its first occurrence.
- Other repositories that describe Atlas as pre-deducting or reporting
  `ai.credit` are being corrected by their owners: vxture-platform#547 and
  `vxture-arda`#214.
- `docs/30-design/210-usage-metering-and-history.md` §3 and the Metering rows in
  `200-s2s-provider-surface.md` described the retired wire (`product: "atlas"`,
  `atlas.*` metrics); rewritten 2026-10-04 with the payload.
