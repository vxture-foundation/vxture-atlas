# Run the local test environment

Brings up Atlas against a local database whose structure is identical to
production, with test data and one real upstream provider, and proves the chain
with real tokens. No mocks and no forged tokens: if the IdP or the provider is
unreachable, the run fails rather than degrading.

## Resident dev stack and version follow (owner convention)

The dev environment is the FULL compose stack, resident: `vx-atlas-app-dev` +
`vx-atlas-postgres-db-dev` + `vx-atlas-forwarder-dev` (profile `dev`),
all `restart: unless-stopped`. It stays up like production does - it is not
started per test session and is never stopped casually. The one sanctioned
stop is the mode switch in "Two run modes" below, and it ends with the
container coming back.

**Version follow.** Dev tracks production, at most one release behind:

- **Release follow (default state):** after every production tag `vX.Y.Z`,
  repoint dev at the SAME immutable CI image and let `/healthz` prove it:

  ```bash
  IMAGE_TAG=sha-<short> COMPOSE_PROFILES=dev docker compose up -d
  curl -s 127.0.0.1:3100/healthz   # version must equal the release tag
  ```

- **Internal iteration (between releases):** unreleased code runs under the
  NEXT patch version with an internal dev counter, `vX.Y.(Z+1)-dev.N`
  (semver prerelease, sorts below the release it precedes; `N` starts at 1
  and resets at every release). The number is injected at build time so the
  health identity says exactly which internal build is live:

  ```bash
  V=v0.2.1-dev.1
  APP_VERSION=$V GIT_SHA=$(git rev-parse --short HEAD) IMAGE_TAG=$V \
    docker compose build app
  IMAGE_TAG=$V COMPOSE_PROFILES=dev docker compose up -d
  ```

  Internal versions are LOCAL identity only: never a git tag (git tags stay
  release-only, `vX.Y.Z` / `beta-*`) and never pushed to a registry.

**Staleness check:** `/healthz` `version` vs the latest release tag. Equal or
one release behind (or a `-dev.N` of the next release) is healthy; anything
older means dev stopped following - catch up before testing against it.

## What it talks to

| Piece | Where | Notes |
|---|---|---|
| Atlas | container `vx-atlas-app-dev`, `:3100` (default); host process `:3100` only for the S2S mode switch below | the port `admin-bff`'s `ATLAS_API_URL` defaults to |
| Database | container `vx-atlas-postgres-db-dev` (compose project `atlas`) | published to `127.0.0.1:5432` by the `forwarder` profile service (`vx-atlas-forwarder-dev`); the `db` service itself publishes no port |
| Platform IdP | `auth-bff` on `:3081` | issuer is literally `http://localhost:3081` - reachable from the host but NOT from inside a container (`localhost` there is the container itself), which is why S2S-flow testing switches Atlas to a host process |
| Operator console | opera on `:3040` -> admin-bff `:3031` -> Atlas | opera mints operator tokens itself; nothing here needs to be configured for it |
| Upstream | Volcano Ark | the only real provider; the key lives in `.env.provider-keys` |

## Two run modes

- **Resident container (default):** the compose `app` service, always on.
  Covers everything that does not verify tokens against the local IdP:
  registry/routing/quota behaviour, real provider calls, reqlog, DDL parity.
- **Host process (S2S/IdP flows only):** `S2sAuthGuard` fetches JWKS from
  `{OIDC_ISSUER}/oidc/jwks`, and the local issuer is literally
  `http://localhost:3081` - unreachable from inside the container. For
  `s2s-smoke.mjs` and anything else that exercises token verification, swap
  modes for the duration of the test:

  ```bash
  docker compose stop app       # frees :3100
  node service/dist/main.cjs    # host process, reads ./.env (see Setup)
  # ... run the S2S tests ...
  docker compose start app      # resident container comes back
  ```

## Structure parity with production

The local database is built by the same three-part baseline plus increments
that `db-init.yml` applies in production, through `deploy/database/apply.sh`.
To prove parity rather than assume it, apply the DDL into a scratch database
and diff the dumps:

```bash
docker exec vx-atlas-postgres-db-dev psql -U postgres -q -c "CREATE DATABASE atlas_ddl_verify;"
for f in deploy/database/ddl/00_baseline.sql \
         deploy/database/ddl/97_service_role.sql \
         deploy/database/ddl/98_column_locks.sql \
         deploy/database/ddl/incr/*.sql; do
  docker exec -i vx-atlas-postgres-db-dev psql -U postgres -d atlas_ddl_verify -q -v ON_ERROR_STOP=1 -f - < "$f"
done

docker exec vx-atlas-postgres-db-dev pg_dump -U postgres -d vx_atlas_db \
  --schema-only --no-owner --no-comments -n key -n reqlog -n routing -n model -n provisioning > /tmp/cur.sql
docker exec vx-atlas-postgres-db-dev pg_dump -U postgres -d atlas_ddl_verify \
  --schema-only --no-owner --no-comments -n key -n reqlog -n routing -n model -n provisioning > /tmp/fresh.sql
diff /tmp/cur.sql /tmp/fresh.sql   # only pg_dump's random \restrict token should differ
docker exec vx-atlas-postgres-db-dev psql -U postgres -q -c "DROP DATABASE atlas_ddl_verify;"
```

