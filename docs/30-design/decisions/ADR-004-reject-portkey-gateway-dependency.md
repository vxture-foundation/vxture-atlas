# ADR-004: reject Portkey Gateway as the provider adapter layer; keep building in-house

**Status**: Accepted
**Date**: 2026-08-01
**Related**: `docs/30-design/100-model-onboarding-and-protocol-adapters.md`,
`docs/70-workplan/00-index.md`

## Context

Of the six capabilities expected of a model gateway, Atlas had roughly one and
a half: multi-vendor adapters (partial) and token accounting (partial). Missing
were load balancing, rate limiting (RPM/TPM/concurrency - the quota gate is a
monthly allowance, a different thing), an OpenAI-compatible surface, and cost
calculation.

None of the missing pieces carry vxture governance semantics on their face, so
replacing `providers/` and `router/` with an open-source gateway (Portkey
Gateway, TypeScript, MIT) was evaluated - keeping the NestJS shell, Prisma,
guards, registry and tenancy untouched.

## Options

**A. Embed `@portkey-ai/gateway` in-process as an npm dependency.** The
intended first choice. Not possible: v1.15.2 declares no `main`, `module`,
`types` or `exports` entry, so `require.resolve` fails outright. It publishes
`build/start-server.js` - a 483KB ESM bundle with a shebang, zero `export`
statements, and trailing side effects that start an HTTP server - plus console
static assets, and no type declarations. It is a server executable distributed
over npm, not a library.

**B. Run it as a sidecar process/container.** Technically workable and cheaper
than LiteLLM (Python) or Bifrost (Go), since it shares the Node runtime. But it
is a second process plus a localhost HTTP hop, while the services profile
(product_240 §2.5) is a single-service shape: deploy, rollback and health
checks all change. It also does not solve the primary provider - see below.

**C. Vendor adapters from source (MIT permits it).** Its 75 providers include
deepseek, ollama, dashscope, zhipu, moonshot, siliconflow, anthropic and
openai - but **not doubao / volcengine / ark**, Atlas's primary provider. Each
adapter is also small (roughly 150-250 lines), comparable to Atlas's own, and
written against Portkey's internal types and config handler, so adopting them
is a port rather than a copy.

**D. Take no dependency; borrow the structure and build the missing pieces.**

## Decision

Option D, on three measured facts rather than preference:

1. In-process embedding - the only shape compatible with the services profile -
   does not exist.
2. The primary provider (doubao/volcengine) is outside its coverage, so any
   adoption still leaves a hand-maintained adapter.
3. Adapters are not the cost centre (~200 lines per vendor). What is actually
   missing is load balancing, rate limiting, the OpenAI-compatible layer and
   cost metering - and those either carry vxture semantics (throttling per
   tenant x model via `model_policies`, metering via `price_rule` and the
   platform kernel) or sit outside the open-source scope entirely.

Also recorded: installing v1.15.2 adds 74 packages to `pnpm-lock.yaml` and its
`postinstall` runs `patch-package`. For a repo whose governance baseline
includes a hard-blocking dependency-vulnerability gate, that is a mark against
it independent of function.

Structure borrowed without the dependency:

- Split each provider directory into `api` / `chatComplete` / streaming / error
  mapping instead of one file per vendor.
- Express routing strategy (fallback / load-balance / conditional) as JSON
  configuration in the existing `policy` table, not a new configuration source.

## Consequences

- `providers/` and `router/` work is counted as in-house build in the workplan.
  There is no "add a dependency, done" shortcut.
- The OpenAI-compatible layer must be built here, as **two entries over one
  pipeline**: `/v1/chat` keeps the vxture S2S contract (karda/arda/varda depend
  on `tenantId`, `applicationType`, `featureId` and other metering dimensions
  that have no place in the OpenAI protocol), and a new
  `/v1/chat/completions`-shaped entry joins it. Both share one auth ->
  authorization -> rate limit -> route -> provider -> metering pipeline.
- Tenant identity on the new entry can only derive from the token or a virtual
  key, never from the body - which also corrects the existing inconsistency
  between `/v1/chat` reading `tenantId` from the body and `/tenancy/*`'s
  "scope comes only from the token" rule.
- Reversible: if the project ships a real library entry point, or adds
  volcengine/doubao adapters, option A can be re-evaluated.
