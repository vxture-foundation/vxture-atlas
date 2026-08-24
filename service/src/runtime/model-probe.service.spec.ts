import { describe, it, expect, vi, beforeEach } from "vitest";

import { ModelProbeService } from "./model-probe.service";
import { ModelAdminException } from "./model-admin.errors";
import { COMMERCE_SENTINEL_UUID } from "../quota/quota.service";
import type { AiModelRecord } from "../types/runtime.types";

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "model-1",
    providerId: "prov-1",
    modelCode: "deepseek-chat",
    modelName: "DeepSeek Chat",
    provider: "deepseek",
    endpointUrl: "https://api.deepseek.com/v1",
    protocol: "openai-chat-completions",
    modelType: "chat",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["chat"],
    supportsStreaming: true,
    isActive: true,
    sort: 999,
    config: null,
    providerConfig: null,
    providerActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deprecatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

async function* streamOf(usage?: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}) {
  yield { type: "text", delta: "pong" };
  yield usage ? { type: "done", usage } : { type: "done" };
}

function build(
  overrides: {
    model?: AiModelRecord | null;
    chat?: ReturnType<typeof vi.fn>;
    chatStream?: ReturnType<typeof vi.fn>;
    resolveKey?: ReturnType<typeof vi.fn>;
    providerRecord?: { id: string; providerCode: string } | null;
    probeableModel?: AiModelRecord | null;
  } = {},
) {
  const model = overrides.model === undefined ? makeModel() : overrides.model;

  const provider = {
    providerName: "openai-compatible",
    chat:
      overrides.chat ??
      vi.fn().mockResolvedValue({
        content: "pong",
        promptTokens: 3,
        completionTokens: 1,
        totalTokens: 4,
      }),
    chatStream:
      overrides.chatStream ??
      vi.fn(() =>
        streamOf({ promptTokens: 3, completionTokens: 1, totalTokens: 4 }),
      ),
  };

  const repository = {
    findModelById: vi.fn().mockResolvedValue(model),
    findProviderById: vi.fn().mockResolvedValue(
      overrides.providerRecord === undefined
        ? { id: "prov-1", providerCode: "deepseek" }
        : overrides.providerRecord,
    ),
    findProbeableModelForProvider: vi
      .fn()
      .mockResolvedValue(
        overrides.probeableModel === undefined ? model : overrides.probeableModel,
      ),
  };
  const router = { resolve: vi.fn().mockReturnValue(provider) };
  const providerKeys = {
    resolveKey: overrides.resolveKey ?? vi.fn().mockResolvedValue("sk-test"),
  };
  const requestLog = { record: vi.fn().mockResolvedValue(undefined) };

  const service = new ModelProbeService(
    repository as never,
    router as never,
    providerKeys as never,
    requestLog as never,
  );

  return { service, provider, repository, router, requestLog };
}

