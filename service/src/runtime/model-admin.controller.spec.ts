import { describe, expect, it, vi } from "vitest";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { legacySegmentOf } from "../capability-route-names";

import { ModelAdminController } from "./model-admin.controller";
import { ProviderKeyController } from "../provider-keys/provider-key.controller";
import { GatewayApiKeyController } from "../gateway-api-keys/gateway-api-key.controller";

/**
 * The HTTP VERB of each operator route, asserted directly off the decorator
 * metadata.
 *
 * This surface had no controller spec at all, which mattered more than usual
 * here for two reasons.
 *
 * First, the verb is the contract: opera calls these, and a wrong verb is a
 * 404 that reads exactly like "the object does not exist". Nothing else in the
 * repo pins it - the service tests call methods directly and never see a verb.
 *
 * Second, Nest makes the specific mistake silent. `RequestMapping` does
 * `Reflect.defineMetadata(METHOD_METADATA, ..., descriptor.value)`, so stacking
 * `@Put` and `@Patch` on one handler does not register two routes: the second
 * decorator overwrites the first and exactly one route exists, with no error at
 * boot. Anyone reaching for that as a compatibility window would believe they
 * had one and would not. This test is what says so out loud.
 */
function methodOf(handler: string): number {
  const fn = (ModelAdminController.prototype as unknown as Record<string, unknown>)[
    handler
  ];
  return Reflect.getMetadata(METHOD_METADATA, fn as object) as number;
}

/**
 * Every path a handler answers on, always as an array.
 *
 * PATH_METADATA holds a string for a single-path route and an array for a
 * multi-path one. #206 made three resources multi-path (canonical name plus the
 * retired one, served together so neither side moves on the other's deploy), so
 * a test assuming `string` reported a false failure on a correct route.
 */
function pathsOf(handler: string): readonly string[] {
  const fn = (ModelAdminController.prototype as unknown as Record<string, unknown>)[
    handler
  ];
  const meta = Reflect.getMetadata(PATH_METADATA, fn as object) as
    | string
    | string[];
  return Array.isArray(meta) ? meta : [meta];
}

// product_251 M-B1: these are partial updates - a body that omits a field
// leaves it unchanged - so the verb is PATCH. They wore PUT, which promises
// the opposite (absent field means cleared), and two callers holding opposite
// beliefs about the same route both "worked" until one of them did not.
const PARTIAL_UPDATE_ROUTES: ReadonlyArray<[string, string]> = [
  ["updateProvider", "providers/:providerId"],
  ["updateEndpoint", "model-routes/:endpointId"],
  ["updateModel", "models/:modelId"],
  ["updateProductGrant", "product-endpoint-grants/:id"],
  ["updateGrant", "tenant-model-grants/:grantId"],
  ["updatePriceRule", "price-rules/:priceRuleId"],
  ["updatePolicy", "policies/:policyId"],
];

describe("ModelAdminController update routes", () => {
  it.each(PARTIAL_UPDATE_ROUTES)(
    "%s is PATCH, not PUT",
    (handler, expectedPath) => {
      expect(pathsOf(handler)).toContain(expectedPath);
      expect(methodOf(handler)).toBe(RequestMethod.PATCH);
    },
  );

  it("registers exactly seven partial-update routes", () => {
    // Guards the other direction: a new update route added as PUT would pass
    // every test above by simply not being in the list.
    const patchHandlers = Object.getOwnPropertyNames(
      ModelAdminController.prototype,
    ).filter((name) => {
      if (name === "constructor") return false;
      const fn = (ModelAdminController.prototype as unknown as Record<string, unknown>)[
        name
      ];
      return (
        typeof fn === "function" &&
        Reflect.getMetadata(METHOD_METADATA, fn as object) ===
          RequestMethod.PATCH
      );
    });

    expect(patchHandlers.sort()).toEqual(
      PARTIAL_UPDATE_ROUTES.map(([handler]) => handler).sort(),
    );
  });

  // Every operator controller, not just this one. The scoping for this change
  // said "seven PUT routes"; there were twelve. provider-keys and
  // gateway-api-keys carried five more, and they were a different defect: not
  // partial updates but ACTIONS (`activate`/`deactivate`/`revoke`, no body),
  // spelled `PUT` while ModelAdminController spelled the identical operation
  // `POST` in all fourteen of its own action routes. The same operation, two
  // verbs, one plane. Those became POST, which is what M-B3 requires.
  it.each([
    ["ModelAdminController", ModelAdminController],
    ["ProviderKeyController", ProviderKeyController],
    ["GatewayApiKeyController", GatewayApiKeyController],
  ])("%s has no PUT route left", (_name, controller) => {
    const putHandlers = Object.getOwnPropertyNames(controller.prototype).filter(
      (name) => {
        if (name === "constructor") return false;
        const fn = (controller.prototype as unknown as Record<string, unknown>)[
          name
        ];
        return (
          typeof fn === "function" &&
          Reflect.getMetadata(METHOD_METADATA, fn as object) ===
            RequestMethod.PUT
        );
      },
    );

    expect(putHandlers).toEqual([]);
  });

  it("spells every activate/deactivate action POST, across all three controllers", () => {
    // M-B3: a binary switch is `POST :id/activate` / `:id/deactivate`. This is
    // the assertion that catches the next controller added with PUT actions.
    const actionRoutes = [
      ModelAdminController,
      ProviderKeyController,
      GatewayApiKeyController,
    ].flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== "constructor")
        .map((name) => {
          const fn = (
            controller.prototype as unknown as Record<string, unknown>
          )[name];
          if (typeof fn !== "function") return null;
          const path = Reflect.getMetadata(PATH_METADATA, fn as object) as
            | string
            | undefined;
          const method = Reflect.getMetadata(METHOD_METADATA, fn as object) as
            | number
            | undefined;
          return path && /(activate|deactivate|revoke)$/.test(path)
            ? { path, method }
            : null;
        })
        .filter((entry): entry is { path: string; method: number } =>
          Boolean(entry),
        ),
    );

    expect(actionRoutes.length).toBeGreaterThan(0);
    for (const route of actionRoutes) {
      expect({ path: route.path, method: route.method }).toEqual({
        path: route.path,
        method: RequestMethod.POST,
      });
    }
  });
});

