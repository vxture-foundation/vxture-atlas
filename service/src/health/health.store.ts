import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { prisma } from "../prisma";
import { API_KEY_OPTIONAL_PROVIDERS } from "../runtime/resolve-api-key";
import { MODEL_HEALTH_STATES, type ModelHealthState, type RouteHealthState } from "./health-state";
import { routeConfigIssues, type ModelFacts } from "./route-config";
import { atlasHealth, type AtlasHealthStore } from "./atlas-health";
import { upstreamHealth, type HealthStore, type RouteDef, type Transition } from "./upstream-health";

/**
 * health.store.ts - the durable half of `upstreamHealth` (ADR-013).
 *
 * Writes only on a transition: the current state is upserted, and - unless it
 * is the quiet first sighting of a healthy model - the transition is appended
 * to `health.events`, in one transaction so the two never disagree.
 *
 * Like `reqlog` and `audit`, this calls Prisma directly from a service: it is
 * a write-mostly path with no repository logic worth a layer.
 */
export class PrismaHealthStore implements HealthStore, AtlasHealthStore {
  /** Atlas's own components as last stored (F3b-A). */
  async loadAtlas(): ReturnType<AtlasHealthStore["loadAtlas"]> {
    const rows = await prisma.healthSubjectState.findMany({ where: { subjectKind: "atlas" } });
    return rows.map((r) => ({ component: r.subjectKey, state: r.state, since: r.since, detail: r.detail }));
  }

  async load(): ReturnType<HealthStore["load"]> {
    const rows = await prisma.healthSubjectState.findMany();
    const modelStates: ReadonlySet<string> = new Set(MODEL_HEALTH_STATES);
    return {
      models: rows
        .filter((r) => r.subjectKind === "model" && modelStates.has(r.state))
        .map((r) => ({
          modelCode: r.subjectKey,
          providerCode: r.providerCode,
          record: {
            state: r.state as ModelHealthState,
            since: r.since.getTime(),
            consecutiveFailures: 0,
            ...(r.upstreamStatus !== null ? { upstreamStatus: r.upstreamStatus } : {}),
            ...(r.detail !== null ? { detail: r.detail } : {}),
          },
        })),
      routes: rows
        .filter((r) => r.subjectKind === "route")
        .map((r) => ({ code: r.subjectKey, state: r.state as RouteHealthState })),
    };
  }

  /** Active routes, each with what makes a named model unable to serve it. */
  async listRoutes(): Promise<RouteDef[]> {
    const rows = await prisma.modelEndpoint.findMany({
      where: { isActive: true, deletedAt: null },
      select: { code: true, category: true, primaryModelCode: true, fallbackModelCode: true },
      orderBy: { code: "asc" },
    });
    const facts = await this.modelFacts(
      rows.flatMap((r) => (r.fallbackModelCode ? [r.primaryModelCode, r.fallbackModelCode] : [r.primaryModelCode])),
    );
    return rows.map((r) => {
      const route = { category: r.category, primary: r.primaryModelCode, fallback: r.fallbackModelCode };
      return { code: r.code, ...route, configIssues: routeConfigIssues(route, facts) };
    });
  }

  private async modelFacts(codes: string[]): Promise<Map<string, ModelFacts>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();
    const [models, keys] = await Promise.all([
      prisma.modelDefinition.findMany({
        where: { modelCode: { in: unique }, deletedAt: null },
        include: { providerRef: { select: { providerCode: true, isActive: true } } },
      }),
      prisma.providerApiKey.findMany({
        where: { isActive: true, deletedAt: null },
        select: { providerCode: true, keyAlias: true },
      }),
    ]);
    const keyed = new Set(keys.map((k) => `${k.providerCode}\u0000${k.keyAlias}`));
    const out = new Map<string, ModelFacts>();
    for (const m of models as unknown as {
      modelCode: string;
      modelType: string;
      isActive: boolean;
      config: unknown;
      providerRef: { providerCode: string; isActive: boolean } | null;
    }[]) {
      const providerCode = m.providerRef?.providerCode ?? "";
      const raw = (m.config as Record<string, unknown> | null)?.["managedKeyAlias"];
      const alias = typeof raw === "string" ? raw.trim() : "";
      out.set(m.modelCode, {
        modelType: m.modelType,
        active: m.isActive && m.providerRef?.isActive !== false,
        hasKey:
          API_KEY_OPTIONAL_PROVIDERS.has(providerCode) ||
          (alias !== "" && keyed.has(`${providerCode}\u0000${alias}`)),
      });
    }
    return out;
  }

  async save(t: Transition): Promise<void> {
    const state = {
      providerCode: t.providerCode ?? null,
      state: t.to,
      since: t.since,
      upstreamStatus: t.upstreamStatus ?? null,
      detail: t.detail ?? null,
      updatedAt: new Date(),
    };
    await prisma.$transaction(async (tx) => {
      await tx.healthSubjectState.upsert({
        where: { subjectKind_subjectKey: { subjectKind: t.subjectKind, subjectKey: t.subjectKey } },
        create: { subjectKind: t.subjectKind, subjectKey: t.subjectKey, ...state },
        update: state,
      });
      if (!t.event) return;
      await tx.healthEvent.create({
        data: {
          subjectKind: t.subjectKind,
          subjectKey: t.subjectKey,
          providerCode: t.providerCode ?? null,
          fromState: t.from,
          toState: t.to,
          severity: t.severity,
          upstreamStatus: t.upstreamStatus ?? null,
          detail: t.detail ?? null,
          affectedRoutes: t.affectedRoutes,
        },
      });
    });
  }
}

/**
 * Attaches the store when the application starts. The restore runs in the
 * background: a database that is slow at boot must not hold the service back,
 * and models seen before it finishes are kept rather than overwritten.
 */
@Injectable()
export class HealthStoreBootstrap implements OnModuleInit {
  private readonly logger = new Logger(HealthStoreBootstrap.name);

  onModuleInit(): void {
    const store = new PrismaHealthStore();
    const warn = (error: unknown): void => {
      this.logger.warn(`health state restore failed: ${error instanceof Error ? error.message : String(error)}`);
    };
    void upstreamHealth.attach(store).catch(warn);
    void atlasHealth.attach(store).catch(warn);
  }
}
