import { describe, expect, it, vi } from "vitest";

import { AuditMiddleware, describeMutation } from "./audit.middleware";
import type { AuditService } from "./audit.service";

function makeRes(statusCode = 200) {
  const listeners: Array<() => void> = [];
  return {
    statusCode,
    on: (_event: "finish", listener: () => void) => {
      listeners.push(listener);
      return undefined;
    },
    finish: () => listeners.forEach((l) => l()),
  };
}

function run(
  request: Record<string, unknown>,
  statusCode = 200,
): { record: ReturnType<typeof vi.fn>; next: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  const next = vi.fn();
  const middleware = new AuditMiddleware({ record } as unknown as AuditService);
  const res = makeRes(statusCode);

  middleware.use(request as never, res as never, next);
  res.finish();

  return { record, next };
}

// ── route -> record derivation ───────────────────────────────────────────────

describe("describeMutation", () => {
  it("reads resource, id and action straight off the route", () => {
    expect(
      describeMutation({
        method: "POST",
        originalUrl: "/capability/providers/prov-1/deactivate",
      }),
    ).toMatchObject({
      objectType: "providers",
      objectId: "prov-1",
      action: "deactivate",
    });
  });

  it("derives the action from the verb when the route names none", () => {
    expect(
      describeMutation({ method: "POST", originalUrl: "/capability/models" }),
    ).toMatchObject({ objectType: "models", objectId: null, action: "create" });

    expect(
      describeMutation({ method: "PUT", originalUrl: "/capability/models/m-1" }),
    ).toMatchObject({ action: "update", objectId: "m-1" });

    expect(
      describeMutation({ method: "DELETE", originalUrl: "/capability/models/m-1" }),
    ).toMatchObject({ action: "delete" });
  });

  it("handles the PUT-based key lifecycle routes, not just the POST ones", () => {
    // Registry resources use POST for activate/deactivate and the two key
    // resources use PUT. Deriving from the path rather than the verb is what
    // makes that inconsistency irrelevant here.
    expect(
      describeMutation({
        method: "PUT",
        originalUrl: "/capability/api-keys/key-1/revoke",
      }),
    ).toMatchObject({
      objectType: "api-keys",
      objectId: "key-1",
      action: "revoke",
    });
  });

  it("ignores reads entirely", () => {
    expect(
      describeMutation({ method: "GET", originalUrl: "/capability/providers" }),
    ).toBeNull();
  });

  it("ignores anything outside the operator plane", () => {
    // The data plane is high-volume and is not a change trail.
    expect(
      describeMutation({ method: "POST", originalUrl: "/v1/chat" }),
    ).toBeNull();
    expect(
      describeMutation({ method: "POST", originalUrl: "/provisioning/webhook" }),
    ).toBeNull();
  });

  it("decodes a well-formed percent-encoded id", () => {
    expect(
      describeMutation({
        method: "PUT",
        originalUrl: "/capability/models/m%2F1",
      }),
    ).toMatchObject({ objectId: "m/1", action: "update" });
  });

  it("falls back to the raw id segment when its percent-encoding is malformed", () => {
    // decodeURIComponent throws URIError on %ZZ, and this middleware runs
    // pre-auth: a throw here would let an unauthenticated caller force a 500
    // AND skip the audit record for the attempt.
    expect(
      describeMutation({
        method: "POST",
        originalUrl: "/capability/providers/%ZZ/activate",
      }),
    ).toMatchObject({
      objectType: "providers",
      objectId: "%ZZ",
      action: "activate",
    });
  });

  it("strips the query string before parsing", () => {
    expect(
      describeMutation({
        method: "DELETE",
        originalUrl: "/capability/grants/g-1?cascade=true",
      }),
    ).toMatchObject({ objectId: "g-1", action: "delete" });
  });

  it("records field NAMES and never their values", () => {
    // The single most important property here: bodies on this plane carry
    // provider keys and gateway secrets.
    const described = describeMutation({
      method: "POST",
      originalUrl: "/capability/provider-keys",
      body: { providerCode: "doubao", apiKey: "sk-super-secret", keyAlias: "primary" },
    });

    expect(described?.changedFields).toEqual([
      "apiKey",
      "keyAlias",
      "providerCode",
    ]);
    expect(JSON.stringify(described)).not.toContain("sk-super-secret");
  });

  it("does not descend into nested objects", () => {
    const described = describeMutation({
      method: "PUT",
      originalUrl: "/capability/models/m-1",
      body: { config: { wire: { chatPath: "/v1/chat" } } },
    });

    expect(described?.changedFields).toEqual(["config"]);
  });

  it("tolerates a body that is not an object", () => {
    for (const body of [undefined, null, "raw", [1, 2]]) {
      expect(
        describeMutation({
          method: "POST",
          originalUrl: "/capability/models/m-1/activate",
          body,
        })?.changedFields,
      ).toEqual([]);
    }
  });
});

// ── write behaviour ──────────────────────────────────────────────────────────

