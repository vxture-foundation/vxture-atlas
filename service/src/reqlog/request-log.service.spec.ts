import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atlasHealth } from "../health/atlas-health";

import { Prisma } from "../generated/prisma";
import { prisma } from "../prisma";
import { metricsRegistry } from "../runtime/metrics.registry";
import { RequestLogService, writeFailureReason } from "./request-log.service";

const VALID_UUID = "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8";

// Usage-record batch 2: record() prices a row by looking up the rule in force
// and the provider's pricing policy. Unit tests have no database, so both
// lookups answer "none" unless a test says otherwise - an unmocked lookup
// hangs on a connection instead of failing.
beforeEach(() => {
  vi.spyOn(prisma.modelPriceRule, "findFirst").mockResolvedValue(null as never);
  vi.spyOn(prisma.modelProvider, "findFirst").mockResolvedValue(null as never);
});

describe("RequestLogService.record", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.requestRecord, "create").mockImplementation(
      create as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the served request with its Atlas domain facts", async () => {
    await new RequestLogService().record({
      requestId: "req-1",
      status: "success",
      workspaceId: VALID_UUID,
      modelCode: "glm-5.2",
      providerCode: "zhipu",
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      latencyMs: 250,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(data).toMatchObject({
      requestId: "req-1",
      status: "success",
      workspaceId: VALID_UUID,
      modelCode: "glm-5.2",
      providerCode: "zhipu",
      inputTokens: 12n,
      outputTokens: 34n,
      totalTokens: 46n,
      latencyMs: 250,
    });
  });

  it("nulls a non-UUID attribution value instead of losing the whole row", async () => {
    // karda's real tenantId is a composite string, not a UUID. Writing
    // it raw would abort the INSERT on a uuid cast and we would record nothing -
    // including the model/provider/token facts that were perfectly valid.
    await new RequestLogService().record({
      requestId: "req-2",
      status: "success",
      tenantId: "org-acme/ws-main",
      workspaceId: VALID_UUID,
      modelCode: "glm-5.2",
    });

    const { data } = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(data["tenantId"]).toBeNull();
    expect(data["workspaceId"]).toBe(VALID_UUID);
    expect(data["modelCode"]).toBe("glm-5.2");
  });

  // product_251 X-2. The contrast with the test above is the whole point: a
  // non-UUID tenantId is nulled because the column is `uuid` and cannot hold
  // it, but taskId is `varchar` precisely so the caller's value survives. If it
  // were coerced the same way, the cross-product join this column exists for
  // would be silently empty for exactly the callers who did the right thing.
  it("stores a caller-minted taskId verbatim, in whatever shape it arrives", async () => {
    for (const taskId of [
      "task_01JQ8Z3M6F",
      "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      "run/2026-08-16/step-3",
    ]) {
      create.mockClear();
      await new RequestLogService().record({
        requestId: "req-task",
        status: "success",
        taskId,
        modelCode: "glm-5.2",
      });
      const { data } = (
        create.mock.calls[0] as [{ data: Record<string, unknown> }]
      )[0];
      expect(data["taskId"]).toBe(taskId);
    }
  });

  it("writes NULL rather than a placeholder when the caller sends no taskId", async () => {
    // Adoption has to be measurable - "callers who send one" must be countable
    // against "callers who do not", which an invented value would destroy.
    await new RequestLogService().record({
      requestId: "req-no-task",
      status: "success",
      modelCode: "glm-5.2",
    });

    const { data } = (
      create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0];
    expect(data["taskId"]).toBeNull();
  });

  it("warns out loud when it drops a request's tenant attribution", async () => {
    // Writing NULL stays correct - the column is `uuid` and losing the whole
    // row over one bad dimension would be worse - but doing it silently is
    // what let a caller's traffic vanish from every tenant report with no
    // error anywhere (#198 4). P3: the deviation can be justified, the
    // silence cannot.
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await new RequestLogService().record({
      requestId: "req-drop",
      status: "success",
      tenantId: "org-acme/ws-main",
      productCode: "vxtpl",
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("tenant attribution dropped"),
    );
    // Names the product, so an operator knows whom to tell.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("vxtpl"));
    const { data } = (
      create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0];
    expect(data["tenantId"]).toBeNull();
  });

  it("stays quiet when the tenant is a real UUID, or absent entirely", async () => {
    // A warning on every ordinary request would train operators to ignore it.
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await new RequestLogService().record({
      requestId: "req-ok",
      status: "success",
      tenantId: VALID_UUID,
    });
    await new RequestLogService().record({
      requestId: "req-none",
      status: "success",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("writes an in-vocabulary usage_type verbatim", async () => {
    await new RequestLogService().record({
      requestId: "req-6",
      status: "success",
      usageType: "test",
    });

    const { data } = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(data["usageType"]).toBe("test");
  });

  it("nulls an out-of-vocabulary usage_type instead of losing the whole row", async () => {
    // usage_type carries CHECK (usage_type IN ('normal','retry','test')).
    // Writing e.g. "production" verbatim would fail the CHECK, the catch would
    // swallow the whole row, and reqlog would read 'billed but never served'
    // for a request that was in fact served. Same degradation as asUuidOrNull.
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await new RequestLogService().record({
      requestId: "req-7",
      status: "success",
      workspaceId: VALID_UUID,
      modelCode: "glm-5.2",
      usageType: "production" as never,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(data["usageType"]).toBeNull();
    // The valid dimensions still land.
    expect(data["workspaceId"]).toBe(VALID_UUID);
    expect(data["modelCode"]).toBe("glm-5.2");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"production"'),
    );
  });

  it("never lets a log-write failure escape into the caller's request", async () => {
    // The hard rule: an inference call that succeeded must not be turned into
    // an error because the observability write failed.
    create.mockRejectedValue(new Error("partition missing"));

    await expect(
      new RequestLogService().record({ requestId: "req-3", status: "success" }),
    ).resolves.toBeUndefined();
  });
});

describe("RequestLogService.recordError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("truncates an oversized provider error body rather than dropping the row", async () => {
    const create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.errorRecord, "create").mockImplementation(create as never);

    await new RequestLogService().recordError({
      requestId: "req-4",
      errorCode: "PROVIDER_UNAVAILABLE",
      errorMessage: "x".repeat(9000),
    });

    const { data } = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect((data["errorMessage"] as string).length).toBe(4000);
  });

  it("swallows its own failures too", async () => {
    vi.spyOn(prisma.errorRecord, "create").mockRejectedValue(
      new Error("db down") as never,
    );

    await expect(
      new RequestLogService().recordError({ requestId: "req-5" }),
    ).resolves.toBeUndefined();
  });
});

describe("RequestLogService.record - cost splits (TD-047)", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.requestRecord, "create").mockImplementation(create as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = () =>
    (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  it("writes both splits as bigint when the upstream reported them", async () => {
    await new RequestLogService().record({
      requestId: "req-splits",
      status: "success",
      inputTokens: 84,
      outputTokens: 469,
      totalTokens: 553,
      cachedInputTokens: 20,
      reasoningTokens: 440,
    });

    expect(written()).toMatchObject({
      cachedInputTokens: 20n,
      reasoningTokens: 440n,
    });
  });

  it("writes NULL, not 0, when the upstream reported nothing", async () => {
    // The whole point of the columns. A fabricated 0 says "this call used no
    // cache and did no thinking", which is a measurement Atlas never took -
    // and it would make unmeasured traffic read as cheap.
    await new RequestLogService().record({
      requestId: "req-nosplits",
      status: "success",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });

    expect(written()).toMatchObject({
      cachedInputTokens: null,
      reasoningTokens: null,
    });
  });

  it("keeps a reported zero, which is a measurement", async () => {
    await new RequestLogService().record({
      requestId: "req-zero",
      status: "success",
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });

    expect(written()).toMatchObject({
      cachedInputTokens: 0n,
      reasoningTokens: 0n,
    });
  });
});

// Usage-record batch 1 (incr/04). What reaches the table, not what the caller
// passed: bigint for counts, the vendor's JSON verbatim, and a real SQL NULL -
// Prisma's DbNull, not JS null - when there is no raw usage.
describe("RequestLogService.record - usage-record batch 1", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.requestRecord, "create").mockImplementation(
      create as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = () =>
    (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  it("writes the vendor facts, the cache writes and the source", async () => {
    const rawUsage = { input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 5 } };
    await new RequestLogService().record({
      requestId: "req-b1",
      status: "success",
      inputTokens: 35,
      cacheWriteInputTokens: 20,
      cacheWrite1hInputTokens: 5,
      usageSource: "reported",
      upstreamRequestId: "msg_01abc",
      upstreamModel: "claude-sonnet-4-5-20250929",
      upstreamUsage: rawUsage,
      finishReason: "other",
      nativeFinishReason: "pause_turn",
    });

    expect(written()).toMatchObject({
      cacheWriteInputTokens: 20n,
      cacheWrite1hInputTokens: 5n,
      usageSource: "reported",
      upstreamRequestId: "msg_01abc",
      upstreamModel: "claude-sonnet-4-5-20250929",
      upstreamUsage: rawUsage,
      finishReason: "other",
      nativeFinishReason: "pause_turn",
    });
  });

  it("writes SQL NULL for every new column the entry does not carry", async () => {
    await new RequestLogService().record({ requestId: "req-b1-empty", status: "success" });

    const data = written();
    expect(data).toMatchObject({
      cacheWriteInputTokens: null,
      cacheWrite1hInputTokens: null,
      usageSource: null,
      upstreamRequestId: null,
      upstreamModel: null,
      finishReason: null,
      nativeFinishReason: null,
    });
    expect(data["upstreamUsage"]).toBe(Prisma.DbNull);
  });
});

