#!/usr/bin/env node
/**
 * check-column-writes.mjs - a field an update path can write must be a column
 * `atlas_svc` may write.
 *
 * TD-039. `98_column_locks.sql` revokes table UPDATE and grants it back per
 * column. Prisma call arguments are `Record<string, unknown>` throughout this
 * repo, and the repositories pass `data: input` straight through. So the two
 * halves meet only at runtime, as `permission denied for table ...` - a 500 on
 * an operator route, with no type error, no test failure and no lint warning
 * anywhere upstream of it.
 *
 * That is not a hypothetical. Measured 2026-08-17 by resolving every
 * `Update*Input` property through the TypeScript checker and running the
 * corresponding UPDATE as `atlas_svc`:
 *
 *   model.models.model_type               permission denied
 *   model.models.provider                 column does not exist (derived on read)
 *   model.model_grants.agent_id           permission denied
 *   model.model_grants.application_id     permission denied
 *   model.model_grants.application_type   permission denied
 *   model.model_policies.tenant_id        permission denied
 *   model.model_policies.effective_at     permission denied
 *
 * Seven live defects, none of which any test caught - the service tests mock
 * the repository away, so a green test of either half proves nothing about the
 * pair. Two of those tests were in fact ASSERTING the broken behaviour.
 *
 * ## Why the TypeScript checker rather than a regex
 *
 * Four of the six input types are `Partial<Pick<...>>` derivations. A regex
 * would have to reimplement type resolution to read them, and would be wrong
 * exactly where a mistake hides. The checker already knows.
 *
 * ## What this does NOT check
 *
 * Only the admin surface, because only it has named `Update*Input` types. A
 * repository writing an untyped object literal is invisible here - that half of
 * TD-039's recovery note stands. Reported as a count so the blind spot is
 * visible rather than implied.
 */

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { columnLockGrantedColumns } from "./check-data-architecture.mjs";

const STRICT = process.argv.includes("--strict");
const TYPES = "service/src/types/runtime.types.ts";
const LOCKS = "deploy/database/ddl/98_column_locks.sql";
const INCR = "deploy/database/ddl/incr";

/**
 * Which table each input type writes.
 *
 * Stated rather than inferred. A name-based guess (`UpdateAiModelInput` ->
 * `models`) would silently stop checking a type somebody renamed, which is the
 * failure this guardrail exists to prevent, one level up.
 */
const INPUT_TO_TABLE = {
  UpdateAiModelInput: "model.models",
  UpdateAiModelGrantInput: "model.model_grants",
  UpdateModelProviderInput: "model.model_providers",
  UpdateModelEndpointInput: "model.model_endpoints",
  UpdateModelPriceRuleInput: "model.model_price_rules",
  UpdateModelPolicyInput: "model.model_policies",
};

/**
 * Fields the service refuses before they can reach Prisma.
 *
 * **This list is NOT verified here, on purpose.** The first version of this
 * script tried to prove each entry had a guard by searching
 * `model-admin.service.ts` for the field name. It did not work: after deleting
 * a guard the check still passed, because the name survived elsewhere in the
 * file and `refuseUnwritableField` was still used by its siblings. A check that
 * cannot fail is worse than no check - it was the third one written that way in
 * a single session.
 *
 * So the two failure modes are split by who can actually see them:
 *
 * - **A guard is deleted** -> the unit tests in `model-admin.service.spec.ts`
 *   fail. Verified by deleting the `modelType` guard: one test goes red.
 * - **A new writable field appears with no grant and no guard** -> this script
 *   fails. That is the case no test can see, because a test only covers fields
 *   somebody already thought about.
 */
const REFUSED_BY_SERVICE = {
  "model.models": ["modelCode", "modelType", "provider"],
  "model.model_grants": ["agentId", "applicationId", "applicationType"],
  "model.model_providers": ["providerCode", "providerType"],
  "model.model_price_rules": [
    "billingMode",
    "cacheWrite1hUnitPrice",
    "cacheWriteUnitPrice",
    "cachedInputUnitPrice",
    "currency",
    "effectiveAt",
    "inputUnitPrice",
    "outputUnitPrice",
    "requestUnitPrice",
    "unitTokens",
  ],
  "model.model_policies": ["tenantId", "effectiveAt"],
};

const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function grantedColumns() {
  let sql = readFileSync(LOCKS, "utf8");
  // Increments apply after the lock file and may grant more, so a column added
  // later is legitimately writable even though 98 does not name it.
  for (const f of readdirSync(INCR).filter((f) => f.endsWith(".sql")).sort()) {
    sql += `\n${readFileSync(`${INCR}/${f}`, "utf8")}`;
  }
  const byTable = new Map();
  for (const { table, column } of columnLockGrantedColumns(sql)) {
    if (!byTable.has(table)) byTable.set(table, new Set());
    byTable.get(table).add(column);
  }
  return byTable;
}

function inputProperties() {
  const require = createRequire(`${process.cwd()}/service/`);
  const ts = require("typescript");
  const program = ts.createProgram([TYPES], {
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(TYPES);
  if (!source) throw new Error(`cannot read ${TYPES}`);

  const found = new Map();
  ts.forEachChild(source, (node) => {
    const name = node.name && node.name.text;
    if (!name || !Object.hasOwn(INPUT_TO_TABLE, name)) return;
    const type = checker.getTypeAtLocation(node.name);
    found.set(
      name,
      checker.getPropertiesOfType(type).map((p) => p.getName()),
    );
  });
  return found;
}

function main() {
  const granted = grantedColumns();
  const inputs = inputProperties();
  const problems = [];

  for (const [inputName, table] of Object.entries(INPUT_TO_TABLE)) {
    const props = inputs.get(inputName);
    if (!props) {
      problems.push(
        `${inputName}: not found in ${TYPES} - renamed or removed? ` +
          `Update INPUT_TO_TABLE, or this table stops being checked.`,
      );
      continue;
    }
    const allowed = granted.get(table) ?? new Set();
    const refused = new Set(REFUSED_BY_SERVICE[table] ?? []);

    for (const prop of props) {
      if (allowed.has(camelToSnake(prop))) continue;
      if (refused.has(prop)) continue;
      problems.push(
        `${table}.${camelToSnake(prop)}: writable via ${inputName}, and ` +
          `atlas_svc has no UPDATE grant on it. This is a 500 at runtime ` +
          `(permission denied), not a type error. Either add a guard in ` +
          `normalizeUpdate* and list it in REFUSED_BY_SERVICE, or grant the ` +
          `column in a db-init increment AND mirror it into 98_column_locks.sql.`,
      );
    }
  }

  const checked = Object.keys(INPUT_TO_TABLE).length;
  if (problems.length === 0) {
    console.log(
      `check-column-writes: OK - ${checked} update inputs, every writable ` +
        `field is either granted or refused before Prisma.`,
    );
    console.log(
      `  Blind spots (TD-039): repositories writing untyped object literals ` +
        `are not covered, and whether each REFUSED_BY_SERVICE entry still has ` +
        `its guard is proven by the unit tests, not here.`,
    );
    return 0;
  }

  console.error("check-column-writes: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  return STRICT ? 1 : 0;
}

process.exit(main());
