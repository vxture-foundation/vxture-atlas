# 50-deployment - Infra, CI/CD, environments

Current deployment facts. The cross-repo authority for host allocation is
`vxture-platform`'s `docs/50-deployment/13-infra-allocation-registry.md`; this
file is the local view.

## Infra allocation

| Item | Value |
|------|-------|
| Deploy host | worker-02 (`100.76.219.48`), shared with arda/varda/vxtpl |
| Stack root | `/srv/md0/atlas` |
| Published port | `3100` (not an app-profile `32X0/32X1` pair). `APP_PUBLISH_PORT=3100` is consumed only by compose's port mapping on the host's own `.env` |
| Public domain | `atlas.vxture.com` - reserved, not bound. Atlas is tailnet-only and has no browser surface, so no edge vhost is scaffolded |
| Tailnet | class 2 (product_230 D1) |
| ACR namespace | `ALIYUN_ACR_NAMESPACE=vx-foundation`; `ALIYUN_ACR_REGISTRY` and credentials are org-level |
| Environments | `production` (required reviewer). No `beta` - see TD-001 |

Registry order is ACR primary, GHCR fallback -
[ADR-005](../30-design/decisions/ADR-005-acr-primary-ghcr-fallback.md). Builds
push to both; only the pull order differs.

## Two local stacks, one character apart

| | file | containers | app port | tokens come from |
|---|---|---|---|---|
| **dev stack** | `docker-compose.yml` | `vx-atlas-*-dev` | 3100 | the real platform IdP |
| **devbox** | `docker-compose.dev.yml` | `vx-atlas-*-devbox` | 3101 | its own in-memory issuer |

**Integration runs on the dev stack. The devbox is self-test only.** When a
real karda/arda/opera is calling, the token must come from the issuer that
will mint it in production - the exchange is part of what is under test. A
devbox token would exercise Atlas's verification against a claim shape this
repo chose for itself, which is the one assumption an integration test exists
to stop trusting.

The devbox exists for the opposite question: "does this route behave", where a
token is merely the cost of asking.

Neither stack can take the other down: separate project names, container
names, network, volume and ports.

### `DATABASE_URL` means two different things, and getting it wrong is silent

`.env` carries the **host-oriented** URL (host segment `127.0.0.1:5432`),
because host tools - psql, the Prisma CLI, DDL verification - reach the
database through the dev-only `forwarder` container. But compose ALSO
interpolates `.env` into `DATABASE_URL: ${DATABASE_URL:-}` for the app
container, where `127.0.0.1` is the container itself. `.env.example` documents
the container-oriented form (host segment `db:5432`, the compose service
alias).

So restarting the dev app without overriding it produces a stack that reaches
no database - and `/healthz` still answers `ok`, because it does not touch the
database. Only `/readyz` shows it:

```
# rebuild/restart the dev app with the container-oriented URL:
export DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed 's|@127\.0\.0\.1:|@db:|')"
APP_VERSION=<version> GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d app

# then confirm - `ok` from /healthz is NOT enough:
curl -s localhost:3100/readyz
```

The dev stack's issuer is a host process on port 3081, so `OIDC_ISSUER` names
`localhost` while `OIDC_BACKCHANNEL_ISSUER` names `host.docker.internal` - the
claim value and the fetch address are deliberately different, which is what
the backchannel split exists for.

## Datastore naming

Per runos ADR-007: the database identifier drops the engine segment - inside
the engine it is tautological, and the engine distinction lives in the
container name.

```
container   vx-<product_code>-<engine>-db-<env>    vx-atlas-postgres-db-prod
database    vx_<product_code>_db                   vx_atlas_db
role        <product_code>_svc                     atlas_svc
```

`<product_code>` comes from `PRODUCT_CODE` and `<env>` from `DEPLOY_ENV`
(routed from the deploy tag; `dev` for a local stack). `<engine>` is a literal
per compose service, so a second datastore CONTAINER is named the same way - a
session store would be `vx-atlas-redis-db-prod`. A second database of the SAME
engine gets a purpose segment (`vx_atlas_audit_db`), reserved until one
exists. The db name is injected configuration (`POSTGRES_DB`/`DATABASE_URL`);
nothing in code or DDL may depend on the literal.

Container names derive in four places that must agree: `docker-compose.yml`,
`deploy/deploy.sh`, `db-init.yml`, and `deploy.yml`'s compose delivery check.
The database name derives in two of them: `docker-compose.yml` (POSTGRES_DB
default) and `db-init.yml` (`DB=`).

## Runtime image

The app image is distroless: a Node 24 runtime and the esbuild bundle, nothing
else. No shell, no npm, no wget; the container runs as nonroot; no
`node_modules` ships in the image. Anything that probes the app from inside
the container must therefore use the runtime itself: the compose healthcheck
and `deploy.sh`'s post-deploy verify both run `/nodejs/bin/node` with an
inline HTTP probe. There is no `docker exec ... sh` into the app container -
inspect it from the host (`curl` against the published port, `docker logs`,
`docker inspect`).

