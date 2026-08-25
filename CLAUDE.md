# vxture-atlas Repository Standards

Authoritative working agreement for this repo. The goal is a clean, predictable
branch and deploy flow with no direct human writes to protected branches, on top
of the org governance base.

This is Atlas, Vxture's L1 model platform (unified model access, routing,
quota and metering - the sole LLM/model egress point for every other vxture
product). Product code `atlas`. Everything below the product line -
governance, CI/CD, the platform integration channels, the data layer - is
rigid, on the authority of product_240 section 3 and the governance standard,
not on this repo's. Atlas is a
**services profile** repo (product_240 section 2.5), not the app profile most
other vxture products use: there is no Next.js app, no `portals/`, no
browser-facing UI. The source is a single NestJS service under `service/`.

**Package manager: pnpm** (whole-stack, owner-decided 2026-07-20). CI cache keys,
the Dockerfile deps stage, and the osv `--lockfile=pnpm-lock.yaml` path are all
pnpm.

**Version baseline: current latest** (owner-decided 2026-08-10, synced from
runos via issues #116-#118). Every component tracks the current latest stable
major: Node 24 LTS, pnpm 11, Postgres 18, Prisma 7 (driver-adapter model, no
url in schema), NestJS 11, TypeScript 6. Latest-COMPATIBLE beats
latest-absolute only where a hard ecosystem cap exists, and the cap is
recorded where applied (TS 7 blocked by typescript-eslint peer <6.1.0;
@types/node tracks the Node runtime major, not the newest types). pnpm 11
notes: credentials never in the project .npmrc (user-level only - see .npmrc
comment for the per-environment wiring); build-script allowlist and overrides
live in pnpm-workspace.yaml (`allowBuilds` / `overrides` - pnpm 11 no longer
reads the package.json `pnpm` field).

Authority for the design lives in the platform repo (`D:\MyWebSite\vxture`), not
here: `docs/10-standards/140-repo-governance-standard.md` (WHAT),
`docs/30-design/product_240_repo-template.md` (template design, section 3
matrix defines exactly which modules apply to an L1/atlas repo - not the full
set),`docs/50-deployment/rebuild/20-self-rectify-runbook.md` (HOW + machine
checks), `docs/10-standards/070-docs-taxonomy.md` (docs numbering). When a gap
is not covered by an existing standard, fix the standard in the platform repo
first, then mirror it here - do not invent a standard inside a product repo.

## What Atlas does NOT inherit (per product_240 section 3, atlas row)

Unlike an "app profile" product (arda/karda/terra), Atlas does **not** get:
- The business-plane DB baseline (`vx_provision`/`local_authz`/`local_usage` +
  domain schemas, template section 2.4) - Atlas is not an asset-face product,
  it has its own purpose-built data model (provider/model/grant/price_rule/
  policy + key/reqlog/routing) in its own physical database
  `vx_atlas_db`, zero cross-database FK to the platform DB.
- `portals/` or any app-profile scaffolding.
- C3 `grant.invalidated` or the visible-set recall filter (atlas is not an
  asset-face product in the sharing-grant sense).
- An `agent-server/` slot.

What it DOES carry is an **obligation**, which is not the same as implemented.
Per-module status is `docs/40-implementation/00-index.md`; open gaps are
`docs/60-operations/10-tech-debt.md`. The obligations:

- the full governance base
- C3 provisioning webhook
- the S2S surface as a **caller** (outbound to Doubao/Claude/Zhipu/private)
- the S2S surface as a **provider** (`/v1/*`)
- C2 entitlement read ahead of every call
- **C3 consume as the sole inference-metering entry point for every other
  vxture product** - karda/arda/varda token usage flows through Atlas, not
  their own metering; boundary design in
  `docs/30-design/210-usage-metering-and-history.md`
- OIDC RP five endpoints - inherited but never built, and no controller
  exists. Atlas has no end-user browser surface and the operator UI lives in
  `vxture-platform`'s portals, so this has never been needed; do not read the
  obligation as done code

## Name cascade (product code `atlas`)

OIDC client pair `atlas` / `atlas-beta`; compose project and app container
`atlas-app`; image name `atlas-app`; workspace package
`@atlas/service` (matching the sibling convention `@arda/app` / `@karda/app`);
NestJS root module `AtlasModule`; health identity `service: "atlas"`
and metrics label `component: "atlas"` (standard 025); service role
`atlas_svc`; secrets
`ATLAS_DB_SVC_PASSWORD`, `ATLAS_PROVISION_WEBHOOK_SECRET`,
`ATLAS_WEBHOOK_BASE_URL`; public host `atlas.vxture.com` (reserved, not yet
bound - Atlas is tailnet-only today, see docs/50-deployment/00-index.md).

**Datastore names are their own derivation** (2026-08-05; database rule
revised 2026-08-10 per runos ADR-007, synced via issue #115). The engine is
visible in the CONTAINER name only - inside the engine the segment is
tautological, so the database identifier drops it:

```
container   vx-<product_code>-<engine>-db-<env>    vx-atlas-postgres-db-prod
database    vx_<product_code>_db                   vx_atlas_db
```

`<product_code>` and `<env>` are derived (`PRODUCT_CODE`, `DEPLOY_ENV`);
`<engine>` is a literal per compose service - `postgres` today, `redis` when a
session store lands. The database name is snake_case on purpose: a hyphen in a
Postgres identifier forces double quotes in every hand-written statement. A
second database of the SAME engine gets a purpose segment
(`vx_atlas_audit_db`), reserved until one exists. The db name is injected
configuration (`POSTGRES_DB`/`DATABASE_URL`); nothing in code or DDL may
depend on the literal.

Container names derive in four places that must agree - `docker-compose.yml`,
`deploy/deploy.sh`, `db-init.yml`, and `deploy.yml`'s delivery check; the
database name derives in `docker-compose.yml` and `db-init.yml`. A
disagreement means db-init silently targets a database nobody runs against.

HTTP paths are NOT part of this cascade - `/v1/*` (data plane) and
`/capability/*` (operator plane) are deliberate, see
`docs/20-specs/10-http-surface.md`.

## Build status

Live in production on worker-02 with karda as a real S2S consumer. Do not
restate status here - it goes stale. What is done and what is left:
`docs/70-workplan/00-index.md`.

## Branch model

Single long-lived branch: `main` (trunk-based). Deploys are NOT tied to merges -
they are triggered only by pushing a release tag, which also selects the
environment (product repos default to two tiers):

- `main` - the only integration branch. All feature work merges here via PR.
  Merging to `main` does NOT deploy anything by itself.
- `beta-YYYYMMDD.N` tag - deploys the beta stack. No approval gate.
- `vX.Y.Z` tag - deploys the production stack. Gated by a required reviewer on
  the `production` GitHub Environment - the deploy job pauses until approved.

`dev-*` and `varda-*` tags are platform-repo-only; product repos do not build
develop/varda environments.

Always branch off `origin/main`, never off a stale local branch.

## How to make a change (the only path)

1. `git fetch origin && git switch -c <feature> origin/main`
2. Commit work on the feature branch.
3. **Bring it up locally in Docker and verify it runs, before pushing.** Not
   "CI will catch it" and not "the unit tests are green" - the bar is a
   container stack that actually serves. Static checks are the floor, not the
   gate:
   - `pnpm --filter @atlas/service test`
   - `pnpm --filter @atlas/service exec tsc --noEmit -p tsconfig.json`
     (vitest does NOT type-check, so a green suite says nothing about a
     signature change)
   - `pnpm lint`
   - `node scripts/guardrails/check-*.mjs --strict` (six of them)

   Then the actual gate - **an isolated local stack, in Docker**:

   **Pull the image CI built for this PR - do not rebuild it.** `build.yml`
   runs on every PR touching `service/**` and pushes to GHCR, so what you
   verify is the exact binary the release will deploy. It also means this works
   on a machine that cannot build (the private `@vxture/shared` needs a token),
   which is what made this rule unenforceable before.

   **Pull by `pr-<number>`, not by your HEAD sha.** A `pull_request` build
   checks out the MERGE commit, so it tags `sha-<merge-sha>` - which is not
   what `git rev-parse HEAD` prints on your branch, and pulling that fails with
   `not found`. `pr-<number>` is stable across pushes to the branch and is the
   only tag you can name without reading the workflow log.

   ```
   PR=249                       # your PR number
   docker pull ghcr.io/vxture-foundation/atlas-app:pr-$PR
   PROJECT_NAME=atlas-val DEPLOY_ENV=val DATA_DIR=./data/val      APP_PUBLISH_PORT=3102 IMAGE=ghcr.io/vxture-foundation/atlas-app IMAGE_TAG=pr-$PR      DATABASE_URL=postgresql://atlas_svc:PW@db:5432/vx_atlas_db      docker compose --profile dev up -d
   curl localhost:3102/healthz && curl localhost:3102/readyz
   ```

   For a commit already on `main` (verifying before a release), there is no PR
   tag - dispatch a build for it and pull the sha:

   ```
   gh workflow run build.yml --ref main -f pass_sha=$(git rev-parse HEAD)
   docker pull ghcr.io/vxture-foundation/atlas-app:sha-$(git rev-parse --short HEAD)
   ```

   That build tags `APP_VERSION=dev` because its ref is a branch, and it
   occupies the `sha-<short>` dedup key - so the release build for the same
   commit is SKIPPED and the deployed container reports `version=dev` unless
   `RELEASE_VERSION` overrides it at run time. It does (deploy.yml -> deploy.sh
   -> `promoteReleaseVersion()` in `env.ts`), but if that ever regresses, this
   is the mechanism to look at.

   `DATABASE_URL` must be overridden **in the shell**: compose also
   interpolates `./.env`, whose host-oriented `@127.0.0.1` means the container
   itself. The app refuses to start on that now, naming the fix.

   Port 3102, not 3101: the devbox stack publishes 3101, so a probe there
   answers from the devbox and looks confusingly healthy. `docker compose down`
   and drop the data dir when finished.

   Extra evidence the change type demands:
   - **Changed behaviour**: remove the fix and confirm the new test actually
     fails. A green suite is not proof of coverage - this repo has repeatedly
     had a defect survive a fully green run because nothing exercised the path.
   - **Changed DB structure or column grants**: apply the DDL to a throwaway
     `postgres:18`, apply it a SECOND time (db-init re-runs on every deploy, so
     non-idempotent means broken deploys), and run the statement as
     `atlas_svc`. Column-level grants and Prisma writes meet only at runtime.
   - **Changed the image**: build it and boot the container.

   If a step genuinely cannot run here - the image build needs a token this
   machine does not have - **say so plainly** and name what was verified
   instead. Never imply a local run that did not happen.
4. Open a PR into `main`. On `vxture-foundation`'s current plan (private repo,
   Free), **nothing technically blocks a direct `git push origin main`** - see
   the Branch protection section below. Going through a PR here is discipline,
   not enforcement; a direct push still lands, silently, except for the
   `direct-push-audit` workflow flagging it after the fact.
5. CI runs on the PR. Squash-merge once green; the branch is auto-deleted on
   merge. This does not deploy anything.
6. When ready to release, cut a tag from the commit you want deployed and push it.
   Deploying to ANY environment - dev included - follows step 3 first.

Squash merge only (merge commits and rebase merges are disabled at the repo
settings level - `allow_merge_commit`/`allow_rebase_merge` are `false`,
`delete_branch_on_merge` is `true`). This one **is** actually enforced by
GitHub regardless of plan - unlike the PR-required/status-checks gate below,
merge-method restriction is a plain repo setting, not a Ruleset.

### Bootstrap order (empty repo)

The branch-protection ruleset is applied LAST, not first: `git init` -> establish
`main` -> first-push `main` and let CI produce the required checks once -> THEN
apply `main-ruleset.json`. Applying a restrictive ruleset before the first code
import would block that import.

## Branch protection (GitHub Rulesets, not legacy protection)

**Not currently applied on this fork - confirmed unavailable, not just
unconfigured.** Both `gh api repos/vxture-foundation/vxture-atlas/rulesets`
(Rulesets) and the legacy `branches/main/protection` API return the same 403:
`Upgrade to GitHub Pro or make this repository public to enable this
feature.` `vxture-foundation` is a Free-plan org and this repo is private;
GitHub does not offer branch protection of either kind on that combination,
full stop - there is no bypass_actor or misconfiguration to fix here, the
feature itself is gated off. The org-secrets-for-private-repos gap and the
production Environment's required-reviewer gap (see docs/50-deployment/
00-index.md) are the same root cause. All three are solved at once by
upgrading to GitHub Team; until/unless that happens, treat everything below
as the design intent for when a ruleset CAN be applied, not as a description
of current enforcement. The `direct-push-audit` workflow
(`.github/workflows/direct-push-audit.yml`) is the compensating control in
the meantime: it cannot block a direct push, but it flags one - loudly, via
an auto-opened issue - the moment one lands.

