import { beforeEach, describe, expect, it, vi } from "vitest";

// TD-058: every registry write stamps updated_at. No database in CI, so every
// update / updateMany is captured and its `data` inspected.
const writes: { table: string; op: string; data: Record<string, unknown> }[] = [];

function table(name: string, extra: Record<string, unknown> = {}) {
  const capture = (op: string) => async (args: { data: Record<string, unknown> }) => {
    writes.push({ table: name, op, data: args.data });
    return { id: "row-1", providerRef: null, ...args.data };
  };
  return { update: capture("update"), updateMany: capture("updateMany"), ...extra };
}

vi.mock("../prisma", () => {
  const tables = {
    modelProvider: table("model_providers"),
    modelDefinition: table("models", { findMany: async () => [{ id: "m-1" }] }),
    modelEndpoint: table("model_endpoints"),
    modelGrant: table("model_grants"),
    productEndpointGrant: table("product_endpoint_grants"),
    modelPriceRule: table("model_price_rules"),
    modelPolicy: table("model_policies"),
  };
  return {
    prisma: {
      ...tables,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tables),
    },
  };
});

const { ModelRegistryRepository } = await import("./model-registry.repository");
const repo = new ModelRegistryRepository();

beforeEach(() => {
  writes.length = 0;
});

const PATHS: [string, () => Promise<unknown>][] = [
  ["updateProvider", () => repo.updateProvider("p", { providerName: "x" })],
  ["restoreProvider", () => repo.restoreProvider("p", { providerName: "x" })],
  ["deleteProvider (and its models and grants)", () => repo.deleteProvider("p")],
  ["updateEndpoint", () => repo.updateEndpoint("e", { fallbackModelCode: null })],
  ["restoreEndpoint", () => repo.restoreEndpoint("e", {})],
  ["deleteEndpoint", () => repo.deleteEndpoint("e")],
  ["updateModel", () => repo.updateModel("m", { modelName: "x" })],
  ["deleteModel (and its grants)", () => repo.deleteModel("m")],
  ["updateGrant", () => repo.updateGrant("g", { isActive: false })],
  ["deleteGrant", () => repo.deleteGrant("g")],
  ["updateProductGrant", () => repo.updateProductGrant("g", { isActive: false })],
  ["deleteProductGrant", () => repo.deleteProductGrant("g")],
  ["updatePriceRule", () => repo.updatePriceRule("r", { isActive: false })],
  ["deletePriceRule", () => repo.deletePriceRule("r")],
  ["updatePolicy", () => repo.updatePolicy("r", { isActive: false })],
  ["deletePolicy", () => repo.deletePolicy("r")],
];

describe("every registry write stamps updated_at (TD-058)", () => {
  it.each(PATHS)("%s", async (_name, run) => {
    const before = Date.now();
    await run();

    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.data["updatedAt"], `${w.table} ${w.op}`).toBeInstanceOf(Date);
      expect((w.data["updatedAt"] as Date).getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("a soft delete stamps one instant for deleted_at and updated_at", async () => {
    await repo.deleteProvider("p");
    for (const w of writes) {
      expect(w.data["updatedAt"]).toEqual(w.data["deletedAt"]);
    }
  });
});
