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

export const meta = {
  id: "platform-claims",
  title: "CLAUDE.md 对平台的声称 vs 平台本身",
  covered: [
    "合并方式：squash-only、禁用 merge commit 与 rebase、合并后删分支",
    "分支保护：Rulesets 与 legacy protection 是否如文档所称在本仓不可用（403）",
    "production Environment 是否如文档所称零保护规则（此前文档说有审批门，是假的）",
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
    claim: "分支保护在本仓不可用（Rulesets 与 legacy 都回 403：Free 组织 + 私有仓）",
    source: "CLAUDE.md, Branch protection",
    probe() {
      const rs = gh(["api", `repos/${REPO}/rulesets`]);
      const legacy = gh(["api", `repos/${REPO}/branches/main/protection`]);
      if (rs.ok && legacy.ok) {
        return { verdict: "mismatch", saw: "两个端点都成功返回了 —— 分支保护现在可用，CLAUDE.md 的整段前提需要重写" };
      }
      const both403 = !rs.ok && rs.status === 1 && !legacy.ok;
      return {
        verdict: both403 ? "match" : "unknown",
        saw: `rulesets: ${rs.ok ? "200" : (rs.body.match(/HTTP \d+/) ?? ["err"])[0]}; legacy: ${legacy.ok ? "200" : (legacy.body.match(/HTTP \d+/) ?? ["err"])[0]}`,
      };
    },
  },
  {
    claim: "production Environment 零保护规则（没有必需审批人）",
    source: "docs/50-deployment/00-index.md，2026-08-25 更正后的说法",
    probe() {
      const r = gh(["api", `repos/${REPO}/environments/production`, "--jq", "(.protection_rules|length)"]);
      if (!r.ok) return { verdict: "unknown", saw: r.body.trim().slice(0, 200) };
      const n = Number(r.body.trim());
      return {
        verdict: n === 0 ? "match" : "mismatch",
        saw: `protection_rules = ${n}${n > 0 ? "（文档说零，实际有 —— 部署会停在审批上）" : ""}`,
      };
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
