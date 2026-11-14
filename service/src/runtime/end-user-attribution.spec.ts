/**
 * Verified customer attribution behavior.
 * @package @atlas/service
 * @layer Domain
 * @category Test
 * @author AI-Generated
 * @date 2026-11-15
 */
import { describe, expect, it } from "vitest";
import { endUserAttribution } from "./end-user-attribution";
const id = "11111111-1111-4111-8111-111111111111";
describe("endUserAttribution", () => {
  it.each([id, `usr_${id}`])("accepts a verified customer %s", (userId) => {
    expect(endUserAttribution({ mode: "obo", callerProductCode: "runos", scope: "tool:atlas", userId })).toEqual({ endUserId: id });
  });
  it.each([undefined, "opr_" + id, "user_42"])("leaves unknown customers unattributed", (userId) => {
    expect(endUserAttribution({ mode: "obo", callerProductCode: "runos", scope: "tool:atlas", ...(userId ? { userId } : {}) })).toEqual({});
  });
  it("never assigns a service subject to a customer", () => {
    expect(endUserAttribution({ mode: "service", callerProductCode: "runos", scope: "tool:atlas", userId: id })).toEqual({});
  });
});
