# 10-standards - Org standards (thin index)

This directory does NOT copy standard text. The org standards are authored and
versioned in the platform repo (`D:\MyWebSite\vxture`); every product repo
consumes them by reference so there is a single source of truth. Fix a gap in
the standard there first, then mirror it here - never invent a standard inside
a product repo.

| Standard | Platform-repo path | Covers |
|----------|--------------------|--------|
| Repo governance | `docs/10-standards/140-repo-governance-standard.md` | branch model, ruleset, secret hygiene, SCA gate, data layer, guardrails |
| Docs taxonomy | `docs/10-standards/070-docs-taxonomy.md` | docs numbering and identifiers. Section 3 delegates in-repo organization to each product repo - ours is `docs/00-meta/10-docs-convention.md` |
| Security | `docs/10-standards/150-security.md` | secret boundaries |
| CI/CD optimization | `docs/10-standards/010-cicd-optimization-playbook.md` | CI speed-ups |
| Container healthcheck | `docs/10-standards/020-container-healthcheck-standard.md` | liveness probe mechanics |
| Health endpoint contract | `docs/10-standards/025-service-health-endpoint-contract.md` | liveness response body: identity block + build-time provenance |

## Template design and runbook (platform repo)

- `docs/30-design/product_240_repo-template.md` - what a product repo
  contains; section 3 (module x layer matrix) is the authority for exactly
  which modules apply to atlas as an L1 product (services profile, no
  business-plane DB baseline, no grant.invalidated/visible-set)
- `docs/50-deployment/rebuild/20-self-rectify-runbook.md` - batch A-G
  self-rectify runbook with per-step machine checks

## What this repo carries locally

The governance base is realized here as concrete artifacts, not prose: the
branch-protection ruleset (`docs/50-deployment/rebuild/main-ruleset.json`), the
secret-scan / SCA / docs-numbering guardrails, and the CI workflows. Those are
the enforcement; this index is the pointer to the WHAT they enforce.
