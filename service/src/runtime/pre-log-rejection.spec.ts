import { describe, expect, it } from "vitest";
import { HttpStatus } from "@nestjs/common";

import { countingRejectionsSync } from "./pre-log-rejection";
import { metricsRegistry } from "./metrics.registry";
import { ModelRuntimeException } from "./runtime.errors";

/**
 * Only the counter's own lines. A whole-scrape comparison would fail on
 * process_resident_memory_bytes, which moves between two calls for reasons
 * that have nothing to do with this.
 */
async function rejectionLines(): Promise<string> {
  const scrape = await metricsRegistry.scrape();
  return scrape
    .split("\n")
    .filter((line) => line.startsWith("model_request_rejections_total"))
    .sort()
    .join("\n");
}

/**
 * The first version of this counted only the chat path, and the commit message
 * claimed it "fixes the class rather than this instance". It did not - embed,
 * rerank and parse each reject on their own path and all three stayed silent.
 * That is the same defect one directory over, so these assert the helper
 * itself rather than one caller of it.
 */
describe("pre-log rejection accounting", () => {
  const AUTH = { callerProductCode: "vxtpl" };

  it("counts a vocabulary rejection against the product that sent it", async () => {
    const before = await rejectionLines();

    expect(() =>
      countingRejectionsSync(AUTH, "req-1", () => {
        throw new ModelRuntimeException(
          HttpStatus.BAD_REQUEST,
          "INVALID_TENANT_ID",
          "not a uuid",
        );
      }),
    ).toThrow(ModelRuntimeException);

    const after = await rejectionLines();
    expect(after).toContain('code="INVALID_TENANT_ID"');
    expect(after).toContain('product="vxtpl"');
    expect(after).not.toBe(before);
  });

  it("does NOT count an unexpected error as a caller rejection", async () => {
    // Counting a bug under a rejection metric would move the "who still needs
    // to migrate" reading in the direction that looks like progress.
    const before = await rejectionLines();

    expect(() =>
      countingRejectionsSync(AUTH, "req-2", () => {
        throw new Error("a bug, not a caller mistake");
      }),
    ).toThrow("a bug");

    expect(await rejectionLines()).toBe(before);
  });

  it("labels an unauthenticated rejection rather than dropping it", async () => {
    // A request refused before the guard resolved a product is still a
    // request somebody sent; `unknown` is a readable bucket, absence is not.
    expect(() =>
      countingRejectionsSync(undefined, undefined, () => {
        throw new ModelRuntimeException(
          HttpStatus.BAD_REQUEST,
          "TENANT_ID_REQUIRED",
          "absent",
        );
      }),
    ).toThrow(ModelRuntimeException);

    expect(await rejectionLines()).toContain('product="unknown"');
  });

  it("returns the value untouched when nothing is rejected", () => {
    expect(countingRejectionsSync(AUTH, "req-3", () => "ok")).toBe("ok");
  });
});
