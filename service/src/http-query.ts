import { BadRequestException } from "@nestjs/common";

/**
 * http-query.ts - reject query parameters a search endpoint does not know.
 *
 * Nest's `@Query("name")` binds only the parameters it is asked for. Everything
 * else is discarded without a word, which is harmless on an endpoint that takes
 * no filters and dangerous on one that does: an unrecognised filter is not
 * applied, so the caller receives an unfiltered page - HTTP 200, well-formed
 * body, completely wrong answer.
 *
 * On an audit search that is the worst available failure. An operator asking
 * "what did opr_x change" after a filter has been renamed gets somebody else's
 * changes, presented as the answer to their question, with nothing anywhere
 * indicating a problem. The rename in front of us (product_251 X-3:
 * `resourceType` -> `objectType`, `operatorSub` -> `actorId`) turns every
 * un-migrated console query into exactly that, so this has to land first.
 *
 * P3: a refusal is recoverable, a silently different answer is not.
 */
export function unknownFilters(
  query: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const permitted = new Set(allowed);
  return Object.keys(query)
    .filter((key) => !permitted.has(key))
    .sort();
}

/**
 * Naming BOTH sides is the point: after a rename the caller is sending a
 * parameter that was correct last week, so "unknown filter" alone reads as a
 * typo. The accepted list is what tells them it moved.
 */
export function unknownFilterMessage(
  unknown: readonly string[],
  allowed: readonly string[],
): string {
  return (
    `unknown filter(s): ${[...unknown].sort().join(", ")}. ` +
    `This endpoint accepts: ${[...allowed].sort().join(", ")}. ` +
    "The request was refused rather than answered without the filter applied."
  );
}

/**
 * The operator plane's form. The consumption plane cannot use it: product_251
 * X-1 requires every `/v1` error to carry a code from the runtime vocabulary,
 * so those handlers pair `unknownFilters` with a `ModelRuntimeException`
 * (`UNKNOWN_FILTER`) and share only the message.
 */
export function rejectUnknownFilters(
  query: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const unknown = unknownFilters(query, allowed);
  if (unknown.length === 0) return;

  throw new BadRequestException({
    code,
    message: unknownFilterMessage(unknown, allowed),
    retryable: false,
    field: unknown[0],
  });
}
