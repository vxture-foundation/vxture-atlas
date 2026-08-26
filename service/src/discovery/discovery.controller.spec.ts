import { describe, it, expect } from "vitest";

import { DiscoveryController } from "./discovery.controller";
import { ATLAS_TOOL_DESCRIPTORS } from "./tool-descriptors";

describe("DiscoveryController.list", () => {
  it("publishes only the capabilities a provider actually serves", () => {
    const controller = new DiscoveryController();
    const result = controller.list();

    expect(result.protocol_version).toBe("1.0");
    // atlas.parse is deliberately withheld from publication.
    expect(result.tools.map((t) => t.name)).toEqual([
      "atlas.chat",
      "atlas.embed",
      "atlas.rerank",
    ]);
    for (const tool of result.tools) {
      // Bumped 1.0.0 -> 1.1.0 (TD-044, 2026-08-18): the version field never
      // moved when taskId became required (#230/#231), so it was worthless
      // as a drift signal for a polling consumer. Retroactive bump - it
      // documents ground truth for whoever starts polling today.
      //
      // 1.1.0 -> 1.2.0 (TD-052, 2026-08-26): the selector properties gained
      // `description`s saying which authorization axis each lives on, after a
      // consumer read three peer options and picked the one on the retiring
      // tenant axis. Not breaking - nothing accepted before is refused now -
      // but a polling consumer diffing `input_schema` sees a real change, and
      // this field is the cheap signal that is supposed to say so.
      //
      // That this assertion had to be edited at all is the mechanism working:
      // the version cannot move by accident, which is precisely what TD-044
      // was about.
      expect(tool.version).toBe("1.2.0");
      expect(tool.deprecated).toBe(false);
      expect(tool.input_schema).toBeTruthy();
      // product_210 §4.1a: the field that lets discovery announce a
      // path change instead of a consumer finding out by 404.
      expect(tool.endpoint).toMatchObject({
        method: "POST",
        path: expect.stringMatching(/^\/v1\//),
      });
    }
  });

  /**
   * The descriptor IS the discovery surface. What it omits is what callers
   * hard-code around - that is the documented cause of vxture-atlas#198, where
   * a consumer invented three endpoint codes because nothing published the
   * real ones. So a descriptor that under-states what the service accepts is
   * not a documentation slip; it is the same defect, one release earlier.
   *
   * All four surfaces refuse only when modelCode, endpointCode and taskProfile
   * are ALL absent (TARGET_SELECTOR_REQUIRED). Every descriptor must say so.
   */
  it("offers all three target selectors, none of them alone required", () => {
    for (const tool of ATLAS_TOOL_DESCRIPTORS) {
      const schema = tool.input_schema as {
        required?: string[];
        anyOf?: Array<{ required?: string[] }>;
        properties?: Record<string, unknown>;
      };

      // modelCode alone required would tell a caller to pin a model when the
      // service would have routed them by intent or entry point.
      expect(schema.required ?? []).not.toContain("modelCode");
      expect(schema.anyOf?.map((branch) => branch.required?.[0]).sort()).toEqual([
        "endpointCode",
        "modelCode",
        "taskProfile",
      ]);
      for (const selector of ["modelCode", "endpointCode", "taskProfile"]) {
        expect(Object.keys(schema.properties ?? {})).toContain(selector);
      }
    }
  });

  /**
   * Third defect in this file in two days: the selectors, then `tenantId`
   * missing from atlas.chat entirely, then `taskId` becoming required without
   * the descriptors following. Each was a field the service enforces and the
   * published contract did not mention, so a caller building from the contract
   * gets a 400 on its first call.
   *
   * These pin the fields the service REFUSES a request without. That list is
   * short and changes rarely; when it changes, this fails.
   */
  it("declares every field the service refuses a request without", () => {
    const required = (name: string): string[] => {
      const tool = ATLAS_TOOL_DESCRIPTORS.find((t) => t.name === name);
      return ((tool?.input_schema as { required?: string[] }).required ?? []).sort();
    };

    // X-2, enforced on all four surfaces since 2026-08-16.
    for (const tool of ATLAS_TOOL_DESCRIPTORS) {
      expect(
        (tool.input_schema as { required?: string[] }).required ?? [],
      ).toContain("taskId");
    }

    // /v1/chat keys on tenantId from the body (400 TENANT_ID_REQUIRED /
    // INVALID_TENANT_ID); the other three key on workspaceId
    // (400 WORKSPACE_ID_REQUIRED).
    expect(required("atlas.chat")).toContain("tenantId");
    for (const name of ["atlas.embed", "atlas.rerank", "atlas.parse"]) {
      expect(required(name)).toContain("workspaceId");
    }
  });

  it("keeps the unpublished parse descriptor in source, ready to restore", () => {
    // Guards against the withholding being "fixed" by deleting the contract:
    // when a parse provider lands, restoring it must be a one-line change.
    expect(ATLAS_TOOL_DESCRIPTORS.map((t) => t.name)).toContain("atlas.parse");
  });
});
