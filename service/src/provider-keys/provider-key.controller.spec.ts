import { describe, expect, it, vi } from "vitest";

import { ProviderKeyController } from "./provider-key.controller";
import type { ProviderKeyService } from "./provider-key.service";
import type { OperatorAuthenticatedRequest } from "../runtime/guards/operator-auth.guard";

/**
 * The rotation audit trail is written from whatever this controller forwards,
 * into `key.key_rotation_logs` - a table with no foreign key that could catch a
 * value that does not name a real operator. So "who rotated this key" is only
 * as trustworthy as this function, and there was no test here at all until
 * 2026-08-26, which is how the defect below survived two audit rounds.
 *
 * The service-level spec cannot cover it: by the time `ProviderKeyService`
 * is called, the forging has already happened.
 */
function build(operatorId?: string) {
  const rotate = vi.fn().mockResolvedValue({ id: "key-1" });
  const req = {
    headers: {},
    ...(operatorId !== undefined ? { operatorAuth: { operatorId } } : {}),
  } as unknown as OperatorAuthenticatedRequest;
  return {
    rotate,
    req,
    controller: new ProviderKeyController({
      rotate,
    } as unknown as ProviderKeyService),
  };
}

/** A body carrying a field the client is not allowed to set. */
const FORGED = {
  plaintextKey: "sk-new",
  reason: "scheduled",
  rotatedBy: "opr_00000000-0000-4000-8000-00000000dead",
} as never;

describe("ProviderKeyController.rotate - operator attribution (M-5)", () => {
  it("takes rotatedBy from the verified token, not the body", async () => {
    const { rotate, req, controller } = build(
      "opr_11111111-1111-4111-8111-111111111111",
    );

    await controller.rotate("key-1", FORGED, req);

    expect(rotate).toHaveBeenCalledWith("key-1", {
      plaintextKey: "sk-new",
      reason: "scheduled",
      rotatedBy: "11111111-1111-4111-8111-111111111111",
    });
  });

  /**
   * The case the previous shape got wrong. `toOperatorAccountUuid` returns
   * `undefined` for a `sub` that is not an `opr_<uuid>`, and the override was
   * spread AFTER the body - so with nothing to override with, the caller's own
   * value went through. Absent attribution is a gap; forged attribution is a
   * false record, and the audit table cannot tell them apart afterwards.
   */
  it("drops a body-supplied rotatedBy when the token yields no operator uuid", async () => {
    const { rotate, req, controller } = build("service-account-not-an-operator");

    await controller.rotate("key-1", FORGED, req);

    expect(rotate).toHaveBeenCalledWith("key-1", {
      plaintextKey: "sk-new",
      reason: "scheduled",
    });
    const [, forwarded] = rotate.mock.calls[0] as [string, object];
    expect(forwarded).not.toHaveProperty("rotatedBy");
  });

  it("drops it with no operator context at all", async () => {
    const { rotate, req, controller } = build();

    await controller.rotate("key-1", FORGED, req);

    const [, forwarded] = rotate.mock.calls[0] as [string, object];
    expect(forwarded).not.toHaveProperty("rotatedBy");
  });

  /**
   * `exactOptionalPropertyTypes` makes "absent" and "present but undefined"
   * different downstream, so an omitted optional must stay omitted rather than
   * arriving as an explicit `undefined`.
   */
  it("omits absent optionals instead of forwarding undefined", async () => {
    const { rotate, req, controller } = build(
      "opr_11111111-1111-4111-8111-111111111111",
    );

    await controller.rotate("key-1", { plaintextKey: "sk-new" }, req);

    expect(rotate).toHaveBeenCalledWith("key-1", {
      plaintextKey: "sk-new",
      rotatedBy: "11111111-1111-4111-8111-111111111111",
    });
    const [, forwarded] = rotate.mock.calls[0] as [string, object];
    expect(forwarded).not.toHaveProperty("reason");
  });
});
