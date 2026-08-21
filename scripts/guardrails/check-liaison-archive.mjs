#!/usr/bin/env node
/**
 * check-liaison-archive.mjs - `docs/80-liaison/` is a frozen archive.
 *
 * `140-repo-governance-standard.md` sec.10 retired the md-letter channel on
 * 2026-07-27: cross-repo liaison goes through GitHub Issues, opened in the repo
 * that has to act. The standard names the two defects that killed the channel,
 * both from real incidents with karda and atlas:
 *
 *   1. a letter sent to the wrong repo has no lightweight correction path -
 *      only another letter apologising and re-sending;
 *   2. "written but not actually sent" has no enforced state, so a draft stalls
 *      and the other side acts on a stale assumption.
 *
 * Issues fix both natively: transfer, immediate visibility, close/reopen.
 *
 * This check enforces the freeze, and nothing else. It does not take a position
 * on whether an archived letter may be edited - that question only exists
 * because the freeze was not enforced. `40-2608131600` was created 2026-08-13,
 * seventeen days after the standard froze this directory, and every downstream
 * problem with it (three false statements reaching platform, a step-up
 * recommendation resting on them, a correction that sat unsent in this repo's
 * own index for two days, and two rounds of in-place editing) followed from a
 * file existing where an issue belonged. This check would have stopped it on
 * day one.
 *
 * Editing an existing archived letter is deliberately NOT checked here: it is
 * an index-level rule (`docs/80-liaison/00-index.md`) and the two repos held
 * opposite conventions until 2026-08-16, so freezing one reading into CI would
 * be settling an unsettled question by fiat. The freeze is settled - it is in
 * the org standard - so only the freeze is enforced.
 *
 *   node scripts/guardrails/check-liaison-archive.mjs [--strict]
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "docs", "80-liaison");
const LETTER = /^\d{2}-\d{10,14}-.+\.md$/;

/**
 * The archive as of the freeze. A file here that is not on this list was added
 * after 2026-07-27 and should have been an issue.
 *
 * `40-2608131600` is on the list and should not have been: it was created
 * 2026-08-13. It is grandfathered because it was really submitted and deleting
 * it would destroy the record platform decided against - not because it was
 * allowed. Do not add to this list; add an issue instead.
 */
const ARCHIVED = new Set([
  "10-2607241030-atlas-reply-to-karda-capability-requirements.md",
  "40-2608131600-atlas-operation-code-vocabulary.md",
]);

const present = readdirSync(DIR).filter((name) => LETTER.test(name));
const added = present.filter((name) => !ARCHIVED.has(name));

if (added.length > 0) {
  console.error("Liaison archive check FAILED:\n");
  for (const name of added) console.error(`  docs/80-liaison/${name}`);
  console.error(
    "\n`docs/80-liaison/` stopped accepting new files on 2026-07-27" +
      "\n(140-repo-governance-standard.md sec.10). Cross-repo liaison goes through" +
      "\nGitHub Issues, opened in the repo that has to act - not the one raising" +
      "\nthe ask - and labelled `liaison`." +
      "\n\nAn issue is visible the moment it exists (no silent draft state), can be" +
      "\ntransferred if it lands in the wrong repo, and close/reopen carries the" +
      "\nthread state that letters tracked by hand. A letter has none of that, which" +
      "\nis why the channel was retired.",
  );
  process.exit(1);
}

const missing = [...ARCHIVED].filter((name) => !present.includes(name));
if (missing.length > 0) {
  console.error("Liaison archive check FAILED - an archived letter is gone:\n");
  for (const name of missing) console.error(`  docs/80-liaison/${name}`);
  console.error(
    "\nArchived letters are the record of what a counterparty was told and" +
      "\ndecided against. Deleting one destroys that. If it is obsolete, say so" +
      "\nunder 'Superseded facts' in docs/80-liaison/00-index.md and leave the file.",
  );
  process.exit(1);
}

console.log(
  `Liaison archive check passed: ${present.length} archived letters, no new files.`,
);
