/**
 * Disposable PostgreSQL checks for atomic policy state and column grants.
 * @package @atlas/service
 * @layer Domain
 * @category Test
 * @author AI-Generated
 * @date 2026-11-18
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/prisma";
import { ProductGrantPolicyRepository } from "./product-grant-policy.repository";
import { evaluatePolicy, type GrantRule } from "./product-grant-policy";
import type { AtlasPrismaClient } from "../prisma";

const url = process.env["ATLAS_POLICY_TEST_DATABASE_URL"];
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/atlas_policy_qa")
)
  throw new Error(
    "Only the explicit disposable local policy database is allowed",
  );
const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url ?? "" }),
});
const runtimeUrl = url ? new URL(url) : null;
if (runtimeUrl) runtimeUrl.username = "atlas_svc";
const runtime = new PrismaClient({
  adapter: new PrismaPg({ connectionString: runtimeUrl?.toString() ?? "" }),
});
const repo = new ProductGrantPolicyRepository(
  runtime as unknown as AtlasPrismaClient,
);
const code = `qa_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
afterAll(async () => {
  await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
});

// Transactions and runtime privileges --------------------------------------
describe.skipIf(!url)("real policy persistence", () => {
  it("replays historical health DDL without rejecting later production states", async () => {
    await admin.$executeRawUnsafe("INSERT INTO health.subject_states (subject_kind,subject_key,state,since) VALUES ('atlas','qa-replay','failing',now()) ON CONFLICT (subject_kind,subject_key) DO UPDATE SET state='failing'");
    await admin.$executeRawUnsafe("INSERT INTO health.events (subject_kind,subject_key,from_state,to_state,severity) VALUES ('atlas','qa-replay','ok','at_risk','warning')");
    const sql = readFileSync(new URL("../../../deploy/database/ddl/incr/10_health_balance.sql", import.meta.url), "utf8");
    const statements = sql.replace(/--[^\n]*/g, "").split(";").map((part) => part.trim()).filter((part) => part && part !== "BEGIN" && part !== "COMMIT");
    for (let pass = 0; pass < 2; pass += 1) {
      await admin.$transaction(async (tx) => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
      });
    }
    expect(await admin.$queryRawUnsafe("SELECT subject_kind,state FROM health.subject_states WHERE subject_key='qa-replay'")).toEqual([{ subject_kind: "atlas", state: "failing" }]);
    await expect(admin.$executeRawUnsafe("INSERT INTO health.subject_states (subject_kind,subject_key,state,since) VALUES ('invalid','qa-reject','ok',now())")).rejects.toThrow();
  });

  it("allows exactly one concurrent creation and keeps one audit revision", async () => {
    const results = await Promise.allSettled([
      repo.save(code, 0, [], "opr_a"),
      repo.save(code, 0, [], "opr_b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    expect((await repo.get(code)).revision).toBe(1);
    expect(await repo.history(code)).toHaveLength(1);
  });
  it("allows exactly one concurrent update", async () => {
    const results = await Promise.allSettled([
      repo.save(code, 1, [], "opr_c"),
      repo.save(code, 1, [], "opr_d"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await repo.get(code)).revision).toBe(2);
    expect(await repo.history(code)).toHaveLength(2);
  });
  it("rolls back the current policy when its history cannot be written", async () => {
    await admin.$executeRawUnsafe(
      "REVOKE INSERT ON model.product_grant_policy_revision FROM atlas_svc",
    );
    try {
      await expect(repo.save(code, 2, [], "opr_fail")).rejects.toThrow();
      expect((await repo.get(code)).revision).toBe(2);
      expect(await repo.history(code)).toHaveLength(2);
    } finally {
      await admin.$executeRawUnsafe(
        "GRANT INSERT ON model.product_grant_policy_revision TO atlas_svc",
      );
    }
  });
  it("does not permit erasing or modifying history or changing policy identity", async () => {
    await expect(
      runtime.$executeRawUnsafe(
        "DELETE FROM model.product_grant_policy_revision",
      ),
    ).rejects.toThrow();
    await expect(
      runtime.$executeRawUnsafe(
        "UPDATE model.product_grant_policy_revision SET updated_by = 'tampered'",
      ),
    ).rejects.toThrow();
    await expect(
      runtime.$executeRawUnsafe(
        "UPDATE model.product_grant_policy SET product_code = 'tampered'",
      ),
    ).rejects.toThrow();
    await expect(
      runtime.$executeRawUnsafe("DELETE FROM model.product_grant_policy"),
    ).rejects.toThrow();
  });

  it("matches future resources from the real catalog and keeps manual provenance under deny precedence", async () => {
    const prefix = `${code}.`;
    const allow: GrantRule = {
      id: "category",
      name: "Data",
      enabled: true,
      effect: "allow",
      selector: {
        mode: "categories",
        values: ["data"],
        tagMatch: "any",
        excludedIds: [],
      },
      riskScope: "read",
      criticalRequiresApproval: true,
    };
    async function addResource(id: string, active: boolean) {
      await admin.modelEndpoint.create({
        data: {
          code: id,
          category: "data",
          tags: ["research"],
          primaryModelCode: "qa-model",
          isActive: active,
        },
      });
    }
    await addResource(`${prefix}anchor`, true);
    await addResource(`${prefix}draft`, false);
    const initial = await repo.loadResources();
    expect(
      evaluatePolicy([allow], initial).get(`${prefix}anchor`)?.contributions,
    ).toHaveLength(1);
    expect(
      evaluatePolicy([allow], initial).get(`${prefix}draft`)?.contributions,
    ).toEqual([]);
    await addResource(`${prefix}future`, true);
    await admin.productEndpointGrant.create({
      data: {
        productCode: code,
        endpointCode: `${prefix}future`,
        isActive: true,
      },
    });
    await admin.productEndpointGrant.create({
      data: {
        productCode: code,
        endpointCode: `${prefix}anchor`,
        expiresAt: new Date(0),
        isActive: true,
      },
    });
    expect((await repo.loadManual(code)).has(`${prefix}anchor`)).toBe(false);
    const catalog = await repo.loadResources();
    const manual = await repo.loadManual(code);
    const future = evaluatePolicy([allow], catalog, manual).get(
      `${prefix}future`,
    )!;
    expect(future.contributions.map((row) => row.source)).toEqual(
      expect.arrayContaining([
        "rule:category",
        expect.stringMatching(/^manual:/),
      ]),
    );
    const deny: GrantRule = {
      ...allow,
      id: "deny",
      effect: "deny",
      selector: {
        mode: "resources",
        values: [`${prefix}future`],
        tagMatch: "any",
        excludedIds: [],
      },
    };
    expect(
      evaluatePolicy([allow, deny], catalog, manual).get(`${prefix}future`)
        ?.contributions,
    ).toEqual([]);
    expect(
      evaluatePolicy([], catalog, manual).get(`${prefix}future`)?.contributions,
    ).toHaveLength(1);
  });
});
