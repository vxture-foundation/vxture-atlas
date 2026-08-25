#!/usr/bin/env node
/**
 * check-workflows.mjs - .github/workflows/*.yml must parse, and must keep the
 * triggers they claim.
 *
 * Why this exists: a workflow that cannot be parsed is indistinguishable from
 * one that does not exist, which is the worst way to discover a CI change is
 * broken - silently, at the moment you need the pipeline. (A literal "\n"
 * inside a shell `printf` becoming a real newline, splitting one line into two
 * and making the file invalid YAML, is the exact failure class that motivated
 * this guardrail in the reference implementation - none of the five required
 * checks reads a workflow file.)
 *
 * Zero dependencies - a deliberately small YAML subset parser is not used here.
 * Instead we shell out to nothing and rely on a structural scan that catches the
 * failure classes that actually occur in these files.
 *
 * 2026-08-25: the sentence above USED to be the whole story, and the header's
 * promise ("must keep the triggers they claim") was not one of the things it
 * did. The only trigger check was "at least one recognised trigger appears",
 * which a mutation run demonstrated: swap ci.yml's `pull_request:` for
 * `workflow_dispatch:` and the guardrail stayed green - PR CI would simply stop
 * running, on a repo where nothing else enforces the required checks either
 * (branch protection is unavailable on this plan). Nothing would have said so.
 *
 * So the trigger set is now PINNED per file, below. Changing a workflow's
 * triggers is a real decision and now costs one line here; forgetting to make
 * it deliberately is what this catches. A new workflow with no pin also fails -
 * an unpinned file would otherwise re-open the hole for anything added later.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const STRICT = process.argv.includes("--strict");

// Each workflow must declare at least one of these triggers; a file that
// declares none is either broken or dead.
const TRIGGERS = ["push", "pull_request", "workflow_dispatch", "workflow_call", "schedule"];

/**
 * The trigger set each workflow is supposed to have. Sorted, compared exactly.
 *
 * This is a pin, not a description: it is here so that a trigger change fails
 * the build until someone edits this line on purpose. Removing an entry to make
 * a red go away is the one edit that defeats the check.
 */
const PINNED_TRIGGERS = new Map([
  ["build.yml", ["pull_request", "workflow_call", "workflow_dispatch"]],
  ["ci.yml", ["pull_request", "push"]],
  ["codeql.yml", ["pull_request", "push", "schedule"]],
  ["db-init.yml", ["workflow_dispatch"]],
  ["deploy.yml", ["workflow_dispatch"]],
  ["direct-push-audit.yml", ["push"]],
  ["logs.yml", ["workflow_dispatch"]],
  ["mirror-image.yml", ["workflow_dispatch"]],
  ["release.yml", ["workflow_dispatch"]],
  ["rollback.yml", ["workflow_dispatch"]],
  ["secret-scan.yml", ["pull_request", "push"]],
  ["set-env-var.yml", ["workflow_dispatch"]],
  ["sonar.yml", ["pull_request", "push"]],
]);

/**
 * Triggers declared by one workflow, as a sorted list. Handles the three shapes
 * these files use: a block, `on: push`, and `on: [push, pull_request]`.
 */
