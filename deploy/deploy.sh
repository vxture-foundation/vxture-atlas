#!/usr/bin/env bash
# On-host deployment lifecycle for the atlas production stack. Invoked by CI
# (deploy.yml / rollback.yml) after the image build.
#
#   bash deploy.sh all       # directories -> start -> verify -> prune
#   bash deploy.sh start     # pull image (primary, then fallback) + up -d
#   bash deploy.sh verify    # health check
#   bash deploy.sh prune     # remove unreferenced images (frees old sha-* tags)
#
# The image tag + registries come from the environment CI sets:
#   IMAGE_REGISTRY / IMAGE_NAMESPACE / IMAGE_TAG (primary),
#   FALLBACK_IMAGE_REGISTRY / FALLBACK_IMAGE_NAMESPACE (fallback).
# worker-02: ACR primary / GHCR fallback (owner decision 2026-07-26, deviates
# from governance section 5's non-VPC default - see deploy.yml and
# docs/50-deployment/00-index.md).
#
# Memory-constrained hosts (governance section 4): if the assigned deploy host
# is a 2C2G-class box (not a data-array box with room for old+new containers),
# switch cmd_start to per-service `pull + up -d --no-deps` instead of the
# full-stack pull/up below.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"     # /srv/md0/atlas on worker-02 - see docs/50-deployment/00-index.md
ENV_FILE="$ROOT/etc/.env"
# Provider API keys live in a separate, never-CI-bootstrapped file (operator
# creates it manually via SSH, chmod 400) - stricter permissions and a
# narrower blast radius than the general operator .env. Optional: compose's
# `required: false` means its absence is fine (e.g. before an operator has
# onboarded any provider key yet).
PROVIDER_KEYS_ENV_FILE="$ROOT/etc/.env.provider-keys"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

# Product code: from the environment (CI passes PRODUCT_CODE), else the
# atlas literal.
PRODUCT_CODE="${PRODUCT_CODE:-atlas}"
IMAGE_NAME="${PRODUCT_CODE}-app"
PROJECT_NAME="${PRODUCT_CODE}"
# Environment suffix for the db container (vx-<code>-postgres-db-<env>). CI
# passes it from the deploy tag; a bare invocation on the host is a production
# stack, so default to prod rather than to the compose-file default of dev.
DEPLOY_ENV="${DEPLOY_ENV:-prod}"
# Where the container runs, passed to compose at RUN time (docker-compose.yml
# reads ${DEPLOY_STAGE:-dev}). It used to be baked into the image as a build
# arg, which meant the production image reported "stage":"production" no matter
# where anyone ran it - including a laptop. An environment is not a property of
# the artifact, so it is derived here, from the deploy target.
#   prod -> production   (standard 025's identity vocabulary)
#   anything else -> itself (dev, beta, val)
case "$DEPLOY_ENV" in
  prod) DEPLOY_STAGE="production" ;;
  *)    DEPLOY_STAGE="$DEPLOY_ENV" ;;
esac
export DEPLOY_STAGE
# The release tag this deployment is part of, passed by deploy.yml from the
# pushed tag. Empty on a bare host invocation, and empty is the correct value
# there: env.ts only promotes it when non-empty, so the image's baked
# APP_VERSION survives rather than being replaced with a blank.
#
# This exists because a release build can be legitimately SKIPPED: build.yml
# dedups on `sha-<short>`, and since PR builds landed (#245) that key can
# already be occupied by a build made under a branch ref, whose APP_VERSION is
# `dev`. v0.18.0 deployed that image and verify_identity warned about it.
RELEASE_VERSION="${RELEASE_VERSION:-}"
export RELEASE_VERSION
APP_CONTAINER="vx-${PRODUCT_CODE}-app-${DEPLOY_ENV}"
# Same derivation docker-compose.yml uses. The engine segment lives in the
# CONTAINER name only - inside the engine it is tautological (runos ADR-007).
DB_CONTAINER="vx-${PRODUCT_CODE}-postgres-db-${DEPLOY_ENV}"
# Dev-only (compose profile `dev`); absent on a production host by design.
FWD_CONTAINER="vx-${PRODUCT_CODE}-forwarder-${DEPLOY_ENV}"
APP_PORT="3100"
# Persistent data lives OUTSIDE the deploy dir (which is rsync --delete'd on every
# deploy) - container-written data is root-owned and would otherwise break the
# next deploy's rsync. Absolute path under the stack root.
DATA_DIR="${DATA_DIR:-$ROOT/data}"

