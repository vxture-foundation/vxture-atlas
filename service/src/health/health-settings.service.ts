import { BadRequestException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";

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
import {
  effectiveBalanceSettings,
  type BalanceSettingRow,
  type EffectiveBalanceSettings,
  type GlobalBalanceSettings,
} from "./vendor-balance";
import { VendorBalanceMonitor } from "./vendor-balance.monitor";

export interface ProbeSettingOverride {
  subjectKind: string;
  subjectKey: string;
  probeIntervalMinutes: number | null;
  probeEnabled: boolean | null;
  balanceMinAmount: number | null;
  balanceMinDays: number | null;
  balancePollMinutes: number | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface HealthSettingsView {
  global: GlobalProbeSettings;
  /** The `.env` / built-in level of the balance thresholds (P1). */
  balanceGlobal: GlobalBalanceSettings;
  overrides: ProbeSettingOverride[];
  /** Every probe target, with the settings in effect and the level each came from. */
  targets: ({
    modelCode: string;
    providerCode: string;
    state: string;
    lastResultAt: string | null;
    /** Set when the last probe did not run - `no_key`: no usable key, so nothing was sent. */
    probeSkipped: { reason: "no_key"; detail?: string } | null;
  } & EffectiveProbeSettings)[];
  /** Every watched vendor, with the balance thresholds in effect and the level each came from. */
  vendors: ({
    providerCode: string;
    state: string;
    currency: string | null;
    /** False for a vendor whose balance Atlas cannot read; `reason` says why, and no threshold is accepted. */
    applicable: boolean;
    reason?: string;
  } & EffectiveBalanceSettings)[];
}

function toOverride(r: {
  subjectKind: string;
  subjectKey: string;
  probeIntervalMinutes: number | null;
  probeEnabled: boolean | null;
  balanceMinAmount?: { toString(): string } | number | null;
  balanceMinDays?: number | null;
  balancePollMinutes?: number | null;
  updatedBy: string | null;
  updatedAt: Date;
}): ProbeSettingOverride {
  return {
    subjectKind: r.subjectKind,
    subjectKey: r.subjectKey,
    probeIntervalMinutes: r.probeIntervalMinutes,
    probeEnabled: r.probeEnabled,
    balanceMinAmount: r.balanceMinAmount != null ? Number(r.balanceMinAmount.toString()) : null,
    balanceMinDays: r.balanceMinDays ?? null,
    balancePollMinutes: r.balancePollMinutes ?? null,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Probe settings on the operator plane (ADR-013 point 5, design 120 section
 * 4.5). Edited from opera; every value reports where it came from.
 */
@Injectable()
export class HealthSettingsService {
  constructor(
    @Inject(HealthProbeScheduler) private readonly scheduler: HealthProbeScheduler,
    @Inject(VendorBalanceMonitor) private readonly balances: VendorBalanceMonitor,
  ) {}

  async view(): Promise<HealthSettingsView> {
    const [rows, targets, vendors] = await Promise.all([
      prisma.healthProbeSetting.findMany(),
      this.scheduler.targets(),
      this.balances.view(),
    ]);
    const global = this.scheduler.globalSettings();
    return {
      global,
      balanceGlobal: this.balances.globalSettings(),
      overrides: rows.map(toOverride),
      targets: targets
        .map((m) => {
          const last = upstreamHealth.lastResultAt(m.modelCode);
          return {
            modelCode: m.modelCode,
            providerCode: m.provider,
            state: upstreamHealth.modelState(m.modelCode) ?? "unknown",
            lastResultAt: last !== undefined ? new Date(last).toISOString() : null,
            probeSkipped: this.scheduler.skipReason(m.modelCode) ?? null,
            ...effectiveProbeSettings(
              { modelCode: m.modelCode, providerCode: m.provider },
              rows as ProbeSettingRow[],
              global,
            ),
          };
        })
        .sort((a, b) => a.modelCode.localeCompare(b.modelCode)),
      vendors: vendors.map((v) => ({
        providerCode: v.providerCode,
        state: v.state,
        currency: v.currency ?? null,
        applicable: v.state !== "not_supported",
        ...(v.state === "not_supported" && v.detail !== undefined ? { reason: v.detail } : {}),
        ...v.settings,
      })),
    };
  }

  async update(
    subjectRaw: string,
    body: unknown,
    operatorId: string | undefined,
  ): Promise<{
    override: ProbeSettingOverride;
    effective: EffectiveProbeSettings;
    balance?: EffectiveBalanceSettings;
  }> {
    const subject = parseSubject(subjectRaw);
    const input: UpdateProbeSettingInput = parseProbeSettingBody(body);
    const balanceFields = (["balanceMinAmount", "balanceMinDays", "balancePollMinutes"] as const).filter(
      (k) => k in input,
    );
    if (subject.kind === "model" && balanceFields.length > 0) {
      // A balance belongs to the vendor's account; a model-level value would be inert.
      throw new BadRequestException({
        code: "HEALTH_SETTING_INVALID",
        message: `${balanceFields.join(", ")} can be set on a vendor (provider:<code>) only, not on a model`,
        retryable: false,
      });
    }

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

    // A threshold on a vendor whose balance Atlas cannot read could never
    // fire. Clearing one (null) is always allowed.
    const vendor = (await this.balances.view()).find((v) => v.providerCode === subject.key);
    const settingBalance = balanceFields.some((k) => input[k] !== null);
    if (subject.kind === "provider" && settingBalance && vendor?.state === "not_supported") {
      throw new BadRequestException({
        code: "HEALTH_SETTING_INVALID",
        message: `balance thresholds cannot apply to "${subject.key}": ${vendor.detail ?? "no balance reader"}`,
        retryable: false,
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
        balanceMinAmount: input.balanceMinAmount ?? null,
        balanceMinDays: input.balanceMinDays ?? null,
        balancePollMinutes: input.balancePollMinutes ?? null,
        updatedBy: data.updatedBy,
        updatedAt: data.updatedAt,
      },
      update: data,
    });

    const rows = (await prisma.healthProbeSetting.findMany()) as ProbeSettingRow[];
    // A vendor's own effective view: no model override can apply to it.
    const providerCode = subject.kind === "model" ? (model?.providerRef?.providerCode ?? "") : subject.key;
    const modelCode = subject.kind === "model" ? subject.key : "";
    const currency = vendor?.currency;
    return {
      override: toOverride(row),
      effective: effectiveProbeSettings({ modelCode, providerCode }, rows, this.scheduler.globalSettings()),
      ...(subject.kind === "provider"
        ? {
            balance: effectiveBalanceSettings(
              providerCode,
              currency,
              rows as unknown as BalanceSettingRow[],
              this.balances.globalSettings(),
            ),
          }
        : {}),
    };
  }
}
