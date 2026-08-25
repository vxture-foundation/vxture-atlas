/**
 * assertion-free-tests.mjs - a green test that asserts nothing (audit L4).
 *
 * Round two closed TD-039 and, on the way, REVERSED two existing tests that had
 * been asserting the wrong behaviour: green tests standing guard over a defect.
 * Every coverage metric counted those lines as covered. The weaker cousin of
 * that shape is a test case with no assertion at all - it passes as long as
 * nothing throws, which is exactly the failure mode the model probe had.
 *
 * xUnit Test Patterns names these smells (Assertion Roulette, Lying Test); the
 * industry tool for them is mutation testing, which this repo now runs against
 * its guardrails but not against its suite. This dimension is the cheap half:
 * find the cases where there is provably nothing to mutate against.
 *
 * DELIBERATELY NOT COVERED:
 *   - whether an assertion asserts the RIGHT thing. That is the TD-039 shape,
 *     and no lexical scan reaches it - only mutation testing of the service
 *     would, and that is not built.
 *   - `expect` reached through a helper. A case that calls a shared
 *     `expectRejects(...)` is counted as assertion-free here and is a false
 *     positive; the report lists cases, it does not fail a build on them.
 *   - assertions inside `afterEach` / custom matchers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const meta = {
  id: "assertion-free-tests",
  title: "断言为空的测试用例",
  covered: [
    "service/ 下每个 *.spec.ts 里的 it(...) / test(...) 用例体内是否出现 expect(",
    "统计口径：用例总数、无 expect 的用例、所在文件",
  ],
  notCovered: [
    "断言的是不是正确的行为 —— TD-039 反转过两条断言错误行为的测试，词法扫描够不到，只有对服务做变异测试才够得到，而那个没建",
    "通过 helper 间接调用 expect 的用例（会被记成假阳性，所以本维度只报清单、不设 CI 红线）",
    "afterEach / 自定义 matcher 里的断言",
    "括号配平是刻意的笨办法：它读得懂 it.each(表)(体) 的两段调用，读不懂更花哨的包装；数错会以清单形式暴露，而不是无声",
  ],
};

const ROOT = join("service", "src");

function* specFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* specFiles(full);
    else if (entry.endsWith(".spec.ts")) yield full;
  }
}

/**
 * Slice out each `it(...)`/`test(...)` body by brace balance. Good enough for
 * this codebase's style and deliberately dumb: it reports what it found and
 * how it counted, so a wrong count is visible rather than silent.
 */
function cases(source) {
  const out = [];
  // The lookbehind is load-bearing. `\b` also matches between a dot and
  // `test`, so `/re/.test(x)` reads as a test case containing no assertion.
  // That was the last false positive standing after the it.each fix: exactly
  // one, reported as a real finding, and wrong.
  const opener =
    /(?<![.\w$])(?:it|test)(?:\.(?:each|only|skip|todo|concurrent|failing))?\s*\(/gu;
  for (const m of source.matchAll(opener)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    // `it.each([...])("name", fn)` is two call groups: balancing the first one
    // stops at the end of the DATA TABLE, so the test body is never seen and
    // every parameterised case reads as assertion-free. A first pass reported
    // exactly that, in bulk. Take the following group too when there is one.
    let end = i;
    let k = i + 1;
    while (k < source.length && /\s/u.test(source[k])) k++;
    if (source[k] === "(") {
      let d = 0;
      for (let q = k; q < source.length; q++) {
        if (source[q] === "(") d++;
        else if (source[q] === ")") {
          d--;
          if (d === 0) {
            end = q;
            break;
          }
        }
      }
    }
    const body = source.slice(m.index, end + 1);
    const name = /["'`](.+?)["'`]/su.exec(body);
    out.push({ line: source.slice(0, m.index).split("\n").length, name: name?.[1] ?? "?", body });
  }
  return out;
}

export async function run({ log }) {
  const findings = [];
  let total = 0;
  let scanned = 0;

  for (const file of specFiles(ROOT)) {
    scanned++;
    const source = readFileSync(file, "utf8");
    for (const c of cases(source)) {
      total++;
      if (c.body.includes("expect(")) continue;
      if (/\.(?:todo|skip)\s*\(/u.test(c.body.slice(0, 24))) continue;
      findings.push({
        severity: "medium",
        title: `无断言用例：${relative(".", file)}:${c.line}`,
        detail: `"${c.name.slice(0, 90)}" 体内没有 expect(。它只要不抛异常就通过 —— 和探针此前的判绿口径相同。`,
      });
    }
  }

  log(`  scanned ${scanned} spec files, ${total} cases, ${findings.length} without expect(`);
  return { findings, probed: total };
}
