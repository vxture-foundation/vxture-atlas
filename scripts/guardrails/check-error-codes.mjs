#!/usr/bin/env node
/**
 * check-error-codes.mjs - consumption-plane error envelope guardrail
 * (product_251 X-1).
 *
 * X-1 makes two promises to whoever calls /v1, and both are the kind that rot
 * quietly: nothing fails, the envelope just stops being uniform, and the cost
 * lands on a consumer months later. So they are checked, not reviewed.
 *
 *   1. EVERY error carries a `code`. A bare-string `BadRequestException("...")`
 *      is rendered by Nest as `{statusCode, message, error}` - no `code` at all.
 *      That was a real second envelope shape on this surface, and the one a new
 *      consumer hit first (vxtpl, vxture-atlas#198: they had to write a third
 *      error branch just to parse it).
 *
 *   2. The published vocabulary is the ACTUAL vocabulary. Both halves matter:
 *      a declared code nobody throws is a dead branch a consumer wrote for
 *      nothing; a thrown code nobody declared never reaches their branch list
 *      at all. Before X-1 this repo had three of the first (including
 *      QUOTA_EXHAUSTED, which a liaison letter had promised karda) and two of
 *      the second.
 *
 * Deliberately NOT checked: the C3 provisioning webhook. Its caller is the
 * platform's outbox, not an agent, so it is not the consumption plane X-1
 * governs - see docs/40-implementation/40-l1-api-conformance.md.
 *
 * Modes: default lists violations as a worklist (exit 0); `--strict` fails hard
 * (exit 1) for CI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join("service", "src");
const ERRORS_FILE = join(SRC_ROOT, "runtime", "runtime.errors.ts");
const STRICT = process.argv.includes("--strict");

// The consumption plane: /v1/* and everything reached from it. `registry` is
// in the list because the routing and UUID rejections a caller actually
// receives (ENDPOINT_NOT_ROUTABLE, INVALID_TENANT_ID, ...) are thrown from the
// repository, not from the controller - scoping by "where the route is
// declared" would have declared four live codes dead.
const CONSUMPTION_DIRS = [
  "runtime",
  "registry",
  "embedding",
  "rerank",
  "parse",
  "providers",
  "quota",
  "router",
  "tenancy",
];

// Other planes, with their own consumers and their own envelopes:
//   - operator (/capability/*)      -> a console, not an agent
//   - internal diagnostics          -> no external consumer at all
//   - C3 provisioning webhook       -> the platform outbox
// Excluded from the VOCABULARY check only; check 1 (an error must carry a
// code at all) still applies to them.
const FOREIGN_PLANE = [
  join("runtime", "guards", "operator-auth.guard.ts"),
  join("runtime", "guards", "internal-diagnostics.guard.ts"),
];

const NEST_HTTP_EXCEPTIONS = [
  "BadRequestException",
  "UnauthorizedException",
  "ForbiddenException",
  "NotFoundException",
  "ConflictException",
  "GoneException",
  "PayloadTooLargeException",
  "UnprocessableEntityException",
  "InternalServerErrorException",
  "ServiceUnavailableException",
];

// The quote class is concatenated rather than inlined: a literal backtick
// inside a String.raw template would have to be backslash-escaped, and
// String.raw would then keep that backslash and make the pattern invalid.
const QUOTE_CLASS = "[`\"']";
/** The constructor call itself, anchored on the line that opens it. */
const EXCEPTION_OPEN = new RegExp(
  String.raw`new\s+(${NEST_HTTP_EXCEPTIONS.join("|")})\s*\(`,
  "u",
);
/** What follows the paren, once leading whitespace/newline is skipped. */
const OPENS_WITH_LITERAL = new RegExp(String.raw`^\s*` + QUOTE_CLASS, "u");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

function consumptionPlaneFiles() {
  return CONSUMPTION_DIRS.flatMap((dir) => {
    const full = join(SRC_ROOT, dir);
    try {
      return statSync(full).isDirectory() ? walk(full) : [];
    } catch {
      return [];
    }
  });
}

/**
 * Read the vocabulary out of the RETRYABLE table rather than the union: the
 * table is an exhaustive `Record` over the union, so type-check already proves
 * they agree, and the table's keys are trivially parseable without a TS parser.
 */
function declaredCodes(source) {
  const table = /const RETRYABLE: Record<[^>]+> = \{([\s\S]*?)\n\};/u.exec(
    source,
  );
  if (!table) {
    throw new Error(
      `could not find the RETRYABLE table in ${ERRORS_FILE} - did it get renamed?`,
    );
  }
  return new Set(
    [...table[1].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gmu)].map((m) => m[1]),
  );
}

const violations = [];
const errorsSource = readFileSync(ERRORS_FILE, "utf8");
const declared = declaredCodes(errorsSource);
const files = consumptionPlaneFiles();

// --- check 1: no codeless HTTP exception on the consumption plane ------------
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const open = EXCEPTION_OPEN.exec(line);
    if (!open) continue;
    // Anchor on the OPENING line, then look at what follows the paren - on the
    // same line, or on the next one when Prettier wrapped a longer message.
    // Matching a two-line window instead would report the same throw twice.
    const after = line.slice(open.index + open[0].length);
    const argument = after.trim() === "" ? (lines[index + 1] ?? "") : after;
    if (OPENS_WITH_LITERAL.test(argument)) {
      violations.push(
        `${relative(".", file)}:${index + 1}  bare-string HTTP exception - ` +
          `no \`code\` reaches the caller (X-1). Throw ModelRuntimeException ` +
          `with a vocabulary code instead.`,
      );
    }
  }
}

// --- check 2: declared vocabulary == emitted vocabulary ----------------------
const emitted = new Set();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (file.endsWith("runtime.errors.ts")) continue;
  if (FOREIGN_PLANE.some((suffix) => file.endsWith(suffix))) continue;
  for (const match of source.matchAll(/"([A-Z][A-Z0-9_]{3,})"/gu)) {
    if (declared.has(match[1])) emitted.add(match[1]);
  }
  // A string that LOOKS like a code but is not declared, used where a code
  // belongs - `code: "..."` or as ModelRuntimeException's second argument.
  for (const match of source.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]{3,})"/gu)) {
    if (!declared.has(match[1])) {
      violations.push(
        `${relative(".", file)}  emits \`${match[1]}\`, which is not in the ` +
          `published vocabulary - a consumer cannot find it in the list.`,
      );
    }
  }
}

for (const code of declared) {
  if (!emitted.has(code)) {
    violations.push(
      `${relative(".", ERRORS_FILE)}  declares \`${code}\` but nothing throws ` +
        `it - a consumer would write a branch that can never run.`,
    );
  }
}

// --- report -----------------------------------------------------------------
if (violations.length === 0) {
  console.log(
    `check-error-codes: OK (${declared.size} codes, all reachable; ` +
      `${files.length} consumption-plane files carry no codeless exception)`,
  );
  process.exit(0);
}

console.log(
  `check-error-codes: ${violations.length} violation(s) of product_251 X-1\n`,
);
for (const violation of violations) console.log(`  ${violation}`);

if (STRICT) {
  console.log("\n--strict: failing the build.");
  process.exit(1);
}
process.exit(0);
