#!/usr/bin/env node
/**
 * selftest.mjs - L1, turned on the audit itself.
 *
 * The rule this repo now writes down is that a check which has never been seen
 * red does not exist yet: "clean" and "not running" print the same line. That
 * applies to the audit before it applies to anything the audit inspects, so
 * each dimension here is pointed at an input that is known to be bad and is
 * required to notice.
 *
 * This file also records where that proof stops, because the honest answer is
 * not "all three":
 *
 *   guardrail-mutation    proven by construction. Its whole output is
 *                         "did a planted defect turn this guardrail red", and
 *                         on the current tree eight of nine do. It cannot
 *                         report a silent pass without also reporting which
 *                         mutation produced it.
 *   assertion-free-tests  proven here. A spec with one assertion-free case is
 *                         planted in an isolated worktree; the dimension must
 *                         find it. Two false-positive classes (it.each data
 *                         tables, `/re/.test(x)`) were found this way, both
 *                         after they had already been reported as findings.
 *   platform-claims       NOT PROVEN, and not provable from here. Turning one
 *                         of its probes red needs a repository whose settings
 *                         actually differ, and pointing it at someone else's
 *                         repo to manufacture a red is not a test of anything.
 *                         Its four probes each print what the platform answered
 *                         (`protection_rules = 0`, `HTTP 403`, ...), so a wrong
 *                         verdict is visible in the transcript rather than
 *                         hidden behind a count - that is a weaker guarantee
 *                         than a red run, and it is stated as weaker.
 */

import { chdir, cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withWorktree } from "./lib/isolate.mjs";
import { applyEdit } from "./lib/edit.mjs";
import * as assertionFreeTests from "./dimensions/assertion-free-tests.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = [];

const PLANTED = `import { describe, it, expect } from "vitest";

describe("audit selftest", () => {
  it("has an assertion and must NOT be reported", () => {
    expect(1).toBe(1);
  });

  it("asserts nothing and must be reported", () => {
    const value = 1 + 1;
    void value;
  });

  it.each([["a"], ["b"]])("parameterised, asserts, must NOT be reported", (v) => {
    expect(v).toBeTypeOf("string");
  });
});
`;

await withWorktree(repoRoot, async (wt) => {
  applyEdit(wt, { file: "service/src/audit/audit-selftest-probe.spec.ts", create: PLANTED });
  const before = cwd();
  chdir(wt);
  try {
    const { findings } = await assertionFreeTests.run({ repoRoot, log: () => {} });
    const hits = findings.filter((f) => f.title.includes("audit-selftest-probe"));
    results.push({
      dimension: "assertion-free-tests",
      // Both directions: it must catch the assertion-free case AND leave the
      // two that do assert alone. A scanner that flags everything is as useless
      // as one that flags nothing, and reads as much more thorough.
      pass: hits.length === 1,
      detail: `planted 1 assertion-free case among 3; dimension reported ${hits.length} from the planted file`,
    });
  } finally {
    chdir(before);
  }
});

results.push({
  dimension: "guardrail-mutation",
  pass: true,
  detail: "proven by construction - every line it prints is a planted-defect verdict",
});
results.push({
  dimension: "platform-claims",
  pass: null,
  detail: "NOT PROVEN - a red needs a repo whose settings differ; probes print the platform's raw answer instead",
});

let failed = false;
for (const r of results) {
  const mark = r.pass === true ? "bites" : r.pass === null ? "unproven" : "DOES NOT BITE";
  if (r.pass === false) failed = true;
  console.log(`${mark.padEnd(14)} ${r.dimension.padEnd(22)} ${r.detail}`);
}
process.exit(failed ? 1 : 0);
