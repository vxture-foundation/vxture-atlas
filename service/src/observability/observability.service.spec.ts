import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

import { ObservabilityService } from "./observability.service";
import type {
  ErrorLogRecord,
  RequestLogRecord,
} from "../reqlog/request-log.types";

function makeRow(overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
  return {
    id: "row-1",
    requestId: "req-1",
    taskId: null,
    status: "success",
    tenantId: "tenant-1",
    workspaceId: null,
    applicationId: null,
    applicationType: null,
    agentId: null,
    modelCode: "gpt-4o",
    providerCode: "openai",
    endpointCode: null,
    productCode: null,
    inputTokens: 10n,
    outputTokens: 5n,
    totalTokens: 15n,
    latencyMs: 200,
    attemptIndex: null,
    usageType: "normal",
    costUnit: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    searchRequestLogs: vi.fn().mockResolvedValue([]),
    findErrorRecordsByRequestIds: vi.fn().mockResolvedValue([]),
    summarizeRequestLogs: vi.fn().mockResolvedValue({
      overall: { requests: 0n, errors: 0n, avgLatencyMs: null, p95LatencyMs: null },
      byGroup: [],
    }),
    summarizeRequestCost: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("ObservabilityService.searchLogs", () => {
  it("rejects an unknown status before querying the repository", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await expect(svc.searchLogs({ status: "bogus" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.searchRequestLogs).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await expect(
      svc.searchLogs({ limit: "not-a-number" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a malformed from/to date", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await expect(svc.searchLogs({ from: "not-a-date" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("clamps an oversized limit to the max and requests one extra row for pagination", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await svc.searchLogs({ limit: "10000" });

    expect(repo.searchRequestLogs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 201 }), // MAX_LIMIT(200) + 1
    );
  });

  it("returns no nextCursor when fewer rows than the limit come back", async () => {
    const repo = makeRepo({
      searchRequestLogs: vi.fn().mockResolvedValue([makeRow()]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({ limit: "50" });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("returns a nextCursor and trims the extra row when more results exist", async () => {
    const rows = [
      makeRow({ id: "row-1", requestId: "req-1" }),
      makeRow({ id: "row-2", requestId: "req-2" }),
    ];
    const repo = makeRepo({
      searchRequestLogs: vi.fn().mockResolvedValue(rows),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({ limit: "1" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("row-1");
    expect(result.nextCursor).not.toBeNull();
  });

  it("a cursor round-trips through search - decode(encode(x)) reaches the repository as the same key", async () => {
    const rows = [makeRow({ id: "row-1" }), makeRow({ id: "row-2" })];
    const repo = makeRepo({
      searchRequestLogs: vi.fn().mockResolvedValue(rows),
    });
    const svc = new ObservabilityService(repo as never);

    const first = await svc.searchLogs({ limit: "1" });
    expect(first.nextCursor).not.toBeNull();

    await svc.searchLogs({ limit: "1", cursor: first.nextCursor! });

    expect(repo.searchRequestLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: { createdAt: rows[0]!.createdAt, id: "row-1" },
      }),
    );
  });

  it("rejects a garbage cursor with a clean 400, not an unhandled parse error", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await expect(
      svc.searchLogs({ cursor: "not-valid-base64-json" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns token counts as plain numbers so a page with rows survives JSON.stringify", async () => {
    // Prisma reads the BIGINT token columns as BigInt, which JSON.stringify
    // rejects - the raw row would 500 any page containing a success row.
    const repo = makeRepo({
      searchRequestLogs: vi.fn().mockResolvedValue([makeRow()]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({});

    expect(result.items[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("converts every bigint the row carries, not a fixed list of columns", async () => {
    // The query selects no explicit column set, so a BIGINT column added to
    // reqlog.request_records arrives here whether or not anyone remembered it.
    // billed_amount is exactly that case: NULL in every row today, so a
    // column-list conversion looks correct until the first billed row 500s the
    // page (vxture-atlas#193).
    const repo = makeRepo({
      searchRequestLogs: vi
        .fn()
        .mockResolvedValue([makeRow({ billedAmount: 4096n } as never)]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({});

    expect(result.items[0]).toMatchObject({ billedAmount: 4096 });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("preserves null token counts rather than coercing them to 0", async () => {
    const repo = makeRepo({
      searchRequestLogs: vi.fn().mockResolvedValue([
        makeRow({ inputTokens: null, outputTokens: null, totalTokens: null }),
      ]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({});

    expect(result.items[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("attaches the matching error record only to non-success rows", async () => {
    const successRow = makeRow({ id: "row-1", requestId: "req-1", status: "success" });
    const failedRow = makeRow({ id: "row-2", requestId: "req-2", status: "error" });
    const errorRecord: ErrorLogRecord = {
      id: "err-1",
      requestId: "req-2",
      providerCode: "openai",
      modelCode: "gpt-4o",
      endpointCode: null,
      errorCode: "PROVIDER_UNAVAILABLE",
      errorMessage: "boom",
      createdAt: new Date("2026-08-01T00:00:01Z"),
    };
    const repo = makeRepo({
      searchRequestLogs: vi.fn().mockResolvedValue([successRow, failedRow]),
      findErrorRecordsByRequestIds: vi.fn().mockResolvedValue([errorRecord]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({});

    expect(repo.findErrorRecordsByRequestIds).toHaveBeenCalledWith(["req-2"]);
    expect(result.items.find((r) => r.requestId === "req-1")?.error).toBeNull();
    expect(result.items.find((r) => r.requestId === "req-2")?.error).toEqual(
      errorRecord,
    );
  });
});

describe("ObservabilityService.summarize", () => {
  it("rejects an unknown window", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await expect(svc.summarize({ window: "3q" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("defaults to a 24h window ending now", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    const before = Date.now();
    await svc.summarize({});
    const after = Date.now();

    const call = repo.summarizeRequestLogs.mock.calls[0]?.[0];
    expect(call.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(call.to.getTime()).toBeLessThanOrEqual(after);
    expect(call.to.getTime() - call.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("converts bigint counts and Decimal averages to numbers and computes an error rate", async () => {
    // Postgres avg() over integer returns numeric, which Prisma surfaces as
    // Decimal - an object that serializes as a JSON *string*. Stand-in below
    // mimics that shape; the assertions demand a real number came out.
    const decimalLike = (value: string) => ({
      valueOf: () => value,
      toString: () => value,
    });
    const repo = makeRepo({
      summarizeRequestLogs: vi.fn().mockResolvedValue({
        overall: {
          requests: 100n,
          errors: 5n,
          avgLatencyMs: decimalLike("120.5"),
          p95LatencyMs: 400,
        },
        byGroup: [
          {
            modelCode: "gpt-4o",
            providerCode: "openai",
            endpointCode: "chat/default",
            requests: 60n,
            errors: 3n,
            totalTokens: 900n,
            avgLatencyMs: decimalLike("110"),
            p95LatencyMs: 350,
          },
        ],
      }),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.summarize({});

    expect(result.overall).toEqual({
      requests: 100,
      errors: 5,
      errorRate: 0.05,
      // `overall` comes from an aggregate with no token sum; it reports 0
      // rather than silently re-deriving one by summing the groups.
      totalTokens: 0,
      avgLatencyMs: 120.5,
      p95LatencyMs: 400,
    });
    /* The repository still hands back `byGroup` (see the mock above) - that is
       the storage layer's word. The wire says `items` (product_251 A-4), and
       the mapping between the two is exactly what this line pins. */
    expect(result.items[0]).toEqual({
      modelCode: "gpt-4o",
      providerCode: "openai",
      endpointCode: "chat/default",
      totalTokens: 900,
      requests: 60,
      errors: 3,
      errorRate: 0.05,
      avgLatencyMs: 110,
      p95LatencyMs: 350,
    });
  });

  it("reports a zero error rate rather than dividing by zero when there are no requests", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    const result = await svc.summarize({});

    expect(result.overall.errorRate).toBe(0);
  });

  it("preserves a null average latency rather than coercing it to NaN or 0", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    const result = await svc.summarize({});

    expect(result.overall.avgLatencyMs).toBeNull();
    expect(result.overall.p95LatencyMs).toBeNull();
  });
});

// ── task attribution (product_251 X-2) ───────────────────────────────────────

describe("ObservabilityService taskId filter", () => {
  it("passes taskId through to the repository", async () => {
    // Storing task_id is only half of X-2. If the dimension cannot be read
    // back, "what did this agent task do" is still unanswerable and the column
    // is inert - so the passthrough is pinned, not assumed.
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await svc.searchLogs({ taskId: "task_01JQ8Z3M6F" });

    expect(repo.searchRequestLogs).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_01JQ8Z3M6F" }),
    );
  });

  it("omits the filter entirely when no taskId is given", async () => {
    // An empty-string filter would match nothing rather than everything,
    // turning "no filter" into "no results".
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await svc.searchLogs({});

    const [filters] = repo.searchRequestLogs.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect("taskId" in filters).toBe(false);
  });

  it("returns the row's taskId to the caller", async () => {
    const repo = makeRepo({
      searchRequestLogs: vi
        .fn()
        .mockResolvedValue([makeRow({ taskId: "task_01JQ8Z3M6F" })]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.searchLogs({ taskId: "task_01JQ8Z3M6F" });

    expect(result.items[0]).toMatchObject({ taskId: "task_01JQ8Z3M6F" });
  });

  it("combines taskId with the other filters rather than replacing them", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await svc.searchLogs({
      taskId: "task_01JQ8Z3M6F",
      status: "error",
      modelCode: "gpt-4o",
    });

    expect(repo.searchRequestLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_01JQ8Z3M6F",
        status: "error",
        modelCode: "gpt-4o",
      }),
    );
  });
});

/**
 * The cost route's own layer. The arithmetic has its own file and its own
 * tests; what is checked here is the wiring nothing else covers - the window,
 * the filters, and the fact that `basis` travels with the numbers.
 */
describe("ObservabilityService.summarizeCost", () => {
  it("rejects an unknown window before touching the repository", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await expect(svc.summarizeCost({ window: "3d" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.summarizeRequestCost).not.toHaveBeenCalled();
  });

  it("defaults to 24h and passes a real window down", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await svc.summarizeCost({});

    const call = repo.summarizeRequestCost.mock.calls[0]?.[0];
    expect(call.to.getTime() - call.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("forwards only the filters it was given", async () => {
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    await svc.summarizeCost({ modelCode: "deepseek-v4-flash" });

    const call = repo.summarizeRequestCost.mock.calls[0]?.[0];
    expect(call.modelCode).toBe("deepseek-v4-flash");
    // Not `providerCode: undefined` - an explicit undefined would reach the
    // query as a bound parameter and is not the same thing as absent.
    expect("providerCode" in call).toBe(false);
  });

  it("carries `basis` with the numbers, not in a document somewhere", async () => {
    // Without it, a reader reconciles against the provider's invoice, finds a
    // difference, and concludes the meter is broken.
    const repo = makeRepo();
    const svc = new ObservabilityService(repo as never);

    const result = await svc.summarizeCost({});

    expect(result.basis.reasoningTokens).toMatch(/never added/iu);
    expect(result.basis.meters).toMatch(/does not bill/iu);
    expect(result.from).toBeTypeOf("string");
    expect(result.to).toBeTypeOf("string");
  });

  it("returns the rollup of what the repository handed back", async () => {
    const repo = makeRepo({
      summarizeRequestCost: vi.fn().mockResolvedValue([
        {
          modelCode: "m",
          providerCode: "p",
          priceRuleId: "r",
          currency: "CNY",
          unitTokens: 1_000_000,
          inputUnitPrice: "3.00000000",
          outputUnitPrice: "12.00000000",
          requestUnitPrice: "0.00000000",
          cachedInputUnitPrice: "0.10000000",
          isoDow: 1,
          hourUtc: 12,
          providerPricing: null,
          requests: 1n,
          requestsMissingInput: 0n,
          requestsMissingOutput: 0n,
          inputTokens: 1_000_000n,
          cachedInputTokens: 0n,
          outputTokens: 0n,
          reasoningTokens: 0n,
        },
      ]),
    });
    const svc = new ObservabilityService(repo as never);

    const result = await svc.summarizeCost({ providerCode: "p" });

    expect(result.totalsByCurrency).toEqual([
      { currency: "CNY", estimatedCost: "3.00000000" },
    ]);
    expect(result.coverage.requests).toBe(1);
  });
});

describe("ObservabilityService.summarizeCost, unusable provider policy", () => {
  it("answers with a code and the provider, not a bare 500", () => {
    // Operator data, not a defect. A 500 here would repeat the shape
    // `PATCH /capability/price-rules/:id` had for weeks: a config row producing
    // an uncoded server error that names nothing.
    const repo = makeRepo({
      summarizeRequestCost: vi.fn().mockResolvedValue([
        {
          modelCode: "m",
          providerCode: "deepseek",
          priceRuleId: null,
          currency: null,
          unitTokens: null,
          inputUnitPrice: null,
          outputUnitPrice: null,
          requestUnitPrice: null,
          cachedInputUnitPrice: null,
          isoDow: 6,
          hourUtc: 2,
          providerPricing: JSON.stringify({ offPeak: { timezone: "Asia/Shanghai" } }),
          requests: 1n,
          requestsMissingInput: 0n,
          requestsMissingOutput: 0n,
          inputTokens: 0n,
          cachedInputTokens: 0n,
          outputTokens: 0n,
          reasoningTokens: 0n,
        },
      ]),
    });
    const svc = new ObservabilityService(repo as never);

    return svc.summarizeCost({}).then(
      () => expect.unreachable("expected a refusal"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(BadRequestException);
        const body = (error as BadRequestException).getResponse() as Record<string, unknown>;
        expect(body["code"]).toBe("OBSERVABILITY_INVALID_PRICING_POLICY");
        expect(body["providerCode"]).toBe("deepseek");
      },
    );
  });
});

