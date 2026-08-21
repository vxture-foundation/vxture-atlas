import { Injectable } from "@nestjs/common";

/**
 * 限流（RPM + 并发数）。
 *
 * `model.model_policies` 的 `rate_limit_rpm`/`max_concurrent` 早就能配、早就能
 * 存（`/capability/policies` CRUD 全通），但运行时从来没读过 —— 运营配了限流,
 * 什么都不会发生。这里补的是"读"这一半。
 *
 * `rate_limit_tpm`/`rate_limit_tpd`（按 token 计）不在这次范围内：token 花费只
 * 有拿到上游响应之后才知道，要做对需要"预扣后修正"或者用量窗口核算，跟这里
 * 的请求前置闸门是不同复杂度的机制，留给后续单独一批。
 *
 * 跟 `model-circuit-breaker.service.ts` 是同一个形状：单实例内存态，天然被
 * "有配置限流的 model+tenant 组合数" 界定规模。**之前 model-probe.service.ts
 * 的注释点名过 `rate-limiter-flexible`**，这里改成手写而不引这个依赖 —— 权衡
 * 是仓库的审计门禁对新依赖零残留基线、需求本身窄（一个请求计数窗口 + 一个
 * 在途计数器），跟熔断器保持同一策略；真到了要跨实例共享限流状态那天，
 * 再评估该库的 Redis 后端是否合适。
 */
const RPM_WINDOW_MS = 60_000;

/**
 * Shared by `QuotaService` (acquires) and `runtime.service.ts` (releases) so
 * both sides always derive the identical key - a hand-rolled string on each
 * side risks drifting out of sync silently (a typo'd separator would just
 * leak concurrency slots forever, not throw).
 */
export function rateLimitKey(modelId: string, tenantId: string): string {
  return `${modelId}:${tenantId}`;
}

interface RequestWindow {
  windowStart: number;
  count: number;
}

@Injectable()
export class ModelRateLimiterService {
  private readonly requestWindows = new Map<string, RequestWindow>();
  private readonly inFlight = new Map<string, number>();

  /**
   * `limit` 为 `null`/`undefined` 表示这条策略没设 RPM 上限 —— 不限流，
   * 而不是当成 0（策略字段大多是选填的，只填了其中几项很正常）。
   */
  checkRpm(key: string, limit: number | null | undefined): void {
    if (limit == null) return;

    const now = Date.now();
    const window = this.requestWindows.get(key);

    if (!window || now - window.windowStart >= RPM_WINDOW_MS) {
      this.requestWindows.set(key, { windowStart: now, count: 1 });
      return;
    }

    if (window.count >= limit) {
      throw new RateLimitBreach(key, "rpm", limit, {
        retryAfterMs: RPM_WINDOW_MS - (now - window.windowStart),
      });
    }

    window.count += 1;
  }

  /**
   * 在途请求数上限。调用方必须保证成功路径和异常路径都会调用
   * `releaseConcurrency` —— 通常是 provider 调用外面套一个 `try/finally`。
   */
  acquireConcurrency(key: string, limit: number | null | undefined): void {
    if (limit == null) return;

    const current = this.inFlight.get(key) ?? 0;
    if (current >= limit) {
      throw new RateLimitBreach(key, "concurrency", limit);
    }
    this.inFlight.set(key, current + 1);
  }

  /** 没获取过也调用是安全的（比如 acquire 本身被跳过时）：钳在 0，不会变负数。 */
  releaseConcurrency(key: string): void {
    const current = this.inFlight.get(key) ?? 0;
    if (current <= 1) {
      this.inFlight.delete(key);
    } else {
      this.inFlight.set(key, current - 1);
    }
  }
}

export class RateLimitBreach extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly key: string,
    readonly dimension: "rpm" | "concurrency",
    readonly limit: number,
    options: { retryAfterMs?: number } = {},
  ) {
    super(`rate limit exceeded for ${key}: ${dimension} limit ${limit}`);
    this.retryAfterMs = options.retryAfterMs;
  }
}
