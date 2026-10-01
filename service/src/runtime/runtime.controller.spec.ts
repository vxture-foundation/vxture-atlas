import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MAX_REQUEST_BODY_BYTES } from "./request-body";
import { ModelRuntimeController } from "./runtime.controller";
import { ModelRuntimeException } from "./runtime.errors";

/**
 * `GET /v1/endpoints` - the consumer catalog (vxture-atlas#198 §3).
 *
 * The service decides what a caller holds; the controller decides WHO is
 * asking. That second half is the security-relevant one and it lives only
 * here, so it is tested here: the product identity must come from the verified
 * token and never from anything the caller can type.
 */
function makeController(
  endpoints: unknown[] = [],
): {
  controller: ModelRuntimeController;
  registry: { listGrantedEndpoints: ReturnType<typeof vi.fn> };
} {
  const registry = {
    listGrantedEndpoints: vi.fn().mockResolvedValue(endpoints),
  };
  return {
    controller: new ModelRuntimeController(
      {} as never,
      registry as never,
    ),
    registry,
  };
}

function request(callerProductCode?: string): never {
  return {
    headers: {},
    ...(callerProductCode ? { s2sAuth: { callerProductCode } } : {}),
  } as never;
}

describe("ModelRuntimeController.listEndpoints", () => {
  it("takes the product from the verified token", async () => {
    const { controller, registry } = makeController();

    await controller.listEndpoints(request("vxtpl"), {});

    expect(registry.listGrantedEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({ productCode: "vxtpl" }),
    );
  });

  it("cannot be talked into answering for another product", async () => {
    // There is deliberately no `productCode` query parameter. If one is ever
    // added, this test is the thing that should stop it: the catalog is a
    // grant listing, and a caller enumerating a sibling product's grants is a
    // disclosure, not a convenience.
    const { controller, registry } = makeController();

    await controller.listEndpoints(
      request("vxtpl"),
      { applicationId: "app-1", applicationType: "agent" },
      "app-1",
      "agent",
    );

    const [scope] = registry.listGrantedEndpoints.mock.calls[0] as [
      { productCode: string },
    ];
    expect(scope.productCode).toBe("vxtpl");
  });

  it("refuses a token with no product identity instead of listing everything", async () => {
    // The guard already rejects such a token, so this is defence in depth -
    // but the failure mode if it ever got through (an unscoped catalog) is bad
    // enough to be worth its own refusal rather than an empty `productCode`
    // reaching the query.
    const { controller, registry } = makeController();

    await expect(controller.listEndpoints(request(), {})).rejects.toBeInstanceOf(
      ModelRuntimeException,
    );
    expect(registry.listGrantedEndpoints).not.toHaveBeenCalled();
  });

  it("narrows to the application scope a call would use", async () => {
    const { controller, registry } = makeController();

    await controller.listEndpoints(
      request("vxtpl"),
      {
        applicationId: "550e8400-e29b-41d4-a716-446655440000",
        applicationType: "workflow",
      },
      "550e8400-e29b-41d4-a716-446655440000",
      "workflow",
    );

    expect(registry.listGrantedEndpoints).toHaveBeenCalledWith({
      productCode: "vxtpl",
      applicationId: "550e8400-e29b-41d4-a716-446655440000",
      applicationType: "workflow",
    });
  });

  it("returns the catalog under an `endpoints` key", async () => {
    const row = {
      endpointCode: "chat/default",
      category: "chat",
      state: "active" as const,
      contextWindow: 131072,
      thinkingModes: ["off", "on"] as ("off" | "on")[],
      maxOutputTokens: 16384,
    };
    const { controller } = makeController([row]);

    expect(await controller.listEndpoints(request("vxtpl"), {})).toEqual({
      endpoints: [row],
      // The ceiling the parser enforces, published once for every route.
      maxRequestBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
    });
  });
});

/**
 * A filter the endpoint does not know is refused, not dropped. Dropping it
 * returns HTTP 200 and a well-formed body that answers a different question -
 * `/v1/models?productCode=x` handing back the whole catalog as if it were x's -
 * and the caller has no way to tell. See service/src/http-query.ts.
 *
 * The consumption plane refuses with its own envelope rather than the operator
 * plane's: product_251 X-1 requires a code from the runtime vocabulary and a
 * `retryable` flag, so a shared `BadRequestException` would have been the one
 * `/v1` error without them.
 */
describe("/v1 unknown filters", () => {
  it("refuses an unknown filter on /v1/models with a vocabulary code", async () => {
    const { controller } = makeController();

    await expect(
      controller.listModels({ productCode: "vxtpl" }),
    ).rejects.toMatchObject({
      // X-1: code from the vocabulary, and retryable present - repeating the
      // same request cannot help, so the caller must not back off and retry.
      response: {
        code: "UNKNOWN_FILTER",
        retryable: false,
      },
    });
  });

  it("refuses an unknown filter on /v1/endpoints before reading the token", async () => {
    const { controller, registry } = makeController();

    await expect(
      controller.listEndpoints(request("vxtpl"), { tenantId: "t" }),
    ).rejects.toBeInstanceOf(ModelRuntimeException);
    // Refused rather than answered: the catalog was never consulted.
    expect(registry.listGrantedEndpoints).not.toHaveBeenCalled();
  });

  it("names the accepted filters so a renamed parameter is recoverable", async () => {
    const { controller } = makeController();

    await expect(
      controller.listEndpoints(request("vxtpl"), { tenantId: "t" }),
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining("applicationId, applicationType"),
      },
    });
  });

  it("lets a known filter through", async () => {
    const { controller, registry } = makeController();

    await controller.listEndpoints(
      request("vxtpl"),
      { applicationType: "agent" },
      undefined,
      "agent",
    );

    expect(registry.listGrantedEndpoints).toHaveBeenCalled();
  });
});
