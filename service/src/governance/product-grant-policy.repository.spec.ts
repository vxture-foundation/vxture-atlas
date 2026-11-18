/**
 * Policy storage contracts independent of optional PostgreSQL fixtures.
 * @package @atlas/service
 * @layer Domain
 * @category Test
 * @author AI-Generated
 * @date 2026-11-18
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductGrantPolicyRepository } from "./product-grant-policy.repository";
import type { AtlasPrismaClient } from "../prisma";

// Isolated transactional adapter ---------------------------------------------
const current = { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
const history = { findMany: vi.fn(), create: vi.fn() };
const endpoints = { findMany: vi.fn() };
const grants = { findMany: vi.fn() };
const transaction = vi.fn(async (operation: (tx: unknown) => Promise<void>) => operation({ productGrantPolicy: current, productGrantPolicyRevision: history }));
const repo = new ProductGrantPolicyRepository({ productGrantPolicy: current, productGrantPolicyRevision: history, modelEndpoint: endpoints, productEndpointGrant: grants, $transaction: transaction } as unknown as AtlasPrismaClient);
beforeEach(() => {
  vi.clearAllMocks();
  current.findFirst.mockResolvedValue(null);
  current.findMany.mockResolvedValue([]);
  current.create.mockReset();
  current.updateMany.mockResolvedValue({ count: 1 });
  history.create.mockReset();
});

// Query scope and failure semantics ------------------------------------------
describe("policy persistence contracts", () => {
  it("returns an explicit unconfigured policy and validates persisted rules", async () => {
    expect(await repo.get("fixture")).toEqual({ productCode: "fixture", revision: 0, rules: [], updatedBy: null, updatedAt: null });
    current.findFirst.mockResolvedValue({ revision: 2, rules: [] });
    expect((await repo.get("fixture")).revision).toBe(2);
    current.findFirst.mockResolvedValue({ rules: null });
    await expect(repo.get("fixture")).rejects.toThrow();
    current.findMany.mockResolvedValue([{ productCode: "fixture", rules: [] }]);
    expect(await repo.list()).toEqual([{ productCode: "fixture", rules: [] }]);
    current.findMany.mockResolvedValue([{ rules: null }]);
    await expect(repo.list()).rejects.toThrow();
  });
  it("retains inactive resource identity and handles legacy absent tags", async () => {
    endpoints.findMany.mockResolvedValue([{ code: "a", category: "data", tags: ["safe"], isActive: true }, { code: "b", category: "crm", tags: null, isActive: false }]);
    expect(await repo.loadResources()).toEqual([{ id: "a", category: "data", tags: ["safe"], eligible: true }, { id: "b", category: "crm", tags: [], eligible: false }]);
    expect(endpoints.findMany).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });
  it("scopes manual grants to live product-wide unexpired records", async () => {
    grants.findMany.mockResolvedValue([{ id: "grant_a", endpointCode: "a" }]);
    expect((await repo.loadManual("fixture")).get("a")).toEqual([{ source: "manual:grant_a", direct: true, riskScope: "read", criticalRequiresApproval: true }]);
    expect(grants.findMany).toHaveBeenCalledWith({ where: { productCode: "fixture", applicationId: null, applicationType: null, isActive: true, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] } });
    history.findMany.mockResolvedValue([{ revision: 2 }]);
    expect(await repo.history("fixture")).toEqual([{ revision: 2 }]);
    expect(history.findMany).toHaveBeenCalledWith({ where: { productCode: "fixture" }, orderBy: { revision: "desc" }, take: 50 });
  });
  it("creates state and immutable history together using the verified actor", async () => {
    const saved = await repo.save("fixture", 0, [], "opr_a");
    expect(saved).toMatchObject({ productCode: "fixture", revision: 1, updatedBy: "opr_a" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(current.create).toHaveBeenCalledWith({ data: saved });
    expect(history.create).toHaveBeenCalledWith({ data: saved });
    expect(current.updateMany).not.toHaveBeenCalled();
  });
  it("uses compare-and-swap without changing product identity", async () => {
    const saved = await repo.save("fixture", 4, [], "opr_b");
    expect(current.updateMany).toHaveBeenCalledWith({ where: { productCode: "fixture", revision: 4 }, data: { revision: 5, rules: [], updatedBy: "opr_b", updatedAt: saved.updatedAt } });
    expect(history.create).toHaveBeenCalledWith({ data: saved });
    current.updateMany.mockResolvedValueOnce({ count: 0 });
    history.create.mockClear();
    await expect(repo.save("fixture", 4, [], "opr_b")).rejects.toMatchObject({ status: 409 });
    expect(history.create).not.toHaveBeenCalled();
  });
  it("maps concurrent creation conflicts to 409 and propagates storage failures", async () => {
    current.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(repo.save("fixture", 0, [], "opr_b")).rejects.toMatchObject({ status: 409 });
    const unavailable = new Error("database unavailable");
    current.create.mockRejectedValueOnce(unavailable);
    await expect(repo.save("fixture", 0, [], "opr_b")).rejects.toBe(unavailable);
    history.create.mockRejectedValueOnce(unavailable);
    await expect(repo.save("fixture", 1, [], "opr_b")).rejects.toBe(unavailable);
  });
});
