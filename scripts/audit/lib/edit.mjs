/**
 * edit.mjs - an edit that proves it landed, exactly once (audit L2).
 *
 * "Remove the fix and confirm the test goes red" is this repo's standing bar,
 * and on 2026-08-25 the ritual itself failed twice: the search needle
 * `"cachedInputUnitPrice",` also matched a line indented twenty spaces, so the
 * removal edited a different statement, the suite stayed green, and the run was
 * one step away from being reported as proof of coverage.
 *
 * So every mutation here is an assertion before it is an edit. A needle that
 * matches zero times, or more than once, is a broken mutation - NOT a passing
 * check - and it throws. A guardrail that stays green after a mutation that
 * never landed would otherwise read exactly like a guardrail that does not
 * bite, which is the same false negative one level up.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

/** Throws unless `resolve(root, file)` stays inside `root`. */
function inside(root, file) {
  const target = resolve(root, file);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..")) throw new Error(`edit escapes the worktree: ${file}`);
  return target;
}

/**
 * Apply one mutation. Returns a human-readable description of where it landed,
 * so a caller can print evidence rather than a claim.
 *
 * `{file, find, replace}` - `find` must occur exactly once.
 * `{file, create}`        - `file` must not already exist.
 */
export function applyEdit(root, edit) {
  const target = inside(root, edit.file);

  if (edit.create !== undefined) {
    if (existsSync(target)) {
      throw new Error(
        `mutation would overwrite an existing file (${edit.file}); a create ` +
          `mutation must introduce something new or it proves nothing`,
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, edit.create, "utf8");
    return `created ${edit.file} (${edit.create.length} bytes)`;
  }

  const before = readFileSync(target, "utf8");
  const hits = before.split(edit.find).length - 1;
  if (hits !== 1) {
    throw new Error(
      `mutation needle matched ${hits} times in ${edit.file}, expected exactly 1. ` +
        `A needle that matches zero times edits nothing; one that matches many ` +
        `edits the wrong thing. Either way the result that follows is unreadable.`,
    );
  }
  const at = before.slice(0, before.indexOf(edit.find)).split("\n").length;
  writeFileSync(target, before.replace(edit.find, edit.replace), "utf8");
  return `${edit.file}:${at} (1 hit, as required)`;
}
