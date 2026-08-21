# Atlas service image - standalone build context (this repo only).
# Not the org's shared deploy/docker/Dockerfile.nestjs-prisma: the build
# context is this repo's root, and the only workspace package is `service`
# itself (see pnpm-workspace.yaml).
#
# The runtime stage is distroless: no shell, no package manager, no npm, no
# Debian userland - the OS surface is the node binary plus libc, and the
# container runs as the unprivileged `nonroot` user.
#
# The image ships ONE file of application code: dist/main.cjs. esbuild inlines
# every runtime dependency, including Prisma's wasm query compiler as base64,
# which is most of what makes the bundle 8.6MB. No node_modules, and no
# src/generated: this header claimed src/generated was a runtime dependency
# until 2026-08-17, and it was not. Verified rather than argued - the image
# booted with /app/src blanked to an empty tmpfs, mapped every route, and
# `prisma.modelDefinition.findMany()` reached the driver and failed on the
# CONNECTION rather than on a missing module. That copy was 53.5MB of a 293MB
# image, 40.4MB of it a Windows binary left by this repo's build workstation.
#
# The `--external` entries in the build script are therefore a runtime contract
# rather than a build detail: what is external is what must never be reached.
# Healthchecks exec /nodejs/bin/node explicitly (docker-compose*.yml,
# deploy.sh) - there is no wget and no shell in this image, by design.

FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY service/package.json ./service/package.json
# pnpm 11 ignores env-expanded credentials in the committed project .npmrc,
# so the secret is written to the build user's npmrc for the install and
# removed in the same layer (BuildKit secret: never persisted either way).
# `set -e` first: without it this RUN's exit status is `rm`'s, so an install
# that 401s still commits a layer holding the store but no link directories.
# The build stage then installs again, unauthenticated, and the image only
# comes out right when the store happens to be warm.
RUN --mount=type=secret,id=node_auth_token \
    set -e; \
    tok="$(cat /run/secrets/node_auth_token 2>/dev/null || true)"; \
    if [ -n "$tok" ]; then echo "//npm.pkg.github.com/:_authToken=$tok" >> /root/.npmrc; fi; \
    pnpm install --frozen-lockfile; \
    rm -f /root/.npmrc

FROM deps AS build
COPY service ./service
RUN pnpm --filter @atlas/service run db:generate
RUN pnpm --filter @atlas/service run build
# Staged symlink for the runtime image: distroless keeps node at
# /nodejs/bin/node, which is NOT on its PATH, while every pre-distroless image
# had /usr/local/bin/node. Shipping this link means "node" resolves via PATH
# in BOTH image generations, so the compose healthcheck and deploy.sh verify
# stay valid across a rollback boundary.
RUN mkdir -p /staged-bin && ln -s /nodejs/bin/node /staged-bin/node

# debian13 (trixie), not debian12: bookworm's libc6/libssl3 lag their fixed
# versions, so the bookworm variant carries a CRITICAL and five HIGH CVEs that
# have upstream fixes it has not picked up. Trixie's remaining findings have no
# upstream fix - i.e. it is the current floor, not a lag. Safe to switch: the
# only native dependency is node itself (Prisma 7 uses the WASM query compiler
# under the driver adapter, so there is no engine binary with a glibc ABI).
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Build provenance (standard 025 section 4.1). build.yml already passes these
# four as build-args; without the ARG declarations here Docker silently drops
# them and the health identity block falls back to dev/unknown - which is
# exactly the "nobody knows which build is live" failure mode standard 025
# exists to prevent. Defaults stay honest so a plain `docker build` still works.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
# These three describe WHAT THIS BINARY IS, so baking them in is right: the
# image and its provenance travel together and cannot disagree.
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

# DEPLOY_STAGE is deliberately NOT baked. It describes WHERE THIS CONTAINER
# IS RUNNING, which is a runtime fact, and one image runs in several places:
# the same v0.17.0 that serves production is what a developer pulls to
# reproduce a bug locally.
#
# It used to be an ARG+ENV like the three above, with the release build
# setting it to `production`. The result was that running the production
# image ANYWHERE - a laptop, a val stack - produced a health endpoint
# reporting "stage":"production", and deploy.sh's identity check reads that
# field. An environment cannot be a property of the artifact.
#
# The honest default is `dev`: a container nobody told where it is running
# is not production. docker-compose.yml passes the real value at RUN time.
ENV DEPLOY_STAGE=dev
COPY --from=build /app/service/dist ./dist
# Directory copy, not file copy: BuildKit dereferences a single-file symlink
# source (dangling here, since /nodejs only exists in THIS stage), but
# preserves symlinks inside a copied directory tree.
COPY --from=build /staged-bin/ /usr/local/bin/
EXPOSE 3100
# Distroless entrypoint is /nodejs/bin/node; CMD supplies only the script.
CMD ["dist/main.cjs"]
