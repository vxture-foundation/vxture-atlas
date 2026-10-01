# ADR-012: A price rule is the vendor's price, set in the admin console

- Status: Accepted (owner, 2026-10-01)
- Date: 2026-10-01
- Deciders: owner

## Context

`model.model_price_rules` holds per-model unit prices. Since usage-record
batch 2 (v0.7.14) every reqlog row is priced with them at write time
(`upstream_cost`), and `/capability/logs/cost` sums the same formula.

The two sides of the interface read the table differently. Atlas uses it as
what the upstream vendor charges for a call. The platform's code calls it the
sales price: opera's metering page says sales prices "belong to admin's price
rules", and admin-bff groups price rules with quotas and policies as the
commercial layer. A sales price typed into this table is read by Atlas as a
vendor cost, and every row's `upstream_cost` is then wrong with nothing
raising an error.

A production read on 2026-10-01 found zero price rules, so no row has been
priced yet. The meaning can be fixed before the first one is written.

## Decision

1. **A price rule is the vendor's price to Atlas**, transcribed from the
   vendor's published price table, in the vendor's currency. `upstream_cost`
   is what the call cost the platform.
2. **Sales price is not in this table.** What a tenant pays, and the
   conversion of tokens into `ai.credit`, belong to the platform and are tuned
   by operations there (ADR-010). Atlas neither stores nor computes them.
3. **The form that writes price rules is the admin console's** model platform
   page, through admin-bff to `POST /capability/price-rules`. Atlas has no
   form of its own.

## Consequences

- The platform's comments that call these sales prices are wrong and are
  raised there, with the admin form's missing cache-write fields
  (`cacheWriteUnitPrice`, `cacheWrite1hUnitPrice`, TD-057).
- Until operators enter vendor prices, every row reads `not_configured` for
  its cost (ADR-011). Rows written before then can be priced later with the
  same formula; whether to is decided when the rules exist.
