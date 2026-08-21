#!/usr/bin/env node
/**
 * check-query-filters.mjs - a list endpoint must refuse a filter it does not know.
 *
 * Nest's `@Query("name")` binds only the parameters it is asked for and drops
 * the rest without a word. On an endpoint that takes no filters that is
 * harmless. On one that does, an unrecognised filter is simply not applied, so
 * the caller gets HTTP 200 and a well-formed body that answers a different
 * question than the one they asked - `/capability/grants?productCode=vxtpl`
 * returning every tenant's grants, presented as vxtpl's.
 *
 * `rejectUnknownFilters` closes that, but only where somebody remembered to
 * call it, and only while its hand-written list still matches the parameters
 * the handler actually declares. Both halves rot silently: adding a `@Query`
 * without extending the list makes a valid filter get rejected, and renaming a
 * parameter without touching the list re-opens the original hole. Neither is a
 * type error, because the list is a string array.
 *
 * So this is the check that holds the invariant instead of a comment claiming
 * it: for every GET handler that declares filters, the guard is called and the
 * list it is given equals the set of `@Query("...")` names in the signature.
 *
 *   node scripts/guardrails/check-query-filters.mjs [--strict]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "service", "src");

/**
 * Both planes' guards. The operator plane throws a BadRequest envelope; the
 * consumption plane needs a code from the runtime vocabulary, so it wraps the
 * split form under its own name (`rejectUnknownV1Filters`). Matching the shape
 * rather than a fixed list of names is deliberate: a third plane with a third
 * envelope should be covered by this check on the day it is written, not on
 * the day somebody remembers to add its wrapper here.
 */
const GUARD_CALL = /\b(?:reject)?[Uu]nknown[A-Za-z0-9]*Filters\(/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

/** Span of a balanced (...) or {...} starting at the first `open` at/after `from`. */
function balanced(text, from, open, close) {
  const start = text.indexOf(open, from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * The handler body, skipping the return-type annotation. Taking the first `{`
 * after the parameter list finds the wrong brace whenever the return type has
 * one of its own - `: Promise<{ endpoints: GrantedEndpoint[] }>` - and then the
 * check reports a guard as missing while looking at a type. Only `<...>` can
 * intervene here, so tracking angle depth is enough.
 */
function bodyAfterSignature(text, from) {
  let angle = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === "<") angle += 1;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "{" && angle === 0) return balanced(text, i, "{", "}");
  }
  return null;
}

const problems = [];

for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file).split("\\").join("/");
  const getRe = /@Get\(([^)]*)\)/g;
  let match;
  while ((match = getRe.exec(text)) !== null) {
    const route = match[1] || '""';
    const sig = balanced(text, match.index + match[0].length, "(", ")");
    if (!sig) continue;
    const signature = text.slice(sig.start, sig.end + 1);

    const declared = [...signature.matchAll(/@Query\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    if (declared.length === 0) continue;

    const where = `${rel}:${lineOf(text, match.index)} @Get(${route})`;

    if (!/@Query\(\)/.test(signature)) {
      problems.push(
        `${where}\n    declares filters ${JSON.stringify(declared.sort())} but takes no ` +
          `bare @Query() parameter, so unknown filters cannot be seen, let alone refused.`,
      );
      continue;
    }

    const body = bodyAfterSignature(text, sig.end + 1);
    const source = body ? text.slice(body.start, body.end + 1) : "";
    const found = GUARD_CALL.exec(source);
    const call = found ? found.index : undefined;

    if (call === undefined) {
      problems.push(
        `${where}\n    declares filters ${JSON.stringify(declared.sort())} but never calls ` +
          `an unknown-filter guard, so an unknown filter is dropped and the caller ` +
          `receives an unfiltered result as the answer to a filtered question.`,
      );
      continue;
    }

    // The list is the first array literal in the guard call - either an inline
    // literal or a named const declared in the same file.
    const args = balanced(source, call, "(", ")");
    const argText = args ? source.slice(args.start, args.end + 1) : "";
    let listed = null;
    const inline = balanced(argText, 0, "[", "]");
    if (inline) {
      listed = [...argText.slice(inline.start, inline.end + 1).matchAll(/"([^"]+)"/g)].map(
        (m) => m[1],
      );
    } else {
      const named = /,\s*([A-Z][A-Z0-9_]*)\s*[,)]/.exec(argText);
      if (named) {
        const decl = new RegExp(`${named[1]}\\s*(?::[^=]+)?=\\s*\\[`).exec(text);
        const span = decl ? balanced(text, decl.index, "[", "]") : null;
        if (span) {
          listed = [...text.slice(span.start, span.end + 1).matchAll(/"([^"]+)"/g)].map(
            (m) => m[1],
          );
        }
      }
    }

    if (listed === null) {
      problems.push(
        `${where}\n    calls the guard but this check could not resolve the accepted list. ` +
          `Pass an inline array literal or an UPPER_SNAKE const declared in the same file, ` +
          `so the list stays checkable.`,
      );
      continue;
    }

    const missing = declared.filter((name) => !listed.includes(name));
    const extra = listed.filter((name) => !declared.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `${where}\n    the accepted list and the declared parameters disagree.` +
          (missing.length
            ? `\n      declared but not accepted: ${missing.sort().join(", ")} (the handler ` +
              `reads them, the guard rejects them - a valid request 400s)`
            : "") +
          (extra.length
            ? `\n      accepted but not declared: ${extra.sort().join(", ")} (the guard lets ` +
              `them through, the handler ignores them - the hole this check exists to close)`
            : ""),
      );
    }
  }
}

if (problems.length > 0) {
  console.error("Query-filter guard check FAILED:\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error(
    `${problems.length} handler(s). See service/src/http-query.ts for why a refusal ` +
      `beats a silently different answer.`,
  );
  process.exit(1);
}

console.log("Query-filter guard check passed: every filtered GET refuses unknown filters.");