**Discipline substitute - non-negotiable until the tooling exists.** Since
nothing technical enforces the rules below, every one of them is a hard rule
for every contributor and every agent working in this repo, human oversight
included:

1. Every change to `main` goes through a branch + PR, always - not "it's a
   small fix," not "I'm iterating fast," no exceptions carved out in the
   moment. A direct push is a process failure to fix, not a shortcut to take.
2. A PR does not get merged until its five required checks
   (`quality-gate`/`build`/`test-coverage`/`audit`/`gitleaks`) show green on
   that PR - checked by eye, since nothing blocks merging early.
3. Squash-merge only, using the PR title as the commit message - never a
   manual merge commit (the repo setting blocks this one technically, but
   don't rely on the setting alone; know why it's there).
4. Cross-cutting discussion, decisions, and any product-to-product
   coordination happen in Issues, not in chat or ephemeral channels - the
   same `liaison` convention `docs/80-liaison/` already uses for cross-repo
   traffic applies to this repo's own internal coordination too. If it isn't
   in an Issue, it didn't happen, for the purpose of anyone reconstructing
   why a decision was made.
5. Read `direct-push-audit`'s open issues (label `direct-push`) before
   trusting `main`'s history is clean. A bypass that already landed cannot be
   undone by this rule, but it should never be silently ignored either.

