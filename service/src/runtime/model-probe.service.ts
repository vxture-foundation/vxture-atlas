import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { ProviderKeyService } from "../provider-keys/provider-key.service";
import { resolveWireFor, supportedThinkingModes } from "../providers/wire";
import type { ResolvedWire } from "../providers/wire";
import { normalizeProtocol } from "../providers/protocol";
import { COMMERCE_SENTINEL_UUID } from "../quota/quota.service";
import { ModelRegistryRepository } from "../registry/model-registry.repository";
import { RequestLogService } from "../reqlog/request-log.service";
import { ModelRouterService } from "../router/model-router.service";
import { ModelAdminException } from "./model-admin.errors";
import { resolveApiKey } from "./resolve-api-key";
import type {
  AiModelRecord,
  ProviderChatRequest,
  ProviderChatResponse,
  TokenUsage,
} from "../types/runtime.types";

/**
 * 连通性自检（docs/30-design/100-model-onboarding-and-protocol-adapters.md §8）。
 *
 * 没有它，运营在管理页面配完一个模型只能上生产流量才知道配没配对；有了它，
 * `config.wire` 配错在保存时就能发现。这是"纯页面接入"能否成立的关键一环。
 *
 * **用量归平台，不属于任何租户**：这是 Atlas 自己的
 * 运维行为，不是任何租户的业务行为，不能出现在任何租户的用量视图里。因此
 * `usage_type='test'`、租户/工作区用全零哨兵、**不扣配额、不上报平台计量内核**。
 */

/**
 * 自检请求的输出上限。
 *
 * 这个值曾经是 16，理由写着"足够验证连通，不足以产生有意义的花费"。对**思考型
 * 模型**这条理由不成立：思考链算在 completion 里（DeepSeek V4 默认开思考、
 * effort 默认 high），16 个 token 全烧在思考上，正文一个字都轮不到 —— 自检看到
 * 的是 `finish_reason=length` 的空正文，与"上游坏了"长得一模一样，而模型本身
 * 完全正常。一次误报的接入失败远比几分钱贵：2048 个输出 token 按注册表里最贵的
 * 单价算也不到 0.06 元。
 */
const PROBE_MAX_TOKENS = 2048;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_PROMPT = "ping";
/** ADR-013: the health probe's budget when reasoning can be turned off. */
const HEALTH_PROBE_MAX_TOKENS = 16;

/**
 * 同一模型两次自检之间的最小间隔。
 *
 * 这里刻意不加任何 step-up 校验：自检不可逆、
 * 不变更任何东西、不回显密钥，风险不是"凭据被盗用做变更"那种身份形状的；而
 * 每点一次测试就要求一次 MFA，会毁掉 probe 存在的唯一理由 —— 那个"改配置 ->
 * 测试 -> 再改"的循环。
 *
 * 真正要挡的是**频率**：前端死循环、连点、被拿到会话后反复调用。冷却期正好
 * 对着这个形状。
 *
 * 局限要说清楚：这是**单实例内存**冷却，多实例部署下挡不住跨实例并发。它是
 * 现阶段的止血，不是完整方案。
 */
const PROBE_COOLDOWN_MS = 10_000;

export type ProbeMode = "chat" | "stream";

export interface ModelProbeCheck {
  mode: ProbeMode;
  ok: boolean;
  latencyMs: number;
  /**
   * 这次检查有没有拿到**可交付的内容** —— 正文或工具调用，思维链不算。
   *
   * 流式这一路此前只统计 usage、完全不看有没有内容帧，于是一个只吐
   * `reasoning_content` 的思考型模型稳定判绿，而真实客户端拿到的是一个空流。
   * 这是自检能犯的最坏一种错：它不是没结论，是给了一个假结论。
   */
  contentReceived: boolean;
  /**
   * 上游有没有回 usage。**这是本自检最有价值的一条**：`runtime.service` 只在
   * usage 到达时才写计量行，所以 `usageReported: false` 意味着这个模型的调用
   * 会静默漏计量。对流式而言，它同时验证了 `wire.streamUsage` 配得
   * 对不对。
   */
  usageReported: boolean;
  totalTokens: number | null;
  error?: { code: string; message: string };
}

