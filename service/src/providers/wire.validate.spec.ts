import { describe, it, expect } from "vitest";

import { validateWire, WIRE_SCHEMA_VERSION } from "./wire";

describe("validateWire (strict on write)", () => {
  it("accepts an absent descriptor", () => {
    expect(validateWire(undefined)).toEqual([]);
    expect(validateWire(null)).toEqual([]);
  });

  it("accepts a fully populated descriptor", () => {
    expect(
      validateWire({
        schemaVersion: WIRE_SCHEMA_VERSION,
        chatPath: "/v1/chat",
        auth: { style: "x-api-key" },
        headers: { "anthropic-version": "2023-06-01" },
        streamUsage: "native",
        supports: { tools: false, toolChoice: false },
        paramMap: { maxTokens: "max_completion_tokens" },
      }),
    ).toEqual([]);
  });

  it("rejects an unknown key and names the allowed set", () => {
    // 运行时会忽略未知键；写入时必须拒绝，否则错别字会静默失效。
    const problems = validateWire({ streamUsge: "none" });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("streamUsge");
    expect(problems[0]).toContain("streamUsage");
  });

  it("rejects a schemaVersion newer than this service", () => {
    expect(validateWire({ schemaVersion: WIRE_SCHEMA_VERSION + 1 })).toEqual([
      expect.stringContaining("newer than this service understands"),
    ]);
  });

  it.each([
    [{ streamUsage: "carrier-pigeon" }, "streamUsage"],
    [{ auth: { style: "magic" } }, "auth.style"],
    [{ supports: { telepathy: true } }, "supports.telepathy"],
    [{ supports: { tools: "yes" } }, "supports.tools"],
    [{ chatPath: 42 }, "chatPath"],
    [{ headers: { "x-a": 1 } }, "headers.x-a"],
    [{ paramMap: ["nope"] }, "paramMap"],
  ])("rejects %o", (wire, expectedField) => {
    const problems = validateWire(wire);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain(expectedField);
  });

  it("rejects a non-object descriptor", () => {
    expect(validateWire("nope")).toEqual(["config.wire must be an object"]);
    expect(validateWire([1])).toEqual(["config.wire must be an object"]);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const problems = validateWire({
      streamUsage: "bogus",
      supports: { tools: "no" },
      unknownKey: 1,
    });

    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
