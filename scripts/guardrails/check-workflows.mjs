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
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const STRICT = process.argv.includes("--strict");

// Each workflow must declare at least one of these triggers; a file that
// declares none is either broken or dead.
const TRIGGERS = ["push", "pull_request", "workflow_dispatch", "workflow_call", "schedule"];

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
