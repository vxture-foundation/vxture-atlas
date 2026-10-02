import { HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";

import { prisma } from "../prisma";
import type { UpdateProbeSettingInput } from "../types/runtime.types";
import { HealthProbeScheduler } from "./health-probe.scheduler";
import {
  effectiveProbeSettings,
  parseProbeSettingBody,
  parseSubject,
  type EffectiveProbeSettings,
  type GlobalProbeSettings,
  type ProbeSettingRow,
} from "./probe-settings";
import { upstreamHealth } from "./upstream-health";

export interface ProbeSettingOverride {
  subjectKind: string;
  subjectKey: string;
  probeIntervalMinutes: number | null;
  probeEnabled: boolean | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface HealthSettingsView {
  global: GlobalProbeSettings;
  overrides: ProbeSettingOverride[];
  /** Every probe target, with the settings in effect and the level each came from. */
  targets: ({
    modelCode: string;
    providerCode: string;
    state: string;
    lastResultAt: string | null;
  } & EffectiveProbeSettings)[];
}

function toOverride(r: {
  subjectKind: string;
  subjectKey: string;
  probeIntervalMinutes: number | null;
  probeEnabled: boolean | null;
  updatedBy: string | null;
  updatedAt: Date;
}): ProbeSettingOverride {
  return { ...r, updatedAt: r.updatedAt.toISOString() };
}

/**
 * Probe settings on the operator plane (ADR-013 point 5, design 120 section
 * 4.5). Edited from opera; every value reports where it came from.
 */
@Injectable()
export class HealthSettingsService {
  constructor(@Inject(HealthProbeScheduler) private readonly scheduler: HealthProbeScheduler) {}

  async view(): Promise<HealthSettingsView> {
    const [rows, targets] = await Promise.all([
      prisma.healthProbeSetting.findMany(),
      this.scheduler.targets(),
    ]);
    const global = this.scheduler.globalSettings();
    return {
      global,
      overrides: rows.map(toOverride),
      targets: targets
        .map((m) => {
          const last = upstreamHealth.lastResultAt(m.modelCode);
          return {
            modelCode: m.modelCode,
            providerCode: m.provider,
            state: upstreamHealth.modelState(m.modelCode) ?? "unknown",
            lastResultAt: last !== undefined ? new Date(last).toISOString() : null,
            ...effectiveProbeSettings(
              { modelCode: m.modelCode, providerCode: m.provider },
              rows as ProbeSettingRow[],
              global,
            ),
          };
        })
        .sort((a, b) => a.modelCode.localeCompare(b.modelCode)),
    };
  }

  async update(
    subjectRaw: string,
    body: unknown,
    operatorId: string | undefined,
  ): Promise<{ override: ProbeSettingOverride; effective: EffectiveProbeSettings }> {
    const subject = parseSubject(subjectRaw);
    const input: UpdateProbeSettingInput = parseProbeSettingBody(body);

    // The subject must exist: a setting on a code nothing has is inert.
    // For a model, its vendor too: the effective settings fall back to it.
    const model =
      subject.kind === "model"
        ? await prisma.modelDefinition.findFirst({
            where: { modelCode: subject.key, deletedAt: null },
            include: { providerRef: { select: { providerCode: true } } },
          })
        : null;
    const provider =
      subject.kind === "provider"
        ? await prisma.modelProvider.findFirst({ where: { providerCode: subject.key, deletedAt: null } })
        : null;
    if ((subject.kind === "model" && !model) || (subject.kind === "provider" && !provider)) {
      throw new NotFoundException({
        code: "HEALTH_SETTING_UNKNOWN_SUBJECT",
        message: `no ${subject.kind} "${subject.key}"`,
        retryable: false,
        statusCode: HttpStatus.NOT_FOUND,
      });
    }

    const data: UpdateProbeSettingInput = {
      ...input,
      updatedBy: operatorId ?? null,
      updatedAt: new Date(),
    };
    const row = await prisma.healthProbeSetting.upsert({
      where: { subjectKind_subjectKey: { subjectKind: subject.kind, subjectKey: subject.key } },
      create: {
        subjectKind: subject.kind,
        subjectKey: subject.key,
        probeIntervalMinutes: input.probeIntervalMinutes ?? null,
        probeEnabled: input.probeEnabled ?? null,
        updatedBy: data.updatedBy,
        updatedAt: data.updatedAt,
      },
      update: data,
    });

    const rows = (await prisma.healthProbeSetting.findMany()) as ProbeSettingRow[];
    // A vendor's own effective view: no model override can apply to it.
    const providerCode = subject.kind === "model" ? (model?.providerRef?.providerCode ?? "") : subject.key;
    const modelCode = subject.kind === "model" ? subject.key : "";
    return {
      override: toOverride(row),
      effective: effectiveProbeSettings({ modelCode, providerCode }, rows, this.scheduler.globalSettings()),
    };
  }
}
