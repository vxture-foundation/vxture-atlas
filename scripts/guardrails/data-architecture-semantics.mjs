/**
 * Compare ORM declarations with PostgreSQL's interpretation of ordered DDL.
 * @package vxture-atlas
 * @layer Infrastructure
 * @category guardrail
 * @author AI-Generated
 * @date 2026-10-21
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// A deliberately bounded Prisma reader; unknown syntax is a failure, not a skip.
// PostgreSQL itself parses all SQL, including DO blocks and incremental changes.
// ============================================================================

const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const literal = (s) => `'${s.replaceAll("'", "''")}'`;
const qualified = (m) => `${quote(m.schema)}.${quote(m.table)}`;
const TYPES = {
  String: "text",
  Boolean: "boolean",
  Int: "integer",
  BigInt: "bigint",
  Float: "double precision",
  Decimal: "decimal(65,30)",
  DateTime: "timestamp(3)",
  Json: "jsonb",
  Bytes: "bytea",
};
const NATIVE = {
  Text: "text",
  Uuid: "uuid",
  JsonB: "jsonb",
  Json: "json",
  SmallInt: "smallint",
  Integer: "integer",
  BigInt: "bigint",
  DoublePrecision: "double precision",
  Real: "real",
  Boolean: "boolean",
  Date: "date",
  ByteA: "bytea",
  VarChar: "varchar",
  Char: "char",
  Decimal: "decimal",
  Timestamp: "timestamp",
  Timestamptz: "timestamptz",
  Time: "time",
  Timetz: "timetz",
};

/** Split lists without corrupting quoted strings or nested expressions. */
export function splitList(text) {
  const out = [];
  let start = 0,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) throw new Error("Unbalanced Prisma expression");
  }
  if (quoted || depth !== 0) throw new Error("Incomplete Prisma expression");
  if (text.slice(start).trim()) out.push(text.slice(start).trim());
  return out;
}

function attributes(text) {
  const attrs = [];
  while (text.trim()) {
    text = text.trim();
    const m = /^(@@?[\w.]+)(?:\s*\()?/.exec(text);
    if (!m) throw new Error(`Unsupported Prisma declaration: ${text}`);
    let end = m[0].length,
      value = null;
    if (m[0].endsWith("(")) {
      let depth = 1,
        quoted = false,
        escaped = false,
        i = end;
      for (; i < text.length && depth; i++) {
        const ch = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth || quoted) throw new Error(`Incomplete attribute: ${text}`);
      value = text.slice(end, i - 1);
      end = i;
    }
    attrs.push({ name: m[1], value });
    text = text.slice(end);
  }
  return attrs;
}

const attr = (attrs, name) => attrs.find((a) => a.name === name);
const stringAttr = (attrs, name, fallback) => {
  const a = attr(attrs, name);
  return a ? JSON.parse(a.value) : fallback;
};
function stripComments(text) {
  // Prisma comments are not SQL. Quoted URLs and // inside defaults survive.
  return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (s) =>
    s.startsWith('"') ? s : s.replace(/[^\n]/g, " "),
  );
}

