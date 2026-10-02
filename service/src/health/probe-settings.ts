import { BadRequestException } from "@nestjs/common";

import type { UpdateProbeSettingInput } from "../types/runtime.types";

/**
 * probe-settings.ts - which probe settings apply to a model, and where each
 * one came from (ADR-013 point 5, design 120 section 4.5). Pure.
 *
 * Most specific first: the model's own override, its vendor's, the server's
 * `.env`, then the built-in default. The level that supplied each value is
 * reported with it, so a form can say "using the default, 10 minutes" - a
 * setting whose effect cannot be seen is a setting nobody can trust.
 */

export const BUILT_IN_INTERVAL_MINUTES = 10;
export const BUILT_IN_ENABLED = true;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 60;

export type SettingSource = "model" | "provider" | "global" | "default";

export interface GlobalProbeSettings {
  intervalMinutes: number;
  enabled: boolean;
  intervalSource: "global" | "default";
  enabledSource: "global" | "default";
}

export interface ProbeSettingRow {
  subjectKind: string;
  subjectKey: string;
  probeIntervalMinutes: number | null;
  probeEnabled: boolean | null;
}

export interface EffectiveProbeSettings {
  intervalMinutes: number;
  enabled: boolean;
  intervalSource: SettingSource;
  enabledSource: SettingSource;
}

/**
 * The server-wide level, from `.env`. An unreadable value is refused - the
 * caller fails start-up - rather than ignored: a setting silently replaced by
 * the default is configurable-but-inert.
 */
export function readGlobalProbeSettings(env: NodeJS.ProcessEnv = process.env): GlobalProbeSettings {
  const rawInterval = env["HEALTH_PROBE_INTERVAL_MINUTES"]?.trim();
  const rawEnabled = env["HEALTH_PROBES_ENABLED"]?.trim().toLowerCase();

  let intervalMinutes = BUILT_IN_INTERVAL_MINUTES;
  if (rawInterval) {
    const n = Number(rawInterval);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      throw new Error(
        `HEALTH_PROBE_INTERVAL_MINUTES must be an integer from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}, got "${rawInterval}"`,
      );
    }
    intervalMinutes = n;
  }

  let enabled = BUILT_IN_ENABLED;
  if (rawEnabled) {
    if (rawEnabled !== "true" && rawEnabled !== "false") {
      throw new Error(`HEALTH_PROBES_ENABLED must be "true" or "false", got "${rawEnabled}"`);
    }
    enabled = rawEnabled === "true";
  }

  return {
    intervalMinutes,
    enabled,
    intervalSource: rawInterval ? "global" : "default",
    enabledSource: rawEnabled ? "global" : "default",
  };
}

export function effectiveProbeSettings(
  subject: { modelCode: string; providerCode: string },
  rows: readonly ProbeSettingRow[],
  global: GlobalProbeSettings,
): EffectiveProbeSettings {
  const model = rows.find((r) => r.subjectKind === "model" && r.subjectKey === subject.modelCode);
  const provider = rows.find((r) => r.subjectKind === "provider" && r.subjectKey === subject.providerCode);

  const interval =
    model?.probeIntervalMinutes != null
      ? { value: model.probeIntervalMinutes, source: "model" as const }
      : provider?.probeIntervalMinutes != null
        ? { value: provider.probeIntervalMinutes, source: "provider" as const }
        : { value: global.intervalMinutes, source: global.intervalSource };
  const enabled =
    model?.probeEnabled != null
      ? { value: model.probeEnabled, source: "model" as const }
      : provider?.probeEnabled != null
        ? { value: provider.probeEnabled, source: "provider" as const }
        : { value: global.enabled, source: global.enabledSource };

  return {
    intervalMinutes: interval.value,
    enabled: enabled.value,
    intervalSource: interval.source,
    enabledSource: enabled.source,
  };
}

function refuse(message: string): BadRequestException {
  return new BadRequestException({ code: "HEALTH_SETTING_INVALID", message, retryable: false });
}

/** A write body, checked. `null` clears an override; anything else unknown is refused. */
export function parseProbeSettingBody(body: unknown): UpdateProbeSettingInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw refuse("body must be an object");
  }
  const allowed = new Set(["probeIntervalMinutes", "probeEnabled"]);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw refuse(`unknown field(s): ${unknown.join(", ")}; allowed: probeIntervalMinutes, probeEnabled`);
  }
  const input = body as Record<string, unknown>;
  const out: UpdateProbeSettingInput = {};

  if ("probeIntervalMinutes" in input) {
    const v = input["probeIntervalMinutes"];
    if (v !== null && (!Number.isInteger(v) || (v as number) < MIN_INTERVAL_MINUTES || (v as number) > MAX_INTERVAL_MINUTES)) {
      throw refuse(
        `probeIntervalMinutes must be an integer from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}, or null to inherit`,
      );
    }
    out.probeIntervalMinutes = v as number | null;
  }
  if ("probeEnabled" in input) {
    const v = input["probeEnabled"];
    if (v !== null && typeof v !== "boolean") {
      throw refuse("probeEnabled must be true, false, or null to inherit");
    }
    out.probeEnabled = v as boolean | null;
  }
  if (Object.keys(out).length === 0) {
    throw refuse("nothing to change: send probeIntervalMinutes and/or probeEnabled");
  }
  return out;
}

/** `model:<code>` or `provider:<code>` - the path segment that names a subject. */
export function parseSubject(raw: string): { kind: "model" | "provider"; key: string } {
  const match = /^(model|provider):(.{1,128})$/u.exec(raw);
  if (!match) {
    throw new BadRequestException({
      code: "HEALTH_SETTING_INVALID",
      message: `subject must be "model:<model_code>" or "provider:<provider_code>", got "${raw}"`,
      retryable: false,
    });
  }
  return { kind: match[1] as "model" | "provider", key: match[2]! };
}
