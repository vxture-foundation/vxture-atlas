/**
 * platform-claims.mjs - CLAUDE.md's claims about the live platform, asked of
 * the live platform (audit R1).
 *
 * This dimension exists because of a measured cost. Round two swept a dimension
 * literally named "release/deploy consistency", reported ZERO findings, and
 * concluded "main and production agree". At that moment the deployment doc said
 * release.yml only creates a tag and that production is gated by an approval -
 * both false. release.yml dispatches deploy.yml itself, and the production
 * Environment carries no protection rules at all. Seven days later a deploy was
 * run against that description, db-init was skipped, and reqlog INSERTs failed
 * whole for 32 seconds.
 *
 * The dimension was not lazy. It compared documents to documents and a version
 * tag to a version tag - the readable half. Nothing asked GitHub. Industry
 * calls the missing half drift detection (terraform plan -detailed-exitcode) or
 * compliance-as-code (InSpec, OPA/Conftest): assert the LIVE system, not a
 * description of it.
 *
 * Every claim below is quoted from CLAUDE.md or docs/50-deployment/, and every
 * one is answered by an API call rather than by another file.
 *
 * DELIBERATELY NOT COVERED:
 *   - anything on worker-02 (tailnet-only; this runs from wherever the auditor
 *     is, and a network-shaped absence would read as a passing check)
 *   - org-level secrets and their visibility
 *   - whether the workflows DO what their names say - only whether GitHub's
 *     configuration matches what we wrote down about it
 *
 * Requires `gh` authenticated. Without it every probe is `unknown`, which is
 * reported as unknown and never as a pass.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const meta = {
  id: "platform-claims",
  title: "CLAUDE.md 对平台的声称 vs 平台本身",
  covered: [
    "合并方式：squash-only、禁用 merge commit 与 rebase、合并后删分支",
    "分支保护与可见性一致：私有时 Rulesets 与 legacy 都回 403；公开时 main-protection 生效、零绕过、必需检查与 main-ruleset.json 一致",
    "production Environment 与可见性一致：私有时零保护规则；公开时有必需审批人且管理员不可绕过",
    "release.yml 是否自己派发 deploy.yml（此前文档说只建 tag，是假的）",
  ],
  notCovered: [
    "worker-02 上的任何东西（tailnet 内，网络不通会被读成通过，所以不放进来）",
    "org 级 secrets 与其可见性",
    "workflow 是否真的做了它名字说的事 —— 这里只问 GitHub 的配置和我们写下的是否一致",
  ],
};

const REPO = "vxture-foundation/vxture-atlas";

function gh(args) {
  try {
    return { ok: true, body: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { ok: false, status: err.status, body: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** The ruleset CLAUDE.md names as authoritative - compared, never restated. */
const RULESET = JSON.parse(
  readFileSync(new URL("../../../docs/50-deployment/rebuild/main-ruleset.json", import.meta.url), "utf8"),
);

function requiredChecksOf(ruleset) {
  const rule = (ruleset.rules ?? []).find((r) => r.type === "required_status_checks");
  return (rule?.parameters?.required_status_checks ?? []).map((c) => c.context).sort();
}

/**
 * The HTTP status a gh call answered, or null when there was none to read.
 *
 * null is the whole point. The first version of the branch-protection probe
 * asked only "did both calls fail?" and called that a 403. On 2026-09-29 a
 * TLS timeout on one call and a 404 on the other came back `match` - a
 * network failure scored as confirmation, the exact shape this file's header
 * says never happens. A verdict may rest on a status; it may not rest on the
 * absence of a success.
 */
export function httpStatusOf(r) {
  if (r.ok) return 200;
  const m = /HTTP (\d{3})/u.exec(r.body ?? "");
  return m ? Number(m[1]) : null;
}

function repoVisibility() {
  const r = gh(["api", `repos/${REPO}`, "--jq", ".visibility"]);
  return r.ok ? r.body.trim() : null;
}

/**
 * Branch protection is available on this Free-plan org only while the repo is
 * public, so the claim is visibility-dependent and so is the verdict.
 * Pure: every input is a raw platform answer, so selftest.mjs can replay the
 * answers that once fooled it.
 */
export function judgeBranchProtection({ visibility, rulesetsStatus, legacyStatus, ruleset, expectedChecks }) {
  const saw = `visibility=${visibility ?? "?"}; rulesets: ${rulesetsStatus ?? "no status"}; legacy: ${legacyStatus ?? "no status"}`;
  if (visibility === "private") {
    if (rulesetsStatus === 403 && legacyStatus === 403) return { verdict: "match", saw };
    if (rulesetsStatus === 200 || legacyStatus === 200 || legacyStatus === 404) {
      return { verdict: "mismatch", saw: `${saw} - 私有却可用分支保护，CLAUDE.md 的前提需要重写` };
    }
    return { verdict: "unknown", saw };
  }
  if (visibility === "public") {
    if (rulesetsStatus !== 200) return { verdict: "unknown", saw };
    if (ruleset === undefined) return { verdict: "unknown", saw: `${saw}; ruleset 详情读取失败` };
    if (ruleset === null) {
      return { verdict: "mismatch", saw: `${saw} - 公开但没有 ${RULESET.name} 规则集` };
    }
    const problems = [];
    if (ruleset.enforcement !== "active") problems.push(`enforcement=${ruleset.enforcement}`);
    if ((ruleset.bypass_actors ?? []).length !== 0) problems.push(`bypass_actors=${ruleset.bypass_actors.length}`);
    const live = requiredChecksOf(ruleset).join(",");
    if (live !== expectedChecks.join(",")) problems.push(`checks=${live} (应为 ${expectedChecks.join(",")})`);
    return problems.length === 0
      ? { verdict: "match", saw: `${saw}; ${ruleset.name} active, bypass 0, checks=${live}` }
      : { verdict: "mismatch", saw: `${saw}; ${problems.join("; ")}` };
  }
  return { verdict: "unknown", saw };
}

