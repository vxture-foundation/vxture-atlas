import { describe, expect, it } from "vitest";

import {
  DATA_PLANE_PATH_SUNSET,
  RENAMED_DATA_PLANE_ROUTES,
  legacyDataPlaneRouteOf,
} from "./data-plane-route-names";

/**
 * Whole-segment, base-qualified matching is this module's correctness property
 * (TD-042), so it is asserted directly rather than only through an HTTP round
 * trip.
 *
 * The two failure modes worth naming, because both are silent:
 *
 * - A substring match would count every `/capability/product-grants` call as
 *   legacy `grants` traffic. The counter that gates deleting the old names then
 *   never reaches zero, and the rename is stuck forever with nobody able to say
 *   why.
 * - A bare-segment map (no base path) would answer for `/capability/endpoints`
 *   too, stamping data-plane sunset headers on the operator plane, whose window
 *   closes on a different date.
 */
describe("legacyDataPlaneRouteOf", () => {
  it("matches the two retired data-plane routes and names their successors", () => {
    expect(legacyDataPlaneRouteOf("/v1/endpoints")).toEqual({
      key: "v1/endpoints",
      canonical: "model-routes",
      successorPath: "/v1/model-routes",
    });
    expect(legacyDataPlaneRouteOf("/tenancy/grants")).toEqual({
      key: "tenancy/grants",
      canonical: "tenant-model-grants",
      successorPath: "/tenancy/tenant-model-grants",
    });
  });

  it("ignores the query string", () => {
    expect(
      legacyDataPlaneRouteOf("/v1/endpoints?applicationType=agent")?.key,
    ).toBe("v1/endpoints");
  });

  it("does not match the canonical spellings", () => {
    expect(legacyDataPlaneRouteOf("/v1/model-routes")).toBeUndefined();
    expect(
      legacyDataPlaneRouteOf("/tenancy/tenant-model-grants"),
    ).toBeUndefined();
  });

  /* The substring trap, stated as a test rather than as a comment: if this
     passes only because the implementation happens to compare whole segments,
     changing it to `url.includes("grants")` must turn this red. */
  it("does not match a longer segment that contains a retired word", () => {
    expect(legacyDataPlaneRouteOf("/capability/product-grants")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("/v1/endpoints-v2")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("/tenancy/grants-archive")).toBeUndefined();
  });

  /* The other plane's window closes on its own date; this module must not
     claim it. */
  it("does not answer for the operator plane", () => {
    expect(legacyDataPlaneRouteOf("/capability/endpoints")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("/capability/grants")).toBeUndefined();
  });

  /* These resolve to nothing because the lookup key is `base/segment` and no
     `Object.prototype` property contains a slash - NOT because of the
     `Object.hasOwn` guard in the implementation. Measured: deleting that guard
     leaves this test green. It is asserted anyway, because the property that
     matters is "a URL cannot reach an inherited property", and that property
     must survive a future re-keying of the map - at which point this test starts
     failing for real and the guard starts earning its place. */
  it("does not resolve inherited Object properties", () => {
    expect(legacyDataPlaneRouteOf("/v1/constructor")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("/v1/toString")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("/tenancy/hasOwnProperty")).toBeUndefined();
  });

  it("returns undefined for paths too short to carry a base and a segment", () => {
    expect(legacyDataPlaneRouteOf("/v1")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("/")).toBeUndefined();
    expect(legacyDataPlaneRouteOf("")).toBeUndefined();
  });

  /* The data plane moves karda and vxtpl, who schedule independently; the
     operator plane moves one console on this repo's own release train. Equal
     dates would mean the wider blast radius got the shorter notice. */
  it("sunsets later than the operator plane, and is a parsable date", () => {
    const sunset = new Date(DATA_PLANE_PATH_SUNSET);
    expect(Number.isNaN(sunset.getTime())).toBe(false);
    expect(sunset.getTime()).toBeGreaterThan(
      new Date("2026-09-16T00:00:00.000Z").getTime(),
    );
  });

  /* Every retired key must be `base/segment`. A bare key would silently match
     nothing (the lookup always builds a two-part key), so the rename would look
     applied while serving no alias at all. */
  it("keys every retired route with its base path", () => {
    for (const key of Object.keys(RENAMED_DATA_PLANE_ROUTES)) {
      expect(key.split("/")).toHaveLength(2);
    }
  });
});

/**
 * The vocabulary above is only half the change: it decides what a retired path
 * MEANS, not whether one is served. The alias itself lives in a Nest decorator,
 * and a decorator that silently stopped carrying the retired spelling would
 * leave every test in this file green while karda got a 404 - the shape this
 * repo keeps producing.
 *
 * So the route metadata is asserted directly. This is not an HTTP round trip
 * (there is no Nest test harness here, and adding one is a bigger decision than
 * this change); it proves the alias reached the decorator on the right method.
 * The `@Get([canonical, retired])` form itself is already proven in production
 * by the `/capability/*` routes, which use it verbatim.
 */
describe("route registration", () => {
  it("serves both spellings on /v1 and /tenancy", async () => {
    const { ModelRuntimeController } = await import("./runtime/runtime.controller");
    const { TenancyController } = await import("./tenancy/tenancy.controller");

    expect(
      Reflect.getMetadata("path", ModelRuntimeController.prototype.listEndpoints),
    ).toEqual(["model-routes", "endpoints"]);
    expect(
      Reflect.getMetadata("path", TenancyController.prototype.listGrants),
    ).toEqual(["tenant-model-grants", "grants"]);
  });

  /* Canonical first is not cosmetic: Nest builds the route table in array order,
     so the first entry is what `@Res()`-less handlers and any path-echoing
     middleware report. A flipped pair would advertise the retired name as the
     real one for the whole window. */
  it("registers the canonical spelling first, retired second", async () => {
    const { ModelRuntimeController } = await import("./runtime/runtime.controller");
    const { TenancyController } = await import("./tenancy/tenancy.controller");

    for (const [method, key] of [
      [ModelRuntimeController.prototype.listEndpoints, "v1/endpoints"],
      [TenancyController.prototype.listGrants, "tenancy/grants"],
    ] as const) {
      const paths = Reflect.getMetadata("path", method) as string[];
      expect(paths[0]).toBe(RENAMED_DATA_PLANE_ROUTES[key]);
      expect(paths[1]).toBe(key.split("/")[1]);
    }
  });
});
