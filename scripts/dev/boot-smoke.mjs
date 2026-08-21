#!/usr/bin/env node
/**
 * boot-smoke.mjs - boot the BUILT BUNDLE and prove it actually serves.
 *
 * Why this exists (TD-023): everything else in CI validates the source, not
 * the artifact. tsc typechecks, vitest runs against swc-transpiled modules
 * that construct classes directly, and `build` only proves esbuild exited 0.
 * None of them ever start `dist/main.cjs`.
 *
 * That gap shipped two distinct failures on 2026-08-05:
 *   1. `MetricsRegistry` was missing from AtlasModule.providers - the bundle
 *      could not boot AT ALL, and CI was green.
 *   2. Five controllers used type-only injection, which esbuild silently
 *      drops (see check-di-metadata.mjs) - the bundle booted and 500d on
 *      first use.
 *
 * This catches the first class directly (no boot, no pass) and the second
 * through /readyz, which exercises a real controller -> service -> repository
 * injection chain rather than just checking a route is registered.
 *
 * No database required: the Prisma driver adapter connects lazily, so /readyz
 * is EXPECTED to report degraded/blocked here. Degraded is fine. A 5xx, a
 * crash, or a process that never listens is not.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.SMOKE_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;

// Deliberately unreachable/dummy values: this asserts the app boots and
// serves WITHOUT external dependencies. Anything that needs a real database
// or IdP to start would be a regression in its own right.
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  DATABASE_URL: "postgresql://smoke:smoke@127.0.0.1:1/smoke",
  OIDC_ISSUER: "http://127.0.0.1:1",
  S2S_AUDIENCE: "atlas",
  ALLOW_INTERNAL_DIAGNOSTICS: "1",
};

const child = spawn(process.execPath, [path.join(root, "service/dist/main.cjs")], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  // Windows: SIGKILL on the child alone does not reliably reap it, and this
  // script ran often enough during development to leave a pile of orphaned
  // processes holding port 3100. detached puts the child in its own process
  // group so `stop()` below can take the whole group down on either platform.
  detached: process.platform !== "win32",
});

let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  try {
    if (process.platform === "win32") {
      // taskkill /T kills the process tree; /F skips the graceful path, which
      // a bundled Nest app does not need on the way out of a smoke test.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

// Cover the paths that skip `finally`: an uncaught throw, or the runner
// killing this script.
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

let exitedEarly = null;
child.on("exit", (code, signal) => {
  exitedEarly = signal ? `signal ${signal}` : `code ${code}`;
});

function fail(message) {
  console.log(`[boot-smoke] FAIL - ${message}`);
  if (log.trim()) {
    console.log("\n--- service output ---");
    console.log(log.trimEnd().split("\n").slice(-40).join("\n"));
  }
  stop();
  process.exit(1);
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitedEarly) {
      fail(`the bundle exited before it ever listened (${exitedEarly}) - this is the "cannot boot" class, exactly what TD-023 shipped once`);
    }
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`no response on ${BASE}/healthz within ${BOOT_TIMEOUT_MS / 1000}s`);
}

const checks = [];
try {
  const health = await waitForBoot();
  const healthBody = await health.json();
  if (healthBody.status !== "ok") fail(`/healthz returned status "${healthBody.status}"`);
  checks.push(`/healthz 200 (version ${healthBody.version}, stage ${healthBody.stage})`);

  // The real target. /readyz runs HealthController -> AtlasHealthService ->
  // ModelRegistryRepository: if any link in that chain were injected by type
  // alone, this is where the undefined would surface as a 500.
  const ready = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(15_000) });
  if (ready.status >= 500) {
    fail(`/readyz returned ${ready.status} - a 5xx here is the undefined-dependency signature, not a missing database (no DB is expected in this smoke)`);
  }
  const readyBody = await ready.json();
  if (!readyBody.checks || typeof readyBody.checks !== "object") {
    fail("/readyz did not return a checks object - the health service did not actually run");
  }
  checks.push(`/readyz ${ready.status} status=${readyBody.status} (${Object.keys(readyBody.checks).length} checks ran)`);

  // Guarded routes: a 401 proves the route is registered and its guard is
  // wired. It does NOT prove the handler's dependencies resolve - that is
  // what check-di-metadata.mjs covers statically. A 404 here means a
  // controller silently failed to register.
  for (const route of [
    "/capability/providers",
    "/capability/endpoints",
    "/capability/api-keys",
    "/capability/logs",
    "/capability/audit-logs",
    "/capability/product-grants",
    "/v1/models",
    "/tenancy/models",
  ]) {
    const res = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) fail(`${route} returned 404 - the controller did not register`);
    if (res.status >= 500) fail(`${route} returned ${res.status} before auth even ran`);
    checks.push(`${route} ${res.status}`);
  }
} finally {
  stop();
}

console.log("[boot-smoke] OK - the built bundle boots and serves:");
for (const c of checks) console.log(`  - ${c}`);
