#!/usr/bin/env node
/**
 * check-docs-numbering.mjs - docs/ numbering hard guardrail.
 *
 * Enforces the repo docs convention (docs/00-meta/00-index.md), which
 * realizes the org taxonomy meta-rule (070-docs-taxonomy.md): numbered = formal
 * (permanent), unnumbered = temporary (locate and delete).
 *
 * Product-repo note: org taxonomy section 3 (owner 2026-07-22) scopes the
 * `{kind}_{domain}_{NNN}_{slug}` domain-document family to the vxture-platform
 * repo ONLY - a single-domain product repo separates documents by directory and
 * number band instead, and a domain prefix there is pure noise. That family is
 * therefore NOT a legal shape here; a file carrying one is a violation.
 *
 * Three checks:
 *   1. file names      - NN(N)-slug.md, or the ADR-/TD- registers
 *   2. directory names - NN(N)-name for a sequence directory, or a docs-relative
 *                        path in DIR_EXEMPTIONS for a keyed one
 *   3. root-only README whitelist - a nested README.md cannot open an unnumbered
 *                        area
 *
 * Modes: default lists violations as a worklist (exit 0); `--strict` fails hard
 * (exit 1) for CI.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const DOCS_ROOT = "docs";
const STRICT = process.argv.includes("--strict");

// Non-docs entry file, whitelisted at the docs/ root level ONLY.
const ROOT_WHITELIST = new Set(["README.md"]);

// Legal "numbered" file shapes (any one qualifies):
//   00-index.md / NN(N)-slug.md   -- in-directory sequence (10-step gaps; 00 is
//                                    the index; digit count is uniform per
//                                    directory)
//   ADR-NNN* / TD-NNN*            -- append-only type registers
const NUMBERED_FILE = [
  /^\d{2,3}-.+\.md$/u,
  /^(ADR|TD)-\d{3}.*\.md$/u,
];

// Directory classification:
//   sequence directory - carries an ordered grouping, must be NN(N)-name
//   keyed directory    - the name IS a stable external key (ADR number, table
//                        name, package name), so a number would fake an order
//                        that does not exist; unnumbered but registered below
// Keys are docs-relative PATHS, not bare names: a bare name would exempt any
// directory that happens to reuse it anywhere in the tree.
const NUMBERED_DIR = /^\d{2,3}-[a-z][a-z0-9-]*$/u;
const DIR_EXEMPTIONS = new Set([
  "30-design/decisions", // key = ADR number; org taxonomy section 4 pins this path
  "50-deployment/rebuild", // governance standard section 1 pins rebuild/main-ruleset.json
]);

const fileViolations = [];
const dirViolations = [];

function walk(dir, relDir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const relPath = relDir ? `${relDir}/${name}` : name;
    if (statSync(full).isDirectory()) {
      if (!NUMBERED_DIR.test(name) && !DIR_EXEMPTIONS.has(relPath)) {
        dirViolations.push(rel(full));
      }
      walk(full, relPath);
    } else if (name.endsWith(".md")) {
      const whitelisted = relDir === "" && ROOT_WHITELIST.has(name);
      if (!whitelisted && !NUMBERED_FILE.some((re) => re.test(name))) {
        fileViolations.push(rel(full));
      }
    }
  }
}

function rel(p) {
  return relative(".", p).replaceAll("\\", "/");
}

try {
  walk(DOCS_ROOT, "");
} catch {
  console.log(`[docs-numbering] no ${DOCS_ROOT}/ - skip`);
  process.exit(0);
}

const total = fileViolations.length + dirViolations.length;
if (total === 0) {
  console.log("[docs-numbering] OK - files and directories all numbered.");
  process.exit(0);
}

if (fileViolations.length > 0) {
  console.log(
    `[docs-numbering] ${fileViolations.length} unnumbered .md (= temporary/to-delete or to-number):`,
  );
  for (const v of fileViolations.sort()) console.log(`  ${v}`);
}
if (dirViolations.length > 0) {
  console.log(`[docs-numbering] ${dirViolations.length} unnumbered directory:`);
  for (const v of dirViolations.sort()) console.log(`  ${v}`);
}

if (STRICT) {
  console.error(
    "\n[docs-numbering] STRICT: number it (files NN(N)-slug.md / ADR- / TD-; " +
      "directories NN(N)-name) or delete it. Note {kind}_{domain}_{NNN}_ is " +
      "platform-repo-only and is NOT legal here.",
  );
  process.exit(1);
}
console.log("\n[docs-numbering] report mode (non-blocking). CI runs --strict.");
process.exit(0);
