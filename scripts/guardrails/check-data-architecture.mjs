#!/usr/bin/env node
/**
 * check-data-architecture.mjs - DDL <-> Prisma lockstep guardrail.
 *
 * The DDL under deploy/database/ddl/ is the single structure authority
 * (product_240 section 2.4 E); the Prisma schema is only a client-generation
 * source and MUST stay in lockstep. This asserts that the set of tables declared
 * in the baseline DDL (00_baseline.sql, which for Atlas covers the model /
 * key / reqlog / provisioning / audit schemas of its own physical database
 * vx_atlas_db - NOT the shared platform DB) equals the set
 * of Prisma models (matched by @@schema + @@map). Any drift fails under
 * --strict (CI).
 *
 * Pure node, zero dependencies.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DDL = "deploy/database/ddl/00_baseline.sql";
const INCR_DIR = "deploy/database/ddl/incr";
const LOCKS = "deploy/database/ddl/98_column_locks.sql";
const PRISMA = "service/prisma/schema.prisma";
const STRICT = process.argv.includes("--strict");

export function ddlTables(sql) {
  const set = new Set();
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\.(\w+)/gi;
  let m;
  while ((m = re.exec(sql))) set.add(`${m[1]}.${m[2]}`);
  return set;
}

export function prismaTables(text) {
  const set = new Set();
  const re = /model\s+\w+\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const schema = /@@schema\("([^"]+)"\)/.exec(body);
    const map = /@@map\("([^"]+)"\)/.exec(body);
    if (schema && map) set.add(`${schema[1]}.${map[1]}`);
  }
  return set;
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort();
}

/**
 * Line comments, removed before any structural parsing.
 *
 * Not cosmetic: the DDL's comments are prose, and prose contains parentheses
 * and commas ("(providers, models, endpoints, grants, price-rules, policies,").
 * Left in, they corrupt both the paren-depth scan and the top-level comma split
 * below, which would make column extraction quietly wrong rather than fail.
 */
function stripLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Split a CREATE TABLE body on commas that are not inside parentheses. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// Table-level items that are not columns. A CREATE TABLE body mixes both.
const NOT_A_COLUMN = /^(PRIMARY|CONSTRAINT|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)$/i;

/** Every (table, column) declared by a `CREATE TABLE` in the baseline. */
export function baselineTableColumns(rawSql) {
  const sql = stripLineComments(rawSql);
  const out = new Set();
  // `[\w.]+` deliberately fails on the `CREATE TABLE %I.%I PARTITION OF ...`
  // inside `ensure_partitions`' format() string - that is a runtime statement,
  // not a declaration, and its columns are inherited from the parent.
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([\w.]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1].toLowerCase();
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    for (const part of splitTopLevel(sql.slice(re.lastIndex, i - 1))) {
      const first = part.trim().split(/\s+/)[0];
      if (first && !NOT_A_COLUMN.test(first)) out.add(`${table}.${first.toLowerCase()}`);
    }
  }
  return out;
}

/**
 * Every (table, column) the Prisma schema declares, by PHYSICAL name.
 *
 * Relation fields are excluded because they are not columns: a field whose
 * type is another declared model (`providerRef ModelProvider?`, `grants
 * ModelGrant[]`) exists only in the client. Scalar lists (`capabilities
 * String[]`) ARE columns and stay.
 */
export function prismaColumns(text) {
  const modelNames = new Set(
    [...text.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]),
  );
  const out = new Set();
  const re = /model\s+\w+\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const schema = /@@schema\("([^"]+)"\)/.exec(body);
    const map = /@@map\("([^"]+)"\)/.exec(body);
    if (!schema || !map) continue;
    const table = `${schema[1]}.${map[1]}`.toLowerCase();
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("@@") || trimmed.startsWith("//")) continue;
      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(trimmed);
      if (!field) continue;
      if (modelNames.has(field[2])) continue; // relation, not a column
      const columnMap = /@map\("([^"]+)"\)/.exec(trimmed);
      out.add(`${table}.${(columnMap ? columnMap[1] : field[1]).toLowerCase()}`);
    }
  }
  return out;
}

/**
 * Columns added by an `incr/*.sql` migration - i.e. columns that do NOT exist
 * on a database provisioned before that migration.
 */
