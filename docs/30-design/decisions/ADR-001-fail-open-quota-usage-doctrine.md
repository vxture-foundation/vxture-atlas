# ADR-001: quota and usage fail open while C2/C3 are not connected

**Status**: Accepted
**Date**: 2026-07-24
**Related**: TD-016, `docs/30-design/210-usage-metering-and-history.md`

## Context

The physical DB split removed the `metering` schema's three proxy models
(`TenantSubscriptionQuota` / `TenantUsageEvent` / `TenantUsageSummary`) - that
schema belongs to the platform DB, which Atlas no longer connects to directly
(boundary #1, zero cross-database FK).

Service code still called those Prisma delegates, kept compiling by a
hand-written interface and a cast onto the real client. The generated client
has no such properties, so the call threw on the request hot path -
`QuotaService.assertAllowed` runs on every chat request.

The real fix is a C2 entitlement read plus a C3 consume write, which depends on
the platform's `tenant/application/agent` to `workspace/product/metric`
scope-key reconciliation, which depends on `product.agent_catalog` - not landed
at decision time and not something this repo can route around.

## Options

**A. Keep the ghost delegates and the cast.** Compiling hides a guaranteed
runtime crash; the signal left for the next reader is "this works".

**B. Let the build fail, honestly reflecting "not connected".** Moves the crash
to build time, but the service is then unusable on a path that quota and usage
should not be blocking in the first place.

**C. Delete the ghost delegates and follow the platform's documented fail-open
doctrine.** `data_model_200_schema.md` §3 already defines the standard response
to this situation - bounded local fail-open with asynchronous reconciliation,
not error and not refusal.

## Decision

Option C. The four affected read methods return `null`/`[]`, and
`assertAllowed` logs a warning and permits when it cannot resolve a quota,
skipping the model-allowlist gating that depends on quota configuration - that
check cannot be executed meaningfully without real quota data.

This is a transitional fix, not the completed integration.

## Consequences

- Removes a live crash risk on the request hot path.
- Behaviour honestly reflects "metering not yet connected"; no fabricated
  result and no type assertion that is false at runtime.
- Following the platform's own documented principle means connecting C2/C3
  later replaces the fail-open branch with a real call rather than overturning
  this code.
- While a workspace has no published entitlement, enforcement stays permissive
  and model access control is looser than intended (TD-016).
