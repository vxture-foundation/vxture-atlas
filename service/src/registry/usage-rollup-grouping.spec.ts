/**
 * usage-rollup-grouping.spec.ts - the tenant rollup carries the product
 * @package @atlas/service
 * @layer Domain
 * @category test
 *
 * @description
 *   Asserts the SQL, because that is where the behaviour lives and there is
 *   no database in CI. A test that mocked the repository and checked
 *   "productCode comes back" would pass with or without the GROUP BY, since
 *   the mock would be the thing deciding what comes back.
 *
 *   WHAT THIS PROTECTS. A billing row has to answer three questions at once -
 *   which customer, which workspace, which product. Those three arrive from
 *   different places and only two of them are trustworthy: `workspace_id` and
 *   `product_code` come from the verified token, while `tenant_id` may fall
 *   back to the request body. Dropping `product_code` from this grouping does
 *   not break anything loudly; it silently returns rows that look complete
 *   and cannot say who ran the traffic.
 *
 *   `application_id` is NOT a substitute and must not be treated as one: it
 *   names an instance inside a product, it is a bare uuid with no product
 *   attribution of its own, and a caller that sends none gets a sentinel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawUnsafe = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafe(...args),
  },
}));

const { ModelRegistryRepository } = await import("./model-registry.repository");

/** Collapses whitespace so assertions do not depend on SQL formatting. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("tenant usage rollup grouping", () => {
  let repository: InstanceType<typeof ModelRegistryRepository>;

  beforeEach(() => {
    queryRawUnsafe.mockReset().mockResolvedValue([]);
    repository = new ModelRegistryRepository();
  });

  it("groups by tenant, workspace AND product", async () => {
    await repository.listUsageSummaries({});

    const sql = flat(queryRawUnsafe.mock.calls[0]![0] as string);
    expect(sql).toContain(
      "GROUP BY tenant_id, workspace_id, product_code, date_trunc('month', created_at), application_id, application_type",
    );
  });

  it("selects the product alongside the other two identities", async () => {
    await repository.listUsageSummaries({});

    const sql = flat(queryRawUnsafe.mock.calls[0]![0] as string);
    expect(sql).toContain('product_code AS "productCode"');
    expect(sql).toContain('workspace_id::text AS "workspaceId"');
    expect(sql).toContain('tenant_id::text AS "tenantId"');
  });

  it("keeps the application breakdown rather than replacing it with product", async () => {
    // Product and application are different levels, not alternatives: one
    // product holds many agents and workflows. Collapsing to product would
    // lose "which agent", collapsing to application would lose "whose agent".
    const sql = flat(
      (await repository
        .listUsageSummaries({})
        .then(() => queryRawUnsafe.mock.calls[0]![0])) as string,
    );
    expect(sql).toContain("application_id");
    expect(sql).toContain("application_type");
  });
});
