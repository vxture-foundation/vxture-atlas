# 70-workplan - Task checklist

What is done and what is left. Status only - no progress narrative; the
reasoning behind a design lives in `docs/30-design/`, the reasoning behind a
deferral in `docs/60-operations/10-tech-debt.md`.

## Done

- [x] Governance base - root files, secret hygiene, SCA gate, docs skeleton,
      guardrails
- [x] CI/CD workflows and the five required checks (`quality-gate` / `build` /
      `test-coverage` / `audit` / `gitleaks`); `main` ruleset applied with
      `bypass_actors: []`
- [x] Own physical database `vx_atlas_db` - three-part DDL, column locks,
      DDL/Prisma lockstep guardrail
- [x] Deploy pipeline exercised end to end - worker-02:3100, ACR primary /
      GHCR fallback, `production` GitHub Environment, db-init, rollback
- [x] Distroless runtime image - no shell/npm/wget, `nonroot` user, no
      node_modules shipped; healthchecks probe via the node binary
- [x] S2S callee surface - `S2sAuthGuard` (RS256/JWKS, product_210 §3.3),
      `mode` + `scope` both asserted
- [x] Operator plane - `OperatorAuthGuard` on `/capability/*`; step-up
      criterion and ceremony belong to the platform catalogue and opera-bff
- [x] Tenant self-service plane `/tenancy/*` - scope derived from the token
- [x] C3 provisioning webhook - HMAC verify, dual-secret rotation, idempotent,
      per-workspace `seq` ordering (atomic check-and-write)
- [x] C2 entitlement client - the quota gate can deny (partial, see TD-016)
- [x] C3 consume caller + own `reqlog` request/error history, 6-month retention
      with partition maintenance and a `/readyz` runway alarm; gate refusals,
      streamed responses without a usage frame, and probe traffic
      (`usage_type = 'test'`) all land in reqlog
- [x] Capability discovery `GET /.well-known/vxture-tools` incl. the §4.1a
      `endpoint` field
- [x] Provider-key vault - envelope-encrypted, add/rotate without a redeploy
- [x] A4 chat live in production - protocol-dispatched adapters
      (openai-compatible / zhipu / claude), streaming, per-model rate limiting
      (RPM + concurrency) and circuit-breaker failover
- [x] Tenant-filtered model list and `taskProfile` routing
- [x] A1 embed + A3 rerank served by Zhipu; rerank P95 measured in production
      2026-08-10 (550ms at 100 candidates) and reported to karda (karda#89)
- [x] A2 parse implemented provider-agnostically
      (`OpenAiCompatibleProvider.parseDocument`, vision-gated); endpoint
      answers an in-contract 501 until a vision model is registered (TD-003)
- [x] Model onboarding - dispatch by `protocol` with `normalizeProtocol`
      aliases, `config.wire` descriptor, schema validation on the write path,
      `GET /capability/protocols`, per-model probe self-check; an unroutable
      protocol is an explicit `503 MODEL_NOT_ROUTABLE`
- [x] Upstream calls carry an `AbortSignal` with a time-to-first-byte guard;
      a client that disconnects mid-stream aborts the upstream call
- [x] **v0.2.2 declared the stable operational baseline** (owner, 2026-08-10);
      remaining items below are scoped OUT of that baseline and gate the next
      feature version instead

## To do

Provider surface (TD-003):

- [ ] A1 embedding provider beyond Zhipu - procurement decision
- [ ] A2 parse activation - register a vision-capable model
      (`config.supportsVision: true`), verify, publish `atlas.parse`
      (TD-019); deferred by owner decision 2026-08-10
- [ ] A3 rerank provider beyond Zhipu - procurement decision

Gateway capabilities ([ADR-004](../30-design/decisions/ADR-004-reject-portkey-gateway-dependency.md)):

- [ ] Load balancing across endpoints expressed as `model_policies` config
      (fallback routing and RPM/concurrency limits are live; TPM/TPD are
      declared but deliberately unenforced)
- [ ] OpenAI-shaped entry (`/v1/chat/completions`) sharing one pipeline with
      `/v1/chat`; tenant identity from the token, never the body
- [x] Cost calculation from `model_price_rules` - `GET /capability/logs/cost`
      (TD-047 part 1, 2026-08-26). Quantities only; Atlas meters, it does not
      bill. Peak/off-peak pricing and exposing the splits on `/capability/logs`
      remain open on TD-047 - the second needs a home in provider config, the
      third changes a published shape and is a three-party decision
- [x] Unify `request_records` failover grain across chat and S2S surfaces -
      one row per attempt on both, `attempt_index` carries the ordinal
      (TD-037, 2026-08-26). Failed attempts are visible, and so is what they
      cost wherever the upstream reported it - which is the empty-response case
      that started this line of work. A timeout still reports nothing, and NULL
      remains the honest answer for those

Request size and model capacity (tenderforge liaison
`vx-agent-bid/docs/80-liaison/40-2609291955`, opened 2026-09-29):

- [x] Body ceiling 16 MiB (`MAX_REQUEST_BODY_BYTES`), X-1 codes
      `PAYLOAD_TOO_LARGE` / `REQUEST_BODY_MALFORMED`, and an upstream
      400/413/422 answered as `UPSTREAM_REJECTED_REQUEST` without tripping the
      circuit breaker - merged in #60. Design: `docs/30-design/200-s2s-provider-surface.md` section 1.4
- [x] Released as v0.7.6 (2026-09-29): dev stack first, then production;
      the letter's probes sent to production (a ~2 MB body passes the parser,
      a 17 MB body gets the 413 envelope)
