import { describe, expect, it, vi } from "vitest";
import { HttpStatus } from "@nestjs/common";

import { RetryAfterFilter } from "./retry-after.filter";
import { ModelRuntimeException } from "./runtime.errors";

function makeHost(headersSent = false): {
  host: never;
  response: {
    status: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    headersSent: boolean;
  };
} {
  const response = {
    status: vi.fn(),
    setHeader: vi.fn(),
    json: vi.fn(),
    headersSent,
  };
  response.status.mockReturnValue(response);
  response.setHeader.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return {
    host: {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never,
    response,
  };
}

const filter = new RetryAfterFilter();

describe("RetryAfterFilter", () => {
  it("sets Retry-After in seconds when the error carries retryAfterMs", () => {
    const { host, response } = makeHost();

    filter.catch(
      new ModelRuntimeException(
        HttpStatus.TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "slow down",
        { retryAfterMs: 2000 },
      ),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(response.status).toHaveBeenCalledWith(429);
  });

  it("rounds up, never down", () => {
    // 400ms floored to "0" tells a client to retry immediately against a gate
    // that is still shut - worse than sending no header at all.
    const { host, response } = makeHost();

    filter.catch(
      new ModelRuntimeException(429, "RATE_LIMITED", "slow down", {
        retryAfterMs: 400,
      }),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
  });

  it("leaves the body byte-identical to what Nest would have sent", () => {
    // The whole point of a narrow filter: every X-1 consumer branches on this
    // envelope, so adding a header must not reshape it.
    const exception = new ModelRuntimeException(
      429,
      "RATE_LIMITED",
      "slow down",
      { retryAfterMs: 1500, modelCode: "m", requestId: "r" },
    );
    const { host, response } = makeHost();

    filter.catch(exception, host);

    expect(response.json).toHaveBeenCalledWith(exception.getResponse());
    expect(response.json).toHaveBeenCalledWith({
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
      requestId: "r",
      modelCode: "m",
      retryAfterMs: 1500,
    });
  });

  it("sends no header on errors that carry no retryAfterMs", () => {
    const { host, response } = makeHost();

    filter.catch(
      new ModelRuntimeException(400, "TASK_ID_REQUIRED", "missing"),
      host,
    );

    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("does not touch a response that already sent its headers", () => {
    // A streaming reply commits headers up front and delivers errors as SSE
    // frames (G-2). Writing a status here would corrupt the stream.
    const { host, response } = makeHost(true);

    filter.catch(
      new ModelRuntimeException(429, "RATE_LIMITED", "slow down", {
        retryAfterMs: 1000,
      }),
      host,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
