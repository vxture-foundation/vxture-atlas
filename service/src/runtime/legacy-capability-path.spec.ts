import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegacyCapabilityPathInterceptor } from "./legacy-capability-path";
import { metricsRegistry } from "./metrics.registry";

/**
 * The interceptor is the half of #206 that decides when the window CLOSES.
 *
 * `capability_legacy_path_requests_total` is what says whether opera has
 * actually cut over. If it silently failed to increment, the gate would read
 * zero forever and the retired paths would be deleted while a live consumer was
 * still calling them - the outage the dual-path window exists to avoid, caused
 * by the instrument meant to prevent it. So the increment is asserted, not
 * assumed.
 */
function contextFor(url: string, operatorId?: string) {
  const headers: Record<string, string> = {};
  const handle = vi.fn(() => "handled");
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        originalUrl: url,
        ...(operatorId ? { operatorAuth: { operatorId } } : {}),
      }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  };
  return { context, handle, headers };
}

describe("LegacyCapabilityPathInterceptor", () => {
  let inc: ReturnType<typeof vi.spyOn>;
  const interceptor = new LegacyCapabilityPathInterceptor();

  beforeEach(() => {
    inc = vi.spyOn(metricsRegistry, "incCounter").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("stamps Deprecation, Sunset and the successor Link on a retired path", () => {
    const { context, handle, headers } = contextFor("/capability/grants");

    interceptor.intercept(context as never, { handle } as never);

    expect(headers["Deprecation"]).toBe("true");
    expect(headers["Link"]).toBe(
      '</capability/tenant-model-grants>; rel="successor-version"',
    );
    // RFC 8594 wants an HTTP-date. `Invalid Date` here is a header a client
    // cannot act on, which is worse than sending none.
    expect(headers["Sunset"]).toMatch(/^\w{3}, \d{2} \w{3} \d{4} .+GMT$/);
    expect(Number.isNaN(new Date(headers["Sunset"] as string).getTime())).toBe(
      false,
    );
  });

  it("names the right successor per resource", () => {
    for (const [url, successor] of [
      ["/capability/product-grants/pg-1", "product-endpoint-grants"],
      ["/capability/endpoints/ep-1/activate", "model-routes"],
    ] as const) {
      const { context, handle, headers } = contextFor(url);
      interceptor.intercept(context as never, { handle } as never);
      expect(headers["Link"]).toBe(
        `</capability/${successor}>; rel="successor-version"`,
      );
    }
  });

  it("counts the retired call against the operator who made it", () => {
    const { context, handle } = contextFor("/capability/endpoints", "opera-bff");

    interceptor.intercept(context as never, { handle } as never);

    expect(inc).toHaveBeenCalledWith("capability_legacy_path_requests_total", {
      path: "endpoints",
      operator: "opera-bff",
    });
  });

  it("labels an unattributed call `unknown` rather than dropping it", () => {
    // A call with no operator context still has to be counted: the gate asks
    // "is anyone still calling this", and an uncounted call answers no.
    const { context, handle } = contextFor("/capability/grants");

    interceptor.intercept(context as never, { handle } as never);

    expect(inc).toHaveBeenCalledWith("capability_legacy_path_requests_total", {
      path: "grants",
      operator: "unknown",
    });
  });

  it("leaves a canonical path completely alone", () => {
    // A canonical call counted as legacy traffic would keep the gate non-zero
    // forever and the old names could never be removed.
    for (const url of [
      "/capability/tenant-model-grants",
      "/capability/product-endpoint-grants/pg-1",
      "/capability/model-routes/ep-1/deactivate",
    ]) {
      const { context, handle, headers } = contextFor(url);
      interceptor.intercept(context as never, { handle } as never);
      expect(headers).toEqual({});
    }
    expect(inc).not.toHaveBeenCalled();
  });

  it("ignores routes that were never renamed", () => {
    const { context, handle, headers } = contextFor("/capability/models/m-1");

    interceptor.intercept(context as never, { handle } as never);

    expect(headers).toEqual({});
    expect(inc).not.toHaveBeenCalled();
  });

  it("always calls through to the handler", () => {
    // Whatever it decides about headers, it must not swallow the request.
    for (const url of ["/capability/grants", "/capability/models"]) {
      const { context, handle } = contextFor(url);
      expect(interceptor.intercept(context as never, { handle } as never)).toBe(
        "handled",
      );
      expect(handle).toHaveBeenCalledOnce();
    }
  });

  it("survives a response object with no setHeader", () => {
    // The header calls are optional-chained. If that ever regressed, a
    // non-Express adapter would throw INSIDE an interceptor wrapping every
    // operator write - the request would fail, not just lose a header.
    const handle = vi.fn(() => "handled");
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: "/capability/grants" }),
        getResponse: () => ({}),
      }),
    };

    expect(() =>
      interceptor.intercept(context as never, { handle } as never),
    ).not.toThrow();
    // The count still happens - it does not depend on the response.
    expect(inc).toHaveBeenCalledOnce();
  });
});