export function incrementallyAddedColumns(sources) {
  const set = new Set();
  // Table-qualified: the same column name on two different tables is not a
  // conflict, and treating it as one made this check fire on a legitimate
  // baseline index (product_code exists on reqlog.request_records via incr/05
  // AND on model.product_endpoint_grants, created whole in the baseline).
  const stmt = /ALTER TABLE\s+([\w.]+)([\s\S]*?);/gi;
  const col = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)/gi;
  for (const sql of sources) {
    let m;
    while ((m = stmt.exec(sql))) {
      const table = m[1].toLowerCase();
      let c;
      col.lastIndex = 0;
      while ((c = col.exec(m[2]))) set.add(`${table}.${c[1].toLowerCase()}`);
    }
  }
  return set;
}

/** Every (table, column) pair a baseline `CREATE INDEX` touches. */
export function baselineIndexedColumns(sql) {
  const found = [];
  const re = /CREATE INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)[\s\S]*?ON\s+([\w.]+)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(sql))) {
    for (const raw of m[3].split(",")) {
      const column = raw.trim().split(/\s+/)[0]?.toLowerCase();
      if (column) found.push({ index: m[1], table: m[2].toLowerCase(), column });
    }
  }
  return found;
}

/** Every (table, column) a `GRANT UPDATE (...)` in the column-lock file names. */
export function columnLockGrantedColumns(sql) {
  const found = [];
  // `\s` already spans the newline these grants usually wrap on.
  const re = /GRANT\s+UPDATE\s*\(([^)]*)\)\s*ON\s+([\w.]+)/gi;
  let m;
  while ((m = re.exec(sql))) {
    for (const raw of m[1].split(",")) {
      const column = raw.trim().toLowerCase();
      if (column) found.push({ table: m[2].toLowerCase(), column });
    }
  }
  return found;
}

/**
 * Same ordering trap as the baseline index below, one file over.
 *
 * db-init applies 00_baseline, then 97_service_role, then 98_column_locks,
 * and only THEN incr/. So a column-level GRANT in 98 that names a column an
 * incr/ migration adds aborts the whole apply on any already-provisioned
 * database - which is exactly how the v0.8.0 db-init failed on
 * `gateway_api_keys.expires_at`.
 *
 * The grant belongs with the ALTER TABLE that creates its column. Nothing is
 * lost by that: db-init's own column-lock assertion parses incr/ as well as
 * this file.
 */
export function prematureColumnLockGrants(lockSql, incrSources) {
  const added = incrementallyAddedColumns(incrSources);
  return columnLockGrantedColumns(lockSql)
    .filter(({ table, column }) => added.has(`${table}.${column}`))
    .map(({ table, column }) => `${table}."${column}"`);
}

/**
 * The baseline must not index a column that only an `incr/` migration adds.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an already-provisioned
 * database, so the column is absent when the baseline runs - and db-init runs
 * the baseline BEFORE incr/. The index statement then aborts the whole apply
 * before the migration that would have added the column ever executes.
 *
 * This is not hypothetical twice over: it was found once with
 * `idx_model_grants_task_profile` (incr/01) and reintroduced with
 * `idx_request_records_endpoint_code` (incr/03), which failed a real
 * production db-init. Both times the fix is the same - the index belongs in
 * the incr/ file next to its ADD COLUMN, which is correct for a fresh install
 * and an existing one alike.
 */