# Image reference resolution (owner, 2026-08-10): explicit env wins (the CI
# deploy path exports all three), then the operator .env for the stable pair
# (IMAGE_REGISTRY / IMAGE_NAMESPACE), then the VERSION pin the last deploy
# wrote for the tag (sha-<short> of the deployed commit), then the historical
# defaults. Before this, the inline `:-latest` defaults meant a bare
# `deploy.sh start` on the host tried to pull :latest from the wrong registry
# and failed - the operator had to hand-export what the host already knew.
envfile_value() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
IMAGE_REGISTRY="${IMAGE_REGISTRY:-$(envfile_value IMAGE_REGISTRY)}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
IMAGE_NAMESPACE="${IMAGE_NAMESPACE:-$(envfile_value IMAGE_NAMESPACE)}"
IMAGE_NAMESPACE="${IMAGE_NAMESPACE:-vxture}"
if [ -z "${IMAGE_TAG:-}" ] && [ -s "$DEPLOY_DIR/VERSION" ]; then
  IMAGE_TAG="sha-$(head -1 "$DEPLOY_DIR/VERSION" | cut -c1-7)"
fi
IMAGE_TAG="${IMAGE_TAG:-latest}"

log() { echo "[deploy] $*"; }

compose() {
  PRODUCT_CODE="$PRODUCT_CODE" \
  PROJECT_NAME="$PROJECT_NAME" \
  DEPLOY_ENV="$DEPLOY_ENV" \
  DATA_DIR="$DATA_DIR" \
  APP_ENV_FILE="$ENV_FILE" \
  APP_PROVIDER_KEYS_ENV_FILE="$PROVIDER_KEYS_ENV_FILE" \
  IMAGE_REGISTRY="$IMAGE_REGISTRY" \
  IMAGE_NAMESPACE="$IMAGE_NAMESPACE" \
  IMAGE_TAG="$IMAGE_TAG" \
  RELEASE_VERSION="$RELEASE_VERSION" \
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

cmd_environment() {
  test -f "$ENV_FILE" || { log "missing $ENV_FILE"; exit 1; }
  test -f "$COMPOSE_FILE" || { log "missing $COMPOSE_FILE"; exit 1; }
  log "environment OK ($ROOT)"
}

cmd_directories() {
  mkdir -p "$DATA_DIR/db"
  log "directories ready ($DATA_DIR)"
}

cmd_start() {
  local reg="$IMAGE_REGISTRY" ns="$IMAGE_NAMESPACE" tag="$IMAGE_TAG"
  local primary="${reg}/${ns}/${IMAGE_NAME}:${tag}"
  log "pulling ${primary}"
  if ! docker pull "$primary"; then
    local fb="${FALLBACK_IMAGE_REGISTRY:-}/${FALLBACK_IMAGE_NAMESPACE:-}/${IMAGE_NAME}:${tag}"
    log "primary pull failed; trying fallback ${fb}"
    docker pull "$fb"
    docker tag "$fb" "$primary"
  fi
  # Tolerated on purpose (an unreachable registry must not block a redeploy of
  # the app), but never silent: a failure here means the db container is
  # running on whatever the host already cached, and a host without that cache
  # cannot start the stack at all. Set POSTGRES_IMAGE to a mirrored ACR
  # reference to make this path deterministic - see docker-compose.yml.
  if ! compose pull db; then
    log "WARNING: could not pull the db image - using the host's local cache"
    log "  a host without that cache cannot bring the stack up; mirror it to ACR"
    log "  (.github/workflows/mirror-image.yml) and set POSTGRES_IMAGE in etc/.env"
  fi
  compose up -d
  log "started"
}

cmd_verify() {
  local tries=0
  local payload=""
  until [ "$tries" -ge 20 ]; do
    # PATH-resolved node exists in both image generations (real binary in
    # pre-distroless, shipped symlink in distroless), so verify keeps working
    # across a rollback boundary. Prints the body for the identity check.
    if payload="$(docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:${APP_PORT}/healthz').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())},()=>process.exit(1))" 2>/dev/null)"; then
      log "verify OK (health 200)"
      verify_identity "$payload"
      verify_readiness
      verify_resource_limits
      return 0
    fi
    tries=$((tries + 1))
    sleep 3
  done
  log "verify FAILED: /healthz not healthy"
  compose ps
  exit 1
}

