import { describe, it, expect } from "vitest";

import {
  BaseProvider,
  ProviderCapabilityNotImplementedError,
  joinEndpoint,
  parseJson,
  resolveUpstreamModel,
} from "./base.provider";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
} from "../types/runtime.types";

// ── joinEndpoint ──────────────────────────────────────────────────────────────

describe("joinEndpoint", () => {
  it("handles trailing slash on base and leading slash on suffix", () => {
    expect(joinEndpoint("https://api.example.com/", "/chat")).toBe(
      "https://api.example.com/chat",
    );
  });

  it("handles base without trailing slash and suffix without leading slash", () => {
    expect(joinEndpoint("https://api.example.com", "chat")).toBe(
      "https://api.example.com/chat",
    );
  });

  it("handles base without trailing slash and suffix with leading slash", () => {
    expect(joinEndpoint("https://api.example.com", "/chat")).toBe(
      "https://api.example.com/chat",
    );
  });

  it("collapses multiple trailing slashes on base", () => {
    expect(joinEndpoint("https://api.example.com///", "chat")).toBe(
      "https://api.example.com/chat",
    );
  });

  it("collapses multiple leading slashes on suffix", () => {
    expect(joinEndpoint("https://api.example.com", "//chat/completions")).toBe(
      "https://api.example.com/chat/completions",
    );
  });

  it("handles a path-like base with trailing slash", () => {
    expect(
      joinEndpoint("https://api.example.com/v1/", "/chat/completions"),
    ).toBe("https://api.example.com/v1/chat/completions");
  });
});

// ── parseJson ─────────────────────────────────────────────────────────────────

describe("parseJson", () => {
  it("parses a valid JSON object", () => {
    expect(parseJson<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses a JSON array", () => {
    expect(parseJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses a JSON string value", () => {
    expect(parseJson<string>('"hello"')).toBe("hello");
  });

  it("throws on empty string", () => {
    expect(() => parseJson("")).toThrow("Provider returned an empty response");
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseJson("   ")).toThrow(
      "Provider returned an empty response",
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJson("{bad json}")).toThrow();
  });
});

// ── BaseProvider S2S capability defaults ──────────────────────────────

class StubProvider extends BaseProvider {
  readonly providerName = "stub";

  chat(_request: ProviderChatRequest): Promise<ProviderChatResponse> {
    throw new Error("not used in this test");
  }
}

describe("BaseProvider default S2S capabilities (embed/rerank/parseDocument)", () => {
  const provider = new StubProvider();

  it("embed throws ProviderCapabilityNotImplementedError by default", async () => {
    await expect(
      provider.embed({
        endpointUrl: "https://example.com",
        apiKey: "",
        modelCode: "m",
        texts: ["hi"],
      }),
    ).rejects.toThrow(ProviderCapabilityNotImplementedError);
  });

  it("rerank throws ProviderCapabilityNotImplementedError by default", async () => {
    await expect(
      provider.rerank({
        endpointUrl: "https://example.com",
        apiKey: "",
        modelCode: "m",
        query: "q",
        candidates: [{ id: "1", text: "a" }],
      }),
    ).rejects.toThrow(ProviderCapabilityNotImplementedError);
  });

  it("parseDocument throws ProviderCapabilityNotImplementedError by default", async () => {
    await expect(
      provider.parseDocument({
        endpointUrl: "https://example.com",
        apiKey: "",
        modelCode: "m",
        task: "ocr",
        pages: [{ pageIndex: 0, imageRef: "ref" }],
      }),
    ).rejects.toThrow(ProviderCapabilityNotImplementedError);
  });

  it("names the provider and capability in the error", async () => {
    try {
      await provider.embed({
        endpointUrl: "https://example.com",
        apiKey: "",
        modelCode: "m",
        texts: ["hi"],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityNotImplementedError);
      const typed = error as ProviderCapabilityNotImplementedError;
      expect(typed.providerName).toBe("stub");
      expect(typed.capability).toBe("embed");
    }
  });
});

// ── resolveUpstreamModel ──────────────────

describe("resolveUpstreamModel", () => {
  it("prefers config.upstreamModel when present", () => {
    expect(
      resolveUpstreamModel({
        modelCode: "deepseek/deepseek-chat",
        config: { upstreamModel: "deepseek-chat" },
      }),
    ).toBe("deepseek-chat");
  });

  it("falls back to modelCode when upstreamModel is absent", () => {
    // The legacy unprefixed rows (doubao/zhipu today) - and any model that
    // has not been given an explicit upstreamModel yet.
    expect(
      resolveUpstreamModel({ modelCode: "glm-5.2", config: {} }),
    ).toBe("glm-5.2");
    expect(resolveUpstreamModel({ modelCode: "glm-5.2" })).toBe("glm-5.2");
  });

  it("falls back when upstreamModel is present but blank", () => {
    expect(
      resolveUpstreamModel({
        modelCode: "glm-5.2",
        config: { upstreamModel: "   " },
      }),
    ).toBe("glm-5.2");
  });

  it("falls back when upstreamModel is a non-string value", () => {
    // config is caller-controlled jsonb - a malformed value must not throw or
    // silently send "[object Object]" upstream.
    expect(
      resolveUpstreamModel({
        modelCode: "glm-5.2",
        config: { upstreamModel: 123 },
      }),
    ).toBe("glm-5.2");
  });

  it("trims the resolved value", () => {
    expect(
      resolveUpstreamModel({
        modelCode: "glm-5.2",
        config: { upstreamModel: "  glm-5.2  " },
      }),
    ).toBe("glm-5.2");
  });
});