export function prematureBaselineIndexes(baselineSql, incrSources) {
  const added = incrementallyAddedColumns(incrSources);
  return baselineIndexedColumns(baselineSql)
    .filter(({ table, column }) => added.has(`${table}.${column}`))
    .map(({ index, table, column }) => `${index} (indexes ${table}."${column}")`);
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let ddl, prisma, baselineSql, prismaText, incrSources;
  try {
    baselineSql = readFileSync(DDL, "utf8");
    prismaText = readFileSync(PRISMA, "utf8");
    ddl = ddlTables(baselineSql);
    prisma = prismaTables(prismaText);
    try {
      incrSources = readdirSync(INCR_DIR)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => readFileSync(`${INCR_DIR}/${f}`, "utf8"));
    } catch {
      incrSources = [];
    }
  } catch (e) {
    console.log(`[data-architecture] skip: ${e.message}`);
    process.exit(0);
  }

  let premature = [];
  try {
    const incr = readdirSync(INCR_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(`${INCR_DIR}/${f}`, "utf8"));
    premature = prematureBaselineIndexes(readFileSync(DDL, "utf8"), incr);
  } catch {
    // No incr/ directory yet - nothing to cross-check.
  }

  let prematureGrants = [];
  try {
    const incr = readdirSync(INCR_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(`${INCR_DIR}/${f}`, "utf8"));
    prematureGrants = prematureColumnLockGrants(
      readFileSync(LOCKS, "utf8"),
      incr,
    );
  } catch {
    // No column-lock file yet - nothing to cross-check.
  }

  if (prematureGrants.length > 0) {
    console.error(
      "[data-architecture] 98_column_locks.sql grants UPDATE on a column that only incr/ adds:",
    );
    for (const g of prematureGrants) console.error(`  ${g}`);
    console.error(
      "  98 runs BEFORE incr/, so this aborts db-init on every provisioned",
    );
    console.error(
      "  database. Move the GRANT into the incr/ file that adds the column -",
    );
    console.error(
      "  db-init's column-lock assertion reads incr/ too, so nothing is lost.",
    );
    process.exit(1);
  }

  if (premature.length > 0) {
    console.error(
      "[data-architecture] 00_baseline.sql indexes a column that only incr/ adds:",
    );
    for (const i of premature) console.error(`  ${i}`);
    console.error(
      "  CREATE TABLE IF NOT EXISTS is a no-op on an existing database, and baseline",
    );
    console.error(
      "  runs before incr/ - so this aborts db-init on every provisioned environment.",
    );
    console.error(
      "  Move the index into the incr/ file that adds the column.",
    );
    process.exit(1);
  }

  const onlyDdl = diff(ddl, prisma);
  const onlyPrisma = diff(prisma, ddl);

  // Columns, not just tables. Comparing table sets alone let a Prisma field
  // with no DDL column pass every check in CI - and that is the one drift that
  // fails SILENTLY in production rather than loudly: Prisma names the missing
  // column in its INSERT, Postgres answers 42703, and RequestLogService (and
  // AuditService) swallow write errors into a warning by design, so the request
  // returns 200 while nothing is recorded. `/healthz`, `/readyz` and
  // `deploy.sh verify` all stay green through it. Nothing else in the pipeline
  // can see this: CI has no database, and every reqlog/audit test mocks Prisma.
  const ddlCols = new Set([
    ...baselineTableColumns(baselineSql),
    ...incrementallyAddedColumns(incrSources),
  ]);
  const prismaCols = prismaColumns(prismaText);
  // Only compare columns on tables BOTH sides declare - a table-level drift is
  // reported above, and cascading it into per-column noise would bury it.
  const shared = new Set([...ddl].filter((t) => prisma.has(t)));
  const onTable = (c) => shared.has(c.slice(0, c.lastIndexOf(".")));
  // The two directions are NOT symmetric, and treating them as such would be
  // wrong rather than merely strict:
  //
  //   prisma-only  DANGEROUS. Prisma names the column in its INSERT, Postgres
  //                answers 42703, and the write is swallowed. Hard fail.
  //   ddl-only     SAFE, and deliberate here. `incr/12` narrowed the write
  //                surface of description_key / is_customer_visible /
  //                is_workforce_visible precisely BY leaving them out of the
  //                Prisma model, so the service cannot touch them even by
  //                accident. Failing on those would demand undoing that.
  //
  // So ddl-only is reported and not fatal. A column the service cannot write is
  // not a lockstep violation; a column it thinks it can write, and cannot, is.
  const colOnlyDdl = diff(ddlCols, prismaCols).filter(onTable);
  const colOnlyPrisma = diff(prismaCols, ddlCols).filter(onTable);

  if (
    onlyDdl.length === 0 &&
    onlyPrisma.length === 0 &&
    colOnlyPrisma.length === 0
  ) {
    console.log(
      `[data-architecture] OK - ${ddl.size} tables / ${prismaCols.size} mapped ` +
        `columns in lockstep, ${colOnlyDdl.length} DDL column(s) deliberately ` +
        "unmapped, no baseline index depends on an incr/ column.",
    );
    process.exit(0);
  }

  console.log("[data-architecture] DDL/prisma drift:");
  for (const t of onlyDdl) console.log(`  in DDL, missing from prisma: ${t}`);
  for (const t of onlyPrisma) console.log(`  in prisma, missing from DDL: ${t}`);
  for (const c of colOnlyPrisma) {
    console.log(
      `  column in prisma with no DDL column: ${c}\n` +
        "      Production would accept the request, swallow the INSERT error as a\n" +
        "      warning, and record nothing - /healthz, /readyz and deploy verify all\n" +
        "      stay green. Add the column in an incr/ file and apply db-init BEFORE\n" +
        "      the app image that writes it.",
    );
  }
  if (STRICT) {
    console.error("[data-architecture] STRICT: DDL and prisma must be in lockstep.");
    process.exit(1);
  }
  process.exit(0);
}