/**
 * #206's migration window, asserted from both directions.
 *
 * Nothing else in the build can see this. Drop the canonical path and every
 * other test stays green, because the retired spelling still answers. Drop the
 * retired path and they stay green too. Both break a live consumer.
 */
describe("renamed operator routes serve both spellings", () => {
  const RENAMED: ReadonlyArray<[string, string, string]> = [
    ["listEndpoints", "model-routes", "endpoints"],
    ["createEndpoint", "model-routes", "endpoints"],
    ["updateEndpoint", "model-routes/:endpointId", "endpoints/:endpointId"],
    ["activateEndpoint", "model-routes/:endpointId/activate", "endpoints/:endpointId/activate"],
    ["deactivateEndpoint", "model-routes/:endpointId/deactivate", "endpoints/:endpointId/deactivate"],
    ["deleteEndpoint", "model-routes/:endpointId", "endpoints/:endpointId"],
    ["listProductGrants", "product-endpoint-grants", "product-grants"],
    ["createProductGrant", "product-endpoint-grants", "product-grants"],
    ["updateProductGrant", "product-endpoint-grants/:id", "product-grants/:id"],
    ["activateProductGrant", "product-endpoint-grants/:id/activate", "product-grants/:id/activate"],
    ["deactivateProductGrant", "product-endpoint-grants/:id/deactivate", "product-grants/:id/deactivate"],
    ["deleteProductGrant", "product-endpoint-grants/:id", "product-grants/:id"],
    ["listGrants", "tenant-model-grants", "grants"],
    ["createGrant", "tenant-model-grants", "grants"],
    ["updateGrant", "tenant-model-grants/:grantId", "grants/:grantId"],
    ["activateGrant", "tenant-model-grants/:grantId/activate", "grants/:grantId/activate"],
    ["deactivateGrant", "tenant-model-grants/:grantId/deactivate", "grants/:grantId/deactivate"],
    ["deleteGrant", "tenant-model-grants/:grantId", "grants/:grantId"],
  ];

  it.each(RENAMED)("%s answers on both %s and %s", (handler, canonical, legacy) => {
    const paths = pathsOf(handler);
    expect(paths).toContain(canonical);
    expect(paths).toContain(legacy);
    // Canonical first: Nest builds its table in this order, and the canonical
    // name is what belongs in a log or an error message.
    expect(paths[0]).toBe(canonical);
  });

  it("covers every renamed route, so a fourth resource cannot be added silently", () => {
    // The table above is the only place the window is written down. A rename
    // that skips it fails here rather than shipping unaudited.
    const multiPath = Object.getOwnPropertyNames(ModelAdminController.prototype)
      .filter(
        (name) =>
          name !== "constructor" &&
          typeof (ModelAdminController.prototype as unknown as Record<string, unknown>)[
            name
          ] === "function" &&
          pathsOf(name).length > 1,
      )
      .sort();
    expect(multiPath).toEqual(RENAMED.map(([h]) => h).sort());
  });

  it("every retired spelling in the table is one the audit layer folds", () => {
    // The two lists are maintained in different files. If a route here used a
    // retired spelling the vocabulary does not know, its audit rows would file
    // under the old name and this window would leak into the trail.
    for (const [, , legacy] of RENAMED) {
      const segment = legacy.split("/")[0] as string;
      expect(legacySegmentOf(`/capability/${segment}`)).toBe(segment);
    }
  });
});

/**
 * A probe's reqlog row is attributed to the platform sentinel, so it cannot say
 * who ran it; the audit record of the same call can. The request id is the one
 * key both carry, and only the handler knows it - so the handler must hand it
 * to the audit middleware, or the two records line up by timestamp alone.
 */
describe("probe routes hand their request id to the audit record", () => {
  it("model probe", async () => {
    const probe = {
      probe: vi.fn().mockResolvedValue({ requestId: "probe-m", ok: true }),
    };
    const controller = new ModelAdminController({} as never, probe as never);
    const req: { auditRequestId?: string } = {};

    await controller.probeModel("m-1", req);

    expect(probe.probe).toHaveBeenCalledWith("m-1");
    expect(req.auditRequestId).toBe("probe-m");
  });

  it("provider probe carries the id of the model probe it ran", async () => {
    const probe = {
      probeProvider: vi.fn().mockResolvedValue({
        providerId: "prov-1",
        probe: { requestId: "probe-p" },
        ok: true,
      }),
    };
    const controller = new ModelAdminController({} as never, probe as never);
    const req: { auditRequestId?: string } = {};

    await controller.probeProvider("prov-1", req);

    expect(req.auditRequestId).toBe("probe-p");
  });
});
