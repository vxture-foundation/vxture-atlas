# ADR-010: Usage is reported to the platform as raw tokens, under the caller's product

- Status: Accepted (owner, 2026-09-30)
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

- The platform needs a way to receive the raw record. The current consume takes
  one metric and one amount under a globally unique idempotency key, so four
  dimensions do not fit. The shape is the platform's to design:
  vxture-platform#547. Atlas changes its payload and its C2 read to match what
  that issue settles on.
- Atlas does not capture cache-write tokens today (e.g. Claude's
  `cache_creation_input_tokens`). Adding that dimension is Atlas work: adapters
  plus a `reqlog` column through db-init.
- Until #547 lands, inference usage still does not reach the platform. Every
  call has a `reqlog` row with its token counts, `request_id` and a NULL
  `billed_amount`, which is the record a backfill would be built from.
- A refused consume now names the platform's reason in the log and counts it in
  `platform_consume_outcomes_total{metric,outcome,reason}`. A refusal like this
  one is a non-zero `outcome="rejected"` series from its first occurrence.
- Other repositories that describe Atlas as pre-deducting or reporting
  `ai.credit` are being corrected by their owners: vxture-platform#547 and
  `vxture-arda`#214.
- `docs/30-design/210-usage-metering-and-history.md` §3 and the Metering rows in
  `200-s2s-provider-surface.md` describe the current wire (`product: "atlas"`,
  `atlas.*` metrics), which this ADR retires. They are rewritten when the
  payload changes.
