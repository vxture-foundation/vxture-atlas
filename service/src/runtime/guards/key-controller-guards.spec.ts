import { describe, expect, it } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";

import { GatewayApiKeyController } from "../../gateway-api-keys/gateway-api-key.controller";
import { ProviderKeyController } from "../../provider-keys/provider-key.controller";
import { OperatorAuthGuard } from "./operator-auth.guard";

/**
 * The key controllers' guard shape, asserted rather than assumed.
 *
 * Both directions are pinned: re-adding a per-route guard would make every
 * key write fail closed against a platform that does not send what it checks;
 * dropping `OperatorAuthGuard` from a controller would leave these routes
 * unauthenticated.
 */

const KEY_CONTROLLERS = [
  { name: "ProviderKeyController", type: ProviderKeyController },
  { name: "GatewayApiKeyController", type: GatewayApiKeyController },
];

/** Method-level `@UseGuards(...)` on every handler of a controller. */
function methodGuards(type: new (...args: never[]) => object) {
  const proto = type.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor")
    .map((name) => ({
      name,
      guards: (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ??
        []) as Array<{ name?: string }>,
    }));
}

describe.each(KEY_CONTROLLERS)("$name guards", ({ type }) => {
  it("is operator-guarded at the class level", () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, type) ??
      []) as unknown[];
    expect(guards).toContain(OperatorAuthGuard);
  });

  it("carries no per-route guard on any handler", () => {
    // Every write here is still recorded in audit.change_records - the
    // provider-side control that remains is a record, not a refusal.
    const withGuards = methodGuards(type).filter((m) => m.guards.length > 0);
    expect(withGuards).toEqual([]);
  });
});

describe("StepUpRequiredGuard", () => {
  it("no longer exists in the guard module", async () => {
    // Deleted rather than left unreferenced: its check was `amr`-based, and
    // the follow-up the platform described (a ceremony token bound to the
    // operation) is explicitly NOT amr - so none of this logic comes back.
    const guardModule = await import("./operator-auth.guard");
    expect(guardModule).not.toHaveProperty("StepUpRequiredGuard");
    expect(guardModule).not.toHaveProperty("hasStepUpFactor");
  });
});
