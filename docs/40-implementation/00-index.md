# 40-implementation - Module map and implementation status

Where each capability lives in `service/` and how complete it is. Route paths
are in `docs/20-specs/10-http-surface.md`; open gaps are in
`docs/60-operations/10-tech-debt.md`; conformance against the cross-product API
convention is in `40-l1-api-conformance.md`.

Atlas is a services-profile repo: one NestJS service under `service/`, root
module `AtlasModule`, workspace package `@atlas/service`. No `portals/`, no
browser surface.

## Dev setup

```bash
pnpm install
pnpm --filter @atlas/service db:generate   # Prisma client -> service/src/generated/
pnpm --filter @atlas/service dev
pnpm --filter @atlas/service test
pnpm type-check:all
```

## Module map

| Module | Holds | Status |
|---|---|---|
| `runtime/` | chat pipeline, health/readiness, metrics, `/status`, registry admin service, API-key resolution, the shared S2S provider helper | complete |
| `runtime/guards/` | `S2sAuthGuard` (data plane), `OperatorAuthGuard` (capability plane), `InternalDiagnosticsGuard` | complete; no step-up guard - the step-up criterion and ceremony are platform's (#165) |
| `registry/` | provider/model/grant/price-rule/policy reads, grant and task-profile resolution, reqlog usage rollups | complete |
| `router/` | dispatch to a provider adapter: specialization layer (Zhipu embed/rerank) then `protocol` layer; a protocol that cannot be normalized is `503 MODEL_NOT_ROUTABLE` - no silent fallback | complete |
| `providers/` | `base`, `openai-compatible` (+ `wire`, `protocol`, `sse`, `parse-vision`), `zhipu`, `claude`; doubao and private upstreams ride the openai-compatible protocol adapter | chat + streaming complete; embed/rerank on Zhipu; parse on openai-compatible, gated on `config.supportsVision` |
| `quota/` | entitlement gate ahead of every call | denies on exhausted pools; permissive for uncovered workspaces (TD-016) |
| `platform/` | C2 entitlement client + C3 `POST /usage/consume` caller | **broken (TD-056)**: both still name `product: "atlas"`, which the platform removed from its catalog on 2026-09-23, so every consume is refused `400 unknown_product` and the C2 read resolves nothing. Replacement per ADR-010, waiting on vxture-platform#547 |
| `reqlog/` | per-request and per-error history writes | complete; the usage record carries every dimension of the usage-record checklist (`incr/04`-`incr/07`), its own cost, and a reason for each empty dimension (ADR-011); vendor usage fields Atlas does not map are counted (`upstream_usage_unmapped_keys_total`); `product_id` stays NULL by design (`product_code` is the resolvable form); A1/A3 rows DO carry token counts whenever the upstream reports usage - Zhipu reports it for both embed and rerank, and for embed that same total is what C3 was billed |
| `tenancy/` | `/tenancy/*` self-service reads, scope from the token | complete |
| `provider-keys/` | envelope-encrypted key vault + rotation log | complete |
| `gateway-api-keys/` | Atlas-issued gateway API keys (`vxk_ext_`): issue/rotate/revoke/lifecycle on `/capability/api-keys`, one-way sha256 storage, secret shown exactly once | CRUD complete; no auth path accepts these keys yet (TD-034) |
| `provisioning/` | C3 webhook - signature, idempotency, ordering, persistence | complete |
| `audit/` | append-only operator change trail: middleware derives a record from every `/capability` write (outcome from the status the client actually got), read via `/capability/audit-logs` | complete |
| `observability/` | `/capability/logs` cursor-paginated reqlog search + `/capability/logs/summary` QPS/error-rate/latency windows | complete |
| `discovery/` | `.well-known/vxture-tools` descriptors | complete; `atlas.parse` withheld until a vision model is registered (TD-019) |
| `embedding/`, `rerank/`, `parse/` | A1/A3/A2 contract layers | complete; A1/A3 served by Zhipu in production; A2 answers an in-contract `501` while no vision-capable model is registered |

## Conventions

- Controllers validate and delegate; services hold the logic; repositories are
  the only Prisma callers, with two exceptions: `reqlog/` and `audit/` call
  `prisma` straight from the service class. Both write append-only tables
  (reqlog INSERT-only, audit INSERT plus its own SELECT search) and have no
  update path, so there is no repository to hold. Anything deriving Atlas's
  write surface from the repository files alone skips these two.
- A verified token claim always wins for attribution, and a body field can
  never override one (product_210 rule 8). `user_id` comes from the token and
  nowhere else. `workspace_id` and `tenant_id` fall back to the A1/A2/A3
  request body only when the token carries no such claim -
  `withWorkspaceFallback` and `toGateRequest` in
  `runtime/s2s-provider.shared.ts` - so a caller whose token omits the claim is
  attributed instead of silently unattributed (TD-035). Both the gate and the
  reqlog row read that same resolved context, so a body-supplied `workspaceId`
  can reach `reqlog.workspace_id` and the C3 consume call. This bullet
  previously said "never from the request body", which is stronger than the
  code has ever been.
- Logging never fails the request it describes - a `reqlog` write error is a
  warning, not a 500.
- A capability a provider does not implement throws
  `ProviderCapabilityNotImplementedError`, surfacing as
  `501 MODEL_NOT_IMPLEMENTED`. Never fake a success response.
- DB structure changes go through `deploy/database/ddl/` and db-init only. The
  DDL/Prisma lockstep guardrail runs in CI.
- Every consumption-plane error carries `code` + `retryable`, and the published
  vocabulary is the one actually thrown (product_251 X-1). Both halves are
  enforced by `scripts/guardrails/check-error-codes.mjs` in CI rather than by
  review - neither fails loudly on its own.
