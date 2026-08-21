# Docs convention (in-repo organization, org taxonomy section 3 delegation)

The org docs taxonomy (`070-docs-taxonomy.md`, platform repo) fixes the
ten-decade top-level skeleton and the numbered/unnumbered rule, but delegates
in-repo organization within `30-design/` and doc-naming specifics to each
product repo. This document is that local authority for `vxture-atlas`.

## File naming

- Local documents are `NN(N)-slug.md`. The platform repo's
  `{kind}_{domain}_{NNN}_{slug}` domain family is NOT legal here - a
  single-domain repo separates by directory and number band instead, so a
  domain prefix would be noise. A `product_*` / `data_*` / `design_*`
  reference in our text always points at a PLATFORM-repo document.
- `30-design/` uses three digits with bands: `1xx` design, `2xx` contracts and
  schema, `3xx` implementation. Every other directory uses two digits. Digit
  count is uniform per directory or the lexical sort breaks.
- ADRs live in `docs/30-design/decisions/ADR-NNN-slug.md` with stable
  append-only IDs. The tech-debt register lives in
  `docs/60-operations/10-tech-debt.md` (`TD-NNN`).

## Directory naming

Directories are numbered too, with two named exceptions pinned by org
standards (do not add more without amending this file):

- `30-design/decisions/` - keyed by ADR number, not sequence.
- `50-deployment/rebuild/` - governance standard section 1 pins
  `rebuild/main-ruleset.json`.

## Liaison naming

`80-liaison/` artifacts are `NN-{YYMMDDHHMM}-{slug}.md` - the stamp follows the
`NN-` index so the numbering guardrail still passes.

## Enforcement

`scripts/guardrails/check-docs-numbering.mjs` enforces all of the above (file
names, directory names, root-only README whitelist) - `pnpm lint:docs-numbering
--strict` in CI.
