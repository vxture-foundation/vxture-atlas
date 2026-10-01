/**
 * 上游请求的取消与超时。
 *
 * 此前 Atlas 对上游的每一次 `fetch` 都**没有** `AbortSignal`：一个不回应的
 * provider 会把连接、socket 和内存一直挂在进程里，直到操作系统层面超时（可能
 * 几分钟）。上层即使自己 `Promise.race` 出一个超时，也只是"不再等待"，请求
 * 本身仍在飞 —— 卡住的是我们，不是上游。
 *
 * ## 为什么是"首字节超时"而不是"总超时"
 *
 * 一次生成本来就可能跑很久：几千 token 的回答花上一两分钟是正常的。给整个
 * 请求设总超时，会把正常的长生成误杀。
 *
 * 真正能区分"上游挂了"和"上游在干活"的是**响应头到达的时刻**：健康的上游会
 * 很快回 200 和头部，然后才慢慢吐 body。所以这里只约束到首字节为止，头部一到
 * 就解除计时，body 想读多久读多久。
 *
 * 已知边界：头部到了之后 body 再挂住，这里管不了。流式的分片空闲超时是独立的
 * 一件事，留待后续。
 *
 * ## 非流式生成不适用上面那条前提（2026-10-01，tenderforge#69）
 *
 * "健康的上游会很快回头部"只对**流式**成立。非流式时，豆包与 DeepSeek 要把整段
 * 答案生成完才回响应头，所以"到头部的时间"就是生成时间。生产上 30 秒的首字节
 * 门槛因此稳定地杀掉每一个生成超过 30 秒的非流式调用（09-30 一个上午 28 次），
 * 还先把备选链走一遍、多付一次调用 —— 而调用方送的 `timeoutMs` 根本没起作用。
 *
 * 所以等待分两种：
 * - `first_byte`：流式，以及 embed / rerank 这类不生成长文本的调用 —— 30 秒。
 * - `whole_response`：非流式的 chat 与 parse —— 头部要等整段答案。上限默认
 *   600 秒，等于 `timeoutMs` 的最大允许值，所以调用方送了 `timeoutMs` 时，
 *   **总是它先到**、由它决定；没送时这是挂死连接的兜底。
 */

/** 默认首字节超时。可用 `PROVIDER_CONNECT_TIMEOUT_MS` 覆盖。 */
export const DEFAULT_TTFB_TIMEOUT_MS = 30_000;

/**
 * 非流式生成等头部的默认上限。等于 chat `timeoutMs` 的最大允许值（600000），
 * 让调用方的总截止永远先生效。可用 `PROVIDER_WHOLE_RESPONSE_TIMEOUT_MS` 覆盖。
 */
export const DEFAULT_WHOLE_RESPONSE_TIMEOUT_MS = 600_000;

/** 一次调用的头部何时该到：首字节即到，还是整段答案生成完才到。 */
export type HeaderWait = "first_byte" | "whole_response";

export function resolveTtfbTimeoutMs(): number {
  return positiveFromEnv("PROVIDER_CONNECT_TIMEOUT_MS", DEFAULT_TTFB_TIMEOUT_MS);
}

export function resolveHeaderTimeoutMs(wait: HeaderWait): number {
  return wait === "whole_response"
    ? positiveFromEnv("PROVIDER_WHOLE_RESPONSE_TIMEOUT_MS", DEFAULT_WHOLE_RESPONSE_TIMEOUT_MS)
    : resolveTtfbTimeoutMs();
}

function positiveFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class UpstreamTimeoutError extends Error {
  constructor(
    readonly providerName: string,
    readonly timeoutMs: number,
  ) {
    super(
      `${providerName} did not send response headers within ${timeoutMs}ms`,
    );
    this.name = "UpstreamTimeoutError";
  }
}

export interface TtfbGuard {
  /** 传给 `fetch` 的 signal。 */
  signal: AbortSignal;
  /** 响应头到达后调用，解除计时；不调用会让定时器空转到超时点。 */
  settle(): void;
  /** 判断一个 fetch 抛出的错误是不是本 guard 触发的。 */
  isTimeout(): boolean;
  /** 本 guard 的等待上限（毫秒），报错时说的就是这个数。 */
  timeoutMs: number;
}

/**
 * @param callerSignal 调用方自己的取消信号（如自检的整体超时、HTTP 客户端断开）。
 *                     与内部的首字节计时**取并集** —— 任何一个触发就取消请求。
 */
export function guardTimeToFirstByte(
  providerName: string,
  callerSignal?: AbortSignal,
  wait: HeaderWait = "first_byte",
): TtfbGuard {
  const timeoutMs = resolveHeaderTimeoutMs(wait);
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new UpstreamTimeoutError(providerName, timeoutMs));
  }, timeoutMs);
  timer.unref();

  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal,
    settle: () => clearTimeout(timer),
    isTimeout: () => timedOut,
    timeoutMs,
  };
}

/**
 * 把 fetch 因取消而抛出的 `AbortError` 翻译成一个说得清原因的错误。
 * 原样抛出的话，运营只会看到 "This operation was aborted"。
 */
export function describeAbort(
  error: unknown,
  guard: TtfbGuard,
  providerName: string,
): unknown {
  if (guard.isTimeout()) {
    return new UpstreamTimeoutError(providerName, guard.timeoutMs);
  }
  return error;
}
