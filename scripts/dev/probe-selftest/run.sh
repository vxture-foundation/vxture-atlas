#!/usr/bin/env bash
# run.sh - prove the model probe reaches the right verdict, with no vendor credential.
#
# Brings up an ISOLATED val stack (its own project, network, database and data
# dir), points three fixture models at a local thinking-model stub, and asserts
# what the probe says about each. Nothing here touches the dev stack.
#
#   scripts/dev/probe-selftest/run.sh sha-3b5e99d     # a CI-built image
#   scripts/dev/probe-selftest/run.sh local           # whatever you built
#   KEEP=1 scripts/dev/probe-selftest/run.sh sha-...  # leave the stack running
#
# What it asserts, and why each case exists:
#
#   stub-thinking          both checks FAIL. A model that spends its whole
#                          budget reasoning answers nothing - the chat check
#                          must name the reasoning chain rather than say
#                          "empty model response", and the STREAM check must
#                          fail too. That one used to pass: HTTP 200, usage
#                          complete, not one deliverable token.
#   stub-thinking-capped   the probe sends 512, not its 2048 default. Exceeding
#                          a model's declared ceiling is a 400, i.e. a fake
#                          onboarding failure on a model that works.
#   stub-no-thinking       both checks PASS, and `thinking` reaches the wire -
#                          config.wire.extraBody is honoured, not just stored.
#
# The last assertion is the one that catches a whole class of regression: it
# reads the stub's record of what Atlas actually SENT, so "the switch is
# configured" and "the switch was transmitted" cannot be confused.
set -euo pipefail

IMAGE_TAG="${1:-local}"
PORT="${APP_PUBLISH_PORT:-3102}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OVERLAY="scripts/dev/probe-selftest/compose.val.yml"
DB_CONT="vx-atlas-postgres-db-val"
APP_CONT="vx-atlas-app-val"

cd "$ROOT"

export PROJECT_NAME=atlas-val DEPLOY_ENV=val DATA_DIR=./data/val
export APP_PUBLISH_PORT="$PORT" PRODUCT_CODE=atlas
export IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
export IMAGE_NAMESPACE="${IMAGE_NAMESPACE:-vxture-foundation}"
export IMAGE_TAG
export POSTGRES_PASSWORD=valpw_local_only
# Must be overridden in the SHELL: compose also interpolates ./.env, whose
# host-oriented @127.0.0.1 means the container itself.
export DATABASE_URL='postgresql://atlas_svc:valpw_local_only@db:5432/vx_atlas_db'

compose() { docker compose -f docker-compose.yml -f "$OVERLAY" "$@"; }

cleanup() {
  if [ "${KEEP:-}" = "1" ]; then
    echo "KEEP=1 - leaving the stack up on :$PORT"
    return
  fi
  compose down >/dev/null 2>&1 || true
  rm -rf ./data/val
}
trap cleanup EXIT

echo "== bringing up the val stack (image $IMAGE_TAG) =="
compose up -d db >/dev/null

# pg_isready is NOT enough: the entrypoint answers on the socket while initdb is
# still creating POSTGRES_DB, so the DDL then fails with "database does not
# exist". Wait for the database itself.
docker exec "$DB_CONT" sh -c '
  i=0
  until psql -U postgres -d vx_atlas_db -tAc "select 1" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 90 ] && { echo "database never came up"; exit 1; }
    sleep 1
  done'

echo "== applying the DDL, in db-init order =="
for f in deploy/database/ddl/00_baseline.sql \
         deploy/database/ddl/97_service_role.sql \
         deploy/database/ddl/98_column_locks.sql \
         deploy/database/ddl/incr/*.sql; do
  case "$f" in *.sql) ;; *) continue ;; esac
  docker exec -i "$DB_CONT" psql -U postgres -d vx_atlas_db -v ON_ERROR_STOP=1 -q < "$f" >/dev/null
done
docker exec "$DB_CONT" psql -U postgres -d vx_atlas_db -q \
  -c "ALTER ROLE atlas_svc WITH PASSWORD 'valpw_local_only';"
docker exec -i "$DB_CONT" psql -U postgres -d vx_atlas_db -v ON_ERROR_STOP=1 -q \
  < scripts/dev/probe-selftest/seed.sql

echo "== starting app, issuer and stub =="
compose up -d >/dev/null
docker exec "$APP_CONT" node -e '
  const t = setInterval(
    () => fetch("http://127.0.0.1:3100/healthz")
      .then((r) => { if (r.ok) { clearInterval(t); process.exit(0); } })
      .catch(() => {}),
    1000,
  );
  setTimeout(() => { console.error("app never became healthy"); process.exit(1); }, 90000);'

TOKEN="$(DEVBOX_ISSUER_CONTAINER=vx-atlas-dev-issuer-val \
  bash scripts/dev/devbox-token.sh operator | tail -1)"

probe() {
  curl -sS -X POST "localhost:$PORT/capability/models/$1/probe" \
    -H "authorization: Bearer $TOKEN"
}

echo "== probing =="
THINKING="$(probe 22222222-2222-2222-2222-222222222222)"
CAPPED="$(probe 33333333-3333-3333-3333-333333333333)"
NOTHINK="$(probe 44444444-4444-4444-4444-444444444444)"
SENT="$(docker exec "$APP_CONT" node -e '
  fetch("http://stub:8080/_requests").then((r) => r.text()).then((t) => console.log(t));')"

node -e '
const [thinking, capped, nothink, sent] = process.argv.slice(1).map((s) => JSON.parse(s));
const fails = [];
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fails.push(label);
};
const leg = (probe, mode) => probe.checks.find((c) => c.mode === mode);

check("thinking model: chat fails", leg(thinking, "chat").ok === false);
check(
  "thinking model: chat names the reasoning chain, not `empty model response`",
  /reasoning chain/.test(leg(thinking, "chat").error?.message ?? ""),
);
check("thinking model: stream fails (used to be a false green)",
  leg(thinking, "stream").ok === false);
check("thinking model: stream says PROBE_STREAM_EMPTY",
  leg(thinking, "stream").error?.code === "PROBE_STREAM_EMPTY");
check("thinking model: stream reported usage anyway (the trap)",
  leg(thinking, "stream").usageReported === true);
check("capped model: still fails, for the same reason", capped.ok === false);
check("thinking disabled: whole probe passes", nothink.ok === true);
check("thinking disabled: content actually arrived on both legs",
  nothink.checks.every((c) => c.contentReceived === true));

const budgets = sent.filter((r) => !r.body.stream).map((r) => r.body.max_tokens);
check("budget defaults to 2048", budgets.includes(2048));
check("budget respects a declared 512 ceiling", budgets.includes(512));
check("extraBody reached the wire",
  sent.some((r) => r.body.thinking?.type === "disabled"));
check("extraBody did not leak onto the other models",
  sent.filter((r) => r.body.thinking !== undefined).length === 2);

console.log(fails.length === 0
  ? "\nprobe self-test: OK"
  : `\nprobe self-test: ${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
' "$THINKING" "$CAPPED" "$NOTHINK" "$SENT"