# Standard 025 section 7 item 5: a 200 alone is not a passing deploy - the
# identity block must carry real build provenance, not the honest-fallback
# placeholders. TD-014 shipped for months behind a green `verify` because
# this was never checked; a warn (not a hard fail) keeps a genuine local/
# untagged build deployable while making the regression impossible to miss.
verify_identity() {
  local payload="$1"
  local placeholders=""
  case "$payload" in
    *'"version":"dev"'*)      placeholders="${placeholders} version=dev" ;;
  esac
  case "$payload" in
    *'"gitSha":"unknown"'*)   placeholders="${placeholders} gitSha=unknown" ;;
  esac
  case "$payload" in
    *'"buildTime":"unknown"'*) placeholders="${placeholders} buildTime=unknown" ;;
  esac
  case "$payload" in
    *'"stage":"dev"'*)        placeholders="${placeholders} stage=dev" ;;
  esac

  if [ -n "$placeholders" ]; then
    log "WARNING: health identity still on fallback values ->${placeholders}"
    log "  build provenance did not reach the image (standard 025 s4/s7, TD-014)"
    log "  the running build is NOT identifiable from the service itself"
  else
    log "verify OK (build provenance present)"
  fi
}

# /healthz is dependency-free by contract (standard 025 section 3): a live
# process answers 200 with the database gone, so the hard gate above cannot be
# the whole verdict - a deploy against a dead or unreachable database would
# otherwise report success. /readyz carries the dependency verdict.
#
# Warn, never fail: db-init owns db structure, so the ordinary deploy chain has
# to stay usable against a database that is not provisioned yet. Same posture
# as verify_identity.
# A compose file that DECLARES a limit and a kernel that ENFORCES one are two
# different facts, and only the second one keeps a leaking container from
# taking the host. `deploy.resources` is also widely believed to be swarm-only
# and silently ignored by `docker compose up` - it is not, on compose 5, but
# "widely believed" is exactly the kind of thing that should be checked rather
# than trusted.
#
# A warn, not a hard fail: an unlimited container still serves, and refusing to
# finish a deploy over it would turn a resource-hygiene regression into an
# outage. The point is that it cannot pass unnoticed.
verify_resource_limits() {
  local c mem cpu pids swap missing=""
  # FWD_CONTAINER is dev-only (compose profile `dev`), so it does not exist on
  # a production host - the inspect guard below skips it silently there. It is
  # in the list because the forwarder is exactly how this defect was found:
  # compose declared its ceiling and the running container had none, because
  # nobody had recreated it since before the limits landed.
  for c in "$APP_CONTAINER" "$DB_CONTAINER" "$FWD_CONTAINER"; do
    docker inspect "$c" >/dev/null 2>&1 || continue
    mem="$(docker inspect "$c" --format '{{.HostConfig.Memory}}' 2>/dev/null || echo 0)"
    cpu="$(docker inspect "$c" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null || echo 0)"
    pids="$(docker inspect "$c" --format '{{.HostConfig.PidsLimit}}' 2>/dev/null || echo 0)"
    swap="$(docker inspect "$c" --format '{{.HostConfig.MemorySwap}}' 2>/dev/null || echo 0)"
    log "limits ${c}: mem=${mem} cpu=${cpu} pids=${pids} memswap=${swap}"
    [ "${mem:-0}" -gt 0 ] 2>/dev/null || missing="${missing} ${c}:memory"
    [ "${cpu:-0}" -gt 0 ] 2>/dev/null || missing="${missing} ${c}:cpus"
    # memswap > memory means the container can swap past its stated ceiling -
    # docker's default when memswap_limit is unset is exactly 2x memory, so
    # "limit: 512M" silently meant 512M resident plus 512M of swap (runos#247).
    # A container that is swapping has not failed and is not working, which is
    # the state hardest to notice; the limit only means what it says when the
    # two are equal.
    if [ "${mem:-0}" -gt 0 ] 2>/dev/null && [ "${swap:-0}" -gt "${mem}" ] 2>/dev/null; then
      missing="${missing} ${c}:memswap>${mem}"
    fi
  done

  if [ -n "$missing" ]; then
    log "WARNING: container(s) running WITHOUT a resource ceiling ->${missing}"
    log "  one leak or one runaway query can take the host and every sibling product on it"
  else
    log "verify OK (resource ceilings enforced)"
  fi
}