// Usage-record K1: a write that fails must be countable, not only a warn line.
describe("RequestLogService - write failures are counted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts a request_records write refused for a missing column, by class", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(prisma.requestRecord, "create").mockRejectedValue(
      new Error(
        "Invalid `prisma.requestRecord.create()` invocation: The column `attempt_index of relation request_records` does not exist in the current database.",
      ) as never,
    );

    await new RequestLogService().record({ requestId: "req-k1", status: "success" });

    expect(await metricsRegistry.scrape()).toContain(
      'reqlog_write_failures_total{table="request_records",reason="missing_column"',
    );
  });

  it("tells atlasHealth a record was lost, with its table and class (F3b-A)", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const record = vi.spyOn(atlasHealth, "recordRequestLogFailure");
    vi.spyOn(prisma.requestRecord, "create").mockRejectedValue(new Error("permission denied for table request_records") as never);

    await new RequestLogService().record({ requestId: "req-f3b", status: "success" });

    expect(record).toHaveBeenCalledWith("request_records", "permission_denied");
  });

  it("sorts driver wording into a closed vocabulary", () => {
    expect(writeFailureReason(new Error('new row violates check constraint "chk_x"'))).toBe(
      "check_violation",
    );
    expect(writeFailureReason(new Error("permission denied for table request_records"))).toBe(
      "permission_denied",
    );
    expect(writeFailureReason(new Error("no partition of relation found for row"))).toBe(
      "missing_partition",
    );
    expect(writeFailureReason(new Error("something new"))).toBe("other");
  });
});

