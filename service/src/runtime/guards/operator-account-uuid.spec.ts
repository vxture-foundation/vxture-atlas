/**
 * operator-account-uuid.spec.ts - operator subject -> account uuid
 * @package @atlas/service
 * @layer Domain
 * @category test
 *
 * @description
 *   Three columns are typed `uuid` and documented as holding a platform
 *   operator ACCOUNT id, while the token subject is the prefixed `opr_<uuid>`
 *   form. Passing the subject through unchanged made Postgres reject the whole
 *   statement, so every write on `/capability/api-keys` and every provider-key
 *   rotation answered 500. These pin the conversion and, as importantly, that
 *   an unfamiliar subject degrades attribution instead of failing the write.
 */
import { describe, expect, it } from "vitest";

import { toOperatorAccountUuid } from "./operator-auth.guard";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("toOperatorAccountUuid", () => {
  it("strips the opr_ prefix that operator tokens carry", () => {
    expect(toOperatorAccountUuid(`opr_${UUID}`)).toBe(UUID);
  });

  it("accepts a bare uuid unchanged", () => {
    // The platform is free to drop the prefix; that must not start returning
    // undefined and silently blank out attribution.
    expect(toOperatorAccountUuid(UUID)).toBe(UUID);
  });

  it("returns undefined for an unfamiliar subject rather than throwing", () => {
    // The write must still succeed. `audit.change_records` holds the full
    // subject as text for every one of these routes, so losing the redundant
    // copy costs attribution in one place, not the operation - and failing a
    // provider-key rotation because a subject gained a new prefix would be the
    // wrong trade in the exact moment rotation matters most.
    expect(toOperatorAccountUuid("opr_not-a-uuid")).toBeUndefined();
    expect(toOperatorAccountUuid("svc_1234")).toBeUndefined();
    expect(toOperatorAccountUuid("unknown")).toBeUndefined();
    expect(toOperatorAccountUuid(undefined)).toBeUndefined();
  });

  it("does not accept a prefixed value whose remainder is not a uuid", () => {
    // Guards against 'strip four characters and hope' - the column is typed
    // uuid, so anything that would not survive the cast must not be offered.
    expect(toOperatorAccountUuid("opr_11111111-1111-4111-8111")).toBeUndefined();
  });
});