The dump includes GRANTs, so this also verifies the column locks
(`98_column_locks.sql`), not just table shape.

## Setup

1. **Publish the database port.** The compose `db` service deliberately
   publishes nothing; the `forwarder` service (compose profile `dev`,
   container `vx-atlas-forwarder-dev`) forwards it to `127.0.0.1:5432`.
   Profiles keep it out of beta/prod - deploy.sh runs compose without
   profiles, so only an explicit dev invocation starts it:

   ```bash
   COMPOSE_PROFILES=dev docker compose up -d
   ```

2. **Give the service role a password** (the DDL creates `atlas_svc` without
   one; production injects it at bootstrap):

   ```bash
   docker exec vx-atlas-postgres-db-dev psql -U postgres -c "ALTER ROLE atlas_svc LOGIN PASSWORD '<local-password>';"
   ```

3. **Write `.env`** (git-ignored) at the repo root - `DATABASE_URL` pointing at
   `atlas_svc@127.0.0.1:5432`, `OIDC_ISSUER=http://localhost:3081`,
   `S2S_AUDIENCE=atlas`, and a `PROVIDER_KEY_ENCRYPTION_KEYS` /
   `..._ACTIVE_KEY_ID` pair for the key vault. Leave `PLATFORM_API_URL` empty:
   with no C2 endpoint the quota gate stays permissive and `usage_event_id`
   stays NULL, which is the documented reconciliation signal, not a fault.

4. **Write `.env.provider-keys`** with the real `DOUBAO_API_KEY`. Separate file
   on purpose - see `docs/50-deployment/00-index.md`.

5. **Seed and run**:

   ```bash
   pnpm --filter @atlas/service db:generate
   node scripts/dev/seed-test-data.mjs
   pnpm --filter @atlas/service build
   export $(grep -v '^#' .env.provider-keys | xargs)
   node service/dist/main.cjs          # from the repo root - it reads ./.env
   ```

   Run it from the repo root: `loadRootEnv` looks for `.env` relative to the
   working directory. `main.cjs` does not read `.env.provider-keys`; compose
   supplies it as a second `env_file`, so locally it is exported by hand.

6. **Verify**: `/readyz` should report `status: "ready"` with `database`,
   `modelRegistry`, `providerKeys` and `reqlogPartitions` all passing.

## Test data

`scripts/dev/seed-test-data.mjs` fills the registry: 5 providers, 9 models
across chat/embedding/rerank, 13 grants over four real tenants from the local
platform DB, price rules, rate policies, routing and fallback rules, and four
envelope-encrypted vault keys.

Only doubao is real. Its two models answer live, one through the managed vault
and one through the legacy env-var path, so both key resolutions are exercised.
The rest are fixtures: correct in shape, no account behind them - they fail at
the provider boundary, which is where a fixture should fail.

The script connects as `atlas_svc`, exactly like the application. It therefore
cannot TRUNCATE and cannot UPDATE identity columns, so it deletes and
re-inserts. That is not a workaround - it is the column-lock governance
(`98_column_locks.sql`) doing its job, and a seed script that needed owner
rights would be a sign the data model had drifted.

## End-to-end check

```bash
node scripts/dev/s2s-smoke.mjs
```

Mints a real S2S token from the local IdP by RFC 8693 token exchange (the
`console` client is on the platform-level S2S allowlist, so no platform-side
data change is needed), then drives: unauthenticated rejection, plane
separation (an S2S token must not reach `/capability/*`), registry reads,
`/tenancy/*` scope derived from the token, two real doubao generations, task-
profile routing, and the honest failures - unknown profile 404, ungranted model
403, discovery omitting `atlas.parse`.

After a run, `reqlog.request_records` carries the real calls with token counts,
latency and workspace attribution, and `usage_event_id IS NULL` because C3 is
not wired locally.

## Known local deviations from production

- Build provenance: the resident container on release follow reports the real
  release identity (it IS the CI image); an internal-iteration build reports
  its `vX.Y.Z-dev.N` + local git sha (injected as build args above); only the
  bare host process falls back to `version:"dev"`, `gitSha:"unknown"`.
- The quota gate is permissive: no `PLATFORM_API_URL`, so no entitlement
  source (TD-016, ADR-001).
- Nothing is reported to the platform metering kernel; local runs only write
  Atlas's own history.
