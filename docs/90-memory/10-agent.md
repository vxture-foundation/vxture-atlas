# Agent entry point

Start here if you are an AI agent working in this repo.

## What this repo is

`vxture-atlas` - Atlas, Vxture's L1 model platform: unified model access,
routing, quota and metering, and the sole LLM egress point for every other
vxture product. Product code `atlas`. The governance base, the applicable
subset of the platform integration contract (C1/C2/C3 - not the full
asset-face set) and the engineering shell come from the platform template and
are rigid.

**Services profile**: one NestJS service under `service/`. No `portals/`, no
Next.js, no browser surface.

## Where authority lives

Not here. The standards are in the platform repo (`D:\MyWebSite\vxture`):
`docs/10-standards/140-repo-governance-standard.md` (WHAT),
`docs/30-design/product_240_repo-template.md` (template design - section 3's
matrix is the authority for which modules apply to an L1 product),
`docs/50-deployment/rebuild/20-self-rectify-runbook.md` (HOW + machine checks),
`docs/10-standards/070-docs-taxonomy.md` (docs numbering). Fix a gap in the
standard there first, then mirror it here - never invent a standard inside a
product repo.

## Where to read what

| Question | File |
|---|---|
| What is done, what is left | `docs/70-workplan/00-index.md` |
| What is implemented, and where | `docs/40-implementation/00-index.md` |
| Which routes exist | `docs/20-specs/10-http-surface.md` |
| Why something is the way it is | `docs/30-design/` and `decisions/` |
| Why a known gap is still open | `docs/60-operations/10-tech-debt.md` |

## Working rules

- Trunk-based: feature branch -> PR -> squash-merge -> delete branch. Never
  push `main` directly.
- The five required CI checks are a stable contract: `quality-gate` / `build` /
  `test-coverage` / `audit` / `gitleaks`. Do not rename the jobs producing them.
- Docs: numbered = formal, unnumbered = temporary. Read
  `docs/00-meta/10-docs-convention.md` before adding a document. Local docs are
  `NN(N)-slug.md`; the platform's `{kind}_{domain}_{NNN}_` family is not legal
  here.
- A decision is recorded once, as an ADR. Other documents reference it rather
  than restating the reasoning.
- Atlas does not get the business-plane DB baseline
  (`vx_provision`/`local_authz`/`local_usage`) that arda/karda/terra get. Its
  own data model (`model`/`key`/`reqlog`/`routing`, physically isolated, zero
  cross-database FK) is the whole story.
- Attribution comes from verified token claims, never from the request body.
- Keep source, config, and root meta files ASCII-only.
- `CLAUDE.md` at the repo root is the full working agreement.
