/**
 * service-mutation.mjs - do the tests defending our load-bearing invariants
 * actually defend them? (audit L1 and L4, pointed at the suite instead of the
 * guardrails.)
 *
 * The shape this exists for is documented and expensive: closing TD-039 meant
 * REVERSING two existing tests that had been asserting the WRONG behaviour.
 * They were green, they were counted as coverage, and they stood guard over a
 * defect. `assertion-free-tests` finds the weak cousin (a case with no
 * assertion at all) and reports zero; nothing finds this one, because no
 * lexical scan can. Only removing the behaviour and watching what happens can.
 *
 * This is NOT a mutation score. Stryker would generate mutants across the whole
 * tree and give a number; that is the systematic version and it is not what
 * runs here. This is a PINNED set: a handful of invariants that would cost real
 * money or real trust if they regressed, each with the spec that is supposed to
 * catch it named alongside. A curated set answers "are the important tests
 * real", not "how good is the suite" - and it answers it in about two minutes,
 * which is what makes it runnable before every release rather than never.
 *
 * ISOLATION - and this one is a deliberate exception to how the rest of the
 * audit works, so it is argued rather than assumed. R3 allows either a natural
 * rollback or structural isolation. The guardrail dimension gets structural
 * isolation (a git worktree). Vitest cannot: it needs the installed dependency
 * tree, and the one time this repo linked a real dependency tree into a
 * worktree, removing the worktree followed the link and emptied node_modules.
 * So this dimension takes the OTHER branch - the natural rollback:
 *
 *   - it refuses to run at all unless `git status --porcelain` is empty, so
 *     `git checkout -- <file>` is an exact undo rather than an approximate one;
 *   - it only ever edits files that are tracked and unmodified;
 *   - it restores in a `finally`, and again from an `exit` handler if the
 *     process dies between the two;
 *   - and it prints the recovery command when it cannot.
 *
 * That is the same argument the DB dimension already relies on with
 * `BEGIN; ... ROLLBACK;`. It is weaker than isolation and is stated as weaker.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { applyEdit } from "../lib/edit.mjs";

export const meta = {
  id: "service-mutation",
  title: "服务不变量的变异测试（钉住的一组）",
  covered: [
    "十一条承重不变量：探针输出预算、流式空交付判绿、成本拆分的“未上报不是 0”、wire.extraBody 保留键、推理 token 不重复计价、未声明缓存单价的回退方向、高峰窗口的半开边界、无策略供应商按全价、失败候选自己写行并带序号、失败尝试的 token 不被丢弃、契约指纹随必填规则移动",
    "每条变异点名它应当被哪个 spec 抓住，只跑那个 spec —— 抓不住时区分“套件没红”与“红在别处”",
    "变异前后各校验一次工作树干净，确保 git checkout 是精确回滚",
    "每个 spec 的干净基线只跑一次并复用；vitest 退出码 1 才算测试失败，其余非零一律记为崩溃、不算“挡住了”",
  ],
  notCovered: [
    "这不是 mutation score。系统性版本是 Stryker，跑全树、给一个数字；这里是刻意挑出来的一组，回答“重要的测试是不是真的”，不回答“套件有多好”",
    "钉住的清单之外的一切代码 —— 没被列进来的不变量，本维度对它一个字都没说",
    "断言是否断言了正确的行为 —— 变异只能证明“有东西在挡”，挡的对不对仍要人读",
    "运行时才成立的东西（列授权、真实上游、DB 约束）：vitest 里 Prisma 是 mock",
  ],
};

/**
 * Each entry: the invariant in one line, the edit that removes it, and the spec
 * that is supposed to notice. `spec` is a path under `service/`.
 */