export function parsePrisma(source) {
  const text = stripComments(source);
  const models = [];
  // Braces inside strings (JSON defaults) cannot delimit a model.
  const masked = text.replace(/"(?:\\.|[^"\\])*"/g, (s) =>
    s.replace(/[{}]/g, " "),
  );
  const blocks = /\b(model|datasource|generator)\s+(\w+)\s*\{([^{}]*)\}/g;
  let m;
  let covered = "";
  let position = 0;
  while ((m = blocks.exec(masked))) {
    covered += masked.slice(position, m.index);
    position = blocks.lastIndex;
    if (m[1] !== "model") continue;
    const bodyStart = masked.indexOf("{", m.index) + 1;
    const body = text.slice(bodyStart, blocks.lastIndex - 1);
    const model = {
      name: m[2],
      schema: "public",
      table: m[2],
      fields: [],
      indexes: [],
      attrs: [],
    };
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("@@")) {
        model.attrs.push(...attributes(line));
        continue;
      }
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f) throw new Error(`${model.name}: unsupported field: ${line}`);
      const attrs = attributes(f[5]);
      model.fields.push({
        name: f[1],
        column: stringAttr(attrs, "@map", f[1]),
        type: f[2],
        list: Boolean(f[3]),
        nullable: Boolean(f[4]),
        attrs,
      });
    }
    model.schema = stringAttr(model.attrs, "@@schema", "public");
    model.table = stringAttr(model.attrs, "@@map", model.name);
    for (const a of model.attrs)
      if (
        !["@@schema", "@@map", "@@id", "@@index", "@@unique"].includes(a.name)
      )
        throw new Error(`${model.name}: unsupported ${a.name}`);
    models.push(model);
  }
  covered += masked.slice(position);
  if (covered.trim() || !models.length)
    throw new Error("Unparsed Prisma blocks or empty model set");
  const names = new Set(models.map((model) => model.name));
  const physical = new Set();
  for (const model of models) {
    const key = `${model.schema}.${model.table}`;
    if (physical.has(key)) throw new Error(`Duplicate physical model ${key}`);
    physical.add(key);
    for (const field of model.fields) {
      field.relation = names.has(field.type);
      if (!field.relation && !TYPES[field.type])
        throw new Error(
          `${key}.${field.column}: unsupported type ${field.type}`,
        );
      for (const a of field.attrs)
        if (
          !a.name.startsWith("@db.") &&
          ![
            "@map",
            "@id",
            "@unique",
            "@default",
            "@updatedAt",
            "@relation",
          ].includes(a.name)
        )
          throw new Error(`${key}.${field.column}: unsupported ${a.name}`);
      if (field.relation && field.attrs.some((a) => a.name !== "@relation"))
        throw new Error(
          `${key}.${field.column}: unsupported relation attribute`,
        );
    }
  }
  return models;
}

function sqlType(field) {
  const native = field.attrs.filter((a) => a.name.startsWith("@db."));
  if (native.length > 1) throw new Error("Multiple native types");
  let type = TYPES[field.type];
  if (native.length) {
    const a = native[0];
    type = NATIVE[a.name.slice(4)];
    if (!type || (a.value !== null && !/^\d+(?:\s*,\s*\d+)?$/.test(a.value)))
      throw new Error(`Unsupported native type ${a.name}`);
    if (a.value !== null) type += `(${a.value})`;
  }
  return type + (field.list ? "[]" : "");
}

function databaseDefault(field) {
  const a = attr(field.attrs, "@default");
  if (!a) return null;
  const value = a.value.trim();
  if (/^(uuid|cuid|ulid|nanoid)\((?:\d+)?\)$/.test(value)) return null;
  if (value === "now()") return "CURRENT_TIMESTAMP";
  const generated = /^dbgenerated\(("(?:\\.|[^"\\])*")\)$/.exec(value);
  if (generated) return JSON.parse(generated[1]);
  if (/^-?\d+(?:\.\d+)?$|^(true|false)$/.test(value)) return value;
  if (value.startsWith('"')) return literal(JSON.parse(value));
  if (value === "[]" && field.list) return `ARRAY[]::${sqlType(field)}`;
  throw new Error(`Unsupported default ${field.name}: ${value}`);
}

function indexFields(model, value) {
  const m = /^\[([\s\S]*)\]$/.exec(value);
  if (!m) throw new Error(`Unsupported index fields: ${value}`);
  return splitList(m[1])
    .map((entry) => {
      const f = /^(\w+)(?:\(sort:\s*(Asc|Desc)\))?$/.exec(entry);
      const field =
        f &&
        model.fields.find(
          (candidate) => candidate.name === f[1] && !candidate.relation,
        );
      if (!field)
        throw new Error(
          `Unknown/unsupported indexed field ${model.name}.${entry}`,
        );
      return quote(field.column) + (f[2] === "Desc" ? " DESC" : "");
    })
    .join(", ");
}