describe("ModelProbeService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("runs both a non-streaming and a streaming check", async () => {
    const result = await ctx.service.probe("model-1");

    expect(result.checks.map((c) => c.mode)).toEqual(["chat", "stream"]);
    expect(result.ok).toBe(true);
  });

  it("skips the streaming check for a model that does not support it", async () => {
    const local = build({ model: makeModel({ supportsStreaming: false }) });
    const result = await local.service.probe("model-1");

    expect(result.checks.map((c) => c.mode)).toEqual(["chat"]);
    expect(local.provider.chatStream).not.toHaveBeenCalled();
  });

  it("reports the resolved adapter, protocol and effective wire descriptor", async () => {
    // 运营核对"我配的到底生效了没有"，靠的就是这三个字段。
    const local = build({
      model: makeModel({
        providerConfig: { wire: { streamUsage: "none" } },
        config: { wire: { chatPath: "/v1/chat" } },
      }),
    });

    const result = await local.service.probe("model-1");

    expect(result.adapter).toBe("openai-compatible");
    expect(result.resolvedProtocol).toBe("openai-chat-completions");
    expect(result.wire.streamUsage).toBe("none");
    expect(result.wire.chatPath).toBe("/v1/chat");
  });

  it("flags a legacy protocol value as still resolvable", async () => {
    const local = build({ model: makeModel({ protocol: "openai" }) });
    const result = await local.service.probe("model-1");

    expect(result.protocol).toBe("openai");
    expect(result.resolvedProtocol).toBe("openai-chat-completions");
  });

  it("reports resolvedProtocol as null when the value is unroutable", async () => {
    // resolvedProtocol null = 协议无法归一化，一条待修正的数据。
    const local = build({ model: makeModel({ protocol: "legacy-junk" }) });
    const result = await local.service.probe("model-1");

    expect(result.resolvedProtocol).toBeNull();
  });

  describe("usage reporting - the point of the probe", () => {
    it("reports usageReported=false when a stream returns no usage", async () => {
      // 调用成功，但不会被计量。
      const local = build({ chatStream: vi.fn(() => streamOf(undefined)) });
      const result = await local.service.probe("model-1");

      const stream = result.checks.find((c) => c.mode === "stream");
      expect(stream?.ok).toBe(true);
      expect(stream?.usageReported).toBe(false);
    });

    it("does not treat missing usage as a failed check", async () => {
      // 上游可能就是不支持回 usage - 那是要被看见的事实，不是错误。
      const local = build({ chatStream: vi.fn(() => streamOf(undefined)) });
      const result = await local.service.probe("model-1");

      expect(result.ok).toBe(true);
    });

    it("reports usageReported=true when usage arrives", async () => {
      const result = await ctx.service.probe("model-1");
      expect(result.checks.every((c) => c.usageReported)).toBe(true);
    });
  });

  describe("failure handling", () => {
    it("reports a failed check without failing the whole probe call", async () => {
      const local = build({
        chat: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      });

      const result = await local.service.probe("model-1");
      const chat = result.checks.find((c) => c.mode === "chat");

      expect(chat?.ok).toBe(false);
      expect(chat?.error?.message).toContain("ECONNREFUSED");
      expect(result.ok).toBe(false);
      // 一条腿断了，另一条仍要跑完 - 运营需要完整画面。
      expect(result.checks).toHaveLength(2);
    });

    it("reports keyResolved=false instead of throwing when the key is missing", async () => {
      const local = build({
        resolveKey: vi.fn().mockRejectedValue(new Error("vault unavailable")),
      });

      const result = await local.service.probe("model-1");
      expect(result.keyResolved).toBe(false);
    });

    it("404s for an unknown model", async () => {
      const local = build({ model: null });
      await expect(local.service.probe("nope")).rejects.toBeInstanceOf(
        ModelAdminException,
      );
    });
  });

  describe("attribution - platform, never a tenant", () => {
    it("logs against the all-zero sentinel with usage_type=test", async () => {
      await ctx.service.probe("model-1");

      expect(ctx.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: COMMERCE_SENTINEL_UUID,
          workspaceId: COMMERCE_SENTINEL_UUID,
          usageType: "test",
          modelCode: "deepseek-chat",
          providerCode: "deepseek",
        }),
      );
    });

    it("uses a distinguishable requestId prefix", async () => {
      const result = await ctx.service.probe("model-1");
      expect(result.requestId).toMatch(/^probe-/);
    });

    it("records the probe even when it failed", async () => {
      const local = build({
        chat: vi.fn().mockRejectedValue(new Error("boom")),
      });

      await local.service.probe("model-1");
      expect(local.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", usageType: "test" }),
      );
    });
  });

  describe("cooldown", () => {
    it("rejects a second probe of the same model inside the window", async () => {
      // 挡的是死循环和连点 - 不是身份问题，所以没有 StepUp（owner 决策）。
      await ctx.service.probe("model-1");

      await expect(ctx.service.probe("model-1")).rejects.toMatchObject({
        code: "MODEL_ADMIN_PROBE_COOLDOWN",
      });
    });

    it("tells the caller how long to wait", async () => {
      await ctx.service.probe("model-1");

      await ctx.service.probe("model-1").catch((error: unknown) => {
        const response = (error as { getResponse: () => { retryAfterMs: number } })
          .getResponse();
        expect(response.retryAfterMs).toBeGreaterThan(0);
        expect(response.retryAfterMs).toBeLessThanOrEqual(10_000);
      });
    });

    it("does not make one model's probe block another", async () => {
      await ctx.service.probe("model-1");

      ctx.repository.findModelById.mockResolvedValueOnce(
        makeModel({ id: "model-2", modelCode: "other" }),
      );
      await expect(ctx.service.probe("model-2")).resolves.toMatchObject({
        modelId: "model-2",
      });
    });

    it("does not consume the window when the model does not exist", async () => {
      // 一个打错的 id 不该把真实模型的自检挡在门外。
      const local = build({ model: null });
      await expect(local.service.probe("nope")).rejects.toBeInstanceOf(
        ModelAdminException,
      );

      local.repository.findModelById.mockResolvedValueOnce(makeModel());
      await expect(local.service.probe("model-1")).resolves.toMatchObject({
        ok: true,
      });
    });

    it("consumes the window at the start, regardless of outcome", async () => {
      // 窗口在发出上游请求之前就记时 - 否则一个卡住 20 秒的自检会把 10 秒的
      // 窗口拖成 30 秒。失败的自检同样占用窗口，正是这一点的可观测证据。
      const failing = build({
        chat: vi.fn().mockRejectedValue(new Error("boom")),
        chatStream: vi.fn(() => {
          throw new Error("boom");
        }),
      });

      const first = await failing.service.probe("model-1");
      expect(first.ok).toBe(false);

      await expect(failing.service.probe("model-1")).rejects.toMatchObject({
        code: "MODEL_ADMIN_PROBE_COOLDOWN",
      });
    });
  });

  it("caps the probe request so a self-check cannot cost real money", async () => {
    // 上限从 16 提到 2048（见 PROBE_MAX_TOKENS）：16 对思考型模型是必然误报，
    // 而 2048 按注册表里最贵的单价算仍不到 0.06 元。"不花钱"仍是约束,
    // 只是它的下界由"能不能答出一个字"决定,不是由一个越小越好的数字决定。
    await ctx.service.probe("model-1");

    expect(ctx.provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 2048, temperature: 0 }),
    );
  });

  describe("cancellation", () => {
    it("hands the adapter a signal, so the timeout can cancel the fetch", async () => {
      await ctx.service.probe("model-1");

      const [request] = ctx.provider.chat.mock.calls[0] as [
        { signal?: AbortSignal },
      ];
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal?.aborted).toBe(false);
    });

    it("aborts that signal when the probe times out", async () => {
      vi.useFakeTimers();
      let captured: AbortSignal | undefined;
      // An upstream that accepts the request and then never answers - the case
      // the timeout exists for. Without the signal the fetch would stay in
      // flight after the probe gave up.
      ctx.provider.chat = vi.fn((request: { signal?: AbortSignal }) => {
        captured = request.signal;
        return new Promise<never>(() => {});
      });

      const probe = ctx.service.probe("model-1");
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await probe;

      expect(captured?.aborted).toBe(true);
      expect(result.checks[0]?.ok).toBe(false);
      expect(result.checks[0]?.error?.message).toContain("timed out");
      vi.useRealTimers();
    });
  });

  // ── provider-level probe ────────────────────────────────────────────────────

  describe("provider probe", () => {
    it("probes through one of the provider's models and names which", async () => {
      // A provider has no wire of its own, so the result has to say which model
      // answered - otherwise a model-specific failure reads as a provider
      // outage.
      const result = await ctx.service.probeProvider("prov-1");

      expect(result).toMatchObject({
        providerId: "prov-1",
        providerCode: "deepseek",
        probedModel: { id: "model-1", modelCode: "deepseek-chat" },
        ok: true,
      });
      expect(result.probe.checks.map((c) => c.mode)).toEqual([
        "chat",
        "stream",
      ]);
    });

    it("404s for an unknown provider", async () => {
      const local = build({ providerRecord: null });

      await expect(
        local.service.probeProvider("nope"),
      ).rejects.toMatchObject({ code: "MODEL_ADMIN_PROVIDER_NOT_FOUND" });
    });

    it("409s when the provider has no active model to probe through", async () => {
      // The provider exists - that is why this is not a 404. Probing a
      // deactivated model and calling the provider healthy would be worse than
      // giving no verdict.
      const local = build({ probeableModel: null });

      await expect(
        local.service.probeProvider("prov-1"),
      ).rejects.toMatchObject({ code: "MODEL_ADMIN_PROVIDER_NOT_PROBEABLE" });
    });

    it("shares the per-model cooldown, so neither route bypasses the other", async () => {
      await ctx.service.probeProvider("prov-1");

      await expect(ctx.service.probe("model-1")).rejects.toMatchObject({
        code: "MODEL_ADMIN_PROBE_COOLDOWN",
      });
    });

    it("attributes the upstream spend to the platform sentinel", async () => {
      // Same rule as the model probe: this is Atlas's own ops action, it must
      // not surface in any tenant's usage view.
      await ctx.service.probeProvider("prov-1");

      expect(ctx.requestLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: COMMERCE_SENTINEL_UUID,
          usageType: "test",
        }),
      );
    });

    it("reports ok=false when the probed model fails", async () => {
      const local = build({
        chat: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      });

      const result = await local.service.probeProvider("prov-1");
      expect(result.ok).toBe(false);
    });
  });

  describe("output budget - a thinking model needs room to answer", () => {
    it("sends a budget large enough for a reasoning chain to finish", async () => {
      // 16 曾经是这个值。思考链算在 completion 里，16 个 token 全烧在思考上，
      // 正文一个字都轮不到 - 一个完全正常的模型被判接入失败。
      await ctx.service.probe("model-1");

      const sent = ctx.provider.chat.mock.calls[0]?.[0] as { maxTokens: number };
      expect(sent.maxTokens).toBe(2048);
    });

    it("never exceeds the output ceiling the model itself declares", async () => {
      // 发一个大于上游允许值的 max_tokens 会被判 400 - 又一次假的接入失败。
      const local = build({ model: makeModel({ maxOutputTokens: 512 }) });
      await local.service.probe("model-1");

      const sent = local.provider.chat.mock.calls[0]?.[0] as {
        maxTokens: number;
      };
      expect(sent.maxTokens).toBe(512);
    });

    it("falls back to the default when the model declares no ceiling", async () => {
      const local = build({ model: makeModel({ maxOutputTokens: null }) });
      await local.service.probe("model-1");

      const sent = local.provider.chat.mock.calls[0]?.[0] as {
        maxTokens: number;
      };
      expect(sent.maxTokens).toBe(2048);
    });
  });

  describe("content frames - the stream check used to be a false green", () => {
    it("fails a stream that completes without a single content frame", async () => {
      // 只吐 reasoning_content 的思考型模型长这样：HTTP 200、usage 齐全、
      // 一个字都没交付。此前这里稳定判绿，而真实客户端拿到的是一个空流。
      const local = build({
        chatStream: vi.fn(async function* () {
          yield {
            type: "done",
            usage: { promptTokens: 84, completionTokens: 16, totalTokens: 100 },
          };
        }),
      });

      const result = await local.service.probe("model-1");
      const stream = result.checks.find((c) => c.mode === "stream");

      expect(stream?.contentReceived).toBe(false);
      expect(stream?.ok).toBe(false);
      expect(result.ok).toBe(false);
    });

    it("gives the empty stream a reason instead of a bare red light", async () => {
      const local = build({
        chatStream: vi.fn(async function* () {
          yield { type: "done" };
        }),
      });

      const result = await local.service.probe("model-1");
      const stream = result.checks.find((c) => c.mode === "stream");

      expect(stream?.error?.code).toBe("PROBE_STREAM_EMPTY");
      expect(stream?.error?.message).toContain("reasoning_content");
    });

    it("counts a tool call as delivered content", async () => {
      // 一个只回工具调用、没有正文的流是正常的，不该被判成空流。
      const local = build({
        chatStream: vi.fn(async function* () {
          yield {
            type: "tool_call",
            toolCall: { id: "1", name: "f", arguments: {} },
          };
          yield { type: "done" };
        }),
      });

      const result = await local.service.probe("model-1");
      const stream = result.checks.find((c) => c.mode === "stream");

      expect(stream?.contentReceived).toBe(true);
      expect(stream?.ok).toBe(true);
    });

    it("reports contentReceived on the non-streaming check too", async () => {
      const result = await ctx.service.probe("model-1");

      expect(result.checks.every((c) => c.contentReceived)).toBe(true);
    });
  });
});