const MUTATIONS = [
  {
    invariant: "探针输出预算随模型走，不是写死的小数字",
    why:
      "写死 16 token 正是 2026-08-25 那次接入故障的成因：思考链算在 completion 里，" +
      "预算在正文产出前烧光，模型看起来接不通。这条变异把那个缺陷装回去。",
    spec: "src/runtime/model-probe.service.spec.ts",
    edit: {
      file: "service/src/runtime/model-probe.service.ts",
      find: "const PROBE_MAX_TOKENS = 2048;",
      replace: "const PROBE_MAX_TOKENS = 16;",
    },
  },
  {
    invariant: "流式一帧内容都没有就不能判绿",
    why:
      "只吐 reasoning_content 的模型回 HTTP 200、usage 齐全、零 token 交付。" +
      "旧探针只要不抛异常就判通过 —— 一个会给出假通过的自检比没有自检更糟。",
    spec: "src/runtime/model-probe.service.spec.ts",
    edit: {
      file: "service/src/runtime/model-probe.service.ts",
      find: "        ok: outcome.contentReceived,",
      replace: "        ok: true,",
    },
  },
  {
    invariant: "上游没报的 token 拆分是缺席，不是 0",
    why:
      "写 0 会让缓存流量看起来免费，而不是未计量。这是 reqlog 里所有 token 列共用的纪律，" +
      "成本拆分列刚加上就必须跟着。",
    spec: "src/providers/openai-compatible.spec.ts",
    edit: {
      file: "service/src/providers/openai-compatible.ts",
      find: '    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),',
      replace: "    ...{ cachedInputTokens: cached ?? 0 },",
    },
  },
  {
    invariant: "config.wire.extraBody 不能覆盖保留键",
    why:
      "model / messages / stream / stream_options / system 一旦可被配置覆盖，" +
      "一条运营配置就能悄悄改掉路由与计量的输入，而请求本身照常成功。",
    spec: "src/providers/wire.spec.ts",
    edit: {
      file: "service/src/providers/wire.ts",
      // Anchored on the log line that names extraBody: the bare `if` also
      // occurs in the thinking merge (ADR-009), and a needle matching three
      // places made this probe unreadable (2026-09-30).
      find: "    if (RESERVED_BODY_KEYS.has(key)) {\n      logger.warn(\n        `ignoring config.wire.extraBody",
      replace: "    if (false) {\n      logger.warn(\n        `ignoring config.wire.extraBody",
    },
  },
  {
    invariant: "推理 token 不参与成本求和",
    why:
      "reasoningTokens 是 outputTokens 的子集，已经按输出价计过一次。" +
      "把它再加一遍，就是给每一个思考型模型的成本重复计价 —— 而结果看上去完全合理，只是更大。",
    spec: "src/observability/cost-rollup.spec.ts",
    edit: {
      file: "service/src/observability/cost-rollup.ts",
      // The needle moved twice: when off-peak pricing introduced `rate()`, and
      // when usage-record batch 2 extracted the formula into `priceUsage`
      // (shared with the per-row cost). Both times the harness reported
      // `unreadable`, not a pass - a mutation whose needle stops matching
      // tests nothing, and reads exactly like one that was defended. The
      // double count is now injected where the rollup hands output in. Batch 3
      // split that call over several lines and the needle moved a third time;
      // the harness again said `unreadable`, not pass.
      find: "        output: row.outputTokens,\n      },",
      replace: "        output: row.outputTokens + row.reasoningTokens,\n      },",
    },
  },
  {
    invariant: "未声明的缓存单价回退到未命中价，而不是当成免费",
    why:
      "NULL 是“没声明”，不是“免费”。当成 0 会让缓存那半凭空消失，" +
      "在 DeepSeek 上把那部分成本低估 30 倍 —— 低估比高估更危险，它不会有人来投诉。",
    spec: "src/observability/cost-rollup.spec.ts",
    edit: {
      file: "service/src/observability/cost-rollup.ts",
      // Moved into `priceUsage` by usage-record batch 2.
      find: "    rates.cachedInputUnitPrice === null\n      ? inputPrice",
      replace: "    rates.cachedInputUnitPrice === null\n      ? 0n",
    },
  },
  {
    invariant: "高峰窗口是半开区间，边界不多吃一小时",
    why:
      "供应商写的是 01:00-04:00，即 04:00 已经不是高峰。把 < 写成 <=，" +
      "每天多算一小时全价 —— 一个方向明确、幅度很小、永远不会有人来投诉的偏差。",
    spec: "src/observability/pricing-window.spec.ts",
    edit: {
      file: "service/src/observability/pricing-window.ts",
      find: "hour >= w.fromHour && hour < w.toHour",
      replace: "hour >= w.fromHour && hour <= w.toHour",
    },
  },
  {
    invariant: "没有声明策略的供应商按全价计，不按折扣计",
    why:
      "把默认从“高峰”翻成“低谷”，会给每一个还没配策略的供应商凭空打五折，" +
      "而账面看起来完全正常 —— 只是少了一半。",
    spec: "src/observability/cost-rollup.spec.ts",
    edit: {
      file: "service/src/observability/cost-rollup.ts",
      find: "      policy === null || !placeable\n        ? true",
      replace: "      policy === null || !placeable\n        ? false",
    },
  },
  {
    invariant: "失败的候选也写自己那一行，并带上尝试序号",
    why:
      "chat 此前整条失败转移链只写一行，失败候选只活在日志和 Prometheus 计数器里 —— " +
      "而它们花掉了真实的供应商开销和延迟。序号丢了，链条就没法重建，" +
      "按供应商的错误率也就仍然只能从指标而不是 reqlog 得出。",
    spec: "src/runtime/runtime.service.spec.ts",
    edit: {
      file: "service/src/runtime/runtime.service.ts",
      find:
        "      // allow one word to carry both. The ordinal says it without ambiguity.\n" +
        "      ...(attemptIndex !== undefined ? { attemptIndex } : {}),",
      replace:
        "      // allow one word to carry both. The ordinal says it without ambiguity.\n" +
        "      ...(false ? { attemptIndex } : {}),",
    },
  },
  {
    invariant: "失败尝试报上来的 token 不被丢弃",
    why:
      "只有一种失败带得出 usage —— 上游回了完整 usage 却没有正文，也就是思考型模型" +
      "把输出预算烧在推理链上的那种，正是开启这条工作线的那个故障。它花掉的钱是真的。" +
      "把 usage 从错误里读回来的那一步一旦没了，行还在、钱又没了，而且看不出区别。",
    spec: "src/runtime/runtime.service.spec.ts",
    edit: {
      file: "service/src/runtime/runtime.service.ts",
      find: "      ...(usageFromError(error) !== undefined",
      replace: "      ...(false",
    },
  },
  {
    // TD-046's exposure counter. Its whole value is that the number is SMALL
    // and therefore actionable - counting `tools` alone, or reasoning alone,
    // would report most of the fleet's traffic and get discounted.
    invariant: "推理曝光计数要求 tools 与推理同时成立",
    why:
      "只满足一个条件就计数，会把风险面报成流量面 —— 一个没人会据以行动的数字，" +
      "和没有这个数字是同一件事。",
    spec: "src/observability/reasoning-tool-exposure.spec.ts",
    edit: {
      file: "service/src/observability/reasoning-tool-exposure.ts",
      find: "  if (!input.toolsPresent) return undefined;\n",
      replace: "",
    },
  },
  {
    invariant: "契约指纹随必填规则移动",
    why:
      "指纹不动，消费方轮询到的就是“什么都没变” —— 这正是工具描述符里那个手维护 " +
      "version 字段犯过的错：用一个不可能变的字段回答“变了吗”。",
    spec: "src/runtime/contract.spec.ts",
    edit: {
      file: "service/src/runtime/contract.ts",
      find: "    ...ruleLines,\n",
      replace: "",
    },
  },
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Files currently mutated, so an unexpected exit still restores them. */
const PENDING = new Map();
process.on("exit", () => {
  for (const [file, root] of PENDING) {
    try {
      git(["checkout", "--", file], root);
    } catch {
      console.error(`  ! RESTORE BY HAND: git checkout -- ${file}`);
    }
  }
});

/**
 * Run one spec. Returns its exit code.
 *
 * Vitest is invoked through its own entry point rather than `npx`, and without
 * a shell. The first version used `npx` with `shell: true` and the first run of
 * a session died with 0xC0000005 - an access violation, not a test failure. It
 * was reported as "baseline not green", which is the correct verdict for a
 * crash and a completely wrong one for the invariant being measured.
 *
 * Which is why the caller distinguishes 1 from everything else: vitest exits 1
 * when tests fail, and any OTHER non-zero code means the run did not get far
 * enough to have an opinion. Treating a crash as a red - "something stopped the
 * mutation, good" - is the exact failure this whole dimension exists to catch.
 */
function runSpec(repoRoot, spec) {
  try {
    execFileSync(
      process.execPath,
      [join("node_modules", "vitest", "vitest.mjs"), "run", spec, "--reporter=dot"],
      {
        cwd: join(repoRoot, "service"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  }
}

/** Vitest says "tests failed" with 1. Anything else non-zero is a crash. */
const TESTS_FAILED = 1;

export async function run({ repoRoot, log }) {
  const findings = [];

  const dirty = git(["status", "--porcelain"], repoRoot).trim();
  if (dirty) {
    return {
      findings: [
        {
          severity: "unreadable",
          title: "工作树不干净，本维度拒绝运行",
          detail:
            "变异直接改真实文件，靠 `git checkout -- <file>` 回滚；" +
            "树不干净时那条回滚会连带丢掉未提交的改动。" +
            `先提交或 stash：\n${dirty.split("\n").slice(0, 5).join("\n")}`,
        },
      ],
      probed: 0,
    };
  }

  // Two mutations can name the same spec, and its clean baseline does not
  // change between them. Each vitest start costs ~13s of transform before a
  // single test runs, so caching this is most of the difference between a step
  // that gets run before a release and one that gets skipped.
  const baselines = new Map();
  const baselineOf = (spec) => {
    if (!baselines.has(spec)) baselines.set(spec, runSpec(repoRoot, spec));
    return baselines.get(spec);
  };

  for (const m of MUTATIONS) {
    const baseline = baselineOf(m.spec);
    if (baseline !== 0) {
      findings.push({
        severity: "unreadable",
        title: `${m.spec}: 变异前就是红的（退出码 ${baseline}）`,
        detail: "变异后的红说明不了任何事。先修基线。",
      });
      log(`  ${m.invariant}: baseline NOT green - unreadable`);
      continue;
    }

    let landed;
    try {
      landed = applyEdit(repoRoot, m.edit);
    } catch (err) {
      findings.push({
        severity: "unreadable",
        title: `变异没能唯一落地：${m.invariant}`,
        detail: `${err.message} 这不是通过，是这次测量作废。`,
      });
      log(`  ${m.invariant}: mutation did not land - ${err.message}`);
      continue;
    }
    PENDING.set(m.edit.file, repoRoot);

    let after;
    try {
      after = runSpec(repoRoot, m.spec);
    } finally {
      git(["checkout", "--", m.edit.file], repoRoot);
      PENDING.delete(m.edit.file);
    }

    if (after !== 0 && after !== TESTS_FAILED) {
      findings.push({
        severity: "unreadable",
        title: `变异后进程崩溃，不是测试失败：${m.invariant}`,
        detail:
          `${m.spec} 以退出码 ${after} 结束。红得不是地方 —— ` +
          "把崩溃读成“有东西挡住了变异”，正是本维度存在的理由所反对的那件事。",
      });
      log(`  ${m.invariant}: CRASHED after mutation (exit ${after}) - unreadable`);
    } else if (after === 0) {
      findings.push({
        severity: "high",
        title: `没有测试挡着：${m.invariant}`,
        detail:
          `${m.why} 变异已确认落地（${landed}），而 ${m.spec} 仍然全绿。` +
          "这条不变量现在只靠人记得住，改掉它不会有任何东西反对。",
      });
      log(`  ${m.invariant}: NOT DEFENDED (${m.spec} stayed green)`);
    } else {
      log(`  ${m.invariant}: defended by ${m.spec} <- ${landed}`);
    }
  }

  const stillDirty = git(["status", "--porcelain"], repoRoot).trim();
  if (stillDirty) {
    findings.push({
      severity: "unreadable",
      title: "本维度结束时工作树不干净 —— 回滚可能没完成",
      detail: `请检查并手工恢复：\n${stillDirty}`,
    });
  }

  return { findings, probed: MUTATIONS.length };
}
