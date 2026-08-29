import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegacyDataPlanePathInterceptor } from "./legacy-data-plane-path";
import { metricsRegistry } from "./metrics.registry";

/**
 * The interceptor is the half of TD-042 that decides when the window CLOSES.
 *
 * `data_plane_legacy_path_requests_total` is what says whether karda and vxtpl
 * have actually cut over. If it silently failed to increment, the gate would
 * read zero forever and the retired paths would be deleted while a live product
 * was still calling them - the outage the dual-path window exists to avoid,
 * caused by the instrument meant to prevent it. So the increment is asserted,
 * not assumed.
 *
 * The product label is asserted for the same reason it exists: "some traffic"
 * does not tell anyone whom to talk to before proposing removal.
 */
function contextFor(url: string, callerProductCode?: string) {
  const headers: Record<string, string> = {};
  const handle = vi.fn(() => "handled");
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        originalUrl: url,
        ...(callerProductCode ? { s2sAuth: { callerProductCode } } : {}),
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

describe("LegacyDataPlanePathInterceptor", () => {
  let inc: ReturnType<typeof vi.spyOn>;
  const interceptor = new LegacyDataPlanePathInterceptor();

  beforeEach(() => {
    inc = vi.spyOn(metricsRegistry, "incCounter").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("stamps Deprecation, Sunset and the successor Link on a retired path", () => {
    const { context, handle, headers } = contextFor("/v1/endpoints", "karda");

    interceptor.intercept(context as never, { handle } as never);

    expect(headers["Deprecation"]).toBe("true");
    expect(headers["Link"]).toBe('</v1/model-routes>; rel="successor-version"');
    // RFC 8594 wants an HTTP-date, not ISO 8601.
    expect(headers["Sunset"]).toMatch(/GMT$/u);
    expect(handle).toHaveBeenCalledOnce();
  });

  it("points /tenancy/grants at its own successor, not /v1's", () => {
    const { context, handle, headers } = contextFor("/tenancy/grants", "vxtpl");

    interceptor.intercept(context as never, { handle } as never);

    expect(headers["Link"]).toBe(
      '</tenancy/tenant-model-grants>; rel="successor-version"',
    );
  });

  it("counts the retired call against the calling product", () => {
    const { context, handle } = contextFor("/v1/endpoints", "karda");

    interceptor.intercept(context as never, { handle } as never);

    expect(inc).toHaveBeenCalledWith("data_plane_legacy_path_requests_total", {
      path: "v1/endpoints",
      product: "karda",
    });
  });

  /* An unauthenticated or pre-guard call must still be counted. Dropping it
     would make the gate read lower than the truth, which is the direction that
     causes an outage. */
  it("counts an unattributable call as `unknown` rather than dropping it", () => {
    const { context, handle } = contextFor("/tenancy/grants");

    interceptor.intercept(context as never, { handle } as never);

    expect(inc).toHaveBeenCalledWith("data_plane_legacy_path_requests_total", {
      path: "tenancy/grants",
      product: "unknown",
    });
  });

  it("leaves the canonical path untouched and uncounted", () => {
    const { context, handle, headers } = contextFor(
      "/v1/model-routes",
      "karda",
    );

    interceptor.intercept(context as never, { handle } as never);

    expect(headers).toEqual({});
    expect(inc).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledOnce();
  });

  /* The operator plane has its own interceptor and its own sunset date. If this
     one answered there too, `/capability/*` would advertise the wrong date. */
  it("does not stamp the operator plane", () => {
    const { context, handle, headers } = contextFor("/capability/grants");

    interceptor.intercept(context as never, { handle } as never);

    expect(headers).toEqual({});
    expect(inc).not.toHaveBeenCalled();
  });

  it("falls back to `url` when `originalUrl` is absent", () => {
    const headers: Record<string, string> = {};
    const handle = vi.fn(() => "handled");
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/v1/endpoints" }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            headers[name] = value;
          },
        }),
      }),
    };

    interceptor.intercept(context as never, { handle } as never);

    expect(headers["Deprecation"]).toBe("true");
  });
});