/** Generate only a disposable reference; never a deployable migration. */
export function referenceSql(models) {
  const sql = [...new Set(models.map((m) => m.schema))].map(
    (s) => `CREATE SCHEMA IF NOT EXISTS ${quote(s)};`,
  );
  const extras = [];
  let counter = 0;
  for (const model of models) {
    const columns = [];
    for (const f of model.fields.filter((f) => !f.relation)) {
      const def = databaseDefault(f);
      columns.push(
        `${quote(f.column)} ${sqlType(f)}${f.nullable ? "" : " NOT NULL"}${def === null ? "" : ` DEFAULT ${def}`}`,
      );
      for (const a of f.attrs.filter((a) =>
        ["@id", "@unique"].includes(a.name),
      )) {
        if (a.value && !/^map:\s*"[^"]+"$/.test(a.value))
          throw new Error(`Unsupported ${a.name} options`);
        columns.push(
          `${a.name === "@id" ? "PRIMARY KEY" : "UNIQUE"} (${quote(f.column)})`,
        );
      }
    }
    for (const a of model.attrs.filter((a) =>
      ["@@id", "@@unique", "@@index"].includes(a.name),
    )) {
      const parts = splitList(a.value);
      const fields = indexFields(model, parts.shift());
      let method = "btree";
      for (const option of parts) {
        if (/^map:\s*"[^"]+"$/.test(option)) continue;
        const type = /^type:\s*(BTree|Gin|Hash|Gist|SpGist|Brin)$/.exec(option);
        if (!type) throw new Error(`Unsupported index option ${option}`);
        method = type[1].toLowerCase();
      }
      if (a.name === "@@id") columns.push(`PRIMARY KEY (${fields})`);
      else
        extras.push(
          `CREATE ${a.name === "@@unique" ? "UNIQUE " : ""}INDEX ${quote(`guard_ref_${counter++}`)} ON ${qualified(model)} USING ${method} (${fields});`,
        );
    }
    sql.push(`CREATE TABLE ${qualified(model)} (${columns.join(",\n")});`);
    for (const f of model.fields.filter((f) => f.relation)) {
      const relation = attr(f.attrs, "@relation");
      if (!relation) continue;
      const parts = splitList(relation.value);
      const options = new Map();
      for (const part of parts) {
        if (/^"/.test(part)) {
          JSON.parse(part);
          continue;
        }
        const kv = /^(fields|references|onDelete|onUpdate|map):\s*(.*)$/.exec(
          part,
        );
        if (!kv) throw new Error(`Unsupported relation ${part}`);
        options.set(kv[1], kv[2]);
      }
      if (!options.has("fields")) {
        if (options.has("references")) throw new Error("Incomplete relation");
        continue;
      }
      const target = models.find((m) => m.name === f.type);
      const local = indexFields(model, options.get("fields"));
      const remote = indexFields(target, options.get("references"));
      const action = (value) => {
        const result = {
          Cascade: "CASCADE",
          Restrict: "RESTRICT",
          NoAction: "NO ACTION",
          SetNull: "SET NULL",
          SetDefault: "SET DEFAULT",
        }[value];
        if (!result) throw new Error(`Unknown FK action ${value}`);
        return result;
      };
      extras.push(
        `ALTER TABLE ${qualified(model)} ADD FOREIGN KEY (${local}) REFERENCES ${qualified(target)} (${remote}) ON DELETE ${action(options.get("onDelete") ?? (f.nullable ? "SetNull" : "Restrict"))} ON UPDATE ${action(options.get("onUpdate") ?? "Cascade")};`,
      );
    }
  }
  return [...sql, ...extras].join("\n");
}

// ============================================================================
// PostgreSQL catalog comparison. Names of equivalent indexes are not semantics.
// ============================================================================

