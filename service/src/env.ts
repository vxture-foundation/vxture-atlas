import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Loads the operator .env at MODULE EVALUATION, not inside bootstrap(): this
// file must be main.ts's first side-effect import (after reflect-metadata),
// ahead of anything that transitively imports src/prisma.ts. Prisma 7's
// driver adapter captures process.env.DATABASE_URL when the client module
// evaluates. In containers the environment is set before the process
// starts and masks any ordering mistake; the documented host-run flow
// (`node service/dist/main.cjs` from the repo root, reading ./.env) is what
// breaks if this import slips below the prisma import.
function loadRootEnv(): void {
  const rootDir = resolve(process.cwd(), "..", "..", "..");
  const candidates = [
    join(rootDir, ".env.local"),
    join(rootDir, ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const separatorIndex = line.indexOf("=");
      if (separatorIndex < 0) continue;

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (!key || process.env[key] !== undefined) continue;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

/**
 * A container that dials 127.0.0.1 for its database is dialling ITSELF.
 *
 * `.env` carries the HOST-oriented URL (`@127.0.0.1:5432`) because host tools -
 * psql, the Prisma CLI, DDL verification - reach the database through the
 * dev-only `forwarder` container. But docker-compose.yml also interpolates
 * `.env` into `DATABASE_URL: ${DATABASE_URL:-}` for the app container, where
 * that host segment resolves to the app itself.
 *
 * The failure is quiet in the worst way: `/healthz` still answers `ok`, because
 * it does not touch the database. Only `/readyz` shows it, and only if someone
 * looks. This has cost time more than once - it is documented in
 * docs/50-deployment/00-index.md and it still happened again on 2026-08-17.
 *
 * So it fails at startup instead, where it is loud and unambiguous. Running on
 * the host is exempt: there 127.0.0.1 IS the forwarder, which is the whole
 * point of that address.
 */
function assertDatabaseUrlIsReachable(): void {
  const url = process.env["DATABASE_URL"];
  if (!url) return;

  // /.dockerenv exists in every container image; absent when run on the host.
  if (!existsSync("/.dockerenv")) return;

  const host = /:\/\/[^@]*@([^:/?]+)/.exec(url)?.[1];
  if (host !== "127.0.0.1" && host !== "localhost") return;

  throw new Error(
    `DATABASE_URL points at ${host}, which inside a container is this ` +
      `container, not the database. Use the compose service alias - ` +
      `@db:5432 - and override DATABASE_URL in the shell: compose ALSO reads ` +
      `./.env for interpolation, so an APP_ENV_FILE alone does not replace it.`,
  );
}

/**
 * The release tag is a fact about this DEPLOYMENT, not about the binary.
 *
 * `@vxture/shared`'s `serviceIdentity()` reads `process.env.APP_VERSION`, which
 * the image bakes at build time. That was fine while an image existed only
 * because a release tag was pushed. Once `build.yml` began building on PRs
 * (#245), a commit could be built under a branch ref first - which poisons the
 * `sha-<short>` dedup key, so the release build is skipped as "already built"
 * and the deployment inherits `APP_VERSION=dev`. v0.18.0 shipped exactly that,
 * and deploy.sh's `version=dev` warning named it correctly.
 *
 * So deploy.sh supplies `RELEASE_VERSION` from the tag it is deploying, and it
 * is promoted here. Under a SEPARATE name on purpose: compose always sets the
 * keys in its `environment:` map, so writing the override straight into
 * APP_VERSION would replace the baked value with an empty string whenever no
 * tag was on offer, with nothing left to fall back to.
 *
 * `gitSha` and `buildTime` stay baked - those really are properties of the
 * binary, and the same image can ship as v0.18.0 and re-ship as v0.18.1
 * without a byte changing.
 */
function promoteReleaseVersion(): void {
  const release = process.env["RELEASE_VERSION"];
  if (release) process.env["APP_VERSION"] = release;
}

loadRootEnv();
promoteReleaseVersion();
assertDatabaseUrlIsReachable();
