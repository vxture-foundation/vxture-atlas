/**
 * isolate.mjs - structural isolation for destructive verification (audit R3).
 *
 * The second audit round's most expensive event was a probe that verified
 * `.gitignore` by creating files in the repo root and cleaning up with an
 * `rm -rf` written against directory NAMES. That cleanup cannot tell "the
 * directory I just made" from "the directory that was already there", so it
 * emptied the running Postgres volume and `.env`.
 *
 * The rule that came out of it is not "be careful". It is that destructive
 * verification needs either a natural rollback or structural isolation:
 *
 *   - database side: `BEGIN; ... ROLLBACK;` - the only naturally safe form,
 *     and what the DB dimension already used.
 *   - filesystem side: no such thing exists, so the work happens in a git
 *     worktree. `data/`, `.env` and `.artifacts/` are untracked, so they do
 *     not exist there at all. It is not that the mutation behaves; it is that
 *     it cannot reach them.
 *
 * Cleanup is `git worktree remove`, a git operation against a path git itself
 * recorded - never a pattern match against a name. `resetWorktree` refuses to
 * run unless its target is the worktree this module created, so a caller
 * cannot aim it at the real tree by passing the wrong string.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Paths this module created. resetWorktree will touch nothing else. */
const OWNED = new Set();

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}


/**
 * Run `body(worktreeDir)` against a detached checkout of HEAD, then remove it.
 * The worktree is removed even if `body` throws.
 */
export async function withWorktree(repoRoot, body) {
  const dir = resolve(mkdtempSync(join(tmpdir(), "atlas-audit-")), "wt");
  git(["worktree", "add", "--detach", "--quiet", dir, "HEAD"], repoRoot);
  OWNED.add(dir);
  try {
    return await body(dir);
  } finally {
    OWNED.delete(dir);
    try {
      git(["worktree", "remove", "--force", dir], repoRoot);
    } catch {
      // A worktree we cannot remove is worth saying out loud rather than
      // swallowing: it is disk we leaked, and the path is the only way back.
      console.error(`  ! could not remove worktree ${dir} - remove it by hand`);
    }
  }
}

/**
 * Return the worktree to HEAD: tracked files restored, files the mutation
 * created dropped. Both are git operations scoped to `dir`.
 */
export function resetWorktree(dir) {
  const target = resolve(dir);
  if (!OWNED.has(target)) {
    throw new Error(
      `resetWorktree refused: ${target} is not a worktree this run created. ` +
        `This guard exists because the round-2 incident was a cleanup pointed ` +
        `at the wrong path.`,
    );
  }
  if (!existsSync(target)) throw new Error(`resetWorktree: ${target} is gone`);
  git(["checkout", "--", "."], target);
  // The exclusions are belt-and-braces. A worktree has no node_modules today -
  // dependencies are reached through NODE_PATH, precisely so that nothing here
  // has to create a link into the real tree that a clean could then follow.
  // If that ever changes, this line must already be safe.
  git(["clean", "-qfd", "-e", "node_modules", "-e", "service/node_modules"], target);
}