export const SNAPSHOT_SQL = `
WITH tables AS (
 SELECT c.oid,n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
), cols AS (
 SELECT t.schema||'.'||t.name||'.'||a.attname AS key,format_type(a.atttypid,a.atttypmod) AS type,
 a.attndims AS dimensions,NOT a.attnotnull AS nullable,pg_get_expr(d.adbin,d.adrelid) AS "default",a.attidentity AS identity,a.attgenerated AS generated
 FROM tables t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
), idx AS (
 SELECT t.schema||'.'||t.name AS "table",i.indisunique AS "unique",i.indisprimary AS "primary",am.amname AS method,
 ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) k) AS keys,
 pg_get_expr(i.indpred,i.indrelid) AS predicate,i.indisvalid AS valid,i.indnullsnotdistinct AS "nullsNotDistinct",
 ARRAY(SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY u(n,k) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.n WHERE u.k>i.indnkeyatts ORDER BY u.k) AS include
 FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
), fk AS (
 SELECT t.schema||'.'||t.name AS "table",pg_get_constraintdef(c.oid) AS definition
 FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid AND c.contype='f'
)
SELECT json_build_object('columns',COALESCE((SELECT json_agg(cols ORDER BY key) FROM cols),'[]'),
'indexes',COALESCE((SELECT json_agg(idx) FROM idx),'[]'),'foreignKeys',COALESCE((SELECT json_agg(fk) FROM fk),'[]'),
'checks',(SELECT count(*) FROM pg_constraint c JOIN tables t ON t.oid=c.conrelid WHERE c.contype='c'));
`;

const canonicalDefault = (v) =>
  v
    ?.replace(/CURRENT_TIMESTAMP(?:\(\))?/gi, "now()")
    .replace(/ARRAY\[\]::/g, "'{}'::") ?? null;
const canonicalType = (type) =>
  type
    .replace(/^timestamp(?= with(?:out)? time zone)/, "timestamp(6)")
    .replace(/^time(?= with(?:out)? time zone)/, "time(6)");
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, ordered(v)]),
        )
      : value;
const keyOf = (object) => JSON.stringify(ordered(object));

export function compareSnapshots(actual, expected, policy = {}) {
  const errors = [],
    notes = [],
    used = new Set();
  const allow = (kind, object, ddl, orm) => {
    const entry = policy[kind]?.[object];
    if (
      !entry ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 15 ||
      keyOf(entry.ddl) !== keyOf(ddl) ||
      keyOf(entry.orm) !== keyOf(orm)
    )
      return false;
    used.add(`${kind}:${object}`);
    notes.push(`${kind} ${object}: ${entry.reason}`);
    return true;
  };
  const actualCols = new Map(actual.columns.map((c) => [c.key, c]));
  const expectedCols = new Set(expected.columns.map((c) => c.key));
  for (const e of expected.columns) {
    const a = actualCols.get(e.key);
    if (!a) {
      errors.push(`${e.key}: ORM column missing from DDL`);
      continue;
    }
    for (const property of [
      "type",
      "dimensions",
      "nullable",
      "identity",
      "generated",
    ]) {
      const av = property === "type" ? canonicalType(a[property]) : a[property];
      const ev = property === "type" ? canonicalType(e[property]) : e[property];
      if (av !== ev && !allow(property, e.key, a[property], e[property]))
        errors.push(
          `${e.key}: ${property} DDL=${JSON.stringify(a[property])}, ORM=${JSON.stringify(e[property])}`,
        );
    }
    if (canonicalDefault(a.default) !== canonicalDefault(e.default)) {
      if (
        e.default === null &&
        allow("databaseDefault", e.key, a.default, null)
      )
        continue;
      errors.push(
        `${e.key}: default DDL=${JSON.stringify(a.default)}, ORM=${JSON.stringify(e.default)}`,
      );
    }
  }
  for (const a of actual.columns)
    if (
      !expectedCols.has(a.key) &&
      !allow(
        "unmappedColumn",
        a.key,
        { type: a.type, nullable: a.nullable, default: a.default },
        null,
      )
    )
      errors.push(`${a.key}: unrecorded DDL-only column ${keyOf(a)}`);
  for (const kind of ["indexes", "foreignKeys"]) {
    const values = new Set(actual[kind].map(keyOf));
    for (const e of expected[kind])
      if (!values.has(keyOf(e)))
        errors.push(`${e.table}: missing/different ${kind}: ${keyOf(e)}`);
    notes.push(
      `${kind}: ${actual[kind].filter((a) => !expected[kind].some((e) => keyOf(e) === keyOf(a))).length} DDL-only objects applied and validated by PostgreSQL`,
    );
  }
  for (const [kind, entries] of Object.entries(policy))
    for (const object of Object.keys(entries))
      if (!used.has(`${kind}:${object}`))
        errors.push(`Stale/unmatched policy ${kind}:${object}`);
  notes.push(
    `CHECK constraints: ${actual.checks} DDL-owned objects applied by PostgreSQL`,
  );
  return { errors, notes };
}

