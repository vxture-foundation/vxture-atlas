import { describe, expect, it } from "vitest";

import { requireTaskId } from "./task-attribution";
import { ModelRuntimeException } from "./runtime.errors";
import { MODEL_RUNTIME_ERROR_CODES } from "./runtime.errors";

/**
 * The 843 tests that started passing again when the fixtures gained a `taskId`
 * prove only that a request WITH one is not blocked. None of them proves a
 * request without one is refused - which is the entire change. So these do.
 */
describe("requireTaskId (product_251 X-2)", () => {
  it("refuses an absent taskId", () => {
    expect(() => requireTaskId(undefined)).toThrow(ModelRuntimeException);
  });

  it("refuses an empty or whitespace-only taskId", () => {
    // Otherwise the requirement is satisfiable by sending "" - the metering key
    // is then present, useless, and no longer detectable as missing, which is
    // worse than the NULL it replaced.
    expect(() => requireTaskId("")).toThrow(ModelRuntimeException);
    expect(() => requireTaskId("   ")).toThrow(ModelRuntimeException);
  });

  it("accepts any stable non-empty string", () => {
    // Deliberately not a UUID. `tenant_id` is a uuid column, so a non-uuid was
    // written NULL and that traffic vanished from every tenant-dimension report
    // with nothing raised (#198 section 4). `task_id` is varchar(128), stored
    // verbatim, because the id belongs to the caller's task system, not ours.
    expect(() => requireTaskId("task-1")).not.toThrow();
    expect(() => requireTaskId("karda:run/8f2c")).not.toThrow();
    expect(() =>
      requireTaskId("0198f3aa-1c2b-7000-8000-000000000001"),
    ).not.toThrow();
  });

  it("carries a code from the published vocabulary, with retryable", () => {
    let thrown: ModelRuntimeException | undefined;
    try {
      requireTaskId(undefined);
    } catch (error) {
      thrown = error as ModelRuntimeException;
    }

    const body = thrown?.getResponse() as Record<string, unknown>;
    expect(MODEL_RUNTIME_ERROR_CODES).toContain("TASK_ID_REQUIRED");
    expect(body["code"]).toBe("TASK_ID_REQUIRED");
    // Sending the identical request again cannot help - the caller has to add
    // a field. X-1 says that must be machine-readable, not inferred.
    expect(body["retryable"]).toBe(false);
  });

  it("tells the caller what to send, not just that it is missing", () => {
    // This refusal will meet every consumer's production traffic at once. A
    // message that only says "required" costs each of them a round trip
    // through us to learn the field name, shape and semantics.
    let message = "";
    try {
      requireTaskId(undefined);
    } catch (error) {
      message = (error as ModelRuntimeException).message;
    }
    expect(message).toContain("taskId");
    expect(message).toMatch(/top-level/);
    expect(message).toMatch(/128/);
  });
});
