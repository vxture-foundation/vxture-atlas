/**
 * guardrail-mutation.mjs - does each CI guardrail actually bite? (audit L1)
 *
 * Industry calls this mutation testing (Stryker / PIT / mutmut): inject a known
 * defect, assert the check goes red, and treat a check that stays green as the
 * defect. Round two did this to eight guardrails BY HAND, once, and never
 * again - which means today the repo has nine guardrails and no standing
 * evidence that any of them still bites. A check that cannot fail and a
 * codebase with no defects print the same line.
 *
 * Each guardrail below gets a mutation that its own header claims it catches.
 * Three results are possible and they are not the same:
 *
 *   bites        the mutation landed and the guardrail exited non-zero. Good.
 *   DOES NOT BITE the mutation landed and the guardrail stayed green. Finding.
 *   unreadable   the mutation did not land uniquely, or the clean baseline was
 *                already red. NOT a pass - the run proved nothing and says so.
 *
 * The baseline matters as much as the mutation: a guardrail that is red before
 * the mutation would "bite" for a reason that has nothing to do with it.
 *
 * DELIBERATELY NOT COVERED, and no regex here could cover it: whether the
 * mutation is REPRESENTATIVE. Proving a guardrail catches one planted defect is
 * not proving it catches the class. This dimension answers "is the check
 * alive", not "is the check sufficient" - the second question belongs to the
 * per-guardrail tests and to whoever reads the guardrail's own header.
 */

import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { withWorktree, resetWorktree } from "../lib/isolate.mjs";
import { applyEdit } from "../lib/edit.mjs";

export const meta = {
  id: "guardrail-mutation",
  title: "十条 CI guardrail 逐个变异测试（十二条变异）",
  covered: [
    "每条 guardrail 在一个它自称会抓的已知坏输入上，是否真的以非零码退出",
    "变异前的干净基线是否为绿（否则变异后的红不可读）",
    "变异是否恰好命中一处（needle 命中 0 次或多次一律判为不可读，不判为通过）",
  ],
  notCovered: [
    "变异是否有代表性 —— 抓住一个植入缺陷不等于抓住这一类，这一半归 guardrail 自己的 header 与逐条测试",
    "guardrail 之外的检查（vitest 套件、tsc、lint）不在本维度",
    "guardrail 在 CI 里是否真的被调用 —— 那是 ci.yml 的事，见 workflow guardrail",
  ],
};

/**
 * One mutation per guardrail, each aimed at something the guardrail's own
 * header says it catches. `why` is printed with the result so a reader can
 * judge the mutation instead of trusting it.
 */
const MUTATIONS = [
  {
    guardrail: "check-request-contract",
    why: "词表里多一个从未发布的 *_REQUIRED 码",
    edit: {
      file: "service/src/runtime/runtime.errors.ts",
      find: '  | "WORKSPACE_ID_REQUIRED"',
      replace: '  | "WORKSPACE_ID_REQUIRED"\n  | "AUDIT_PROBE_UNPUBLISHED_REQUIRED"',
    },
  },
  {
    guardrail: "check-error-codes",
    why: "码表里多一个声明了但从不抛出的码",
    edit: {
      file: "service/src/runtime/runtime.errors.ts",
      find: "\n  WORKSPACE_ID_REQUIRED:",
      replace: "\n  AUDIT_PROBE_DECLARED_NEVER_THROWN: 400,\n  WORKSPACE_ID_REQUIRED:",
    },
  },
  {
    guardrail: "check-data-architecture",
    // The other direction (a column in DDL and not in Prisma) is deliberately
    // NON-fatal - incr/12 narrowed a write surface exactly that way. Mutating
    // that direction would have proved nothing, and a first pass did.
    why: "Prisma 多一列而 DDL 里没有（生产会把 INSERT 错误吞成 warning）",
    edit: {
      file: "service/prisma/schema.prisma",
      find: '  workspaceId            String?  @map("workspace_id") @db.Uuid',
      replace:
        '  workspaceId            String?  @map("workspace_id") @db.Uuid\n' +
        '  auditProbeColumn       String?  @map("audit_probe_column") @db.VarChar(8)',
    },
  },
  {
    guardrail: "check-di-metadata",
    why: "构造函数参数只靠类型注入，@Inject 被拿掉",
    edit: {
      file: "service/src/audit/audit.controller.ts",
      find: "constructor(@Inject(AuditService) private readonly audit: AuditService) {}",
      replace: "constructor(private readonly audit: AuditService) {}",
    },
  },
  {
    guardrail: "check-query-filters",
    why: "@Query 参数名与传给未知过滤器守卫的清单脱节",
    edit: {
      file: "service/src/audit/audit.controller.ts",
      find: '@Query("objectType") objectType?: string,',
      replace: '@Query("objectTypeRenamed") objectType?: string,',
    },
  },
  {
    guardrail: "check-column-writes",
    // Not `modelCode`: that one already has a REFUSED_BY_SERVICE guard, so it
    // is accounted for and the guardrail is right to stay green on it. The
    // mutation has to be a name that is neither granted nor refused.
    why: "运营面 Update 输入多出一个既未授权、也没有拒绝守卫的字段",
    edit: {
      file: "service/src/types/runtime.types.ts",
      find: "export interface UpdateAiModelInput {",
      replace: "export interface UpdateAiModelInput {\n  auditProbeField?: string;",
    },
  },
  {
    guardrail: "check-liaison-archive",
    why: "已冻结的 80-liaison/ 目录里新增一封 NN-*.md",
    edit: {
      file: "docs/80-liaison/50-2608251200-audit-probe.md",
      create: "# audit probe\n\nCreated by scripts/audit; must trip the archive guardrail.\n",
    },
  },
  {
    guardrail: "check-docs-numbering",
    // Uniqueness of a number is NOT one of its three stated checks, so a
    // duplicate-prefix file was out of scope and a first pass wrongly read its
    // green as a defect. A domain-prefixed name is in scope, explicitly.
    why: "平台仓才合法的 {kind}_{domain}_{NNN}_{slug} 命名出现在产品仓",
    edit: {
      file: "docs/20-specs/spec_atlas_010_audit_probe.md",
      create: "# audit probe\n\nA domain-prefixed name; the guardrail header calls this a violation here.\n",
    },
  },
  {
    guardrail: "check-workflows",
    why: "ci.yml 丢掉 pull_request 触发器，只留 workflow_dispatch",
    edit: {
      file: ".github/workflows/ci.yml",
      find: "on:\n  pull_request:\n    branches:\n      - main",
      replace: "on:\n  workflow_dispatch:",
    },
  },
  {
    // check-request-contract's second half. Its FIRST census - "every
    // *_REQUIRED code in the vocabulary is published" - was green while
    // /v1/parse enforced `task` and declared it nowhere, because that refusal
    // was named PARSE_TASK_INVALID. The naming convention was the hiding
    // place, so the census now reads the throw sites.
    guardrail: "check-request-contract",
    why: "把 /v1/parse 的 task 必填规则从已发布契约里撤掉（回到 2026-08-26 之前）",
    edit: {
      file: "service/src/runtime/request-contract.ts",
      find: '      { kind: "always", fields: ["task"], code: "PARSE_TASK_REQUIRED" },\n',
      replace: "",
    },
  },
  {
    // The defect that created this guardrail, replanted verbatim. It is the
    // only mutation here whose original cost was two false verifications: the
    // recipe said `IMAGE=`, compose read `IMAGE_NAMESPACE`, and the difference
    // was a locally-built image reporting `gitSha: unknown` while everything
    // else looked right.
    guardrail: "check-compose-invocations",
    why: "本机验证配方改回传 IMAGE=（compose 不读它，于是静默构建而非跑 CI 镜像）",
    edit: {
      file: "CLAUDE.md",
      find: "IMAGE_NAMESPACE=vxture-foundation IMAGE_TAG=pr-$PR",
      replace: "IMAGE=ghcr.io/vxture-foundation/atlas-app IMAGE_TAG=pr-$PR",
    },
  },
  {
    // Same guardrail, its other half. TD-026 pinned these once by hand; this
    // asks whether anything would notice them coming unpinned.
    guardrail: "check-workflows",
    why: "凭证路径上的第三方 action 从 SHA 退回可变 tag",
    edit: {
      file: ".github/workflows/sonar.yml",
      find:
        "uses: SonarSource/sonarqube-scan-action@" +
        "22918119ff8e1ca75a623e15c8296b6ea4fbe28f",
      replace: "uses: SonarSource/sonarqube-scan-action@v8",
    },
  },
];

