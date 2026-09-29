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
 *
 * 2026-08-26: third-party action refs are checked too, for the same reason one
 * level down. TD-026 closed on 2026-08-16 by PINNING all seven `docker/*` and
 * Sonar refs to full SHAs - a one-time cleanup with nothing holding it. Adding
 * `docker/login-action@v4` to a new job would have restored the exact hazard the
 * cleanup removed, silently, because no check in this repo read a `uses:` line
 * at all. A mutable tag in a job that holds registry credentials means the code
 * that runs against those credentials can change without any commit here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const ACTION_DIRS = [".github/actions"];

/**
 * Owners whose actions may stay on a tag.
 *
 * This is the boundary TD-026 actually drew, and it is narrower than the
 * industry default: OpenSSF Scorecard's Pinned-Dependencies check wants every
 * ref pinned, `actions/checkout` included. Widening it here would be this
 * guardrail deciding something the repo has not - so instead the count of
 * first-party tag refs is printed on every run. A number nobody can avoid
 * seeing is the honest way to leave a gap open.
 */
const TAG_ALLOWED_OWNERS = new Set(["actions", "github"]);

const SHA_REF = /^[0-9a-f]{40}$/;
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
  // workflow_dispatch added 2026-08-26: required-check evidence on a sha must
  // be reproducible, because a lost push event is otherwise unrecoverable.
  ["ci.yml", ["pull_request", "push", "workflow_dispatch"]],
  ["codeql.yml", ["pull_request", "push", "schedule"]],
  ["db-init.yml", ["workflow_dispatch"]],
  ["deploy.yml", ["workflow_dispatch"]],
  ["direct-push-audit.yml", ["push"]],
  ["logs.yml", ["workflow_dispatch"]],
  ["mirror-image.yml", ["workflow_dispatch"]],
  ["release.yml", ["workflow_dispatch"]],
  ["rollback.yml", ["workflow_dispatch"]],
  ["secret-scan.yml", ["pull_request", "push", "workflow_dispatch"]],
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

/**
 * Every `uses:` in one file. Composite actions are included: a third-party
 * action hidden inside a composite action (.github/actions/NAME/action.yml)
 * same credentials as one written in a workflow, and scanning only
 * `.github/workflows` would have missed the tailscale ref entirely.
 */
function scanUses(name, text, counters) {
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)\s*(?:#\s*(.*?)\s*)?$/.exec(line);
    if (!m) return;
    const [, ref, comment] = m;
    if (ref.startsWith("./") || ref.startsWith(".\\")) return; // in-repo

    const owner = ref.split("/")[0];
    const at = ref.lastIndexOf("@");
    const version = at === -1 ? "" : ref.slice(at + 1);

    if (TAG_ALLOWED_OWNERS.has(owner)) {
      if (!SHA_REF.test(version)) counters.firstPartyOnTag++;
      return;
    }

    counters.thirdParty++;
    if (!SHA_REF.test(version)) {
      problems.push(
        `${name}:${i + 1} third-party action on a mutable ref: ${ref}. ` +
          `Pin it to a full 40-character commit SHA (TD-026). A tag can be ` +
          `moved by its owner, so the code running next to this job's ` +
          `credentials would change with no commit in this repo.`,
      );
      return;
    }
    // A SHA with no version beside it is unreadable to a human and is what
    // dependabot rewrites, so the comment is load-bearing, not decoration.
    if (!/^v?\d/.test(comment ?? "")) {
      problems.push(
        `${name}:${i + 1} ${ref} is pinned but carries no version comment. ` +
          `Append \`# vX.Y.Z\`: it is how a reader knows what the SHA is, and ` +
          `how dependabot raises it.`,
      );
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

const counters = { thirdParty: 0, firstPartyOnTag: 0 };
for (const f of files) scanUses(f, readFileSync(join(DIR, f), "utf8"), counters);
for (const dir of ACTION_DIRS) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const candidate of ["action.yml", "action.yaml"]) {
      const full = join(dir, entry.name, candidate);
      try {
        scanUses(join(entry.name, candidate), readFileSync(full, "utf8"), counters);
      } catch {
        // the other spelling
      }
    }
  }
}

if (problems.length === 0) {
  console.log(
    `[workflows] OK - ${files.length} workflow files parse, declare their ` +
      `pinned triggers, and every one of ${counters.thirdParty} third-party ` +
      "action refs is a SHA with a version comment.",
  );
  console.log(
    `  Not covered, deliberately: ${counters.firstPartyOnTag} first-party ` +
      "(actions/*, github/*) refs are on tags. TD-026 scoped pinning to the " +
      "credential path; OpenSSF Scorecard would pin these too, and that is a " +
      "decision this guardrail does not get to make on its own.",
  );
  process.exit(0);
}

console.log(`[workflows] ${problems.length} problem(s):`);
for (const p of problems) console.log(`  ${p}`);
if (STRICT) {
  console.error("\n[workflows] STRICT: a workflow that cannot be parsed is indistinguishable from one that does not exist.");
  process.exit(1);
}
process.exit(0);