describe("AuditMiddleware", () => {
  it("always calls next, audited or not", () => {
    expect(
      run({ method: "GET", originalUrl: "/capability/providers" }).next,
    ).toHaveBeenCalledTimes(1);
    expect(
      run({ method: "POST", originalUrl: "/capability/providers" }).next,
    ).toHaveBeenCalledTimes(1);
  });

  it("attributes the change to the verified operator", () => {
    const { record } = run({
      method: "POST",
      originalUrl: "/capability/providers/prov-1/deactivate",
      operatorAuth: {
        operatorId: "opr_11111111-1111-4111-8111-111111111111",
        // The TOKEN context keeps actorClientId; only the RECORD field it
        // populates is called actorConsole (product_251 X-3).
        actorClientId: "console",
      },
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: "providers",
        objectId: "prov-1",
        action: "deactivate",
        actorId: "opr_11111111-1111-4111-8111-111111111111",
        actorConsole: "console",
        outcome: "success",
      }),
    );
  });

  it("records a rejected change as a failure, not a change", () => {
    const { record } = run(
      {
        method: "DELETE",
        originalUrl: "/capability/providers/prov-1",
        operatorAuth: { operatorId: "opr_1", actorClientId: "console" },
      },
      409,
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure" }),
    );
  });

  it("still records an attempt the guard rejected", () => {
    // No handler ran, so there is no identity - but a write attempt with no
    // attributable operator is exactly what an auditor wants surfaced.
    const { record } = run(
      { method: "POST", originalUrl: "/capability/providers" },
      401,
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "unknown", outcome: "failure" }),
    );
  });

  it("counts a 3xx as success and a 4xx as failure", () => {
    expect(
      run({ method: "POST", originalUrl: "/capability/models" }, 304).record,
    ).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(
      run({ method: "POST", originalUrl: "/capability/models" }, 400).record,
    ).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });

  it("writes nothing at all for a read", () => {
    expect(
      run({ method: "GET", originalUrl: "/capability/logs" }).record,
    ).not.toHaveBeenCalled();
  });
});

/**
 * #206: three resources answer on two spellings each while opera migrates.
 *
 * `resource_type` is derived from the resource path segment, so without folding
 * it, ONE operation files under TWO resource types and an auditor asking "who
 * granted this tenant access to this model" gets half the trail with no
 * indication that half is missing.
 *
 * Nothing else in the build sees this. The route table can register both
 * spellings, every controller test can pass, and the audit trail still splits -
 * a first attempt at this rename passed 913 tests with exactly that defect in
 * it. So the property is asserted here, on the derivation itself.
 */
describe("describeMutation folds renamed resources to one name (#206)", () => {
  const RENAMED: ReadonlyArray<[string, string, string]> = [
    ["tenant-model-grants", "grants", "g-1"],
    ["product-endpoint-grants", "product-grants", "pg-1"],
    ["model-routes", "endpoints", "ep-1"],
  ];

  it.each(RENAMED)(
    "records %s for both spellings",
    (canonical, legacy, id) => {
      for (const segment of [canonical, legacy]) {
        expect(
          describeMutation({
            method: "POST",
            originalUrl: `/capability/${segment}`,
          }),
        ).toMatchObject({ objectType: canonical, objectId: null, action: "create" });

        expect(
          describeMutation({
            method: "POST",
            originalUrl: `/capability/${segment}/${id}/deactivate`,
          }),
        ).toMatchObject({
          objectType: canonical,
          objectId: id,
          action: "deactivate",
        });

        expect(
          describeMutation({
            method: "DELETE",
            originalUrl: `/capability/${segment}/${id}`,
          }),
        ).toMatchObject({ objectType: canonical, objectId: id });
      }
    },
  );

  it("keeps product-grants and grants apart", () => {
    // The two fold to DIFFERENT canonical names. A substring match would send
    // both to `tenant-model-grants` and merge two genuinely different
    // authorization axes into one audit resource - worse than splitting one.
    expect(
      describeMutation({ method: "POST", originalUrl: "/capability/product-grants" }),
    ).toMatchObject({ objectType: "product-endpoint-grants" });
    expect(
      describeMutation({ method: "POST", originalUrl: "/capability/grants" }),
    ).toMatchObject({ objectType: "tenant-model-grants" });
  });

  it("leaves resources that were never renamed untouched", () => {
    for (const other of ["models", "providers", "price-rules", "policies"]) {
      expect(
        describeMutation({ method: "POST", originalUrl: `/capability/${other}` }),
      ).toMatchObject({ objectType: other });
    }
  });

  it("does not put a prototype member in resource_type", () => {
    // The segment is caller-controlled. A plain map lookup would resolve
    // `constructor` to Object's constructor - a function - and write it to the
    // audit column.
    const got = describeMutation({
      method: "POST",
      originalUrl: "/capability/constructor",
    });
    expect(got?.objectType).toBe("constructor");
    expect(typeof got?.objectType).toBe("string");
  });
});