// Usage-record batch 2 (J1/J2): the row carries its own price, by the rule in
// force when the attempt STARTED, with the same formula the cost rollup uses.
describe("RequestLogService.record - the row prices itself", () => {
  let create: ReturnType<typeof vi.fn>;
  const rule = {
    id: "3f6b2f7e-1d7e-4b8a-9c4e-2d5f6a7b8c9d",
    currency: "CNY",
    unitTokens: 1_000_000,
    inputUnitPrice: { toString: () => "4.00000000" },
    outputUnitPrice: { toString: () => "16.00000000" },
    requestUnitPrice: { toString: () => "0.00000000" },
    cachedInputUnitPrice: { toString: () => "1.00000000" },
  };

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.requestRecord, "create").mockImplementation(create as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = () =>
    (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  it("prices a peak-hour call by the rule in force at startedAt", async () => {
    const findRule = vi
      .spyOn(prisma.modelPriceRule, "findFirst")
      .mockResolvedValue(rule as never);
    const startedAt = new Date("2026-09-30T03:00:00Z");

    await new RequestLogService().record({
      requestId: "req-price",
      status: "success",
      modelCode: "deepseek-v4-pro",
      providerCode: "deepseek",
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      outputTokens: 100_000,
      startedAt,
    });

    // uncached 750k x 4 + cached 250k x 1 + output 100k x 16, per 1M = 3 + 0.25 + 1.6
    expect(written()).toMatchObject({
      upstreamCost: "4.85000000",
      costCurrency: "CNY",
      priceRuleId: rule.id,
      pricingWindow: "peak",
      startedAt,
    });
    const where = (findRule.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      modelDef: { modelCode: "deepseek-v4-pro" },
      billingMode: "token",
      deletedAt: null,
      effectiveAt: { lte: startedAt },
    });
  });

  it("applies the provider's off-peak discount by when the call started", async () => {
    vi.spyOn(prisma.modelPriceRule, "findFirst").mockResolvedValue(rule as never);
    vi.spyOn(prisma.modelProvider, "findFirst").mockResolvedValue({
      config: {
        pricing: {
          offPeak: {
            timezone: "UTC",
            multiplier: "0.5",
            appliesTo: ["input", "cachedInput", "output"],
            peakWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], fromHour: 0, toHour: 16 }],
          },
        },
      },
    } as never);

    await new RequestLogService().record({
      requestId: "req-offpeak",
      status: "success",
      modelCode: "deepseek-v4-pro",
      providerCode: "deepseek",
      inputTokens: 1_000_000,
      outputTokens: 0,
      startedAt: new Date("2026-09-30T18:00:00Z"),
    });

    expect(written()).toMatchObject({ upstreamCost: "2.00000000", pricingWindow: "off_peak" });
  });

  it("leaves the row unpriced - NULL, not 0 - when no rule is in force", async () => {
    await new RequestLogService().record({
      requestId: "req-norule",
      status: "success",
      modelCode: "some-model",
      inputTokens: 10,
      outputTokens: 5,
    });

    expect(written()).toMatchObject({
      upstreamCost: null,
      costCurrency: null,
      priceRuleId: null,
      pricingWindow: null,
    });
  });

  it("does not look a price up for a row with no token counts", async () => {
    const findRule = vi.spyOn(prisma.modelPriceRule, "findFirst");

    await new RequestLogService().record({
      requestId: "req-notokens",
      status: "error",
      modelCode: "some-model",
    });

    expect(findRule).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ upstreamCost: null });
  });

  it("writes the request facts it is given", async () => {
    const startedAt = new Date("2026-09-30T01:00:00Z");
    const firstTokenAt = new Date("2026-09-30T01:00:01.200Z");
    await new RequestLogService().record({
      requestId: "req-facts",
      status: "success",
      startedAt,
      firstTokenAt,
      selectorKind: "endpoint",
      selectorValue: "chat/deterministic",
      providerKeyAlias: "deepseek-main",
      thinkingMode: "off",
      maxTokens: 4096,
      streamed: true,
      cancelledBy: "client",
    });

    expect(written()).toMatchObject({
      startedAt,
      firstTokenAt,
      selectorKind: "endpoint",
      selectorValue: "chat/deterministic",
      providerKeyAlias: "deepseek-main",
      thinkingMode: "off",
      maxTokens: 4096,
      streamed: true,
      cancelledBy: "client",
    });
  });
});

