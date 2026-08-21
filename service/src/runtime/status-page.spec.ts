import { describe, it, expect } from "vitest";

import { renderStatusPage } from "./status-page";
import type { AtlasReadyResponse } from "./health.service";

function makeReady(
  overrides: Partial<AtlasReadyResponse> = {},
): AtlasReadyResponse {
  return {
    service: "atlas",
    product: "vxture",
    version: "v0.1.1",
    gitSha: "baa74d8",
    stage: "production",
    buildTime: "2026-07-27T00:00:00Z",
    time: "2026-07-27T06:00:00Z",
    status: "ready",
    checks: {
      database: { status: "pass", latencyMs: 3 },
      modelRegistry: { status: "pass", latencyMs: 5, activeModels: 2 },
      providerKeys: { status: "pass", checkedKeys: 1, missing: [] },
      usageSummaryRead: { status: "pass", latencyMs: 1, summaries: 0 },
      registryDrift: { status: "pass" as const },
      reqlogPartitions: { status: "pass", latencyMs: 1, monthsAhead: 12, defaultPartitionRows: 0 },
    },
    ...overrides,
  };
}

describe("renderStatusPage", () => {
  it("renders identity fields", () => {
    const html = renderStatusPage(makeReady());
    expect(html).toContain("v0.1.1");
    expect(html).toContain("baa74d8");
    expect(html).toContain("production");
    expect(html).toContain("atlas");
  });

  it("renders every check with its status", () => {
    const html = renderStatusPage(makeReady());
    expect(html).toContain("database");
    expect(html).toContain("modelRegistry");
    expect(html).toContain("providerKeys");
    expect(html).toContain("usageSummaryRead");
  });

  it("renders a failing check's message", () => {
    const html = renderStatusPage(
      makeReady({
        status: "blocked",
        checks: {
          database: {
            status: "fail",
            latencyMs: 2,
            message: "connection refused",
          },
          modelRegistry: { status: "pass" },
          providerKeys: { status: "pass" },
          usageSummaryRead: { status: "pass" },
      registryDrift: { status: "pass" as const },
      reqlogPartitions: { status: "pass", monthsAhead: 12 },
        },
      }),
    );
    expect(html).toContain("connection refused");
    expect(html).toContain("blocked");
  });

  it("escapes HTML in check messages to prevent injection", () => {
    const html = renderStatusPage(
      makeReady({
        checks: {
          database: {
            status: "fail",
            message: "<script>alert(1)</script>",
          },
          modelRegistry: { status: "pass" },
          providerKeys: { status: "pass" },
          usageSummaryRead: { status: "pass" },
      registryDrift: { status: "pass" as const },
      reqlogPartitions: { status: "pass", monthsAhead: 12 },
        },
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
