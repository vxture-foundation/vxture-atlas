import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../prisma";
import { HealthSettingsService } from "./health-settings.service";
import { readGlobalProbeSettings } from "./probe-settings";

function build() {
  const scheduler = { globalSettings: () => readGlobalProbeSettings({}), targets: vi.fn().mockResolvedValue([]) };
  return new HealthSettingsService(scheduler as never);
}

describe("HealthSettingsService.update", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a model that does not exist - a setting on nothing is inert", async () => {
    vi.spyOn(prisma.modelDefinition, "findFirst").mockResolvedValue(null as never);
    await expect(build().update("model:nope", { probeEnabled: false }, "opr_1")).rejects.toMatchObject({
      response: { code: "HEALTH_SETTING_UNKNOWN_SUBJECT" },
    });
  });

  it("writes the override with the operator from the token, and reports what is now in effect", async () => {
    vi.spyOn(prisma.modelDefinition, "findFirst").mockResolvedValue({
      modelCode: "deepseek-v4-flash",
      providerRef: { providerCode: "deepseek" },
    } as never);
    const saved = {
      subjectKind: "model",
      subjectKey: "deepseek-v4-flash",
      probeIntervalMinutes: 30,
      probeEnabled: null,
      updatedBy: "opr_1",
      updatedAt: new Date("2026-10-02T10:00:00Z"),
    };
    const upsert = vi.spyOn(prisma.healthProbeSetting, "upsert").mockResolvedValue(saved as never);
    vi.spyOn(prisma.healthProbeSetting, "findMany").mockResolvedValue([saved] as never);

    const result = await build().update("model:deepseek-v4-flash", { probeIntervalMinutes: 30 }, "opr_1");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subjectKind_subjectKey: { subjectKind: "model", subjectKey: "deepseek-v4-flash" } },
        update: expect.objectContaining({ probeIntervalMinutes: 30, updatedBy: "opr_1" }),
      }),
    );
    expect(result.effective).toEqual({
      intervalMinutes: 30,
      intervalSource: "model",
      enabled: true,
      enabledSource: "default",
    });
  });

  it("refuses an out-of-range value before touching the database", async () => {
    const find = vi.spyOn(prisma.modelProvider, "findFirst");
    await expect(build().update("provider:deepseek", { probeIntervalMinutes: 2 }, "opr_1")).rejects.toMatchObject({
      response: { code: "HEALTH_SETTING_INVALID" },
    });
    expect(find).not.toHaveBeenCalled();
  });
});
