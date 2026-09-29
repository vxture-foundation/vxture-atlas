import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { buildClaudeBody } from "./claude.provider";
import { buildOpenAiCompatibleBody } from "./openai-compatible";
import {
  ANTHROPIC_WIRE_DEFAULTS,
  OPENAI_WIRE_DEFAULTS,
  resolveWire,
  supportedThinkingModes,
  thinkingFragment,
  validateWire,
} from "./wire";
import type { ProviderChatRequest } from "../types/runtime.types";

/**
 * ADR-009: a per-call `thinking` mode, translated per model by
 * `config.wire.thinking`. These pin the three things that make it honest:
 * the translation is data, it can never override the adapter's own keys, and
 * a mode the model cannot run is never quietly served as `{}`.
 */

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const DEEPSEEK = {
  wire: {
    thinking: {
      off: { thinking: { type: "disabled" } },
      on: { thinking: { type: "enabled" } },
    },
  },
};

function request(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    endpointUrl: "https://api.example/v1",
    apiKey: "k",
    modelCode: "m",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("config.wire.thinking - resolution", () => {
  it("has no modes by default: nothing is supported until an operator records it", () => {
    expect(supportedThinkingModes(OPENAI_WIRE_DEFAULTS)).toEqual([]);
    expect(supportedThinkingModes(ANTHROPIC_WIRE_DEFAULTS)).toEqual([]);
  });

  it("reads both modes from a model's config", () => {
    const wire = resolveWire(OPENAI_WIRE_DEFAULTS, null, DEEPSEEK);
    expect(supportedThinkingModes(wire)).toEqual(["off", "on"]);
    expect(thinkingFragment(wire, "off")).toEqual({ thinking: { type: "disabled" } });
  });

  it("lets a model REPLACE its provider's fragment per mode, not merge into it", () => {
    const provider = { wire: { thinking: { off: { thinking: { type: "disabled" }, extra: 1 } } } };
    const model = { wire: { thinking: { off: { reasoning_effort: "none" } } } };
    const wire = resolveWire(OPENAI_WIRE_DEFAULTS, provider, model);
    expect(thinkingFragment(wire, "off")).toEqual({ reasoning_effort: "none" });
  });

  it("models an always-on model as `on: {}` and no `off`", () => {
    const wire = resolveWire(ANTHROPIC_WIRE_DEFAULTS, null, { wire: { thinking: { on: {} } } });
    expect(supportedThinkingModes(wire)).toEqual(["on"]);
    expect(thinkingFragment(wire, "on")).toEqual({});
  });

  it("drops a reserved key at runtime instead of letting it reach the body", () => {
    const wire = resolveWire(OPENAI_WIRE_DEFAULTS, null, {
      wire: { thinking: { off: { model: "smuggled", thinking: { type: "disabled" } } } },
    });
    expect(thinkingFragment(wire, "off")).toEqual({ thinking: { type: "disabled" } });
  });

  it("throws rather than answering {} for a mode the wire cannot run - {} would be the silent drop", () => {
    expect(() => thinkingFragment(OPENAI_WIRE_DEFAULTS, "off")).toThrow(/cannot honour/u);
  });

  it("adds nothing when the call asked for no mode", () => {
    expect(thinkingFragment(OPENAI_WIRE_DEFAULTS, undefined)).toEqual({});
  });
});

describe("config.wire.thinking - write-path validation", () => {
  it("accepts a well-formed mapping", () => {
    expect(validateWire(DEEPSEEK.wire)).toEqual([]);
  });

  it.each([
    [{ thinking: [] }, "must be an object"],
    [{ thinking: { auto: {} } }, "is not a mode"],
    [{ thinking: { off: "disabled" } }, "must be an object"],
    [{ thinking: { off: { messages: [] } } }, "is reserved by the adapter"],
  ])("refuses %j", (wire, problem) => {
    expect(validateWire(wire).join(" ")).toContain(problem);
  });
});

describe("the fragment's position in the upstream body", () => {
  const wire = resolveWire(OPENAI_WIRE_DEFAULTS, null, {
    wire: {
      extraBody: { thinking: { type: "enabled" }, stop: ["x"] },
      thinking: { off: { thinking: { type: "disabled" } } },
    },
  });

  it("openai-compatible: beats the per-model extraBody default", () => {
    const body = buildOpenAiCompatibleBody(request({ thinking: "off" }), false, wire);
    expect(body["thinking"]).toEqual({ type: "disabled" });
    expect(body["stop"]).toEqual(["x"]);
  });

  it("openai-compatible: leaves extraBody alone when the call asked for no mode", () => {
    const body = buildOpenAiCompatibleBody(request(), false, wire);
    expect(body["thinking"]).toEqual({ type: "enabled" });
  });

  it("claude: same position and rule", () => {
    const claudeWire = resolveWire(ANTHROPIC_WIRE_DEFAULTS, null, {
      wire: { thinking: { on: { thinking: { type: "adaptive" } } } },
    });
    const body = buildClaudeBody(request({ thinking: "on" }), false, claudeWire);
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(body["model"]).toBe("m");
  });
});
