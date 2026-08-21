import { describe, expect, it } from "vitest";

import {
  CAPABILITY_PATH_SUNSET,
  RENAMED_CAPABILITY_SEGMENTS,
  canonicalCapabilitySegment,
  legacySegmentOf,
} from "./capability-route-names";

/**
 * Two properties, and both of them are load-bearing in a way no other test
 * covers:
 *
 * - `legacySegmentOf` feeds the counter that gates DELETING the old names. If
 *   it over-matched, the counter would never reach zero and the window would
 *   never close.
 * - `canonicalCapabilitySegment` feeds `audit.change_records.resource_type`. If
 *   it under-matched, one operation would file under two resource types and an
 *   audit query would silently return half the trail.
 */
describe("legacySegmentOf", () => {
  it("does not let `grants` match inside `product-grants`", () => {
    // The reason this is a segment comparison and not a substring test.
    expect(legacySegmentOf("/capability/product-grants")).toBe("product-grants");
    expect(legacySegmentOf("/capability/product-grants/abc/activate")).toBe(
      "product-grants",
    );
  });

  it("matches each retired segment", () => {
    expect(legacySegmentOf("/capability/grants")).toBe("grants");
    expect(legacySegmentOf("/capability/endpoints")).toBe("endpoints");
    expect(legacySegmentOf("/capability/grants/g-1/deactivate")).toBe("grants");
  });

  it("does not match the new names", () => {
    // A canonical call counted as legacy traffic would keep the counter
    // non-zero forever, and the old names could never be removed.
    for (const canonical of Object.values(RENAMED_CAPABILITY_SEGMENTS)) {
      expect(legacySegmentOf(`/capability/${canonical}`)).toBeUndefined();
      expect(
        legacySegmentOf(`/capability/${canonical}/x/activate`),
      ).toBeUndefined();
    }
  });

  it("ignores the query string", () => {
    expect(legacySegmentOf("/capability/grants?tenantId=t-1")).toBe("grants");
  });

  it("only looks at the resource position", () => {
    expect(legacySegmentOf("/capability/models")).toBeUndefined();
    expect(legacySegmentOf("/capability/providers")).toBeUndefined();
    // The word deeper in the path is not the resource being called.
    expect(legacySegmentOf("/capability/models/grants")).toBeUndefined();
  });

  it("ignores paths outside the operator plane", () => {
    // /v1 and /tenancy carry the same words on the DATA plane, where consumers
    // are products rather than one console. Not in this window - counting them
    // would misreport the operator migration as unfinished.
    expect(legacySegmentOf("/v1/endpoints")).toBeUndefined();
    expect(legacySegmentOf("/tenancy/grants")).toBeUndefined();
  });

  it("tolerates an absolute-form URL", () => {
    expect(legacySegmentOf("http://atlas:3100/capability/endpoints")).toBe(
      "endpoints",
    );
  });

  it("returns undefined with no resource segment", () => {
    expect(legacySegmentOf("/capability")).toBeUndefined();
    expect(legacySegmentOf("")).toBeUndefined();
  });
});

describe("canonicalCapabilitySegment", () => {
  it("folds every retired name onto its replacement", () => {
    expect(canonicalCapabilitySegment("grants")).toBe("tenant-model-grants");
    expect(canonicalCapabilitySegment("product-grants")).toBe(
      "product-endpoint-grants",
    );
    expect(canonicalCapabilitySegment("endpoints")).toBe("model-routes");
  });

  it("is idempotent - a canonical name folds to itself", () => {
    // The audit middleware calls this on EVERY operator route, so a canonical
    // call must not be rewritten into something else.
    for (const canonical of Object.values(RENAMED_CAPABILITY_SEGMENTS)) {
      expect(canonicalCapabilitySegment(canonical)).toBe(canonical);
    }
  });

  it("passes through resources that were never renamed", () => {
    for (const other of ["models", "providers", "price-rules", "policies"]) {
      expect(canonicalCapabilitySegment(other)).toBe(other);
    }
  });

  it("does not inherit from Object.prototype", () => {
    // The map is looked up by caller-influenced segment. With a plain `[]`
    // lookup and no `Object.hasOwn` guard, a request to
    // `/capability/constructor` would resolve to Object's constructor and put a
    // function where a resource name belongs.
    expect(canonicalCapabilitySegment("constructor")).toBe("constructor");
    expect(canonicalCapabilitySegment("__proto__")).toBe("__proto__");
    expect(canonicalCapabilitySegment("toString")).toBe("toString");
  });
});

describe("CAPABILITY_PATH_SUNSET", () => {
  it("is a parseable instant, because it is serialised into a Sunset header", () => {
    // RFC 8594 wants an HTTP-date. An unparseable constant emits
    // `Sunset: Invalid Date` - a header a client cannot act on, worse than
    // sending none.
    const parsed = new Date(CAPABILITY_PATH_SUNSET);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toUTCString()).toMatch(/GMT$/);
  });
});