/**
 * Provider-level connectivity check.
 *
 * `GET /capability/providers` reports `health` derived from real traffic, on
 * purpose - no extra upstream cost on page load. The cost of that choice is a
 * blind spot Atlas created for itself: **a provider that has never carried
 * traffic reads `unknown` forever**, so an operator cannot verify a newly
 * onboarded provider before sending it real load.
 *
 * This closes that gap on demand. Periodic probing was once ruled out here
 * for its recurring upstream cost; the owner has since accepted that cost
 * (ADR-013, 2026-10-02): `probeForHealth` below is called every 10 minutes for
 * any model without real traffic, with the smallest call that proves the model
 * answers. That one feeds health state, not this operator view.
 */
export interface ProviderProbeResult {
  providerId: string;
  providerCode: string;
  /**
   * Which model the check ran through. A provider has no wire of its own, so
   * "is this provider reachable" is always answered *as* one of its models -
   * naming it keeps the result interpretable when the probe fails for a
   * model-specific reason (bad `modelCode` upstream) rather than a
   * provider-level one (bad key, unreachable host).
   */
  probedModel: { id: string; modelCode: string };
  probe: ModelProbeResult;
  ok: boolean;
}

export interface ModelProbeResult {
  requestId: string;
  modelId: string;
  modelCode: string;
  provider: string;
  /** 注册表里存的原值。 */
  protocol: string;
  /** 归一化后的分发键；`null` 表示走了 provider_code 回退层。 */
  resolvedProtocol: string | null;
  adapter: string;
  endpointUrl: string;
  keyResolved: boolean;
  /** 本次实际生效的合并后描述符 —— 运营核对"我配的到底生效了没有"。 */
  wire: ResolvedWire;
  checks: ModelProbeCheck[];
  ok: boolean;
}

@Injectable()
export class ModelProbeService {
  private readonly logger = new Logger(ModelProbeService.name);

  constructor(
    @Inject(ModelRegistryRepository)
    private readonly repository: ModelRegistryRepository,
    @Inject(ModelRouterService)
    private readonly router: ModelRouterService,
    @Inject(ProviderKeyService)
    private readonly providerKeys: ProviderKeyService,
    @Inject(RequestLogService)
    private readonly requestLog: RequestLogService,
  ) {}

  /** modelId -> 上一次自检开始的时刻。见 `PROBE_COOLDOWN_MS`。 */
  private readonly lastProbeAt = new Map<string, number>();

