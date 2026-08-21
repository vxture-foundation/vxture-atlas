/**
 * status-page.ts - human-readable HTML rendering of AtlasReadyResponse.
 * Atlas has no portals/ (services profile) - karda/arda's /status is a Next.js
 * portal page; this is the equivalent for a backend-only service: render the
 * same data /readyz already computes, as HTML instead of
 * JSON, served directly by this NestJS app. No new data source, no new checks.
 */
import type { HealthCheckResult, AtlasReadyResponse } from "./health.service";

const STATUS_COLORS: Record<string, string> = {
  ok: "#16a34a",
  ready: "#16a34a",
  pass: "#16a34a",
  degraded: "#d97706",
  warn: "#d97706",
  blocked: "#dc2626",
  fail: "#dc2626",
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

function renderCheckRow(name: string, check: HealthCheckResult): string {
  const latency =
    typeof check.latencyMs === "number" ? `${check.latencyMs}ms` : "-";
  const detail = [
    ...(check.message ? [escapeHtml(check.message)] : []),
    ...Object.entries(check)
      .filter(([key]) => !["status", "latencyMs", "message"].includes(key))
      .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(JSON.stringify(value))}`),
  ].join(", ");

  return `
    <tr>
      <td>${escapeHtml(name)}</td>
      <td><span class="badge" style="background:${statusColor(check.status)}">${escapeHtml(check.status)}</span></td>
      <td>${escapeHtml(latency)}</td>
      <td class="detail">${detail || "-"}</td>
    </tr>`;
}

export function renderStatusPage(data: AtlasReadyResponse): string {
  const checkRows = Object.entries(data.checks)
    .map(([name, check]) => renderCheckRow(name, check))
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>atlas status</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 2rem; background: #0b0f14; color: #e5e7eb; }
  h1 { font-size: 1.1rem; margin-bottom: 0.25rem; }
  .sub { color: #9ca3af; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  th, td { text-align: left; padding: 0.4rem 0.8rem; border-bottom: 1px solid #1f2937; font-size: 0.9rem; }
  th { color: #9ca3af; font-weight: 600; }
  .detail { color: #9ca3af; word-break: break-word; }
  .badge { color: #0b0f14; padding: 0.1rem 0.5rem; border-radius: 0.25rem; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
  .identity { margin-bottom: 1.5rem; }
  .identity div { margin: 0.15rem 0; }
  .identity span.label { color: #9ca3af; display: inline-block; width: 8rem; }
</style>
</head>
<body>
  <h1>atlas</h1>
  <div class="sub">overall status:
    <span class="badge" style="background:${statusColor(data.status)}">${escapeHtml(data.status)}</span>
  </div>
  <div class="identity">
    <div><span class="label">service</span>${escapeHtml(data.service)}</div>
    <div><span class="label">product</span>${escapeHtml(data.product ?? "-")}</div>
    <div><span class="label">version</span>${escapeHtml(data.version)}</div>
    <div><span class="label">git sha</span>${escapeHtml(data.gitSha)}</div>
    <div><span class="label">stage</span>${escapeHtml(data.stage)}</div>
    <div><span class="label">build time</span>${escapeHtml(data.buildTime)}</div>
    <div><span class="label">server time</span>${escapeHtml(data.time)}</div>
  </div>
  <table>
    <thead>
      <tr><th>check</th><th>status</th><th>latency</th><th>detail</th></tr>
    </thead>
    <tbody>${checkRows}</tbody>
  </table>
</body>
</html>`;
}