/**
 * Run a guardrail from THIS repo against `cwd`. Returns its exit code.
 *
 * The script comes from the real repo; only the working directory is the
 * worktree. That matters because guardrails read their inputs relative to cwd
 * but resolve their dependencies relative to themselves - and a worktree has no
 * node_modules. `check-column-writes` loads `typescript` through
 * `createRequire(cwd + "/service/")`, which is anchored to the worktree, so
 * NODE_PATH carries it back to the real dependency tree. Without this the
 * guardrail dies on a missing module and the harness reports "baseline not
 * green" - an unreadable result the harness itself manufactured.
 */
function runGuardrail(repoRoot, name, cwd) {
  try {
    execFileSync(process.execPath, [`${repoRoot}/scripts/guardrails/${name}.mjs`, "--strict"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_PATH: [join(repoRoot, "service", "node_modules"), join(repoRoot, "node_modules")].join(delimiter) },
    });
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  }
}

export async function run({ repoRoot, log }) {
  const findings = [];

  await withWorktree(repoRoot, async (wt) => {
    for (const m of MUTATIONS) {
      const baseline = runGuardrail(repoRoot, m.guardrail, wt);
      if (baseline !== 0) {
        findings.push({
          severity: "unreadable",
          title: `${m.guardrail}: 干净基线就不是绿的（退出码 ${baseline}）`,
          detail:
            "变异后的红说明不了任何事，因为它在变异前就已经红。先修基线，再谈这条 guardrail 会不会咬。",
        });
        log(`  ${m.guardrail}: baseline NOT green (exit ${baseline}) - unreadable`);
        continue;
      }

      let landed;
      try {
        landed = applyEdit(wt, m.edit);
      } catch (err) {
        findings.push({
          severity: "unreadable",
          title: `${m.guardrail}: 变异没能唯一落地`,
          detail: `${err.message} 这不是通过，是这次测量作废。`,
        });
        log(`  ${m.guardrail}: mutation did not land - ${err.message}`);
        resetWorktree(wt);
        continue;
      }

      const after = runGuardrail(repoRoot, m.guardrail, wt);
      resetWorktree(wt);

      if (after === 0) {
        findings.push({
          severity: "high",
          title: `${m.guardrail} 不咬：${m.why}`,
          detail:
            `变异已确认落地（${landed}），guardrail 仍以 0 退出。` +
            "一条不会红的检查，和一份干净的代码，在 CI 里是同一行字。",
        });
        log(`  ${m.guardrail}: DOES NOT BITE (${m.why})`);
      } else {
        log(`  ${m.guardrail}: bites (exit ${after}) <- ${landed}`);
      }
    }
  });

  return { findings, probed: MUTATIONS.length };
}
