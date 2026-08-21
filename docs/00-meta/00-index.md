# 00-meta - Documentation map

The tree follows the org docs taxonomy (`070-docs-taxonomy.md`): ten
decade-numbered directories, `00-index.md` in each, numbered = formal /
unnumbered = temporary. In-repo organization is delegated to this repo
(taxonomy section 3) and defined in
[`10-docs-convention.md`](./10-docs-convention.md), enforced by
`pnpm lint:docs-numbering --strict` in CI.

## What goes where

| Decade | Holds |
|--------|-------|
| `00-meta` | this map and the docs convention |
| `10-standards` | thin index pointing at the org standards; no standard text is copied here |
| `20-specs` | product specifications, incl. the authoritative HTTP surface |
| `30-design` | architecture and domain design (`1xx` design / `2xx` contracts and schema / `3xx` implementation) plus `decisions/` (ADRs) |
| `40-implementation` | module map and implementation status |
| `50-deployment` | infra, CI/CD, environments, the branch-protection ruleset |
| `60-operations` | runbooks (`NN-run-*.md`), audits, the tech-debt register |
| `70-workplan` | the task checklist: done and to do |
| `80-liaison` | archived liaison letters; the live channel is GitHub Issues |
| `90-memory` | in-repo AI handoff |

## Separation of concerns

Design documents state the final design, not how it was arrived at.
Implementation documents state current status. The workplan states what is done
and what is left. Decisions are recorded once, as ADRs, and referenced
elsewhere. The history of any of it is in git.

## Authority

The governing standards live in the platform repo (`D:\MyWebSite\vxture`), not
here:

- `docs/10-standards/140-repo-governance-standard.md` - governance base (WHAT)
- `docs/10-standards/070-docs-taxonomy.md` - docs numbering
- `docs/30-design/product_240_repo-template.md` - template design; section 3
  defines which modules apply to atlas as an L1 product
- `docs/50-deployment/rebuild/20-self-rectify-runbook.md` - runbook (HOW)

A `product_NNN_*` / `data_*` / `design_*` reference anywhere in this repo's
docs points at a PLATFORM-repo document. Local documents are always
`NN(N)-slug`.
