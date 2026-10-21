/**
 * Remove trailing slashes without scanning the same suffix repeatedly.
 *
 * @package @atlas/service
 * @layer Infrastructure
 * @category HTTP
 * @author AI-Generated
 * @date 2026-10-21
 */

/** Preserve every character before the final slash run, including internal slashes. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
