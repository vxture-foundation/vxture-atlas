#!/usr/bin/env node
/**
 * check-di-metadata.mjs - every Nest DI constructor parameter must carry an
 * explicit `@Inject(...)`.
 *
 * Why this exists (TD-023): the deployed artifact is an esbuild bundle, and
 * esbuild does not implement `emitDecoratorMetadata` - it silently drops
 * `design:paramtypes` even though tsconfig.json sets the flag. A constructor
 * parameter injected by TYPE alone therefore resolves to `undefined` at
 * runtime. Nest does not throw: the class is constructed, the property is
 * undefined, and the first request that touches it 500s with
 * "Cannot read properties of undefined".
 *
 * Nothing else catches this:
 *   - tsc is happy; the types are correct.
 *   - vitest transpiles with swc, which DOES emit the metadata, and the specs
 *     construct controllers directly - so unit tests pass either way.
 *   - the bundle builds without a warning.
 *
 * That combination is how five controllers (embedding, rerank, parse, tenancy
 * and the C3 provisioning webhook) shipped broken on 2026-08-05 and were only
 * found by hitting them. This is the cheap half of the fix - the boot smoke
 * step in ci.yml is the other half, and catches the failures a static scan
 * cannot see (a provider missing from AtlasModule entirely).
 *
 * Pure node, zero dependencies - deliberately a scanner, not a TS parser. It
 * only has to recognise the two shapes Nest DI actually takes in this repo.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "service/src";
const STRICT = process.argv.includes("--strict");

/** A class is a DI participant if Nest is the one constructing it. */
const DI_DECORATOR = /@(Injectable|Controller)\s*\(/;

const problems = [];
let classesChecked = 0;
let paramsChecked = 0;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `generated/` is Prisma output - not ours, and not Nest.
      if (entry === "generated" || entry === "node_modules") continue;
      out.push(...walk(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts") || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip comments so a `@Inject` mentioned in prose (this repo has several
 * long comments ABOUT the trap) is never mistaken for a real decorator, and
 * a commented-out parameter is never counted.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (state === "code") {
      if (two === "//") { state = "line"; i += 2; continue; }
      if (two === "/*") { state = "block"; i += 2; continue; }
      // Keep strings intact - a `//` inside a URL is not a comment.
      if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
        const quote = src[i];
        out += src[i++];
        while (i < src.length) {
          if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
          out += src[i];
          if (src[i] === quote) { i++; break; }
          i++;
        }
        continue;
      }
      out += src[i++];
      continue;
    }
    if (state === "line") {
      if (src[i] === "\n") { state = "code"; out += "\n"; }
      i++;
      continue;
    }
    // block
    if (two === "*/") { state = "code"; i += 2; continue; }
    if (src[i] === "\n") out += "\n";
    i++;
  }
  return out;
}

/** Split a parameter list on top-level commas (types contain commas too). */
function splitParams(list) {
  const params = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      params.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  params.push(current);
  return params.map((p) => p.trim()).filter(Boolean);
}

/** Read the balanced `(...)` starting at `open`; returns [inner, endIndex]. */
function readBalanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return [src.slice(open + 1, i), i];
    }
  }
  return [null, -1];
}

/**
 * The contiguous decorator block on the lines immediately above a class
 * declaration. A linear backward line walk (paren balance handles multi-line
 * decorator arguments) instead of a single nested-quantifier regex, which
 * backtracks exponentially on adversarial input.
 */
function decoratorBlockAbove(src, classLineStart) {
  const above = src.slice(0, classLineStart).split("\n");
  const block = [];
  let pending = []; // tail lines of a possibly-multi-line decorator group
  let balance = 0; // ')' surplus accumulated while walking upward in a group
  for (let i = above.length - 1; i >= 0; i--) {
    const line = above[i];
    const opens = (line.match(/\(/g) ?? []).length;
    const closes = (line.match(/\)/g) ?? []).length;
    if (balance > 0) {
      pending.unshift(line);
      balance += closes - opens;
      if (balance <= 0) {
        if (!/^[^\S\n]*@[\w.]+/.test(line)) return block.join("\n");
        block.unshift(...pending);
        pending = [];
        balance = 0;
      }
      continue;
    }
    if (/^[^\S\n]*@[\w.]+/.test(line)) {
      block.unshift(line);
      continue;
    }
    if (closes > opens) {
      pending = [line];
      balance = closes - opens;
      continue;
    }
    break; // blank or code line - the contiguous block has ended
  }
  return block.join("\n");
}

for (const file of walk(ROOT)) {
  const src = stripComments(readFileSync(file, "utf8"));

  // Every class in the file; the decorator block is collected separately by
  // a linear scan so no regex has to model "zero or more decorator lines".
  const classRe = /(?:^|\n)[^\S\n]*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  let match;
  while ((match = classRe.exec(src))) {
    const className = match[1];
    // Boundary excludes the newline before the class line, so the backward
    // walk starts on the last line ABOVE the class (no trailing "" element).
    const boundary = match[0].startsWith("\n") ? match.index : 0;
    const decorators = decoratorBlockAbove(src, boundary);
    if (!DI_DECORATOR.test(decorators)) continue;

    // Find this class's constructor, bounded by the next class declaration so
    // a second class in the same file is never attributed to this one.
    const bodyStart = match.index + match[0].length;
    const nextClass = src.slice(bodyStart).search(/\n(?:export\s+)?(?:abstract\s+)?class\s+\w/);
    const body = src.slice(bodyStart, nextClass === -1 ? undefined : bodyStart + nextClass);

    const ctorAt = body.search(/\bconstructor\s*\(/);
    if (ctorAt === -1) continue;
    classesChecked++;

    const open = body.indexOf("(", ctorAt);
    const [inner] = readBalanced(body, open);
    if (inner === null) {
      problems.push(`${file}: ${className} - could not parse the constructor parameter list`);
      continue;
    }

    for (const param of splitParams(inner)) {
      paramsChecked++;
      if (param.includes("@Inject")) continue;
      const name = param.split(/[:=]/)[0].replace(/^(private|public|protected|readonly|\s)+/g, "").trim();
      problems.push(
        `${file}: ${className}.constructor parameter "${name}" has no @Inject() - ` +
          `esbuild drops design:paramtypes, so this resolves to undefined at runtime (TD-023)`,
      );
    }
  }
}

if (problems.length > 0) {
  console.log("[di-metadata] FAIL - Nest constructor parameters missing @Inject():");
  for (const p of problems) console.log(`  - ${p}`);
  console.log(
    "\n  Fix: annotate each parameter explicitly, e.g.\n" +
      "    constructor(@Inject(FooService) private readonly foo: FooService) {}",
  );
  process.exit(STRICT ? 1 : 0);
}

console.log(
  `[di-metadata] OK - ${paramsChecked} constructor parameters across ${classesChecked} Nest classes all carry @Inject().`,
);