Design (apply via `gh api repos/vxture-foundation/vxture-atlas/rulesets` once
upgraded). The authoritative ruleset is
`docs/50-deployment/rebuild/main-ruleset.json`.

**Required checks (authoritative set of five):** `quality-gate` / `build` /
`test-coverage` / `audit` / `gitleaks`. CI job names must produce exactly these
five contexts - renaming a job breaks branch protection. Never remove a check
from the required set.

**`bypass_actors` MUST stay empty.** A bypass actor makes every rule above
advisory for that actor, so a direct `git push origin main` succeeds silently -
which is how this repo's "direct push is BLOCKED" claim was once false
(TD-020). Admin can still break glass by editing the ruleset; the difference is
that this is a recorded config change instead of an invisible per-push
exemption. Do not re-add a bypass actor to make an urgent merge easier.

## CI/CD pipeline

`ci.yml` triggers on PRs to `main` and on `push:main`; it does NOT deploy.

- `quality-gate` aggregates the static checks: whitespace/conflict-marker check,
  the docs numbering guardrail, the data-architecture guardrail (DDL <-> Prisma
  lockstep), and the workflow guardrail (workflows parse and keep triggers).
- `build`: `pnpm type-check:all` plus the NestJS esbuild bundle build.
- `test-coverage`: `pnpm --filter @atlas/service test`.
- `audit` (separate required check): `osv-scanner` (pinned binary) scans
  `pnpm-lock.yaml`, hard-blocking on any new finding, with
  `--config .osv-scanner.toml`.
