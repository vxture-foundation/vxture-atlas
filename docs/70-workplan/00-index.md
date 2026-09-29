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
`vx-agent-bid/docs/80-liaison/40-2609291955`, opened 2026-09-29; reply thread
`vx-agent-tenderforge`#69):

Done:

- [x] Body ceiling 16 MiB (`MAX_REQUEST_BODY_BYTES`); X-1 codes
      `PAYLOAD_TOO_LARGE` / `REQUEST_BODY_MALFORMED`; raw body kept for the
      webhook only; an upstream 400/413/422 answered as
      `UPSTREAM_REJECTED_REQUEST` without tripping the circuit breaker (#60).
      Design: `docs/30-design/200-s2s-provider-surface.md` section 1.4
- [x] Released as v0.7.6 (2026-09-29), dev stack first; the letter's probes
      sent to production (~2 MB passes the parser, 17 MB gets the 413 envelope)
- [x] No input truncation anywhere on the chat path (checked 2026-09-29)
- [x] Letter 40 answered in `vx-agent-tenderforge`#69 - an issue in the repo
      that has to act; `docs/80-liaison/` is a frozen archive

A - missed by the first pass:

- [x] A1. Design doc section 1.4: state that the body is parsed BEFORE S2S
      auth, so an unauthenticated caller can make the process buffer up to the
      ceiling, and why that is accepted (tailnet-only)
- [x] A2. X-1 registration for `PAYLOAD_TOO_LARGE`, `REQUEST_BODY_MALFORMED`,
      `UPSTREAM_REJECTED_REQUEST`: none needed (checked 2026-09-29).
      product_251 is archived into the platform's integration rules, which
      keep no per-product code table - Atlas's published contract artifact is
      the list, and the platform conformance guard counts only `retryable`
      and the four refusal codes. X-4 vocabulary search: no existing spelling
      to collide with - platform's `VALIDATION_TOO_LARGE` is a single field's
      value, not the request body; runos has neither

B - tenderforge is waiting on these:

- [x] B1. Letter 30 checked against production (2026-09-30) and answered
      in #69: every context and output floor is met (smallest across each
      chain: 128000 on `chat/default`, 256000 on the other three; output
      128000). Temperature is the caller's to send. Thinking is not
      configured on any route - see B5
- [x] B5a. Thinking analysed (owner, 2026-09-30): a per-call request
      parameter, not a route - ADR-009 (Proposed)
- [ ] B5b. ADR-009 accepted, then code: `thinking: "off"|"on"`, per-model
      `config.wire.thinking` fragments, `THINKING_MODE_UNSUPPORTED`,
      `thinkingModes` on `/v1/model-routes`, applied mode echoed
- [ ] B5c. Upstream default ON: confirmed for Doubao (2026-09-30, real
      request; production's `chat/fast` primary thinks today), DeepSeek not
      yet observed. After B5b: confirm `off` yields no reasoning, then fill
      `config.wire.thinking` for the routed models; reply in #69
- [ ] B6. Call deadline: pass the caller's timeout to the upstream as a
      total deadline (today only a time-to-first-byte guard exists)
- [ ] B7. Layer 2, an optional `requirements` block resolved by an
      operator-configured policy: cross-product vocabulary discussion open
      as `vxture-platform`#540 (2026-09-30); Atlas designs it after that
      settles
- [x] B2a. `max_context_tokens` vs `context_window` settled: the policy
      column is enforced by nothing (TD-054); capacity is published from the
      model's own columns
- [x] B2b. `/v1/model-routes` publishes per-route `contextWindow` /
      `maxOutputTokens` (smallest across the chain, `null` = unknown) and a
      top-level `maxRequestBytes` - code merged, not yet released
- [x] B2c. No fill needed: B1 found both columns set on all eight models
      behind tenderforge's four routes, so v0.7.7 publishes numbers
- [x] B3a. Letter 40 item 3 designed: ADR-008 (Proposed) - recognise each
      provider's refusal, no gateway token estimation, unrecognised overflow
      degrades to `UPSTREAM_REJECTED_REQUEST`
- [x] B3b. ADR-008 accepted (owner, 2026-09-29); `CONTEXT_LENGTH_EXCEEDED`
      with a code-kept signature table pinned by recorded vendor bodies.
      Doubao's signature still needs C1's real over-context request
- [ ] B3c. Move the signatures to per-provider configuration (TD-055)
- [x] Released as v0.7.7 (2026-09-30, first release through the production
      approval gate): #65, #67, #68, #69; verified in production and on the
      dev stack against a real Doubao upstream; tenderforge told in #69
- [ ] B4. tenderforge's production re-run of the failed interpretation, and
      whether their path to Atlas has a proxy capping the body (asked in #69)

C - verification:

- [x] C1 (Doubao). Real over-context request through the dev stack
      (2026-09-30): Doubao answers 400 `InvalidParameter` "...exceed max
      message tokens" - now a signature. Six overflows in a row, then a normal
      call is still served: the breaker exemption holds on the real path
- [ ] C1 (rest). Zhipu: the dev key answers 401, so its overflow is
      untested. DeepSeek: no grant for the dev product. Claude: no usable
      model in dev - its signature is still observed wording, not recorded
- [x] C2 (Doubao). 8 MB and 15 MB bodies both reached tokenization (400
      overflow, not 413): Doubao's byte cap is above 15 MB, so the 16 MiB
      ceiling does not cut in ahead of it
- [ ] C2 (rest). Zhipu, DeepSeek, MiniMax - same blockers as C1
- [x] C3. Refusals before routing are counted in the existing
      `model_request_rejections_total{code, product="unknown"}` rather than
      a second metric for the same fact

D - raised during this work:

- [ ] D1. After the repo returns to private: run
      `pnpm audit:run --only platform-claims` and confirm branch protection
      and the production approval gate against the live state
- [ ] D2. Owner decision: review repository content for anything that
      should not have been public during the 2026-09-29 visibility change

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
