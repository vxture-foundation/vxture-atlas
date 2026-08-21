import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@nestjs/common";

import {
  ANTHROPIC_WIRE_DEFAULTS,
  OPENAI_WIRE_DEFAULTS,
  resolveWire,
  WIRE_SCHEMA_VERSION,
} from "./wire";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("resolveWire", () => {
  it("returns the adapter defaults when nothing is configured", () => {
    expect(resolveWire(OPENAI_WIRE_DEFAULTS, null, undefined)).toEqual(
      OPENAI_WIRE_DEFAULTS,
    );
  });

  it("lets the model config override the provider config", () => {
    const resolved = resolveWire(
      OPENAI_WIRE_DEFAULTS,
      { wire: { chatPath: "/provider/path", streamUsage: "native" } },
      { wire: { chatPath: "/model/path" } },
    );

    expect(resolved.chatPath).toBe("/model/path");
    // 模型只覆盖了 chatPath，服务商设的 streamUsage 必须保留。
    expect(resolved.streamUsage).toBe("native");
  });

  it("deep-merges supports rather than replacing the whole object", () => {
    const resolved = resolveWire(OPENAI_WIRE_DEFAULTS, {
      wire: { supports: { tools: false } },
    });

    expect(resolved.supports).toEqual({
      tools: false,
      toolChoice: true,
      topP: true,
      temperature: true,
    });
  });

  it("merges headers across levels", () => {
    const resolved = resolveWire(
      ANTHROPIC_WIRE_DEFAULTS,
      { wire: { headers: { "x-org": "vxture" } } },
      { wire: { headers: { "anthropic-version": "2026-01-01" } } },
    );

    expect(resolved.headers).toEqual({
      "anthropic-version": "2026-01-01",
      "x-org": "vxture",
    });
  });

  it("does not mutate the frozen defaults", () => {
    resolveWire(OPENAI_WIRE_DEFAULTS, { wire: { supports: { tools: false } } });
    expect(OPENAI_WIRE_DEFAULTS.supports.tools).toBe(true);
  });

  describe("lenient on read", () => {
    it("ignores an unknown key and warns instead of failing", () => {
      const resolved = resolveWire(OPENAI_WIRE_DEFAULTS, {
        wire: { chatPath: "/keep", somethingNewer: true },
      });

      expect(resolved.chatPath).toBe("/keep");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("somethingNewer"),
      );
    });

    it("warns but keeps working when the config declares a newer schemaVersion", () => {
      // 运营改配置比服务发版快 - 读不懂的新键不该让一个正在跑的模型停摆。
      const resolved = resolveWire(OPENAI_WIRE_DEFAULTS, {
        wire: { schemaVersion: WIRE_SCHEMA_VERSION + 1, chatPath: "/still" },
      });

      expect(resolved.chatPath).toBe("/still");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("schemaVersion"));
    });

    it.each([["not-an-object"], [42], [[1, 2]]])(
      "ignores a malformed wire value (%s)",
      (value) => {
        expect(
          resolveWire(OPENAI_WIRE_DEFAULTS, { wire: value } as never),
        ).toEqual(OPENAI_WIRE_DEFAULTS);
      },
    );

    it("ignores an out-of-vocabulary enum value", () => {
      const resolved = resolveWire(OPENAI_WIRE_DEFAULTS, {
        wire: { streamUsage: "carrier-pigeon", auth: { style: "magic" } },
      });

      expect(resolved.streamUsage).toBe(OPENAI_WIRE_DEFAULTS.streamUsage);
      expect(resolved.authStyle).toBe(OPENAI_WIRE_DEFAULTS.authStyle);
    });

    it("ignores a non-boolean supports value", () => {
      const resolved = resolveWire(OPENAI_WIRE_DEFAULTS, {
        wire: { supports: { tools: "yes" } },
      });

      expect(resolved.supports.tools).toBe(true);
    });
  });

  describe("defaults per protocol", () => {
    it("opts OpenAI-dialect streams into usage reporting", () => {
      // 这个默认值是修复点：不 opt-in，上游流式不回 usage，这次调用就不会
      // 被计量（设计文档 section 9 / TD-017）。
      expect(OPENAI_WIRE_DEFAULTS.streamUsage).toBe("stream_options");
      expect(OPENAI_WIRE_DEFAULTS.authStyle).toBe("bearer");
    });

    it("marks Anthropic as reporting usage natively", () => {
      expect(ANTHROPIC_WIRE_DEFAULTS.streamUsage).toBe("native");
      expect(ANTHROPIC_WIRE_DEFAULTS.authStyle).toBe("x-api-key");
      expect(ANTHROPIC_WIRE_DEFAULTS.headers["anthropic-version"]).toBe(
        "2023-06-01",
      );
    });
  });
});
