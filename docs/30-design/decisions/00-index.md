# ADR register (architecture decision records)

Decisions of record for this repo. Each is `ADR-NNN-slug.md` with a stable,
never-reused, never-renumbered ID (taxonomy meta-rule section 4). New decisions
append; IDs may skip.

A decision belongs here, once. Other documents reference an ADR rather than
restating its reasoning.

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-001 | [Quota/usage fail-open while C2/C3 are not connected](ADR-001-fail-open-quota-usage-doctrine.md) | Accepted | 2026-07-24 |
| ADR-002 | [S2S provider surface - contract layer only](ADR-002-s2s-provider-surface-contract-layer-only.md) | Accepted | 2026-07-24 |
| ADR-003 | [Provider-key vault - envelope encryption](ADR-003-provider-key-vault-envelope-encryption.md) | Accepted | 2026-07-26 |
| ADR-004 | [Reject the Portkey Gateway dependency](ADR-004-reject-portkey-gateway-dependency.md) | Accepted | 2026-08-01 |
| ADR-005 | [ACR primary, GHCR fallback for worker-02](ADR-005-acr-primary-ghcr-fallback.md) | Accepted | 2026-07-26 |
| ADR-006 | [The DDL is one create-once baseline; increment history is folded away](ADR-006-clean-rebaseline.md) | Accepted | 2026-08-17 |
| ADR-007 | [The audit runs before a release, not in CI](ADR-007-audit-runs-before-release-not-in-ci.md) | Accepted | 2026-08-26 |
| ADR-008 | [Context overflow is recognised from the upstream's refusal, not estimated](ADR-008-context-overflow-from-upstream-refusal.md) | Accepted | 2026-09-29 |
| ADR-009 | [Thinking is a per-call request parameter, mapped per model as data](ADR-009-thinking-is-a-request-parameter.md) | Accepted | 2026-09-30 |
| ADR-010 | [Usage is reported to the platform as raw tokens, under the caller's product](ADR-010-usage-reported-as-raw-tokens-per-caller.md) | Accepted | 2026-09-30 |
| ADR-011 | [Every empty usage dimension says why it is empty](ADR-011-every-empty-usage-dimension-says-why.md) | Accepted | 2026-09-30 |
| ADR-012 | [A price rule is the vendor's price, set in the admin console](ADR-012-price-rules-are-vendor-prices.md) | Accepted | 2026-10-01 |
