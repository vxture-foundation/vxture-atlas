/**
 * contract.ts - the `/v1` vocabulary, published as an artifact instead of a
 * letter.
 *
 * ## Why this exists
 *
 * Four consumers (karda / yucer / vxtpl / platform) each hand-copy the same
 * error-code table out of a liaison letter into their own repository. karda
 * opened #21 with the receipt: `10-2607241030` promised `QUOTA_EXHAUSTED`,
 * `quota.service.ts` has thrown `QUOTA_EXCEEDED` since the first day, karda
 * implemented what the letter said, and the branch never fired. Both sides' CI
 * stayed green, production raised nothing, and it took months to notice -
 * because **the symptom of a dead branch is that nothing happens.**
 *
 * A code table that lives only in prose has no failure mode that anyone can
 * observe. This turns it into bytes a consumer can diff.
 *
 * ## Why the source is already trustworthy
 *
 * The hard part was done by product_251 X-1: `RETRYABLE` is an exhaustive
 * `Record` over the union, so a code cannot exist without a retry
 * classification, and `check-error-codes.mjs` proves that every declared code
 * is thrown and every thrown code is declared. What was missing was never
 * correctness - it was **delivery**.
 *
 * ## The fingerprint is derived, never written
 *
 * TD-044 recorded the failure this avoids: `ToolDescriptor.version` is
 * hand-maintained and has never moved, including through the release that made
 * `taskId` mandatory. A consumer diffing that field is told "nothing changed"
 * by a field that cannot change. **A version number nobody increments is worse
 * than no version number**, because it converts a missing signal into a false
 * one.
 *
 * So this fingerprint is a pure function of the content. There is no write path
 * that could set it wrong, because there is no write path at all - the same
 * argument `model-behavior-version.ts` makes for `behaviorVersion`.
 */

import { createHash } from "node:crypto";

import { byCodeUnit } from "../model-behavior-version";
import { MODEL_RUNTIME_ERROR_CODES, isRetryable } from "./runtime.errors";

/**
 * Scheme tag, same convention as `behaviorVersion`'s `b1-`.
 *
 * It changes only if the shape below or the digest algorithm changes, and when
 * it does the fingerprint changes for everyone at once. A consumer has to be
 * able to tell that apart from "the vocabulary actually changed": same scheme +
 * different digest is a real change; a different scheme is ours, and comes with
 * a liaison note.
 */
const SCHEME = "c1";

export interface ContractErrorCode {
  code: string;
  /**
   * Whether repeating the identical request can succeed. Published as a FACT,
   * not as advice: what a consumer does with it - back off, fail the task,
   * surface it - is the consumer's decision and Atlas does not model it.
   */
  retryable: boolean;
}

export interface AtlasContract {
  /**
   * Opaque. Not ordered, not a semver, and carrying no claim about how large
   * the change was - exactly like `behaviorVersion`. Diff it against the last
   * value you saw; equal means the vocabulary below is byte-identical.
   */
  fingerprint: string;
  /** Every code `/v1` can put in an error envelope, with its retry class. */
  errorCodes: ContractErrorCode[];
}

/**
 * Build the contract from the running build's own vocabulary.
 *
 * Sorted by code unit rather than `localeCompare` for the reason
 * `model-behavior-version.ts` spells out: the order feeds a hash, and a
 * locale-sensitive sort would make two machines fingerprint the same
 * vocabulary differently. A consumer comparing across them would read "the
 * contract changed" on every request.
 */
export function buildAtlasContract(): AtlasContract {
  const errorCodes: ContractErrorCode[] = [...MODEL_RUNTIME_ERROR_CODES]
    .sort(byCodeUnit)
    .map((code) => ({ code, retryable: isRetryable(code) }));

  // Hash the semantic content, not the JSON rendering: whitespace and key order
  // must not move the fingerprint, or a formatter would announce a contract
  // change to four consumers.
  const material = errorCodes
    .map((entry) => `${entry.code}:${entry.retryable ? "1" : "0"}`)
    .join("\n");

  const digest = createHash("sha256")
    .update(material)
    .digest("hex")
    .slice(0, 12);

  return { fingerprint: `${SCHEME}-${digest}`, errorCodes };
}