// Usage-record batch 3 (incr/06).
describe("RequestLogService.record - batch 3 facts", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.requestRecord, "create").mockImplementation(create as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the facts it is given, and stamps the stage on every row", async () => {
    await new RequestLogService().record({
      requestId: "req-b3",
      status: "success",
      tokenJti: "jti-abc",
      modelBehaviorVersion: "bv1-0123456789ab",
      toolCount: 3,
      toolCallsMade: 1,
      messageCount: 7,
      vectorCount: 2,
      vectorDimension: 1024,
    });

    const data = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      tokenJti: "jti-abc",
      modelBehaviorVersion: "bv1-0123456789ab",
      toolCount: 3,
      toolCallsMade: 1,
      messageCount: 7,
      vectorCount: 2,
      vectorDimension: 1024,
    });
    // Same source as /healthz; whatever it is, it is written on every row.
    expect(data).toHaveProperty("deployStage");
  });

  it("clamps a count past smallint instead of failing the insert", async () => {
    await new RequestLogService().record({
      requestId: "req-b3-big",
      status: "success",
      messageCount: 100_000,
    });

    const data = (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data["messageCount"]).toBe(32767);
  });
});

// Usage-record batch 4: the writer stamps, for every empty dimension, why.
describe("RequestLogService.record - dimension_status", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma.requestRecord, "create").mockImplementation(create as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = () =>
    (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  it("explains every empty dimension of a served chat row", async () => {
    await new RequestLogService().record({
      requestId: "req-b4",
      status: "success",
      capability: "chat",
      usageSource: "reported",
      streamed: false,
      modelCode: "deepseek-v4-pro",
      providerCode: "deepseek",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      finishReason: "stop",
      notSupported: ["cacheWriteInputTokens"],
      nullReasons: { billedAmount: "not_reported" },
    });

    const data = written();
    const status = data["dimensionStatus"] as Record<string, string>;
    expect(status).toMatchObject({
      cache_write_input_tokens: "not_supported", // declared by the adapter
      service_tier: "not_reported", // in the protocol, not sent this time
      upstream_cost: "not_configured", // no price rule in force (mocked: none)
      thinking_mode: "not_specified", // the caller sent none
      first_token_at: "not_applicable", // not a stream
      generated_image_count: "not_integrated", // Atlas has no such mechanism
      billed_amount: "not_reported", // the caller's own reason wins
    });
    // A value present is not marked.
    expect(status["input_tokens"]).toBeUndefined();
    // Facts Atlas states on a row that reached a provider.
    expect(data).toMatchObject({ queueWaitMs: 0, isBatch: false, contentFiltered: false });
  });

  it("marks the vendor columns not_reached on a row that never reached one", async () => {
    await new RequestLogService().record({
      requestId: "req-b4-refused",
      status: "error",
      capability: "chat",
      modelCode: "m",
    });

    const status = written()["dimensionStatus"] as Record<string, string>;
    expect(status["input_tokens"]).toBe("not_reached");
    expect(status["queue_wait_ms"]).toBe("not_reached");
    expect(written()).toMatchObject({ queueWaitMs: null, isBatch: null });
  });

  it("says a dropped non-UUID tenant was a capture failure, not an absent one", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await new RequestLogService().record({
      requestId: "req-b4-tenant",
      status: "success",
      tenantId: "org-acme/ws-main",
    });

    const status = written()["dimensionStatus"] as Record<string, string>;
    expect(status["tenant_id"]).toBe("capture_failed");
  });
});

