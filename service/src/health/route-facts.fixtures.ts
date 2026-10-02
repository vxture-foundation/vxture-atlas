import { vi } from "vitest";

import { prisma } from "../prisma";

/**
 * Mocks the two reads `PrismaHealthStore.listRoutes` makes for a route's
 * model facts: every requested model exists, is active, is a chat model and
 * has an active key - unless named in `overrides`.
 */
export function mockRouteModelFacts(
  overrides: Record<string, { modelType?: string; isActive?: boolean; keyed?: boolean }> = {},
): void {
  vi.spyOn(prisma.modelDefinition, "findMany").mockImplementation((async (args: {
    where?: { modelCode?: { in?: string[] } };
  }) =>
    (args.where?.modelCode?.in ?? []).map((modelCode) => {
      const o = overrides[modelCode] ?? {};
      return {
        modelCode,
        modelType: o.modelType ?? "chat",
        isActive: o.isActive ?? true,
        config: o.keyed === false ? null : { managedKeyAlias: "primary" },
        providerRef: { providerCode: "vendor", isActive: true },
      };
    })) as never);
  vi.spyOn(prisma.providerApiKey, "findMany").mockResolvedValue([
    { providerCode: "vendor", keyAlias: "primary" },
  ] as never);
}
