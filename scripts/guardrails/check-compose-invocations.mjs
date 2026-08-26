#!/usr/bin/env node
/**
 * check-compose-invocations.mjs - a documented `docker compose` command must
 * pass variables compose actually reads, and must not be able to build.
 *
 * The failure this exists for happened on 2026-08-26 and cost two false
 * verifications before anyone noticed.
 *
 * CLAUDE.md's val-stack recipe passed `IMAGE=ghcr.io/<org>/atlas-app`.
 * `docker-compose.yml` never reads `IMAGE`: it composes the reference from
 * `IMAGE_REGISTRY` / `IMAGE_NAMESPACE` / `PRODUCT_CODE` / `IMAGE_TAG`. So the
 * variable was accepted by the shell, ignored by compose, and the service
 * resolved to its default namespace instead - a DIFFERENT image, which was not
 * present locally, which compose then silently BUILT from source.
 *
 * Every visible signal said it had worked. `docker pull` really did pull the
 * CI image. `docker compose up` really did start a container. `/healthz`
 * answered 200. The only tell was `gitSha: unknown` in an identity block
 * nobody had a reason to read, and the container was a local build of the same
 * commit - so it behaved correctly while being the wrong artifact. Two
 * releases were verified this way and reported as "the CI image, not a local
 * rebuild".
 *
 * That is this repo's recurring defect exactly: a sentence nothing enforced.
 * The recipe claimed to pull what CI built, and no test, check, or type read
 * the recipe.
 *
 * TWO rules, because the first alone would not have been enough:
 *
 *   1. Every `VAR=value` prefix on a documented `docker compose` line names a
 *      variable `docker-compose.yml` interpolates. Catches the typo/rename.
 *
 *   2. An invocation that pins `IMAGE_TAG` also passes `--no-build`. Catches
 *      the consequence. A correct variable still builds silently when the
 *      image is absent - a stale pull, a wrong tag, a machine that never
 *      pulled - and CLAUDE.md's claim that the recipe "works on a machine that
 *      cannot build" is only true if building is refused rather than attempted.
 *
 * DELIBERATELY NOT CHECKED, and each is held elsewhere:
 *
 *   - Whether the VALUE is right. `IMAGE_NAMESPACE=typo` passes here; the
 *     pull in the same recipe block fails loudly, which is a signal a static
 *     check cannot improve on.
 *   - Compose invocations anywhere but CLAUDE.md - workflows and deploy.sh
 *     export their variables rather than prefixing them, so this parser would
 *     read nothing and report a hollow zero. deploy.sh's own path is covered
 *     by the deploy job's four verifications.
 *   - Whether `docker-compose.yml` is internally correct. That is compose's
 *     job and the deploy path's.
 *
 * Modes: default lists violations (exit 0); `--strict` fails hard for CI.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Inputs resolve from `process.cwd()`, NOT from this file's own location.
 *
 * That is the contract every guardrail here follows, and it is not cosmetic:
 * `scripts/audit` runs the real script against a mutated worktree as cwd. A
 * guardrail that resolved its inputs relative to itself would read the clean
 * repo, exit 0, and be reported as "does not bite" - which is exactly what the
 * first version of this file did on its first audit run.
 */
const ROOT = process.cwd();
const DOC = "CLAUDE.md";
const COMPOSE = "docker-compose.yml";

/** Variables `docker-compose.yml` interpolates, in any `${NAME...}` form. */
function interpolatedVars(text) {
  const found = new Set();
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) found.add(m[1]);
  return found;
}

/**
 * Documented `docker compose` invocations, with their inline VAR= prefixes.
 *
 * Whole lines only. A prefix assignment must sit before the command on the
 * same line to apply to it, so a line is the correct unit and a multi-line
 * continuation is out of scope by construction rather than by oversight - if
 * one is ever introduced, this reports zero invocations, which the count below
 * makes visible instead of silent.
 */
function invocations(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const at = line.indexOf("docker compose");
    if (at < 0) return;
    const prefix = line.slice(0, at);
    const vars = [...prefix.matchAll(/(^|\s)([A-Z][A-Z0-9_]*)=/g)].map((m) => m[2]);
    out.push({ line: i + 1, vars, command: line.slice(at).trim(), text: line });
  });
  return out;
}

const composeText = readFileSync(join(ROOT, COMPOSE), "utf8");
const docText = readFileSync(join(ROOT, DOC), "utf8");

const known = interpolatedVars(composeText);
const calls = invocations(docText);
const violations = [];

for (const call of calls) {
  for (const name of call.vars) {
    if (!known.has(name)) {
      violations.push({
        line: call.line,
        text: `${DOC}:${call.line} passes ${name}=, which ${COMPOSE} never reads`,
        hint: `compose interpolates: ${[...known].sort().join(", ")}`,
      });
    }
  }
  if (call.vars.includes("IMAGE_TAG") && !/--no-build\b/.test(call.command)) {
    violations.push({
      line: call.line,
      text: `${DOC}:${call.line} pins IMAGE_TAG but omits --no-build`,
      hint: "without it, a missing image is built from source instead of refusing",
    });
  }
}

const strict = process.argv.includes("--strict");

console.log(
  `[check-compose-invocations] ${calls.length} documented invocation(s) in ${DOC}; ` +
    `${known.size} variable(s) interpolated by ${COMPOSE}`,
);

if (calls.length === 0) {
  // A zero here means the parser found nothing to check, which is not the same
  // as finding nothing wrong. Say so rather than printing a clean bill.
  console.log(
    "[check-compose-invocations] no invocation matched - the recipe moved, " +
      "was reformatted across lines, or was removed. This is NOT a pass.",
  );
  process.exit(strict ? 1 : 0);
}

for (const v of violations) {
  console.log(`[check-compose-invocations] ${v.text}`);
  console.log(`[check-compose-invocations]   ${v.hint}`);
}

if (violations.length === 0) {
  console.log("[check-compose-invocations] OK");
  process.exit(0);
}
process.exit(strict ? 1 : 0);