/** Same availability rule, applied to the production Environment's reviewer. */
export function judgeProductionGate({ visibility, status, env }) {
  if (status !== 200 || env === null) {
    return { verdict: "unknown", saw: `visibility=${visibility ?? "?"}; environment: ${status ?? "no status"}` };
  }
  const reviewers = (env.protection_rules ?? [])
    .filter((r) => r.type === "required_reviewers")
    .flatMap((r) => r.reviewers ?? []);
  const saw = `visibility=${visibility}; protection_rules=${(env.protection_rules ?? []).length}; reviewers=${reviewers.length}; can_admins_bypass=${env.can_admins_bypass}`;
  if (visibility === "private") {
    return (env.protection_rules ?? []).length === 0
      ? { verdict: "match", saw }
      : { verdict: "mismatch", saw: `${saw} - 私有却有保护规则，部署会停在审批上` };
  }
  if (visibility === "public") {
    return reviewers.length > 0 && env.can_admins_bypass === false
      ? { verdict: "match", saw }
      : { verdict: "mismatch", saw: `${saw} - 公开却没有不可绕过的审批门` };
  }
  return { verdict: "unknown", saw };
}

/** Each probe returns "match" | "mismatch" | "unknown" plus what it saw. */
const PROBES = [
  {
    claim: "squash-merge only；merge commit 与 rebase 在仓库设置层面关闭，合并后自动删分支",
    source: "CLAUDE.md, How to make a change",
    probe() {
      const r = gh(["api", `repos/${REPO}`, "--jq", "[.allow_merge_commit,.allow_rebase_merge,.allow_squash_merge,.delete_branch_on_merge]|@csv"]);
      if (!r.ok) return { verdict: "unknown", saw: r.body.trim().slice(0, 200) };
      const saw = r.body.trim();
      return { verdict: saw === '"false,false,true,true"' || saw === "false,false,true,true" ? "match" : "mismatch", saw };
    },
  },
  {
    claim: "分支保护与仓库可见性一致（CLAUDE.md, Branch protection）",
    source: "CLAUDE.md, Branch protection",
    probe() {
      const visibility = repoVisibility();
      const rs = gh(["api", `repos/${REPO}/rulesets`]);
      const legacy = gh(["api", `repos/${REPO}/branches/main/protection`]);
      let ruleset = null;
      if (rs.ok) {
        const summary = JSON.parse(rs.body).find((r) => r.name === RULESET.name);
        if (summary) {
          const detail = gh(["api", `repos/${REPO}/rulesets/${summary.id}`]);
          ruleset = detail.ok ? JSON.parse(detail.body) : undefined;
        }
      }
      return judgeBranchProtection({
        visibility,
        rulesetsStatus: httpStatusOf(rs),
        legacyStatus: httpStatusOf(legacy),
        ruleset,
        expectedChecks: requiredChecksOf(RULESET),
      });
    },
  },
  {
    claim: "production Environment 的审批门与仓库可见性一致",
    source: "docs/50-deployment/00-index.md, approval gate",
    probe() {
      const visibility = repoVisibility();
      const r = gh(["api", `repos/${REPO}/environments/production`]);
      return judgeProductionGate({
        visibility,
        status: httpStatusOf(r),
        env: r.ok ? JSON.parse(r.body) : null,
      });
    },
  },
  {
    claim: "release.yml 自己派发 deploy.yml（不是只建 tag）",
    source: "docs/50-deployment/00-index.md，2026-08-25 更正后的说法",
    probe() {
      const r = gh(["api", `repos/${REPO}/contents/.github/workflows/release.yml`, "--jq", ".content"]);
      if (!r.ok) return { verdict: "unknown", saw: r.body.trim().slice(0, 200) };
      const text = Buffer.from(r.body.trim(), "base64").toString("utf8");
      const dispatches = /workflow\s+run\s+deploy\.yml|workflow_dispatch|gh\s+workflow\s+run/u.test(text);
      return {
        verdict: dispatches ? "match" : "mismatch",
        saw: dispatches ? "release.yml 里存在对 deploy 的派发调用" : "release.yml 里找不到任何派发调用 —— 文档的说法又反了",
      };
    },
  },
];

export async function run({ log }) {
  const findings = [];
  let unknown = 0;

  for (const p of PROBES) {
    const { verdict, saw } = p.probe();
    log(`  [${verdict}] ${p.claim} -- ${saw}`);
    if (verdict === "mismatch") {
      findings.push({
        severity: "high",
        title: `声称与平台不符：${p.claim}`,
        detail: `出处 ${p.source}。平台回答：${saw}`,
      });
    } else if (verdict === "unknown") {
      unknown++;
      findings.push({
        severity: "unreadable",
        title: `无法判定：${p.claim}`,
        detail: `平台没有给出可判读的回答（${saw}）。这不是通过 —— 未判定和一致是两回事。`,
      });
    }
  }

  return { findings, probed: PROBES.length, unknown };
}
