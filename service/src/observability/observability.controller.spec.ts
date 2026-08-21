import { describe, expect, it, vi } from "vitest";

import { ObservabilityController } from "./observability.controller";

/**
 * The controller is a thin mapping from query parameters to filter fields -
 * which is exactly why it is worth testing. A misspelled key here does not
 * throw and does not fail type-check: the filter silently does not apply, the
 * caller gets the unfiltered page, and it reads like there simply was no
 * matching data. That is the P3 failure shape (a silent deviation, not a
 * refusal) sitting in the one place nothing else covers.
 */
function makeController() {
  const observability = {
    searchLogs: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    summarize: vi.fn().mockResolvedValue({
      windowStart: "",
      windowEnd: "",
      overall: {},
      byGroup: [],
    }),
  };
  return {
    controller: new ObservabilityController(observability as never),
    observability,
  };
}

describe("ObservabilityController.searchLogs", () => {
  it("forwards every filter it accepts, under the same name", async () => {
    const { controller, observability } = makeController();

    await controller.searchLogs(
      {},
      "tenant-1",
      "gpt-4o",
      "openai",
      "chat/default",
      "error",
      "req-1",
      "task_01JQ8Z3M6F",
      "2026-08-01T00:00:00Z",
      "2026-08-02T00:00:00Z",
      "cursor-1",
      "25",
    );

    expect(observability.searchLogs).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      modelCode: "gpt-4o",
      providerCode: "openai",
      endpointCode: "chat/default",
      status: "error",
      requestId: "req-1",
      taskId: "task_01JQ8Z3M6F",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-02T00:00:00Z",
      cursor: "cursor-1",
      limit: "25",
    });
  });

  it("omits absent parameters instead of passing undefined through", async () => {
    // The service distinguishes "no filter" from "filter on nothing"; a key
    // present with an undefined value would blur the two.
    const { controller, observability } = makeController();

    await controller.searchLogs({});

    expect(observability.searchLogs).toHaveBeenCalledWith({});
  });

  it("passes taskId on its own, without requiring any other filter", async () => {
    // "show me everything this agent task did" is the whole point of X-2, and
    // it is a query with exactly one term.
    const { controller, observability } = makeController();

    await controller.searchLogs(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "task_01JQ8Z3M6F",
    );

    expect(observability.searchLogs).toHaveBeenCalledWith({
      taskId: "task_01JQ8Z3M6F",
    });
  });
});

describe("ObservabilityController.summarize", () => {
  it("forwards the window and group filters", async () => {
    const { controller, observability } = makeController();

    await controller.summarize({}, "24h", "gpt-4o", "openai", "chat/default");

    expect(observability.summarize).toHaveBeenCalledWith({
      window: "24h",
      modelCode: "gpt-4o",
      providerCode: "openai",
      endpointCode: "chat/default",
    });
  });

  it("omits absent parameters so the service applies its own default window", async () => {
    const { controller, observability } = makeController();

    await controller.summarize({});

    expect(observability.summarize).toHaveBeenCalledWith({});
  });
});

describe("ObservabilityController unknown filters", () => {
  it("refuses a filter it does not know rather than returning an unfiltered page", async () => {
    const { controller, observability } = makeController();

    expect(() => controller.searchLogs({ tenant_id: "t-1" })).toThrow();
    expect(observability.searchLogs).not.toHaveBeenCalled();
  });

  it("accepts taskId, which is in the allow-list", async () => {
    // The allow-list has to move with the service. A filter the service
    // supports but the list omits would be refused - loud, and caught here.
    const { controller, observability } = makeController();

    await controller.searchLogs(
      { taskId: "task_1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "task_1",
    );

    expect(observability.searchLogs).toHaveBeenCalledWith({ taskId: "task_1" });
  });

  it("guards the summary endpoint with its own narrower list", async () => {
    const { controller, observability } = makeController();

    // `limit` is legal on /logs and meaningless on /logs/summary.
    expect(() => controller.summarize({ limit: "25" })).toThrow();
    expect(observability.summarize).not.toHaveBeenCalled();
  });
});
