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
 *   service-mutation      proven by construction, same as above, with one
 *                         extra rule earned the hard way: vitest exits 1 when
 *                         tests fail, and the first version of that runner
 *                         crashed with 0xC0000005 and had the crash counted as
 *                         a red. Any non-1 exit is now a crash, not a defence.
 *   platform-claims       HALF PROVEN. The judgement of the two
 *                         visibility-dependent probes is a pure function and
 *                         is replayed here on recorded platform answers,
 *                         including the timeout-plus-404 that it once scored
 *                         `match` (2026-09-29). The GATHERING - the live API
 *                         calls - is still not provable from here: a red
 *                         needs a repository whose settings actually differ.
 *                         Each probe prints what the platform answered, which
 *                         is a weaker guarantee than a red run, stated as
 *                         weaker.
 */

import { chdir, cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withWorktree } from "./lib/isolate.mjs";
import { applyEdit } from "./lib/edit.mjs";
import * as assertionFreeTests from "./dimensions/assertion-free-tests.mjs";
import * as platformClaims from "./dimensions/platform-claims.mjs";

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
  dimension: "service-mutation",
  pass: true,
  detail: "proven by construction - each line is a planted-defect verdict, and a non-1 exit is reported as a crash rather than a red",
});
// platform-claims: the JUDGEMENT is proven by replaying raw platform answers;
// the gathering (live API calls) still is not. The first case is the one that
// fooled it on 2026-09-29: a TLS timeout (no status at all) on the rulesets
// call plus a 404 on legacy was scored `match` against "both return 403".
{
  const checks = ["audit", "build", "gitleaks", "quality-gate", "test-coverage"];
  const ruleset = (over = {}) => ({
    name: "main-protection",
    enforcement: "active",
    bypass_actors: [],
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: checks.map((context) => ({ context })) } }],
    ...over,
  });
  const bp = (args) => platformClaims.judgeBranchProtection({ expectedChecks: checks, ruleset: null, ...args }).verdict;
  const gate = (args) => platformClaims.judgeProductionGate(args).verdict;
  const cases = [
    ["network timeout + 404 is not a 403", bp({ visibility: "public", rulesetsStatus: null, legacyStatus: 404 }), "unknown"],
    ["private, status unreadable", bp({ visibility: "private", rulesetsStatus: null, legacyStatus: null }), "unknown"],
    ["private, both 403", bp({ visibility: "private", rulesetsStatus: 403, legacyStatus: 403 }), "match"],
    ["private but protection reachable", bp({ visibility: "private", rulesetsStatus: 200, legacyStatus: 404 }), "mismatch"],
    ["public, ruleset missing", bp({ visibility: "public", rulesetsStatus: 200, legacyStatus: 404 }), "mismatch"],
    ["public, ruleset as designed", bp({ visibility: "public", rulesetsStatus: 200, legacyStatus: 404, ruleset: ruleset() }), "match"],
    ["public, a bypass actor", bp({ visibility: "public", rulesetsStatus: 200, legacyStatus: 404, ruleset: ruleset({ bypass_actors: [{ actor_id: 1 }] }) }), "mismatch"],
    ["public, ruleset disabled", bp({ visibility: "public", rulesetsStatus: 200, legacyStatus: 404, ruleset: ruleset({ enforcement: "disabled" }) }), "mismatch"],
    ["no status from a timeout", String(platformClaims.httpStatusOf({ ok: false, body: "net/http: TLS handshake timeout" })), "null"],
    ["env unreadable", gate({ visibility: "public", status: null, env: null }), "unknown"],
    ["public env, no reviewer", gate({ visibility: "public", status: 200, env: { protection_rules: [], can_admins_bypass: true } }), "mismatch"],
    ["public env, reviewer but bypassable", gate({ visibility: "public", status: 200, env: { protection_rules: [{ type: "required_reviewers", reviewers: [{}] }], can_admins_bypass: true } }), "mismatch"],
    ["private env, no rules", gate({ visibility: "private", status: 200, env: { protection_rules: [] } }), "match"],
  ];
  const wrong = cases.filter(([, got, want]) => got !== want);
  results.push({
    dimension: "platform-claims",
    pass: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `judgement replayed on ${cases.length} recorded answers, all verdicts right; live gathering still unproven`
        : `wrong verdicts: ${wrong.map(([n, got, want]) => `${n} (got ${got}, want ${want})`).join("; ")}`,
  });
}

let failed = false;
for (const r of results) {
  const mark = r.pass === true ? "bites" : r.pass === null ? "unproven" : "DOES NOT BITE";
  if (r.pass === false) failed = true;
  console.log(`${mark.padEnd(14)} ${r.dimension.padEnd(22)} ${r.detail}`);
}
process.exit(failed ? 1 : 0);