// ============================================================================
// Disposable cluster only: no supplied URL, host port, bind mount or prod secret.
// ============================================================================

export function readInputs(root) {
  const dir = join(root, "deploy/database/ddl");
  const increments = readdirSync(join(dir, "incr"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const paths = [
    "00_baseline.sql",
    "97_service_role.sql",
    "98_column_locks.sql",
    ...increments.map((f) => `incr/${f}`),
  ];
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "deploy/database/ddl/incr/*.sql"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  for (const path of tracked)
    if (!paths.includes(path.replace("deploy/database/ddl/", "")))
      throw new Error(`Tracked migration missing: ${path}`);
  return paths.map((path) => {
    const sql = readFileSync(join(dir, path), "utf8");
    if (!sql.trim()) throw new Error(`Empty DDL ${path}`);
    return { path, sql };
  });
}

export function withDisposableCluster(work) {
  const docker = (args, input) =>
    execFileSync("docker", args, {
      input,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  let id;
  try {
    id = docker([
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--label",
      "vxture.guard=ddl-orm",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:18",
    ]);
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid disposable cluster ID");
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker(["exec", id, "psql", "-h", "127.0.0.1", "-U", "postgres", "-XAtc", "SELECT 1"]);
        ready = true;
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }
    if (!ready) throw new Error("Disposable PostgreSQL did not start");
    const sql = (db, input) =>
      docker(
        [
          "exec",
          "-i",
          id,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          db,
          "-XqAt",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        input,
      );
    return work(sql);
  } finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) {
      if (
        docker([
          "inspect",
          "--format",
          '{{index .Config.Labels "vxture.guard"}}',
          id,
        ]) !== "ddl-orm"
      )
        throw new Error("Refusing cleanup of unowned container");
      docker(["rm", "--force", id]);
    }
  }
}

export function runDatabaseGuard(root = process.cwd()) {
  const inputs = readInputs(root);
  const models = parsePrisma(
    readFileSync(join(root, "service/prisma/schema.prisma"), "utf8"),
  );
  const reference = referenceSql(models);
  const policy = JSON.parse(
    readFileSync(
      join(root, "scripts/guardrails/data-architecture-policy.json"),
      "utf8",
    ),
  );
  return withDisposableCluster((sql) => {
    sql("postgres", "CREATE DATABASE ddl; CREATE DATABASE orm;");
    for (const file of inputs) {
      console.log(`[data-architecture] apply ${file.path}`);
      try {
        sql("ddl", file.sql);
      } catch (e) {
        throw new Error(
          `DDL apply failed at ${file.path}: ${e.stderr?.toString() ?? e.message}`,
        );
      }
    }
    sql("orm", reference);
    const snapshot = (db) => JSON.parse(sql(db, SNAPSHOT_SQL));
    const first = snapshot("ddl");
    for (const file of inputs) sql("ddl", file.sql);
    const actual = snapshot("ddl");
    const stable = (view) =>
      Object.fromEntries(
        Object.entries(view).map(([k, v]) => [
          k,
          Array.isArray(v)
            ? [...v].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
            : v,
        ]),
      );
    if (keyOf(stable(first)) !== keyOf(stable(actual)))
      throw new Error("DDL replay changed the final structure");
    const result = compareSnapshots(actual, snapshot("orm"), policy);
    for (const note of result.notes) console.log(`[data-architecture] ${note}`);
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    console.log(
      `[data-architecture] semantic OK: ${models.length} models / ${actual.columns.length} DDL columns, ordered initialization and replay`,
    );
  });
}
