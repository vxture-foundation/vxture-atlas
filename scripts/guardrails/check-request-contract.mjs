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

/**
 * The third rule, added 2026-08-26 after the first two missed a live gap.
 *
 * `/v1/parse` enforced `task` at runtime and declared it nowhere: absent and
 * wrong both answered `PARSE_TASK_INVALID`, and the census above only looks at
 * `*_REQUIRED`, so the naming was itself what hid it. A consumer building from
 * the artifact sent {taskId, workspaceId, selector, pages} and got a 400 the
 * artifact could not have predicted - from the one document that exists to be
 * worth trusting.
 *
 * So the census stops being the vocabulary and becomes the CODE: every
 * `BAD_REQUEST` a `/v1` surface can throw must be either published in the
 * request contract, or classified below as a value rule with a reason. A new
 * refusal added to any of these four files fails this check until someone says
 * which of the two it is. That is the point - the previous version could only
 * catch a mistake somebody had already named correctly.
 */
const SURFACES = Object.freeze({
  "/v1/chat": join("service", "src", "runtime", "runtime.service.ts"),
  "/v1/embed": join("service", "src", "embedding", "embedding.service.ts"),
  "/v1/rerank": join("service", "src", "rerank", "rerank.service.ts"),
  "/v1/parse": join("service", "src", "parse", "parse.service.ts"),
});

/**
 * Refusals about a value that ARRIVED, not one that is missing. These stay out
 * of the request contract on purpose: the contract answers "what must I send",
 * and a caller cannot avoid these by sending more fields.
 *
 * Every entry needs a reason. An unexplained entry is how a presence rule gets
 * filed here to make the check go green.
 */
const VALUE_ONLY = Object.freeze({
  CLIENT_ABORTED: "not a validation refusal - the caller disconnected mid-stream",
  INVALID_TENANT_ID: "tenantId arrived and is not a uuid; absence is TENANT_ID_REQUIRED",
  APPLICATION_TYPE_INVALID: "value outside the enum; absence is APPLICATION_TYPE_REQUIRED",
  USAGE_TYPE_INVALID: "optional field, value outside the enum",
  CHAT_MESSAGES_INVALID: "messages arrived malformed; absence is CHAT_MESSAGES_REQUIRED",
  CHAT_THINKING_INVALID: "thinking is optional; this refuses a value outside off/on, absence means the upstream default (ADR-009)",
  EMBED_TEXTS_INVALID: "texts arrived malformed; absence is EMBED_TEXTS_REQUIRED",
  RERANK_CANDIDATES_INVALID: "candidates arrived malformed; absence is RERANK_CANDIDATES_REQUIRED",
  CANDIDATE_POOL_TOO_LARGE: "a ceiling on an accepted value, not a missing field",
  PARSE_TASK_INVALID: "task arrived outside the enum; absence is PARSE_TASK_REQUIRED",
  PARSE_PAGES_INVALID: "pages arrived malformed; absence is PARSE_PAGES_REQUIRED",
});

const problems = [];

for (const [surface, file] of Object.entries(SURFACES)) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    // Unreadable is neither pass nor fail: say so rather than counting a
    // surface with zero throw sites as a clean one.
    problems.push(
      `${surface}: cannot read ${file} - this surface was NOT checked, which ` +
        `is not the same as finding nothing wrong.`,
    );
    continue;
  }
  const thrown = new Set(
    [...source.matchAll(/HttpStatus\.BAD_REQUEST,\s*"([A-Z][A-Z0-9_]{3,})"/gu)].map(
      (m) => m[1],
    ),
  );
  for (const code of [...thrown].sort()) {
    if (published.has(code)) continue;
    if (Object.hasOwn(VALUE_ONLY, code)) continue;
    problems.push(
      `${surface} can answer ${code} with 400, and it is neither published in ` +
        `request-contract.ts nor classified as a value rule in this script. ` +
        `If it means "you did not send X", publish it; if it means "what you ` +
        `sent is wrong", add it to VALUE_ONLY with the reason.`,
    );
  }
}

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
    `  ${Object.keys(SURFACES).length} surfaces read for BAD_REQUEST throw ` +
      `sites; ${Object.keys(VALUE_ONLY).length} classified as value rules.`,
  );
  console.log(
    "  Not covered here (a regex cannot): whether each rule names the right " +
      "surface, and whether a VALUE_ONLY classification is honest. The " +
      "per-surface omission tests hold the first half; nothing holds the " +
      "second, which is why each entry carries a reason a reader can check.",
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
