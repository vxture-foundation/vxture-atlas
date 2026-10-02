import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { prisma } from "../prisma";
import { MODEL_HEALTH_STATES, type ModelHealthState, type RouteHealthState } from "./health-state";
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
export class PrismaHealthStore implements HealthStore {
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

  async listRoutes(): Promise<RouteDef[]> {
    const rows = await prisma.modelEndpoint.findMany({
      where: { isActive: true, deletedAt: null },
      select: { code: true, primaryModelCode: true, fallbackModelCode: true },
      orderBy: { code: "asc" },
    });
    return rows.map((r) => ({
      code: r.code,
      primary: r.primaryModelCode,
      fallback: r.fallbackModelCode,
    }));
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
    void upstreamHealth.attach(new PrismaHealthStore()).catch((error: unknown) => {
      this.logger.warn(
        `health state restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
