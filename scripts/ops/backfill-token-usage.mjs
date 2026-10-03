#!/usr/bin/env node
/**
 * backfill-token-usage.mjs - replay served-but-never-recorded reqlog rows to
 * the platform as raw token facts (ADR-010; vxture-platform ADR-013 D7;
 * workplan E5).
 *
 * Why it exists: from 2026-09-23 (atlas left the platform's product catalog)
 * until the per-caller token report shipped, every C3 report Atlas sent was
 * refused, so the platform's ledger has none of the inference it served
 * (TD-056). Each of those calls still has a `reqlog.request_records` row with
 * its token splits, its `request_id` and the product that called.
 *
 * What it sends: one `POST /usage/consume` per row, in the token shape, with
 * `backfill: true`. The platform records the fact and deducts nothing
 * (`credit_skip_reason = pre_cutover`, owner 2026-10-03). The report is
 * idempotent on (workspace, product, request_id, attempt_index), so running
 * it twice sends the same rows and the platform answers with the row it has.
 *
 * What it cannot send: a rerank row's candidate count. `billed_amount` was
 * written only when the platform accepted the report, so refused rerank rows
 * carry no pool size anywhere; they go out with their upstream token usage
 * when the vendor reported one, and are counted as skipped otherwise. Parse
 * pages are recoverable from `input_image_count`.
 *
 * Nothing is written back to reqlog: `request_records` is append-only by
 * design (`98_column_locks.sql`), and a backfilled row has no deduction event
 * to echo. Correlation is by `request_id` on both sides.
 *
 * Usage:
 *   node scripts/ops/backfill-token-usage.mjs --before <ISO> [--since <ISO>] [--limit N] [--concurrency N] [--apply]
 *
 *   --before   required: only rows that started before this instant - the
 *              moment the per-caller report went live, so a live report and a
 *              backfill never race for the same row
 *   --since    default 2026-07-28T00:00:00Z (the first reqlog row)
 *   --limit    default 5000 rows per run; re-run to continue
 *   --apply    actually send; without it the run only classifies and prints
 *
 * Env: DATABASE_URL (Atlas), PLATFORM_API_URL, PLATFORM_INTERNAL_AUTH_TOKEN -
 * the same three the service reads; `.env` in the repo root is loaded if
 * present (values already in the environment win).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvFile(name) {
  let text;
  try {
    text = readFileSync(path.join(root, name), "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(i + 1).trim();
  }
}
loadEnvFile(".env");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return v;
}
const apply = process.argv.includes("--apply");
const beforeRaw = arg("--before", undefined);
if (!beforeRaw) {
  console.error("--before <ISO> is required: the instant the per-caller report went live");
  process.exit(2);
}
const before = new Date(beforeRaw);
const since = new Date(arg("--since", "2026-07-28T00:00:00Z"));
const limit = Number(arg("--limit", "5000"));
const concurrency = Number(arg("--concurrency", "4"));
for (const [label, d] of [["--before", before], ["--since", since]]) {
  if (Number.isNaN(d.getTime())) {
    console.error(`${label} is not a date`);
    process.exit(2);
  }
}
if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error("--limit and --concurrency must be positive integers");
  process.exit(2);
}

const base = (process.env.PLATFORM_API_URL ?? "").replace(/\/+$/, "");
const token = process.env.PLATFORM_INTERNAL_AUTH_TOKEN ?? "";
if (apply && (!base || !token)) {
  console.error("PLATFORM_API_URL and PLATFORM_INTERNAL_AUTH_TOKEN are required with --apply");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set - .env missing or not loaded?");
  process.exit(2);
}

const { PrismaClient } = await import(
  pathToFileURL(path.join(root, "service/src/generated/prisma/index.js")).href
);
const { PrismaPg } = await import(
  pathToFileURL(path.join(root, "service/node_modules/@prisma/adapter-pg/dist/index.js")).href
);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Served, attributable, and never recorded by the platform. `started_at` is
// NULL on rows before incr/05; created_at is the same instant to the second.
const rows = await prisma.$queryRawUnsafe(
  `select id, request_id, attempt_index, workspace_id, product_code, model_code, provider_code,
          input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_tokens,
          billed_metric_key, input_image_count, vector_count,
          coalesce(started_at, created_at) as occurred_at
     from reqlog.request_records
    where status = 'success'
      and usage_event_id is null
      and workspace_id is not null
      and product_code is not null
      and coalesce(started_at, created_at) >= $1
      and coalesce(started_at, created_at) <  $2
    order by coalesce(started_at, created_at), id
    limit $3`,
  since,
  before,
  limit,
);

const n = (v) => (v === null || v === undefined ? undefined : Number(v));

/** The platform wants the four input/output dimensions non-overlapping. */
function toReport(row) {
  const prompt = n(row.input_tokens);
  const completion = n(row.output_tokens);
  const cacheRead = Math.max(0, n(row.cached_input_tokens) ?? 0);
  const cacheWrite = Math.max(0, n(row.cache_write_input_tokens) ?? 0);
  const tokens = {
    input: Math.max(0, (prompt ?? 0) - cacheRead - cacheWrite),
    output: Math.max(0, completion ?? 0),
    cache_write: cacheWrite,
    cache_read: cacheRead,
  };
  const metric = row.billed_metric_key ?? "";
  const isParse = metric === "atlas.parse" || (metric === "" && row.input_image_count !== null && row.vector_count === null);
  const parsePages = isParse ? n(row.input_image_count) : undefined;
  const total = tokens.input + tokens.output + tokens.cache_write + tokens.cache_read;
  if (total <= 0 && !(parsePages > 0)) return { skip: "no_amount" };
  const body = {
    workspace_id: row.workspace_id,
    product: row.product_code,
    request_id: row.request_id,
    attempt_index: row.attempt_index ?? 0,
    outcome: "served",
    occurred_at: new Date(row.occurred_at).toISOString(),
    ...(row.model_code ? { model_code: row.model_code } : {}),
    ...(row.provider_code ? { provider_code: row.provider_code } : {}),
    tokens,
    ...(n(row.reasoning_tokens) !== undefined ? { reasoning_tokens: n(row.reasoning_tokens) } : {}),
    ...(parsePages > 0 ? { parse_pages: parsePages } : {}),
    backfill: true,
  };
  return { body };
}