- [ ] Verify `UPSTREAM_REJECTED_REQUEST` against a real upstream (an
      over-context request): unit tests only so far
- [ ] Confirm nothing in front of Atlas caps the body on tenderforge's
      production path (e.g. nginx `client_max_body_size`, 1 MB default). The
      direct tailnet path to `:3100` is clear (a 17 MB body reached Atlas);
      whether tenderforge uses that path is theirs to confirm, asked in
      `vx-agent-tenderforge`#69
- [ ] Measure the request-size limits of the domestic upstreams (Doubao,
      Zhipu, DeepSeek, MiniMax): none publishes one
- [ ] Letter 30 (`30-2609142131`), never answered: read from production which
      models serve `chat/deterministic` / `chat/fast` / `chat/default` /
      `chat/reasoning`, and their context window, max output, thinking and
      temperature, against the floors the letter asks for
- [ ] Letter 40 item 4: fill `contextWindow` / `maxOutputTokens` for the
      routed models, then publish per-route capacity on `/v1/model-routes`
      (`contextWindow`, `maxOutputTokens`: the minimum across the fallback
      chain; `maxRequestBytes`). Data before fields: a published `null` is
      configured-but-inert
- [ ] Letter 40 item 3: ADR, then code - recognise each provider's
      context-overflow refusal and answer it with a structured code, fallback
      first. No token estimation in the gateway, no truncation
- [ ] Refusals before routing (`PAYLOAD_TOO_LARGE`,
      `REQUEST_BODY_MALFORMED`) leave no reqlog row: add a counter metric
- [x] Reply to letter 40: `vx-agent-tenderforge`#69 (2026-09-29), an issue
      in the repo that has to act (`docs/80-liaison/` is a frozen archive).
      Items 3-5 are stated there as open
- [ ] Follow up in `vx-agent-tenderforge`#69: letter 30's model floors, and
      items 3 and 4 as they land; their production re-run of the failed
      interpretation

Platform-side, not this repo's write-scope:

- [ ] Remaining S2S callers - admin-bff, varda (TD-004)
- [ ] ~~`taskProfile` field in the opera grants UI~~ **Withdrawn 2026-08-27**
      (TD-009/TD-052): that would be building UI for the retiring tenant
      axis. A product wants `endpointCode`, whose grants already have CRUD.
      Withdrawn on `vxture-platform#52`
- [ ] Published `atlas` plan_version so the quota gate can deny uncovered
      workspaces (TD-016)
- [x] Action-ref pinning, enforced rather than performed - third-party
      `uses:` refs must be a 40-character SHA carrying a version comment,
      checked by `check-workflows` including composite actions
      (2026-08-26). TD-026 closed on 2026-08-16 by pinning the seven refs;
      until now nothing stopped the eighth from arriving on a tag. This
      line said "blocked" for ten days after the work it describes had
      already been done. First-party `actions/*` refs stay on tags on
      purpose and the count is printed on every run; the org-wide rule is
      still the platform line's to publish (`vxture-platform`#188).

Housekeeping:

- [ ] Beta tier - needs a dedicated host (TD-001)
- [ ] Move `reqlog.ensure_partitions` / `drop_expired_partitions` onto the
      platform's `db-maintenance.yml`; the manual twice-yearly db-init cadence
      works and is alarmed, so this is convenience, not a blocker
- [ ] Own admin/console regression against the network path - karda has proven
      the S2S chain, the BFF/console side has not been re-run