## Tag to environment

- `beta-YYYYMMDD.N` -> beta stack. Dormant (TD-001).
- `vX.Y.Z` -> production.

Merging to `main` deploys nothing. `dev-*` and `varda-*` tags are
platform-repo-only.

**There is no approval gate on production today, and this file used to say
there was.** The `production` GitHub Environment exists with **zero protection
rules** - verified 2026-08-25 against
`GET /repos/{owner}/{repo}/environments/production`, which returns
`protection_rules: []`. Same root cause as the missing branch protection
(CLAUDE.md): a Free-plan org on a private repo cannot configure them. A required
reviewer is the design intent for when the plan allows it, not a description of
what happens when you dispatch a deploy.

So: **dispatching a deploy changes production immediately, and nothing pauses
to ask.** Treat the dispatch itself as the decision.

## Workflows

`release.yml` / `build.yml` / `deploy.yml` / `rollback.yml` / `db-init.yml` plus
the `tailnet-ssh-connect` composite action, following the org CD reference
pattern (vxture-arda). `deploy.yml` delivers the compose file and runs
`bash deploy/deploy.sh` on worker-02.

**`release.yml` does not stop at the tag - it dispatches `deploy.yml`.** Cutting
a release therefore ships it, in one action, with no second confirmation. This
file previously listed the four workflows without `release.yml` and without the
chain, and the omission has already cost something: a release cut on 2026-08-24
was sequenced as "tag, then db-init, then deploy" on the strength of it, so the
new binary served for 32 seconds against a schema that lacked the columns it
writes. Every `reqlog` INSERT in that window failed whole and was swallowed into
a warning - the calls succeeded and left no record.

**The order is therefore: db-init FIRST, then release.** Not between. Every deploy publishes an immutable
`sha-<short>` image tag; `deploy.sh`'s `cmd_all` prunes unreferenced images
afterwards so the host disk does not accumulate them.

DB structure changes run only through `db-init.yml` (`confirm=yes` +
`expected_sha`) against `deploy/database/ddl/`. It declares
`environment: production` like the deploy does, and gets the same non-gate for
the same reason. The routine deploy chain never runs migrations or seeds.

**Run it before `release.yml`, not after.** An additive column is harmless to
apply early and harmless to apply twice (db-init re-runs on every deploy, so
every increment is idempotent by rule); a binary that writes a column the
database does not have yet loses the whole row, silently, while the request it
describes succeeds.

## Secrets

- `DEPLOY_WORKER02_*` (`HOST`/`USER`/`SSH_KEY`/`SSH_KEY_PASSPHRASE`/
  `KNOWN_HOSTS`/`PORT`), `ALIYUN_ACR_*`, `TAILSCALE_OAUTH_*`, `NODE_AUTH_TOKEN`
  are org-level, shared to the repos deploying to worker-02. This repo only
  needs to be on the sharing allowlist.
- `DEPLOY_DIR` and `ENV_FILE_BASE64` are per-repo - genuinely product-specific,
  not host-targeting.
- `DEPLOY_WORKER02_KNOWN_HOSTS` is mandatory and fail-closed in
  `.github/actions/tailnet-ssh-connect`; collect it with
  `ssh-keyscan -p <port> <host>` from a trusted network.

## Provider API keys - separate env file

Legacy `config.apiKeyEnvVar` keys (`DOUBAO_API_KEY` etc.) load from
`<stack_root>/etc/.env.provider-keys`, a second `env_file:` entry
(`APP_PROVIDER_KEYS_ENV_FILE`, `required: false`) kept **separate** from the
general `<stack_root>/etc/.env`.

Why separate: `deploy.yml` bootstraps `.env` from a GitHub secret on first
deploy but never touches this file. An operator creates it over SSH, so it can
carry stricter permissions (`chmod 400`) and its plaintext never transits
GitHub Actions - a smaller blast radius for the one class of secret that is
read on every model call.

```bash
sudo touch /srv/md0/atlas/etc/.env.provider-keys
sudo chmod 400 /srv/md0/atlas/etc/.env.provider-keys
sudo nano /srv/md0/atlas/etc/.env.provider-keys   # DOUBAO_API_KEY=<real key>
cd /srv/md0/atlas && docker compose restart app   # env_file is read at container start
```

The managed vault
([ADR-003](../30-design/decisions/ADR-003-provider-key-vault-envelope-encryption.md))
is the target state and needs neither this file nor `.env`; this file only
covers models still on the legacy path.

## Base-image mirror

worker-02's `/etc/docker/daemon.json` (set by the platform's host bootstrap,
not per-repo) uses an Aliyun Docker Hub mirror. Atlas's stack pulls only
`postgres:18-alpine`.

## Branch protection

`rebuild/main-ruleset.json` is authoritative; apply via
`gh api repos/vxture-foundation/vxture-atlas/rulesets`. `bypass_actors` must
stay empty.