- `gitleaks` (separate required check, `.github/workflows/secret-scan.yml`):
  pinned gitleaks binary, full-history `detect`.

The tag-to-env deploy workflows (`deploy.yml`/`build.yml`/`rollback.yml`/
`db-init.yml`) and the `tailnet-ssh-connect` composite action follow the org
CD reference pattern (vxture-arda). See `docs/50-deployment/00-index.md`.

## Secret hygiene (four layers)

Credentials never enter the repo - only environment/config injection. Leaks are
revoked at the source console, not scrubbed from history. Dev-phase repos are
PUBLIC (no private fallback), so "credentials never committed" is an absolute
rule, not a posture backed by a private boundary.

1. GitHub secret scanning + push protection (repo setting).
2. `gitleaks` CI (`.github/workflows/secret-scan.yml`).
3. Local `.husky/pre-commit` - wire once per clone with
   `git config core.hooksPath .husky`.
4. Public posture, all-rights-reserved (no LICENSE file, no `license` field).

Shared credentials (ACR, tailscale, npm token) are org-level: configured once and
shared to selected repos, not duplicated per repo.

## Dependency security (SCA)

`audit` = osv-scanner hard gate over `pnpm-lock.yaml`. Fix (upgrade / pnpm
override / exact pin for peer-only deps) or record a named `[[PackageOverrides]]`
exception with a reason - never widen the gate.

