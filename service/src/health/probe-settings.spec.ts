import { describe, expect, it } from "vitest";

import {
  effectiveProbeSettings,
  parseProbeSettingBody,
  parseSubject,
  readGlobalProbeSettings,
} from "./probe-settings";

describe("readGlobalProbeSettings - the .env level", () => {
  it("falls back to the built-in default, and says so", () => {
    expect(readGlobalProbeSettings({})).toEqual({
      intervalMinutes: 10,
      enabled: true,
      intervalSource: "default",
      enabledSource: "default",
    });
  });

  it("reads valid values as the global level", () => {
    expect(readGlobalProbeSettings({ HEALTH_PROBE_INTERVAL_MINUTES: "15", HEALTH_PROBES_ENABLED: "false" })).toEqual({
      intervalMinutes: 15,
      enabled: false,
      intervalSource: "global",
      enabledSource: "global",
    });
  });

  it.each([["4"], ["61"], ["7.5"], ["ten"]])("refuses interval %s - an ignored setting is inert", (v) => {
    expect(() => readGlobalProbeSettings({ HEALTH_PROBE_INTERVAL_MINUTES: v })).toThrow(/HEALTH_PROBE_INTERVAL_MINUTES/);
  });

  it("refuses an enabled flag that is not true/false", () => {
    expect(() => readGlobalProbeSettings({ HEALTH_PROBES_ENABLED: "yes" })).toThrow(/HEALTH_PROBES_ENABLED/);
  });
});

describe("effectiveProbeSettings - most specific first, with the source", () => {
  const global = readGlobalProbeSettings({});
  const subject = { modelCode: "deepseek-v4-flash", providerCode: "deepseek" };

  it("model over vendor over global", () => {
    const rows = [
      { subjectKind: "provider", subjectKey: "deepseek", probeIntervalMinutes: 30, probeEnabled: false },
      { subjectKind: "model", subjectKey: "deepseek-v4-flash", probeIntervalMinutes: null, probeEnabled: true },
    ];
    expect(effectiveProbeSettings(subject, rows, global)).toEqual({
      intervalMinutes: 30,
      intervalSource: "provider",
      enabled: true,
      enabledSource: "model",
    });
  });

  it("nothing set: the default, labelled as the default", () => {
    expect(effectiveProbeSettings(subject, [], global)).toEqual({
      intervalMinutes: 10,
      intervalSource: "default",
      enabled: true,
      enabledSource: "default",
    });
  });

  it("another model's override does not apply", () => {
    const rows = [{ subjectKind: "model", subjectKey: "other", probeIntervalMinutes: 60, probeEnabled: false }];
    expect(effectiveProbeSettings(subject, rows, global).intervalMinutes).toBe(10);
  });
});

describe("parseProbeSettingBody / parseSubject - the write surface", () => {
  it("accepts values in range, and null to inherit", () => {
    expect(parseProbeSettingBody({ probeIntervalMinutes: 5, probeEnabled: false })).toEqual({
      probeIntervalMinutes: 5,
      probeEnabled: false,
    });
    expect(parseProbeSettingBody({ probeIntervalMinutes: null })).toEqual({ probeIntervalMinutes: null });
  });

  it.each([
    [{ probeIntervalMinutes: 4 }],
    [{ probeIntervalMinutes: 61 }],
    [{ probeIntervalMinutes: "10" }],
    [{ probeEnabled: "yes" }],
    [{ probeBudget: 3 }],
    [{}],
    [[]],
  ])("refuses %j with HEALTH_SETTING_INVALID", (body) => {
    expect(() => parseProbeSettingBody(body)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: "HEALTH_SETTING_INVALID" }) }));
  });

  it("names a subject as model:<code> or provider:<code>", () => {
    expect(parseSubject("model:deepseek-v4-flash")).toEqual({ kind: "model", key: "deepseek-v4-flash" });
    expect(parseSubject("provider:deepseek")).toEqual({ kind: "provider", key: "deepseek" });
    expect(() => parseSubject("deepseek")).toThrow();
  });
});