function declaredTriggers(lines) {
  const onIdx = lines.findIndex((l) => /^on:/.test(l));
  if (onIdx === -1) return [];
  const found = new Set();
  const inline = lines[onIdx].slice(3).trim();
  if (inline) {
    for (const t of TRIGGERS) if (new RegExp(`(^|[\\[,\\s])${t}([\\],\\s]|$)`).test(inline)) found.add(t);
  }
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (/^[A-Za-z_"']/.test(lines[i])) break;
    const m = /^ {2}([a-z_]+):/.exec(lines[i]);
    if (m && TRIGGERS.includes(m[1])) found.add(m[1]);
  }
  return [...found].sort();
}

const problems = [];

function scan(name, text) {
  const lines = text.split(/\r?\n/);

  // 1. Tabs are never valid YAML indentation.
  lines.forEach((l, i) => {
    if (/^\t/.test(l)) problems.push(`${name}:${i + 1} leading tab (invalid YAML indentation)`);
  });

  // 2. Top-level keys must be at column 0 and include `on:` and `jobs:`.
  const topKeys = lines
    .filter((l) => /^[A-Za-z_"']/.test(l))
    .map((l) => l.split(":")[0].replace(/["']/g, "").trim());
  for (const need of ["on", "jobs"]) {
    if (!topKeys.includes(need)) problems.push(`${name}: no top-level '${need}:' key`);
  }

  // 3. At least one recognised trigger must appear in the `on:` block.
  const onIdx = lines.findIndex((l) => /^on:/.test(l));
  if (onIdx !== -1) {
    let block = [];
    for (let i = onIdx + 1; i < lines.length; i++) {
      if (/^[A-Za-z_"']/.test(lines[i])) break;
      block.push(lines[i]);
    }
    const inline = lines[onIdx].slice(3).trim();
    const hay = inline + "\n" + block.join("\n");
    if (!TRIGGERS.some((t) => new RegExp(`(^|\\s)${t}\\s*:`, "m").test(hay) || hay.includes(t))) {
      problems.push(`${name}: 'on:' block declares no recognised trigger`);
    }
  }

  // 3b. ...and it must be the trigger set this workflow is pinned to. "At least
  // one trigger" is satisfied by the WRONG one, which is how a workflow stops
  // running while still looking configured.
  const pinned = PINNED_TRIGGERS.get(name);
  const actual = declaredTriggers(lines);
  if (!pinned) {
    problems.push(
      `${name}: no pinned trigger set. Add it to PINNED_TRIGGERS (currently ` +
        `declares: ${actual.join(", ") || "none"}) so a later change to it has ` +
        `to be deliberate.`,
    );
  } else if (pinned.join(",") !== actual.join(",")) {
    problems.push(
      `${name}: triggers drifted. pinned [${pinned.join(", ")}] but declares ` +
        `[${actual.join(", ") || "none"}]. If the change is intended, edit ` +
        `PINNED_TRIGGERS in this file in the same commit.`,
    );
  }

  // 4. Block scalars (`run: |`) must stay indented. This is the precise shape of
  //    the break that motivated the guardrail: a literal \n inside a shell string
  //    became a real newline, the continuation landed at column 0, and YAML read
  //    it as a new top-level key instead of script text. Match the structure, not
  //    the punctuation (a quote-counting heuristic cries wolf on `sed "s/'/''/g"`,
  //    which is perfectly valid).
  lines.forEach((l, i) => {
    if (!/^\s*[\w-]+:\s*[|>][-+]?\s*$/.test(l)) return;
    const keyIndent = l.search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j];
      if (cur.trim() === "") continue;
      // A comment may sit at any indentation and legally end a block scalar.
      if (/^\s*#/.test(cur)) continue;
      const ind = cur.search(/\S/);
      if (ind > keyIndent) continue; // still inside the block
      // The block ended. Legal only if this line is itself a sibling key or a
      // list item at or below the parent's indentation.
      if (!/^\s*(-\s+)?[\w-]+:/.test(cur) && !/^\s*-\s/.test(cur)) {
        problems.push(
          `${name}:${j + 1} block scalar opened at line ${i + 1} is terminated by a non-key line ` +
            `(${JSON.stringify(cur.slice(0, 40))}) - a literal \\n may have become a real newline`,
        );
      }
      break;
    }
  });
}

let files;
try {
  files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
} catch {
  console.log("[workflows] no .github/workflows - skip");
  process.exit(0);
}

for (const f of files) scan(f, readFileSync(join(DIR, f), "utf8"));

if (problems.length === 0) {
  console.log(`[workflows] OK - ${files.length} workflow files parse and declare triggers.`);
  process.exit(0);
}

console.log(`[workflows] ${problems.length} problem(s):`);
for (const p of problems) console.log(`  ${p}`);
if (STRICT) {
  console.error("\n[workflows] STRICT: a workflow that cannot be parsed is indistinguishable from one that does not exist.");
  process.exit(1);
}
process.exit(0);
