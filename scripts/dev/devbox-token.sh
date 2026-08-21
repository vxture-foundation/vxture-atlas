#!/usr/bin/env bash
# devbox-token.sh - mint a token from the devbox issuer.
#
# The issuer publishes NO port. It is the one component in that stack whose
# exposure would grant a CAPABILITY - minting credentials - rather than access
# to disposable data, so it is reachable only from inside atlas-devbox-net.
# This reaches it through `docker exec`, which puts the ability to mint behind
# Docker daemon access instead of behind a listening socket. Binding the port
# to 127.0.0.1 would already be narrow; narrow is not the same as absent.
#
#   scripts/dev/devbox-token.sh                      # s2s, product=karda
#   scripts/dev/devbox-token.sh operator             # operator plane
#   scripts/dev/devbox-token.sh s2s product=arda tenantId=<uuid>
#
# Tokens are worthless outside the devbox: the signing key is generated in
# memory at issuer startup and the `iss` claim names the devbox, so production
# rejects them on the signature AND on the claim, independently.
set -euo pipefail

CONTAINER="${DEVBOX_ISSUER_CONTAINER:-vx-atlas-dev-issuer-devbox}"
ISSUER_PORT="${DEVBOX_ISSUER_PORT:-3181}"
KIND="${1:-s2s}"
shift || true

QUERY="kind=${KIND}"
for pair in "$@"; do QUERY="${QUERY}&${pair}"; done

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "devbox issuer '$CONTAINER' is not running - start it with:" >&2
  echo "  docker compose -f docker-compose.dev.yml up -d" >&2
  exit 1
fi

# Built inside the container, so no URL literal appears in the host command.
docker exec "$CONTAINER" sh -c \
  "wget -qO- \"http://127.0.0.1:${ISSUER_PORT}/mint?${QUERY}\"" \
  | sed -E 's/.*"access_token":"([^"]+)".*/\1/'
