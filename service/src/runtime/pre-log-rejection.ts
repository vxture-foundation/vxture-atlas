import { Logger } from "@nestjs/common";

import { metricsRegistry } from "./metrics.registry";
import { isModelRuntimeErrorCode, ModelRuntimeException } from "./runtime.errors";

const logger = new Logger("PreLogRejection");

/**
 * The only record that a refused request ever existed.
 *
 * Every /v1 entry point validates BEFORE the in-flight gauge and before the
 * first reqlog write, so a rejection leaves no row, no error record and no log
 * line. For the caller that is fine - they got a 400 naming the field. For an
 * operator asking "who is still sending this" it is silence, and tightening a
 * validation rule without this trades one invisible failure for another: the
 * traffic stops being mis-attributed by disappearing entirely.
 *
 * Wrapping all four surfaces rather than the one that motivated it. chat,
 * embed, rerank and parse each reject on their own path; covering only the one
 * being changed would have left three quiet, which is the same defect one
 * directory over.
 */
export async function countingRejections<T>(
  auth: { callerProductCode?: string | undefined } | undefined,
  requestId: string | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    recordRejection(error, auth, requestId);
    throw error;
  }
}

/** Synchronous form, for a validate() that is not async. */
export function countingRejectionsSync<T>(
  auth: { callerProductCode?: string | undefined } | undefined,
  requestId: string | undefined,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    recordRejection(error, auth, requestId);
    throw error;
  }
}

/**
 * Exported for the body parser (request-body.ts): a body refused before
 * routing is the earliest pre-log rejection of all, and before this it was
 * counted nowhere. It runs before the token is verified, so its product is
 * always "unknown" - honest, and still bounded.
 */
export function recordRejection(
  error: unknown,
  auth: { callerProductCode?: string | undefined } | undefined,
  requestId: string | undefined,
): void {
  // Only OUR rejections. An unexpected error is not a caller mistake, and
  // counting it under a rejection metric would make the "who still needs to
  // migrate" reading wrong in the direction that looks like progress.
  const code =
    error instanceof ModelRuntimeException && isModelRuntimeErrorCode(error.code)
      ? error.code
      : undefined;
  if (code === undefined) return;

  // Both labels are server-derived: `code` from the closed vocabulary and
  // `product` from the verified token. Neither is caller-controlled, so the
  // label cardinality is bounded no matter what is sent.
  metricsRegistry.incCounter("model_request_rejections_total", {
    code,
    product: auth?.callerProductCode ?? "unknown",
  });
  logger.warn(
    `request rejected before logging: ${code}` +
      (auth?.callerProductCode ? ` (product=${auth.callerProductCode})` : "") +
      (requestId ? ` requestId=${requestId}` : ""),
  );
}
