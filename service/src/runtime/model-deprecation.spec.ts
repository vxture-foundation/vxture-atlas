import { describe, expect, it, vi } from "vitest";

import { toModelState } from "../object-state";
import { ModelAdminController } from "./model-admin.controller";
import { ModelAdminService } from "./model-admin.service";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describeMutation } from "../audit/audit.middleware";

/**
 * product_251 X-4 / vxture-atlas#205.
 *
 * The complaint was not "there is no version column". It was that a supplier
 * changing what sits behind a `model_code` - routine, not an incident - reaches
 * the consumer as nothing at all. A model had two binary facts, `is_active` and
 * `deleted_at`, and neither can say "still works, stop building on it": the
 * only way to retire one was to switch it off, which is a 404 at call time with
 * no warning before it.
 */
describe("model deprecation", () => {
  describe("state derivation", () => {
    it("reports a deprecated model as deprecated, not inactive", () => {
      expect(
        toModelState({ isActive: true, deprecatedAt: new Date() }),
      ).toBe("deprecated");
    });

    it("keeps a plain model active", () => {
      expect(toModelState({ isActive: true, deprecatedAt: null })).toBe(
        "active",
      );
    });

    it("lets an explicit deactivation win over a deprecation", () => {
      // An operator who deactivated a deprecated model meant it. Reporting
      // `deprecated` would read as "still serving", which is the opposite.
      expect(
        toModelState({ isActive: false, deprecatedAt: new Date() }),
      ).toBe("inactive");
    });
  });

  describe("a deprecated model still serves", () => {
    it("does not touch isActive, so routing is unaffected", async () => {
      // The whole point. If deprecating stopped a model resolving, this would
      // be `deactivate` with a longer name, and the consumer would get the
      // same 404 the change exists to give warning of.
      const updateModel = vi.fn().mockResolvedValue({
        id: "m-1",
        isActive: true,
        deprecatedAt: new Date("2026-08-16T00:00:00Z"),
      });
      const repository = {
        findModelById: vi.fn().mockResolvedValue({ id: "m-1", isActive: true }),
        updateModel,
        countGrantsByModel: vi.fn().mockResolvedValue(new Map()),
        countEndpointRefsByModelCode: vi.fn().mockResolvedValue(new Map()),
      };
      const { ModelAdminService } = await import("./model-admin.service");
      const service = new ModelAdminService(repository as never);

      await service.setModelDeprecated("m-1", true).catch(() => undefined);

      const [, patch] = updateModel.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(patch).toHaveProperty("deprecatedAt");
      expect(patch).not.toHaveProperty("isActive");
    });
  });


  /**
   * The operator plane is where deprecation is PERFORMED, and until 2026-08-17
   * it was the one plane that could not read the result: `mapModel` reported
   * `toObjectState(isActive)`, which has only two values, so a deprecated model
   * was indistinguishable from a plain active one in the console list. The
   * signal existed on `GET /v1/models` for consumers and nowhere for the person
   * who set it - which is exactly why the console's `isActive -> state` work
   * sat blocked on "waiting for atlas to expose deprecated on the management
   * plane".
   *
   * 867 tests passed with that gap, because none of them read a model back
   * through the ADMIN mapper after deprecating it. These do.
   */
  describe("the management plane can read back what it just set", () => {
    const AT = new Date("2026-08-17T00:00:00.000Z");

    function serviceWith(row: Record<string, unknown>) {
      const repo = {
        findModelById: vi.fn().mockResolvedValue({ id: "m-1" }),
        updateModel: vi.fn().mockResolvedValue({
          id: "m-1",
          providerId: "p-1",
          modelCode: "glm-4",
          modelName: "GLM-4",
          provider: "zhipu",
          endpointUrl: "https://x/v1",
          protocol: "openai",
          modelType: "chat",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          capabilities: [],
          supportsStreaming: true,
          sort: 999,
          config: null,
          createdAt: AT,
          updatedAt: AT,
          ...row,
        }),
      };
      return new ModelAdminService(repo as never);
    }

    it("reports state deprecated after a deprecate action", async () => {
      const record = await serviceWith({
        isActive: true,
        deprecatedAt: AT,
      }).setModelDeprecated("m-1", true);

      expect(record.state).toBe("deprecated");
      expect(record.deprecatedAt).toBe("2026-08-17T00:00:00.000Z");
    });

    it("reports state active again after undeprecate", async () => {
      const record = await serviceWith({
        isActive: true,
        deprecatedAt: null,
      }).setModelDeprecated("m-1", false);

      expect(record.state).toBe("active");
      expect(record.deprecatedAt).toBeNull();
    });

    it("still reports inactive for a deactivated model, deprecated or not", async () => {
      // Same precedence the consumer plane uses. Two planes disagreeing about
      // one row is the shape this change exists to remove.
      const record = await serviceWith({
        isActive: false,
        deprecatedAt: AT,
      }).setModelDeprecated("m-1", true);

      expect(record.state).toBe("inactive");
    });
  });

  describe("the operator surface", () => {
    it("uses named POST actions, not a field on update", () => {
      // M-B3, and the audit reason from the state migration: `action` is
      // derived from the path, so a deprecation done through PATCH would be
      // filed as `update` and "who deprecated this" would be unanswerable.
      for (const handler of ["deprecateModel", "undeprecateModel"]) {
        const fn = (
          ModelAdminController.prototype as unknown as Record<string, unknown>
        )[handler];
        expect(Reflect.getMetadata(METHOD_METADATA, fn as object)).toBe(
          RequestMethod.POST,
        );
        expect(Reflect.getMetadata(PATH_METADATA, fn as object)).toMatch(
          /models\/:modelId\/(un)?deprecate$/,
        );
      }
    });

    it("is recognised by the audit trail as its own action", () => {
      // Without `deprecate` in ACTION_SEGMENTS this falls to
      // defaultAction("POST") and a retirement is recorded as `create` - the
      // opposite verb, and the named route buys nothing.
      const described = describeMutation({
        method: "POST",
        originalUrl: "/capability/models/m-1/deprecate",
      });

      expect(described).toMatchObject({
        objectType: "models",
        objectId: "m-1",
        action: "deprecate",
      });
    });
  });
});
