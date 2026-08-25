#!/usr/bin/env node
/**
 * run-audit.mjs - the audit runner.
 *
 * Its one structural job is to make a ZERO readable. Round two had a dimension
 * named "release/deploy consistency" report zero findings while two false
 * claims sat inside its subject; nothing in that report said what the dimension
 * had actually looked at, so the zero could not be told apart from a zero that
 * meant something. ISO 19011 requires an audit report to state its scope and
 * its scope limitations for exactly this reason, and "nothing came to our
 * attention" is limited assurance - a weaker claim than "we tested X and X
 * holds". Round two's zero was read as the strong one.
 *
 * So: a dimension that does not declare `covered` and `notCovered` is not run.
 * The runner refuses it rather than printing its number. Declaring scope is not
 * documentation here, it is the interface.
 *
 * Findings carry a severity, and `unreadable` is one of them on purpose: a
 * probe that could not reach its subject is neither a pass nor a defect, and
 * collapsing it into either is how a network timeout becomes a green check.
 *
 * Usage: node scripts/audit/run-audit.mjs [--only <id>] [--json]
 * Exit code is 0 even with findings - this reports, it does not gate. The
 * gating checks are scripts/guardrails/.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import * as guardrailMutation from "./dimensions/guardrail-mutation.mjs";
import * as assertionFreeTests from "./dimensions/assertion-free-tests.mjs";
import * as platformClaims from "./dimensions/platform-claims.mjs";

const DIMENSIONS = [guardrailMutation, assertionFreeTests, platformClaims];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const asJson = args.includes("--json");

const log = asJson ? () => {} : (line) => console.log(line);

/** A dimension that will not say what it looked at does not get to report. */
function assertDeclaresScope(dim) {
  const m = dim.meta;
  if (!m?.id || !Array.isArray(m.covered) || !Array.isArray(m.notCovered)) {
    throw new Error(`dimension ${m?.id ?? "<unnamed>"} has no scope declaration`);
  }
  if (m.covered.length === 0 || m.notCovered.length === 0) {
    throw new Error(
      `dimension ${m.id} declares an empty scope. A dimension that cannot name ` +
        `what it did NOT look at cannot produce a readable zero, so it is not run.`,
    );
  }
}

const results = [];

for (const dim of DIMENSIONS) {
  assertDeclaresScope(dim);
  if (only && dim.meta.id !== only) continue;

  log(`\n=== ${dim.meta.id} - ${dim.meta.title} ===`);
  let outcome;
  try {
    outcome = await dim.run({ repoRoot, log });
  } catch (err) {
    outcome = {
      findings: [
        {
          severity: "unreadable",
          title: `维度自身失败：${dim.meta.id}`,
          detail: `${err.message} 维度没跑完，它的 0 不代表任何事。`,
        },
      ],
      probed: 0,
    };
    log(`  ! dimension threw: ${err.message}`);
  }
  results.push({ meta: dim.meta, ...outcome });
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

console.log("\n\n=========== 审计结论 ===========");
for (const r of results) {
  const high = r.findings.filter((f) => f.severity === "high").length;
  const medium = r.findings.filter((f) => f.severity === "medium").length;
  const unreadable = r.findings.filter((f) => f.severity === "unreadable").length;

  console.log(`\n## ${r.meta.id} - ${r.meta.title}`);
  console.log(`   探测 ${r.probed} 项 | 高 ${high} · 中 ${medium} · 不可判定 ${unreadable}`);
  console.log("   扫了：");
  for (const c of r.meta.covered) console.log(`     + ${c}`);
  console.log("   没扫（这一段是结论的一部分，不是免责声明）：");
  for (const c of r.meta.notCovered) console.log(`     - ${c}`);
  if (r.findings.length === 0) {
    console.log("   发现：0 —— 在上面那个范围内，且基线与变异均已判读。");
  } else {
    console.log("   发现：");
    for (const f of r.findings) {
      console.log(`     [${f.severity}] ${f.title}`);
      console.log(`             ${f.detail}`);
    }
  }
}