// A vendor that starts reporting a figure Atlas does not map must surface,
// not just land in upstream_usage while the column keeps saying not_supported.
describe("RequestLogService.record - unmapped vendor usage", () => {
  beforeEach(() => {
    vi.spyOn(prisma.requestRecord, "create").mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts every unmapped field and warns once per provider and field", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const service = new RequestLogService();
    const entry = {
      requestId: "req-unmapped",
      status: "success" as const,
      providerCode: "doubao",
      upstreamUsage: { prompt_tokens: 1, prompt_tokens_details: { image_tokens: 7 } },
    };

    await service.record(entry);
    await service.record({ ...entry, requestId: "req-unmapped-2" });

    expect(await metricsRegistry.scrape()).toContain(
      'upstream_usage_unmapped_keys_total{provider="doubao",key="prompt_tokens_details.image_tokens"} 2',
    );
    const lines = warn.mock.calls.filter(([m]) => String(m).includes("image_tokens"));
    expect(lines).toHaveLength(1);
  });

  it("is silent for a usage object Atlas fully maps", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await new RequestLogService().record({
      requestId: "req-mapped",
      status: "success",
      providerCode: "deepseek",
      upstreamUsage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    expect(warn.mock.calls.filter(([m]) => String(m).includes("does not map"))).toEqual([]);
  });
});
