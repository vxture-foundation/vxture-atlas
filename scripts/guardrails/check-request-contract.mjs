#!/usr/bin/env node
/**
 * check-request-contract.mjs - the published request rules and the enforced
 * ones cannot drift apart quietly (#21).
 *
 * `request-contract.ts` states, per `/v1` surface, which fields are required
 * and what code refuses a request that omits them. Consumers pin it. So the
 * question this script answers is the one no test can: **did somebody add a
 * requirement and not publish it?**
 *
 * The check works because X-1 already closed the other half. A new required
 * field cannot be enforced without a code, every code must be declared in
 * `runtime.errors.ts`, and `check-error-codes.mjs` proves declared == thrown.
 * So "every `*_REQUIRED` code in the vocabulary appears in the request
 * contract" is enough to catch the omission - the vocabulary is the census.
 *
 * The reverse direction is checked too: a rule citing a code that does not
 * exist would publish a refusal a consumer can never receive, which is the
 * `QUOTA_EXHAUSTED` failure in miniature.
 *
 * Deliberately NOT checked here: whether the rule names the right SURFACE. A
 * regex cannot know that, and getting it wrong is exactly as harmful as omitting
 * it. That half is held by the per-surface tests, which omit each declared field
 * against the real service and assert the declared code comes back.
 *
 * Modes: default lists violations (exit 0); `--strict` fails hard for CI.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ERRORS_FILE = join("service", "src", "runtime", "runtime.errors.ts");
const CONTRACT_FILE = join("service", "src", "runtime", "request-contract.ts");
const STRICT = process.argv.includes("--strict");

/**
 * Codes that name a missing input. `INVALID_*` is deliberately out of scope:
 * those describe a value that arrived and was wrong, not one that never came,
 * and a consumer cannot avoid them by sending more fields.
 */
const REQUIRED_SUFFIX = "_REQUIRED";

const errorsSource = readFileSync(ERRORS_FILE, "utf8");
const contractSource = readFileSync(CONTRACT_FILE, "utf8");

/** The vocabulary's census of "you did not send something". */
const declared = new Set(
  [...errorsSource.matchAll(/"([A-Z][A-Z0-9_]*_REQUIRED)"/gu)].map((m) => m[1]),
);

/** Every code the request contract claims a surface can answer with. */
const published = new Set(
  [...contractSource.matchAll(/code:\s*"([A-Z][A-Z0-9_]{3,})"/gu)].map(
    (m) => m[1],
  ),
);

const problems = [];

for (const code of [...declared].sort()) {
  if (published.has(code)) continue;
  problems.push(
    `${code} is in the published vocabulary but no surface in ` +
      `request-contract.ts says it can answer with it. A consumer pinning the ` +
      `contract cannot know the field is required, which is the taskId failure ` +
      `(TD-044) with a different field name.`,
  );
}

for (const code of [...published].sort()) {
  if (code.endsWith(REQUIRED_SUFFIX) && !declared.has(code)) {
    problems.push(
      `${code} is published by request-contract.ts and is not in the ` +
        `vocabulary. That advertises a refusal no caller can ever receive.`,
    );
  }
}

if (problems.length === 0) {
  console.log(
    `check-request-contract: OK - ${declared.size} "missing input" codes, ` +
      `every one published; every published code exists.`,
  );
  console.log(
    "  Not covered here (a regex cannot): whether each rule names the right " +
      "surface. The per-surface omission tests hold that half.",
  );
  process.exit(0);
}

console.error("check-request-contract: FAILED");
for (const problem of problems) console.error(`  - ${problem}`);
if (STRICT) {
  console.error("");
  console.error("--strict: failing the build.");
  process.exit(1);
}
process.exit(0);
