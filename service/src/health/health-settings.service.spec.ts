import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../prisma";
import { HealthSettingsService } from "./health-settings.service";
import { readGlobalProbeSettings } from "./probe-settings";
import { readGlobalBalanceSettings } from "./vendor-balance";

function build(vendors: object[] = []) {
  const scheduler = { globalSettings: () => readGlobalProbeSettings({}), targets: vi.fn().mockResolvedValue([]) };
  const balances = {
    globalSettings: () => readGlobalBalanceSettings({}),
    view: vi.fn().mockResolvedValue(vendors),
  };
  return new HealthSettingsService(scheduler as never, balances as never);
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

  it("refuses a balance threshold on a model - a balance belongs to the vendor's account", async () => {
    const find = vi.spyOn(prisma.modelDefinition, "findFirst");
    await expect(
      build().update("model:deepseek-v4-flash", { balanceMinAmount: 50 }, "opr_1"),
    ).rejects.toMatchObject({ response: { code: "HEALTH_SETTING_INVALID" } });
    expect(find).not.toHaveBeenCalled();
  });

  it("writes a vendor's balance thresholds and reports them in the vendor's currency", async () => {
    vi.spyOn(prisma.modelProvider, "findFirst").mockResolvedValue({ providerCode: "deepseek" } as never);
    const saved = {
      subjectKind: "provider",
      subjectKey: "deepseek",
      probeIntervalMinutes: null,
      probeEnabled: null,
      balanceMinAmount: { toString: () => "50.00" },
      balanceMinDays: null,
      balancePollMinutes: null,
      updatedBy: "opr_1",
      updatedAt: new Date("2026-10-02T10:00:00Z"),
    };
    const upsert = vi.spyOn(prisma.healthProbeSetting, "upsert").mockResolvedValue(saved as never);
    vi.spyOn(prisma.healthProbeSetting, "findMany").mockResolvedValue([saved] as never);

    const result = await build([{ providerCode: "deepseek", currency: "CNY" }]).update(
      "provider:deepseek",
      { balanceMinAmount: 50 },
      "opr_1",
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ balanceMinAmount: 50 }) }),
    );
    expect(result.override.balanceMinAmount).toBe(50);
    expect(result.balance).toEqual({
      minAmount: 50,
      minAmountSource: "provider",
      minDays: 3,
      minDaysSource: "default",
      pollMinutes: 60,
      pollMinutesSource: "default",
    });
  });

  it("refuses a threshold on a vendor whose balance cannot be read - it could never fire - but lets one be cleared", async () => {
    vi.spyOn(prisma.modelProvider, "findFirst").mockResolvedValue({ providerCode: "doubao" } as never);
    const upsert = vi.spyOn(prisma.healthProbeSetting, "upsert").mockResolvedValue({
      subjectKind: "provider",
      subjectKey: "doubao",
      probeIntervalMinutes: null,
      probeEnabled: null,
      updatedBy: "opr_1",
      updatedAt: new Date(),
    } as never);
    vi.spyOn(prisma.healthProbeSetting, "findMany").mockResolvedValue([] as never);
    const service = build([{ providerCode: "doubao", state: "not_supported", detail: "needs AK/SK" }]);

    await expect(service.update("provider:doubao", { balanceMinDays: 3 }, "opr_1")).rejects.toMatchObject({
      response: { code: "HEALTH_SETTING_INVALID", message: expect.stringContaining("needs AK/SK") },
    });
    expect(upsert).not.toHaveBeenCalled();
    await service.update("provider:doubao", { balanceMinDays: null }, "opr_1");
    expect(upsert).toHaveBeenCalled();
  });

  it("refuses an out-of-range value before touching the database", async () => {
    const find = vi.spyOn(prisma.modelProvider, "findFirst");
    await expect(build().update("provider:deepseek", { probeIntervalMinutes: 2 }, "opr_1")).rejects.toMatchObject({
      response: { code: "HEALTH_SETTING_INVALID" },
    });
    expect(find).not.toHaveBeenCalled();
  });
});
