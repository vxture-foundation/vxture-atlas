/**
 * uuid.ts - one definition of "is this a UUID", for the whole service.
 *
 * There were four identical copies of this regex (registry repository, reqlog
 * writer, operator guard, tenancy service), each deciding independently whether
 * a caller-supplied identifier counted. Four copies is four chances to drift,
 * and the bug class they exist to prevent is exactly a disagreement between
 * layers about what a valid tenant id is: one layer accepted a non-UUID
 * `tenantId`, the next wrote it as NULL, and a third rejected it outright with
 * `400 INVALID_TENANT_ID` - three different answers to one question, which is
 * how the same request could look fine for weeks and then fail (#198 §4).
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}