  /**
   * Probe a provider by probing one of its models. Shares the per-model
   * cooldown rather than adding a second one: the model pick is deterministic,
   * so hammering `providers/:id/probe` and hammering `models/:id/probe` land on
   * the same cooldown key and neither can be used to bypass the other.
   */
  async probeProvider(providerId: string): Promise<ProviderProbeResult> {
    const provider = await this.repository.findProviderById(providerId);
    if (!provider) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_PROVIDER_NOT_FOUND",
        `provider ${providerId} not found`,
        { providerId },
      );
    }

    const model =
      await this.repository.findProbeableModelForProvider(providerId);
    if (!model) {
      // Not a 404 - the provider exists, it just has nothing to probe through.
      // Reporting that plainly beats probing a deactivated model and calling
      // the provider healthy on the strength of it.
      throw new ModelAdminException(
        HttpStatus.CONFLICT,
        "MODEL_ADMIN_PROVIDER_NOT_PROBEABLE",
        `provider ${provider.providerCode} has no active model to probe through - add or activate one first`,
        { providerId, providerCode: provider.providerCode },
      );
    }

    const probe = await this.probe(model.id);

    return {
      providerId: provider.id,
      providerCode: provider.providerCode,
      probedModel: { id: model.id, modelCode: model.modelCode },
      probe,
      ok: probe.ok,
    };
  }

  async probe(modelId: string): Promise<ModelProbeResult> {
    const model = await this.repository.findModelById(modelId);
    if (!model) {
      throw new ModelAdminException(
        HttpStatus.NOT_FOUND,
        "MODEL_ADMIN_MODEL_NOT_FOUND",
        `model ${modelId} not found`,
        { modelId },
      );
    }

    this.assertNotCoolingDown(model.id);

    const requestId = `probe-${randomUUID()}`;
    // 这里有意不经过 quota.assertAllowed - 自检不属于任何租户，扣谁的额度都不对。
    const provider = this.router.resolve(model);
    const apiKey = await this.resolveKeyQuietly(model, requestId);

    const request = buildProbeRequest(model, apiKey);
    const checks: ModelProbeCheck[] = [
      await this.runChat(provider, request),
    ];

    if (model.supportsStreaming) {
      checks.push(await this.runStream(provider, request));
    }

    const result: ModelProbeResult = {
      requestId,
      modelId: model.id,
      modelCode: model.modelCode,
      provider: model.provider,
      protocol: model.protocol,
      resolvedProtocol: normalizeProtocol(model.protocol) ?? null,
      adapter: provider.providerName,
      endpointUrl: model.endpointUrl,
      keyResolved: apiKey.length > 0,
      wire: resolveWireFor(model),
      checks,
      ok: checks.every((check) => check.ok),
    };

    await this.recordProbe(model, requestId, result);
    return result;
  }

  /**
   * ADR-013 active probe: the smallest call that proves the model answers.
   *
   * - chat (and parse - a vision chat model): one prompt with
   *   `thinking: "off"` and a 16-token budget when the model can turn
   *   reasoning off; otherwise the operator probe's budget, so a reasoning chain
   *   cannot spend it and fake a failure (the 2026-08-25 lesson).
   * - embedding: one short text. rerank: one query, one candidate.
   *
   * Returns the ORIGINAL error so health can classify it (402 vs 429 vs 5xx).
   * Recorded like the operator probe: reqlog `usage_type='test'` under the
   * platform sentinel, never reported to platform metering - no tenant pays.
   * No cooldown: the scheduler is the only caller and paces itself.
   */
  async probeForHealth(model: AiModelRecord): Promise<{ ok: boolean; error?: unknown }> {
    const requestId = `health-probe-${randomUUID()}`;
    const provider = this.router.resolve(model);
    const apiKey = await this.resolveKeyQuietly(model, requestId);
    const startedAt = Date.now();
    let outcome: { ok: boolean; error?: unknown; totalTokens: number };

    try {
      if (model.modelType === "embedding") {
        const r = await withTimeout(() =>
          provider.embed({ endpointUrl: model.endpointUrl, apiKey, modelCode: model.modelCode, texts: [PROBE_PROMPT], ...(model.config != null ? { config: model.config } : {}) }),
        );
        outcome = { ok: true, totalTokens: r.usage?.totalTokens ?? 0 };
      } else if (model.modelType === "rerank") {
        const r = await withTimeout(() =>
          provider.rerank({ endpointUrl: model.endpointUrl, apiKey, modelCode: model.modelCode, query: PROBE_PROMPT, candidates: [{ id: "0", text: PROBE_PROMPT }], ...(model.config != null ? { config: model.config } : {}) }),
        );
        outcome = { ok: true, totalTokens: r.usage?.totalTokens ?? 0 };
      } else {
        const canTurnOff = supportedThinkingModes(resolveWireFor(model)).includes("off");
        const request = {
          ...buildProbeRequest(model, apiKey),
          ...(canTurnOff ? { thinking: "off" as const, maxTokens: HEALTH_PROBE_MAX_TOKENS } : {}),
        };
        const r = await withTimeout((signal) => provider.chat({ ...request, signal }));
        outcome = { ok: true, totalTokens: r.totalTokens ?? 0 };
      }
    } catch (error) {
      outcome = { ok: false, error, totalTokens: 0 };
    }

    await this.requestLog.record({
      requestId,
      status: outcome.ok ? "success" : "error",
      tenantId: COMMERCE_SENTINEL_UUID,
      workspaceId: COMMERCE_SENTINEL_UUID,
      modelCode: model.modelCode,
      providerCode: model.provider,
      totalTokens: outcome.totalTokens,
      latencyMs: Date.now() - startedAt,
      usageType: "test",
    });
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  }

  /**
   * 冷却期在**模型存在性校验之后**判定，且在真正发出上游请求之前记时 ——
   * 记的是"开始",不是"结束",否则一个卡死 20 秒的自检会把冷却窗口拖长到
   * 30 秒。
   */
  private assertNotCoolingDown(modelId: string): void {
    const now = Date.now();
    const previous = this.lastProbeAt.get(modelId);

    if (previous !== undefined && now - previous < PROBE_COOLDOWN_MS) {
      throw new ModelAdminException(
        HttpStatus.TOO_MANY_REQUESTS,
        "MODEL_ADMIN_PROBE_COOLDOWN",
        `model ${modelId} was probed less than ${PROBE_COOLDOWN_MS}ms ago`,
        { modelId, retryAfterMs: PROBE_COOLDOWN_MS - (now - previous) },
      );
    }

    this.lastProbeAt.set(modelId, now);
    this.pruneCooldowns(now);
  }

  /** Map 的规模天然被模型数量界定，顺手清掉过期项，不让它无限留存。 */
  private pruneCooldowns(now: number): void {
    for (const [id, at] of this.lastProbeAt) {
      if (now - at >= PROBE_COOLDOWN_MS) {
        this.lastProbeAt.delete(id);
      }
    }
  }

  private async runChat(
    provider: { chat: (r: ProviderChatRequest) => Promise<ProviderChatResponse> },
    request: ProviderChatRequest,
  ): Promise<ModelProbeCheck> {
    const startedAt = Date.now();
    try {
      const response = await withTimeout((signal) =>
        provider.chat({ ...request, signal }),
      );
      const total = response.totalTokens ?? 0;
      return {
        mode: "chat",
        ok: true,
        latencyMs: Date.now() - startedAt,
        // 非流式适配器在正文与工具调用都为空时就抛错了，所以走到这里必有内容。
        // 仍然如实计算而不是写死 true - 这一列的含义是"观察到的"，不是"推断的"。
        contentReceived:
          response.content.length > 0 || (response.toolCalls?.length ?? 0) > 0,
        usageReported: total > 0,
        totalTokens: total,
      };
    } catch (error) {
      return failedCheck("chat", Date.now() - startedAt, error);
    }
  }

  private async runStream(
    provider: {
      chatStream: (r: ProviderChatRequest) => AsyncGenerator<{
        type: string;
        usage?: TokenUsage;
      }>;
    },
    request: ProviderChatRequest,
  ): Promise<ModelProbeCheck> {
    const startedAt = Date.now();
    try {
      const outcome = await withTimeout((signal) =>
        collectStreamOutcome(provider, { ...request, signal }),
      );
      const total = outcome.usage?.totalTokens ?? 0;
      return {
        mode: "stream",
        ok: outcome.contentReceived,
        latencyMs: Date.now() - startedAt,
        contentReceived: outcome.contentReceived,
        // 流式没回 usage 不算失败 —— 上游可能就是不支持。但它是一个必须被
        // 看见的信号：这个模型的流式调用不会被计量。
        usageReported: total > 0,
        totalTokens: outcome.usage ? total : null,
        // 一个没有内容帧的流是坏的，哪怕它 HTTP 200、哪怕它回了 usage。不给
        // 出错误码就等于让页面显示一个没有理由的红灯。
        ...(outcome.contentReceived
          ? {}
          : {
              error: {
                code: "PROBE_STREAM_EMPTY",
                message:
                  "stream completed without a single content frame - the model produced no text and no tool call " +
                  "(a thinking model that only emits reasoning_content looks exactly like this)",
              },
            }),
      };
    } catch (error) {
      return failedCheck("stream", Date.now() - startedAt, error);
    }
  }

  private async resolveKeyQuietly(
    model: AiModelRecord,
    requestId: string,
  ): Promise<string> {
    try {
      return await resolveApiKey(
        {
          resolveManagedKey: (providerCode, keyAlias) =>
            this.providerKeys.resolveKey(providerCode, keyAlias),
        },
        model,
        requestId,
      );
    } catch (error) {
      // 密钥解析失败本身就是自检要报告的结论之一，不该让整个自检 500。
      this.logger.warn(
        `probe ${requestId}: key resolution failed - ${errorMessage(error)}`,
      );
      return "";
    }
  }

  /**
   * 写 `reqlog.request_records`，归属平台哨兵，不上报平台计量内核 ——
   * 自检消耗的 token 是 Atlas 的运维成本，不是任何人的账单。
   */
  private async recordProbe(
    model: AiModelRecord,
    requestId: string,
    result: ModelProbeResult,
  ): Promise<void> {
    const totals = result.checks.reduce(
      (sum, check) => sum + (check.totalTokens ?? 0),
      0,
    );

    await this.requestLog.record({
      requestId,
      status: result.ok ? "success" : "error",
      tenantId: COMMERCE_SENTINEL_UUID,
      workspaceId: COMMERCE_SENTINEL_UUID,
      modelCode: model.modelCode,
      providerCode: model.provider,
      totalTokens: totals,
      latencyMs: result.checks.reduce((sum, c) => sum + c.latencyMs, 0),
      usageType: "test",
    });
  }
}

