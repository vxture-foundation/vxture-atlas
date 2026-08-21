import { describe, expect, it } from "vitest";

import { modelBehaviorVersion } from "./model-behavior-version";
import type { AiModelRecord } from "./types/runtime.types";

function model(over: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "m-1",
    providerId: "p-1",
    modelCode: "doubao-lite",
    modelName: "Doubao Lite",
    provider: "doubao",
    endpointUrl: "https://ark.example.com/v3/chat",
    protocol: "openai",
    modelType: "chat",
    description: null,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    capabilities: ["chat"],
    supportsStreaming: true,
    isActive: true,
    sort: 0,
    config: null,
    providerConfig: null,
    providerActive: true,
    deprecatedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...over,
  };
}

/**
 * The fingerprint has to be right in BOTH directions, and they fail
 * differently:
 *
 * - Missing a real change is a silent wrong answer - the exact defect this
 *   exists to remove.
 * - Changing on something harmless is a signal that cries wolf, and a consumer
 *   who learns to ignore it will ignore the real repoint too.
 */
describe("modelBehaviorVersion", () => {
  it("is stable for an unchanged model", () => {
    expect(modelBehaviorVersion(model())).toBe(modelBehaviorVersion(model()));
  });

  it("carries its scheme tag, so an algorithm change is distinguishable", () => {
    // Same scheme + different digest = the model changed. Different scheme =
    // we changed, and every model moves at once. A consumer must be able to
    // tell those apart.
    expect(modelBehaviorVersion(model())).toMatch(/^b1-[0-9a-f]{12}$/);
  });

  describe("changes when the model's behaviour can change", () => {
    const base = modelBehaviorVersion(model());

    it.each([
      ["endpointUrl - repointed upstream", { endpointUrl: "https://other.example.com/v1" }],
      ["providerId - moved to another provider", { providerId: "p-2" }],
      ["protocol - different wire", { protocol: "anthropic" }],
      ["modelType", { modelType: "embed" }],
      ["contextWindow", { contextWindow: 8000 }],
      ["maxOutputTokens", { maxOutputTokens: 1024 }],
      ["capabilities", { capabilities: ["chat", "vision"] }],
      ["supportsStreaming", { supportsStreaming: false }],
      ["config.wire", { config: { wire: { chatPath: "/v2/chat" } } }],
      ["config.supportsVision", { config: { supportsVision: true } }],
      ["providerConfig - the defaults this model inherits", {
        providerConfig: { wire: { chatPath: "/v9" } },
      }],
    ] as ReadonlyArray<[string, Partial<AiModelRecord>]>)(
      "%s",
      (_label, over) => {
        expect(modelBehaviorVersion(model(over))).not.toBe(base);
      },
    );
  });

  describe("does not change on things that are not behaviour", () => {
    const base = modelBehaviorVersion(model());

    it.each([
      ["modelName - a display-name typo fix", { modelName: "Doubao Lite v2" }],
      ["description", { description: "now with more words" }],
      ["sort - list ordering", { sort: 42 }],
      ["isActive - already reported as state", { isActive: false }],
      ["deprecatedAt - lifecycle, not behaviour", { deprecatedAt: new Date() }],
      ["updatedBy / updatedAt - audit columns", {
        updatedBy: "someone", updatedAt: new Date(1),
      }],
    ] as ReadonlyArray<[string, Partial<AiModelRecord>]>)(
      "%s",
      (_label, over) => {
        expect(modelBehaviorVersion(model(over))).toBe(base);
      },
    );

    it("a key rotation - custody is not semantics", () => {
      // Bumping on a rotation would tell every consumer their golden outputs
      // might have moved, for a change that cannot alter one token of output.
      const a = model({ config: { wire: { chatPath: "/x" }, keyReference: { source: "managed", name: "k1" } } });
      const b = model({ config: { wire: { chatPath: "/x" }, keyReference: { source: "managed", name: "k2" } } });
      expect(modelBehaviorVersion(a)).toBe(modelBehaviorVersion(b));
    });

    it("config key insertion order", () => {
      // A re-save that reorders JSON keys changed nothing. Without canonical
      // serialisation it would read as a repoint.
      const a = model({ config: { a: 1, b: { x: 1, y: 2 } } });
      const b = model({ config: { b: { y: 2, x: 1 }, a: 1 } });
      expect(modelBehaviorVersion(a)).toBe(modelBehaviorVersion(b));
    });

    it("capabilities order", () => {
      const a = model({ capabilities: ["chat", "vision"] });
      const b = model({ capabilities: ["vision", "chat"] });
      expect(modelBehaviorVersion(a)).toBe(modelBehaviorVersion(b));
    });
  });

  it("does not mutate the record it fingerprints", () => {
    // `capabilities` is sorted internally. Sorting the caller's array in place
    // would reorder what the API returns, on a read.
    const m = model({ capabilities: ["vision", "chat"] });
    modelBehaviorVersion(m);
    expect(m.capabilities).toEqual(["vision", "chat"]);
  });

  it("orders keys independently of locale", () => {
    // SonarQube S2871 flags a bare `.sort()` and suggests `localeCompare`.
    // Taking that suggestion would be a real defect here: `localeCompare` is
    // locale-sensitive, so the same model would fingerprint differently on two
    // machines with different locales and a consumer comparing across them
    // would read "the model changed" on every call.
    //
    // These keys sort differently under `localeCompare` in several locales than
    // they do by code unit, so a switch to `localeCompare` moves the digest and
    // this test goes red.
    const tricky = { "ä": 1, z: 2, A: 3, a: 4, "_": 5, "Ä": 6 };
    const first = modelBehaviorVersion(model({ config: tricky }));

    const reordered = Object.fromEntries(
      Object.entries(tricky).reverse(),
    ) as Record<string, unknown>;
    expect(modelBehaviorVersion(model({ config: reordered }))).toBe(first);

    // Pin the DIGEST, not the format. Format alone does not bite: under
    // localeCompare this test still passed, because self-consistency and
    // reorder-invariance both hold within a single locale - the value just
    // moves. The two orderings genuinely differ here
    // (A,_,a,z,Ä,ä by code unit; _,a,A,ä,Ä,z by locale), so pinning
    // the value is what turns a switch to localeCompare red.
    expect(first).toBe("b1-f6cfd600c8c4");
  });

  it("distinguishes two genuinely different models", () => {
    expect(modelBehaviorVersion(model())).not.toBe(
      modelBehaviorVersion(model({ endpointUrl: "https://z.example.com" })),
    );
  });
});