async function send(body) {
  const res = await fetch(`${base}/usage/consume`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vxture-internal-auth": token },
    body: JSON.stringify(body),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    // unreadable body: the status is the answer
  }
  if (!res.ok) {
    const word = typeof json.message === "string" ? json.message : `http_${res.status}`;
    return { outcome: "rejected", reason: word };
  }
  return {
    outcome: "recorded",
    reason: typeof json.credit_skip_reason === "string" ? json.credit_skip_reason : "deducted",
  };
}

const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
const byProduct = new Map();

let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    const { skip, body } = toReport(row);
    if (skip) {
      bump(`skipped:${skip}`);
      continue;
    }
    byProduct.set(body.product, (byProduct.get(body.product) ?? 0) + 1);
    if (!apply) {
      bump("would_send");
      continue;
    }
    try {
      const r = await send(body);
      bump(`${r.outcome}:${r.reason}`);
    } catch (error) {
      bump(`failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
await prisma.$disconnect();

console.log(
  `[backfill] ${apply ? "APPLIED" : "DRY RUN"} rows=${rows.length} since=${since.toISOString()} before=${before.toISOString()} limit=${limit}`,
);
for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k.padEnd(40)} ${v}`);
console.log("[backfill] by product:");
for (const [k, v] of [...byProduct.entries()].sort()) console.log(`  ${k.padEnd(40)} ${v}`);
if (rows.length === limit) {
  console.log(`[backfill] limit reached - run again with the same arguments to continue`);
}
