/**
 * Prove drift rejection against PostgreSQL, not regex-shaped mocks.
 * @package vxture-atlas
 * @layer Infrastructure
 * @category test
 * @author AI-Generated
 * @date 2026-10-21
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  parsePrisma,
  referenceSql,
  compareSnapshots,
  SNAPSHOT_SQL,
  withDisposableCluster,
  readInputs,
} from "./data-architecture-semantics.mjs";

// ============================================================================
// Pure reader failures must be detected before any database or Docker operation.
// ============================================================================

const schema = `
datasource db {
  provider = "postgresql"
  schemas = ["fixture"]
}
model Parent {
  key String @id @map("id") @db.Uuid
  rows Item[]
  @@map("parent")
  @@schema("fixture")
}
model Item {
  id String @id @default(uuid()) @db.Uuid
  name String @default("ok") @db.VarChar(32)
  parentId String? @map("parent_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  tags String[] @default([])
  parent Parent? @relation(fields: [parentId], references: [key], onUpdate: NoAction)
  @@index([name, createdAt(sort: Desc)], type: BTree)
  @@unique([parentId, name])
  @@map("item")
  @@schema("fixture")
}`;
test("physical mappings, scalar lists, and relation fields", () => {
  const sql = referenceSql(parsePrisma(schema));
  assert.match(sql, /"fixture"\."parent"/);
  assert.match(sql, /"tags" text\[\]/);
  assert.doesNotMatch(sql, /"parent" Parent|"rows"/);
  assert.doesNotMatch(sql, /gen_random_uuid/); // uuid() belongs to the client.
});
for (const [label, mutated] of [
  ["unknown field type", schema.replace("tags String[]", "tags Mystery[]")],
  [
    "unsupported attribute",
    schema.replace("@db.VarChar(32)", "@db.VarChar(32) @ignore"),
  ],
  ["unknown block", schema + "\nenum Mode { A B }"],
  ["unterminated model", schema.slice(0, -1)],
  [
    "unparsed field",
    schema.replace("tags String[] @default([])", "broken ! declaration"),
  ],
])
  test(label, () => assert.throws(() => referenceSql(parsePrisma(mutated))));
test("unsupported index syntax fails", () =>
  assert.throws(() =>
    referenceSql(parsePrisma(schema.replace("type: BTree", "type: Unknown"))),
  ));
test("missing tracked migration cannot pass", () => {
  const root = mkdtempSync(join(tmpdir(), "ddl-orm-missing-"));
  const dir = join(root, "deploy/database/ddl");
  mkdirSync(join(dir, "incr"), { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const name of [
    "00_baseline.sql",
    "97_service_role.sql",
    "98_column_locks.sql",
    "incr/01.sql",
  ])
    writeFileSync(join(dir, name), "SELECT 1;");
  execFileSync("git", ["add", "."], { cwd: root });
  // Rename only the tracked file inside this disposable fixture.
  execFileSync(process.execPath, [
    "-e",
    "require('node:fs').renameSync(process.argv[1],process.argv[2])",
    join(dir, "incr/01.sql"),
    join(dir, "incr/02.sql"),
  ]);
  assert.throws(() => readInputs(root), /Tracked migration missing/);
});
test("missing input directory fails", () =>
  assert.throws(() =>
    readInputs(mkdtempSync(join(tmpdir(), "ddl-orm-absent-"))),
  ));

// ============================================================================
// Each mutation starts from the same real PostgreSQL structure and must fail.
// ============================================================================

test("PostgreSQL semantic mutations and ordered upgrades", () => {
  withDisposableCluster((sql) => {
    sql("postgres", "CREATE DATABASE reference; CREATE DATABASE actual;");
    const reference = referenceSql(parsePrisma(schema));
    sql("reference", reference);
    sql("actual", reference);
    const expected = JSON.parse(sql("reference", SNAPSHOT_SQL));
    const compare = (policy = {}) =>
      compareSnapshots(
        JSON.parse(sql("actual", SNAPSHOT_SQL)),
        expected,
        policy,
      );
    assert.deepEqual(compare().errors, []);
    const mutations = [
      [
        "missing ORM column",
        "ALTER TABLE fixture.item DROP COLUMN tags;",
        /missing from DDL/,
      ],
      [
        "nullability",
        "ALTER TABLE fixture.item ALTER COLUMN name DROP NOT NULL;",
        /nullable/,
      ],
      [
        "type length",
        "ALTER TABLE fixture.item ALTER COLUMN name TYPE varchar(31);",
        /type/,
      ],
      [
        "array dimensions",
        "ALTER TABLE fixture.item ALTER COLUMN tags TYPE text;",
        /type|dimensions/,
      ],
      [
        "database default",
        "ALTER TABLE fixture.item ALTER COLUMN name SET DEFAULT 'different';",
        /default/,
      ],
      [
        "missing default",
        "ALTER TABLE fixture.item ALTER COLUMN created_at DROP DEFAULT;",
        /default/,
      ],
      [
        "generated identity",
        "ALTER TABLE fixture.item ADD COLUMN serial bigint GENERATED ALWAYS AS IDENTITY;",
        /DDL-only column/,
      ],
      ["missing index", "DROP INDEX fixture.guard_ref_0;", /indexes/],
      ["unique constraint", "DROP INDEX fixture.guard_ref_1;", /indexes/],
      [
        "foreign key action",
        "ALTER TABLE fixture.item DROP CONSTRAINT item_parent_id_fkey; ALTER TABLE fixture.item ADD FOREIGN KEY(parent_id) REFERENCES fixture.parent(id) ON DELETE CASCADE;",
        /foreignKeys/,
      ],
    ];
    for (const [name, mutation, pattern] of mutations) {
      // Keep mutation, snapshot and rollback on the same connection.
      const result = JSON.parse(
        sql("actual", `BEGIN; ${mutation}\n${SNAPSHOT_SQL}\nROLLBACK;`),
      );
      const errors = compareSnapshots(result, expected).errors.join("\n");
      assert.match(errors, pattern, name);
    }
    const ddlOnly = JSON.parse(
      sql(
        "actual",
        `BEGIN; ALTER TABLE fixture.item ADD COLUMN hidden text; ${SNAPSHOT_SQL} ROLLBACK;`,
      ),
    );
    assert.equal(compareSnapshots(ddlOnly, expected).errors.length, 1);
    const policy = {
      unmappedColumn: {
        "fixture.item.hidden": {
          ddl: { type: "text", nullable: true, default: null },
          orm: null,
          reason:
            "Intentional database-only column restricts the ORM write surface.",
        },
      },
    };
    assert.deepEqual(compareSnapshots(ddlOnly, expected, policy).errors, []);
    assert.match(
      compareSnapshots(ddlOnly, expected, {
        unmappedColumn: {
          "fixture.item.hidden": {
            ...policy.unmappedColumn["fixture.item.hidden"],
            ddl: { type: "integer" },
          },
        },
      }).errors.join("\n"),
      /unrecorded/,
    );
    assert.match(
      compareSnapshots(expected, expected, policy).errors.join("\n"),
      /Stale/,
    );
    // DDL-owned CHECK/partial expression indexes are legal and stay out of ORM.
    sql(
      "actual",
      "ALTER TABLE fixture.item ADD CONSTRAINT allowed_name CHECK (name <> ''); CREATE INDEX extra_partial ON fixture.item ((lower(name))) WHERE name IS NOT NULL;",
    );
    assert.deepEqual(compare().errors, []);
    // An unknown SQL declaration and an index before its column must fail.
    assert.throws(() =>
      sql("actual", "ALTER TABLE fixture.item UNSUPPORTED ACTION;"),
    );
    assert.throws(() =>
      sql("actual", "CREATE INDEX bad_order ON fixture.item(later_column);"),
    );
    sql(
      "actual",
      "ALTER TABLE fixture.item ADD COLUMN later_column text; CREATE INDEX good_order ON fixture.item(later_column); ALTER TABLE fixture.item RENAME COLUMN later_column TO renamed; ALTER TABLE fixture.item ALTER COLUMN renamed TYPE varchar(8); ALTER TABLE fixture.item ALTER COLUMN renamed SET DEFAULT 'x'; ALTER TABLE fixture.item ALTER COLUMN renamed SET NOT NULL; DROP INDEX fixture.good_order; ALTER TABLE fixture.item DROP COLUMN renamed;",
    );
    assert.deepEqual(compare().errors, []);
  });
});