verify_readiness() {
  local tries=0
  local payload=""
  # The body is the signal, not the HTTP status - /readyz answers 200 whatever
  # the verdict. Retried because /healthz turns 200 the moment the process
  # listens, which can precede the db container accepting connections; warning
  # on that first sample would be noise rather than signal.
  until [ "$tries" -ge 5 ]; do
    if payload="$(docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:${APP_PORT}/readyz').then(async r=>{process.stdout.write(await r.text())},()=>process.exit(1))" 2>/dev/null)"; then
      case "$payload" in
        *'"status":"ready"'*)
          log "verify OK (readiness ready)"
          return 0
          ;;
      esac
    fi
    tries=$((tries + 1))
    sleep 3
  done

  if [ -z "$payload" ]; then
    log "WARNING: /readyz did not answer - dependency readiness is unknown"
    return 0
  fi

  local verdict="unknown"
  case "$payload" in
    *'"status":"blocked"'*)  verdict="blocked" ;;
    *'"status":"degraded"'*) verdict="degraded" ;;
  esac

  local failing=""
  failing="$(readiness_failing_checks "$payload")" || failing=""
  log "WARNING: readiness is ${verdict}, not ready"
  if [ -n "$failing" ]; then
    log "  not passing:${failing}"
  fi
  log "  db structure is provisioned by db-init, not by this deploy"
}

# The deploy host is not guaranteed to have jq. The /readyz body is one line of
# JSON and every check object opens with its own status, so the not-passing
# names are readable positionally; empty output (no match) is the passing case.
readiness_failing_checks() {
  printf '%s' "$1" \
    | grep -oE '"[a-zA-Z]+":[{]"status":"(warn|fail)"' \
    | sed 's/^"/ /; s/":{"status":"/=/; s/"$//' \
    | tr -d '\n'
}

cmd_prune() {
  # Every deploy pushes/pulls a new immutable sha-<short> app image tag
  # (build.yml) - without cleanup these accumulate on the host disk forever.
  # `docker image prune -af` (not `-a` alone) removes only images with no
  # container referencing them - the currently-running tag is never a
  # candidate, so this is safe to run unconditionally after a verified deploy.
  docker image prune -af >/dev/null 2>&1 || true
  log "pruned unreferenced images"
}

cmd_all() {
  cmd_environment
  cmd_directories
  cmd_start
  cmd_verify
  cmd_prune
}

case "${1:-}" in
  all)         cmd_all ;;
  environment) cmd_environment ;;
  directories) cmd_directories ;;
  start)       cmd_start ;;
  verify)      cmd_verify ;;
  prune)       cmd_prune ;;
  *) echo "usage: bash deploy.sh {all|environment|directories|start|verify|prune}"; exit 1 ;;
esac