## Auditing claims

The recurring defect in this repo is a claim nothing binds: a sentence in a
doc, a code comment, or a liaison letter that no code, test, or check enforces.
Two audit rounds have swept for it, and both were exhaustive - every
`exhaustive` / `never` / `cannot` / "we decided X" pulled out and read against
the code. That is expensive, and the hit rate is roughly 23 findings a round.

**Do not pre-filter by how important a claim looks.** The obvious move is to
rank claims by consequence and chase only the top ones. It does not work here,
because this defect's symptom is that nothing happens. The canonical instance:
a liaison letter promised `QUOTA_EXHAUSTED` while the code threw
`QUOTA_EXCEEDED` from the first day. The consumer implemented against the
letter, the branch never matched, both repos' CI stayed green, production
raised zero alerts, and it went unnoticed for months. A consequence ranking
filters that claim out - a code name inside a letter looks like the least
consequential line on the page.

Audit practice outside software has the other half of this, and it is worth
naming because we do not have it yet. Financial audit does pre-filter, by
materiality (ISA 320) and sampling (ISA 530), but it pairs the quantitative
threshold with a **qualitative materiality** bypass: some misstatements are
material whatever their size. `QUOTA_EXHAUSTED` is exactly that shape -
quantitatively trivial, qualitatively decisive. So the industry answer is not
"never pre-filter"; it is "pre-filter, plus a criterion for what bypasses the
filter". **We have no such criterion, so we do not get the filter either.**

Until that criterion exists, enumeration is the only honest method: sweep the
whole surface, or say plainly that the sweep was partial and name what was left
out. **A sampled audit reported as a complete one is itself a claim nothing
binds** - and a swept dimension that reports zero findings without stating what
it covered is the same thing one level down (ISO 19011 requires an audit report
to state its scope limitations for this reason; a round-2 dimension named
"release/deploy consistency" reported zero while the deployment doc carried two
false claims, and the cost was a skipped db-init and 32 seconds of lost
metering).

## Docs taxonomy

`docs/` follows the org docs taxonomy for the shared skeleton: top-level decades
`00-meta` / `10-standards` / `20-specs` / `30-design` / `40-implementation` /
`50-deployment` / `60-operations` / `70-workplan` / `80-liaison` / `90-memory`;
map in `docs/00-meta/00-index.md`. Numbered = formal, unnumbered = temporary.

ADRs live in `docs/30-design/decisions/` with stable append-only IDs; the
tech-debt register lives in `docs/60-operations/10-tech-debt.md` (`TD-NNN`).

Each document has one job. Design documents state the final design, not how it
was reached; implementation documents state current status; the workplan is a
done/to-do checklist. A decision is recorded once as an ADR and referenced
elsewhere - do not restate its reasoning in a second file. History belongs in
git, not in progress notes appended to documents.

## Rigid zone / blank zone

**Rigid (do not deviate):** the entire governance base; CI/CD key names, job
names, workflow semantics; the three-channel module endpoints/signing/idempotency/
gating formula/cache discipline (for the subset that applies to atlas - see
product_240 section 3); value-domain consumption; DB governance (DDL
three-part + column locks + db-init as the sole structure-change path); docs
numbering; the data-face hard constraints; Atlas's role as the sole inference-
metering entry point for every other product.

**Blank (Atlas decides):** the S2S provider surface's actual endpoint shapes for
embedding/parse/rerank (karda has submitted field-level requirements as design
input, `docs/80-liaison/00-index.md` - not a contract, a starting point);
model-runtime internal structure (registry/router/quota/metering/providers);
the `20-specs/` product
definition; domain guardrails.

## Repository hygiene

- Keep the working tree clean; do not commit local runtime artifacts (`.env`,
  generated data, certs, caches) - they are git-ignored on purpose.
- After a merge, prune stale remotes: `git fetch --prune`.
- Keep source, config, and root meta files (`.gitignore`, `.editorconfig`,
  `.gitattributes`, `.npmrc`, `.gitleaks.toml`, `CLAUDE.md`, `README.md`)
  ASCII-only - no em-dashes, smart quotes, or non-ASCII characters.
