import { describe, expect, it, vi } from "vitest";

import { AuditController } from "./audit.controller";
import type { AuditService } from "./audit.service";

/**
 * The controller is query-parameter plumbing, but not trivial plumbing: nine
 * optional params each spread conditionally, and `exactOptionalPropertyTypes`
 * makes "absent" and "present but undefined" different things downstream. A
 * transposed or dropped param here silently widens an auditor's filter, which
 * is the failure that matters on this surface.
 */
function build() {
  const search = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  return {
    search,
    controller: new AuditController({ search } as unknown as AuditService),
  };
}

describe("AuditController", () => {
  it("passes every filter through under its own name", async () => {
    const { search, controller } = build();

    await controller.searchAuditLogs(
      {},
      "providers",
      "prov-1",
      "opr_1",
      "deactivate",
      "failure",
      "2026-08-01T00:00:00Z",
      "2026-08-13T00:00:00Z",
      "cursor-token",
      "25",
    );

    expect(search).toHaveBeenCalledWith({
      objectType: "providers",
      objectId: "prov-1",
      actorId: "opr_1",
      action: "deactivate",
      outcome: "failure",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-13T00:00:00Z",
      cursor: "cursor-token",
      limit: "25",
    });
  });

  it("omits absent filters rather than passing them as undefined", async () => {
    // Not cosmetic: `{ objectId: undefined }` and `{}` are different types
    // here, and only the second means "no filter".
    const { search, controller } = build();

    await controller.searchAuditLogs({}, undefined, undefined, "opr_1");

    expect(search).toHaveBeenCalledWith({ actorId: "opr_1" });
  });

  it("asks for nothing in particular when given nothing", async () => {
    const { search, controller } = build();

    await controller.searchAuditLogs({});

    expect(search).toHaveBeenCalledWith({});
  });

  it("returns the service result unchanged", async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ items: [{ id: "aud-1" }], nextCursor: "next" });
    const controller = new AuditController({ search } as unknown as AuditService);

    await expect(controller.searchAuditLogs({})).resolves.toEqual({
      items: [{ id: "aud-1" }],
      nextCursor: "next",
    });
  });

  // product_251 X-3 renames objectType -> objectType and actorId ->
  // actorId. Until this check existed, an un-migrated console query would have
  // been ANSWERED rather than refused: Nest binds only the parameters it is
  // asked for and discards the rest, so the filter would simply not apply and
  // the auditor would receive an unfiltered page - 200, well-formed, and about
  // somebody else's changes.
  it("refuses an unknown filter instead of answering without it", async () => {
    const { search, controller } = build();

    expect(() =>
      controller.searchAuditLogs({ resourceType: "providers" }),
    ).toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it("names both the rejected filter and the accepted ones", async () => {
    // After a rename the caller is sending something that was correct last
    // week, so "unknown filter" alone reads as a typo on their side. The
    // accepted list is what tells them it moved.
    const { controller } = build();

    try {
      controller.searchAuditLogs({ operatorSub: "opr_1" });
      throw new Error("expected a rejection");
    } catch (error) {
      const body = (error as { getResponse(): Record<string, unknown> }).getResponse();
      expect(body["code"]).toBe("AUDIT_UNKNOWN_FILTER");
      expect(body["message"]).toContain("operatorSub");
      expect(body["message"]).toContain("operatorSub");
      expect(body["message"]).toContain("actorId");
      expect(body["retryable"]).toBe(false);
    }
  });

  it("still accepts every filter it documents", async () => {
    // The guard must not become the reason a legitimate query fails.
    const { search, controller } = build();
    const everyFilter = {
      objectType: "providers",
      objectId: "prov-1",
      actorId: "opr_1",
      action: "deactivate",
      outcome: "failure",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-13T00:00:00Z",
      cursor: "c",
      limit: "25",
    };

    await controller.searchAuditLogs(everyFilter, "providers");

    expect(search).toHaveBeenCalled();
  });
});
