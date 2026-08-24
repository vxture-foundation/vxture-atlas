import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../prisma";
import { RequestLogService } from "./request-log.service";

const VALID_UUID = "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8";

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
