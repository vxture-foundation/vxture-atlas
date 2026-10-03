import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { ModelRegistryRepository } from "../registry/model-registry.repository";
import { atlasHealth } from "./atlas-health";

const TICK_MS = 60_000;
/** The runway moves by months; reading it every ten minutes is plenty. */
const PARTITION_EVERY_MS = 10 * 60_000;

/**
 * atlas-health.monitor.ts - the clock behind `atlasHealth` (F3b-A): once a
 * minute the request log is re-judged (it recovers after a quiet window), and
 * every ten minutes the reqlog partition runway is read - the same query
 * `/readyz` uses, now also a health subject with events.
 */
@Injectable()
export class AtlasHealthMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AtlasHealthMonitor.name);
  private timer: NodeJS.Timeout | undefined;
  private lastPartitionReadAt = Number.NEGATIVE_INFINITY;

  constructor(@Inject(ModelRegistryRepository) private readonly repository: ModelRegistryRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Public for tests. */
  async tick(now: number = Date.now()): Promise<void> {
    atlasHealth.evaluate();
    if (now - this.lastPartitionReadAt < PARTITION_EVERY_MS) return;
    this.lastPartitionReadAt = now;
    try {
      const [row] = await this.repository.readReqlogPartitionRunway();
      atlasHealth.recordPartitions(Number(row?.monthsAhead ?? 0), Number(row?.defaultPartitionRows ?? 0));
    } catch (error) {
      // Unreadable is not a state of the partitions; /readyz reports the read failing.
      this.logger.warn(`partition runway read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
