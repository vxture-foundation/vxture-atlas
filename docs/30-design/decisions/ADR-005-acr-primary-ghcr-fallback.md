# ADR-005: ACR primary, GHCR fallback for worker-02

**Status**: Accepted
**Date**: 2026-07-26
**Related**: `docs/50-deployment/00-index.md`

## Context

`140-repo-governance-standard.md` section 5 defaults non-VPC hosts to GHCR
primary, on the reasoning that a non-VPC host reaches ACR only over its billed
public endpoint with no guaranteed speed advantage. worker-02 is such a host.

## Decision

Owner decision: **ACR primary, GHCR fallback** on worker-02, set through
`IMAGE_REGISTRY` / `FALLBACK_IMAGE_REGISTRY` in the deploy script. `build.yml`
pushes to both registries regardless; only the pull order differs.

This is a per-host operational choice, not a new governance rule. It does not
propagate to sibling repos - arda and karda stay GHCR-primary on the same host.

## Consequences

- Public ACR egress is billed and GHCR pulls are not, so if ACR-primary proves
  slower or costlier in practice, reverting is a two-variable change here.
- A registry outage on either side is covered, since both receive every build.