function buildProbeRequest(
  model: AiModelRecord,
  apiKey: string,
): ProviderChatRequest {
  return {
    endpointUrl: model.endpointUrl,
    apiKey,
    modelCode: model.modelCode,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    maxTokens: probeMaxTokens(model),
    temperature: 0,
    ...(model.config != null ? { config: model.config } : {}),
    ...(model.providerConfig != null
      ? { providerConfig: model.providerConfig }
      : {}),
  };
}


/**
 * 模型自己声明的输出上限更小时以它为准：发一个大于上游允许值的 `max_tokens`
 * 会被直接判 400，那同样是一次假的"接入失败"。
 */
function probeMaxTokens(model: AiModelRecord): number {
  const declared = model.maxOutputTokens;
  return declared != null && declared > 0
    ? Math.min(declared, PROBE_MAX_TOKENS)
    : PROBE_MAX_TOKENS;
}

async function collectStreamOutcome(
  provider: {
    chatStream: (r: ProviderChatRequest) => AsyncGenerator<{
      type: string;
      usage?: TokenUsage;
    }>;
  },
  request: ProviderChatRequest,
): Promise<{ usage: TokenUsage | undefined; contentReceived: boolean }> {
  let usage: TokenUsage | undefined;
  let contentReceived = false;

  for await (const event of provider.chatStream(request)) {
    if (event.type === "text" || event.type === "tool_call") {
      contentReceived = true;
    }
    if (event.type === "done" && event.usage) {
      usage = event.usage;
    }
  }

  return { usage, contentReceived };
}

/**
 * 上游挂住时给自检一个上界，并**真正取消**底层 fetch —— 适配器现在有
 * AbortSignal 通路（providers/upstream-timeout.ts），signal 会与适配器内部的
 * 首字节超时取并集。
 *
 * race 仍然保留：signal 只对走 fetch 的路径有效，任何不理会它的代码路径仍需
 * 一个兜底的上界，否则管理面会被一个永不落地的 promise 挂住。
 */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const expired = new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`);
  const timer = setTimeout(() => controller.abort(expired), PROBE_TIMEOUT_MS);
  timer.unref();

  return Promise.race([
    run(controller.signal),
    new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(expired), {
        once: true,
      });
    }),
  ]).finally(() => clearTimeout(timer));
}

function failedCheck(
  mode: ProbeMode,
  latencyMs: number,
  error: unknown,
): ModelProbeCheck {
  return {
    mode,
    ok: false,
    latencyMs,
    contentReceived: false,
    usageReported: false,
    totalTokens: null,
    error: {
      code: errorCode(error),
      message: errorMessage(error),
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    return `HTTP_${String((error as { status: unknown }).status)}`;
  }
  return "PROBE_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
