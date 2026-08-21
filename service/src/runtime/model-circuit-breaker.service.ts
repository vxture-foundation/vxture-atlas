import { Injectable } from "@nestjs/common";

/**
 * 熔断器（模型级）。
 *
 * 没有它，一个持续故障的 primary 会让每一次请求都先付一次完整的超时/失败代价
 * 才轮到 `config.fallbackModelCodes` 里配的 fallback —— fallback 链本身在
 * `runtime.service.ts` 里早就能跑，缺的是"已知在挂就别再等它超时"这一步。
 *
 * 跟 `model-probe.service.ts` 的冷却 Map 是同一个形状：单实例内存态，
 * 天然被模型数量界定规模，不需要额外淘汰策略；同样的局限也适用 ——
 * 多实例部署下每个实例各自学习健康状况，不共享熔断状态。
 *
 * 半开状态刻意不做成显式状态机：`trippedUntil` 一过期，下一个请求自然
 * 就会重新尝试这个 candidate，成功则 `recordSuccess` 清掉整条记录，失败则
 * 照常计入 `consecutiveFailures` 并可能立刻重新跳闸 —— 这就是半开重试,
 * 不需要额外的第三种状态。
 */
const TRIP_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

interface CircuitState {
  consecutiveFailures: number;
  trippedUntil: number | null;
}

@Injectable()
export class ModelCircuitBreakerService {
  private readonly state = new Map<string, CircuitState>();

  /** 已知在挂且冷却期未过。过期后自动视为未跳闸,允许半开重试。 */
  isTripped(modelCode: string): boolean {
    const entry = this.state.get(modelCode);
    if (!entry?.trippedUntil) {
      return false;
    }
    return Date.now() < entry.trippedUntil;
  }

  /** 成功即康复：直接丢掉记录,而不是清零字段,让 Map 只留正在/曾经故障的模型。 */
  recordSuccess(modelCode: string): void {
    this.state.delete(modelCode);
  }

  recordFailure(modelCode: string): void {
    const entry = this.state.get(modelCode) ?? {
      consecutiveFailures: 0,
      trippedUntil: null,
    };
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= TRIP_THRESHOLD) {
      entry.trippedUntil = Date.now() + COOLDOWN_MS;
    }
    this.state.set(modelCode, entry);
  }
}
