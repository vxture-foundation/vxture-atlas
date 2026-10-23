#!/usr/bin/env node
/**
 * readiness-startup.mjs - measure cold connection and parallel readiness reads.
 * @package @atlas/service
 * @layer Infrastructure
 * @category diagnostics
 * @author AI-Generated
 * @date 2026-10-23
 *
 * Run from the repository root with PROBE_DATABASE_URL pointing at a local
 * throwaway database with Atlas DDL. No .env or provider credentials are read.
 * Reports timings only: no SQL, parameters, rows, connection URLs or secrets.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

// Configuration and dependency resolution.
const databaseUrl = process.env.PROBE_DATABASE_URL;
assert(databaseUrl, "PROBE_DATABASE_URL is required; no implicit .env loading");
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname),
  "Use a local throwaway PostgreSQL database");
process.env.DATABASE_URL = databaseUrl;
const serviceRequire = createRequire(resolve("service/package.json"));
const adapterRequire = createRequire(serviceRequire.resolve("@prisma/adapter-pg"));
const pg = adapterRequire("pg");
const { build } = serviceRequire("esbuild");
const artifactDir = resolve("service/.artifacts");
await mkdir(artifactDir, { recursive: true });
const outfile = resolve(artifactDir, `readiness-startup-${process.pid}.cjs`);

// Hook only this diagnostic process, preserving pg's callback and Promise APIs.
const connections = new WeakMap();
let connectionCount = 0;
function connection(client) {
  if (!connections.has(client)) connections.set(client, { id: ++connectionCount, queries: 0 });
  return connections.get(client);
}
function timed(original, kind) {
  return function (...args) {
    const state = connection(this);
    const query = kind === "query" ? ++state.queries : undefined;
    const startedAt = performance.now();
    let logged = false;
    const report = (error) => {
      if (logged) return;
      logged = true;
      console.log(JSON.stringify({ kind, connection: state.id, query,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
        outcome: error ? "error" : "ok" }));
    };
    const callback = args.at(-1);
    if (typeof callback === "function") {
      args[args.length - 1] = function (error, ...values) {
        report(error);
        return callback.call(this, error, ...values);
      };
    }
    try {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then((value) => { report(); return value; }, (error) => { report(error); throw error; });
      }
      return result;
    } catch (error) {
      report(error);
      throw error;
    }
  };
}
const originalConnect = pg.Client.prototype.connect;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.connect = timed(originalConnect, "connect");
pg.Client.prototype.query = timed(originalQuery, "query");

// Bundle the actual repository, health service and startup restore readers.
// External dependencies resolve from service/, sharing this instrumented pg.
let probe;
try {
  await build({
    stdin: { contents: `
      export { prisma } from './service/src/prisma';
      export { ModelRegistryRepository } from './service/src/registry/model-registry.repository';
      export { ProviderKeyRepository } from './service/src/provider-keys/provider-key.repository';
      export { AtlasHealthService } from './service/src/runtime/health.service';
      export { PrismaHealthStore } from './service/src/health/health.store';
    `, resolveDir: process.cwd(), loader: "ts" },
    outfile, bundle: true, platform: "node", format: "cjs", target: "node24",
    packages: "external", tsconfig: "service/tsconfig.json", logLevel: "silent",
  });
  probe = serviceRequire(outfile);
  await probe.prisma.$connect();
  const service = new probe.AtlasHealthService(new probe.ModelRegistryRepository(), new probe.ProviderKeyRepository());
  const store = new probe.PrismaHealthStore();
  const measure = async (name, run) => {
    const start = performance.now();
    const result = await run();
    console.log(JSON.stringify({ phase: name, elapsedMs: Math.round(performance.now() - start),
      ...(result?.checks ? { checks: Object.fromEntries(Object.entries(result.checks)
        .map(([key, value]) => [key, { status: value.status, latencyMs: value.latencyMs }])) } : {}) }));
  };
  await Promise.all([
    measure("restore-models-routes", () => store.load()),
    measure("restore-atlas", () => store.loadAtlas()),
    measure("cold-readiness", () => service.ready()),
  ]);
  await measure("warm-readiness", () => service.ready());
} finally {
  await probe?.prisma.$disconnect();
  pg.Client.prototype.connect = originalConnect;
  pg.Client.prototype.query = originalQuery;
  await rm(outfile, { force: true });
}
