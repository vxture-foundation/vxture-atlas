import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawUnsafe = vi.fn().mockResolvedValue([]);

vi.mock("../prisma", () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafe(...args),
  },
}));

const { ModelRegistryRepository } = await import("./model-registry.repository");

/**
 * `summarizeRequestCost` is the one part of the cost path a unit test cannot
 * actually execute: the answer comes from Postgres, and Prisma is mocked here.
 * That gap was closed a different way - the query was run against a throwaway
 * postgres:18 with the real DDL on 2026-08-26, and the rows it returned are
 * pinned in `cost-rollup.spec.ts`.
 *
 * What is left for this file is the half a live run does NOT protect, because
 * it would look identical either way: whether the filters are BOUND or
 * interpolated. A query built by pasting `modelCode` into the string returns
 * exactly the same rows for every input this repo will ever pass it, and stays
 * wrong until someone sends a value with a quote in it. The repository's own
 * header states the rule ("bound as parameters, never conditionally
 * interpolated"); these assertions are what makes it more than a sentence.
 */
describe("summarizeRequestCost query", () => {
  const from = new Date("2026-08-01T00:00:00Z");
  const to = new Date("2026-08-02T00:00:00Z");

  beforeEach(() => {
    queryRawUnsafe.mockClear();
  });

  async function run(params: Record<string, unknown> = {}) {
    const repo = new ModelRegistryRepository();
    await repo.summarizeRequestCost({ from, to, ...params } as never);
    const [sql, ...bound] = queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    return { sql, bound };
  }

  it("binds every filter as a parameter and never interpolates one", async () => {
    const { sql, bound } = await run({
      modelCode: "deepseek-v4-flash",
      providerCode: "deepseek",
    });

    expect(bound).toEqual([from, to, "deepseek-v4-flash", "deepseek"]);
    expect(sql).not.toContain("deepseek-v4-flash");
    expect(sql).toContain("$3::varchar IS NULL OR r.model_code = $3");
    expect(sql).toContain("$4::varchar IS NULL OR r.provider_code = $4");
  });

  it("binds null for an absent filter rather than rewriting the query", async () => {
    // The alternative - appending a WHERE clause only when a filter is present
    // - gives two query shapes to reason about and only one of them ever gets
    // read carefully.
    const { sql, bound } = await run();
    const { sql: filtered } = await run({ modelCode: "m" });

    expect(bound).toEqual([from, to, null, null]);
    expect(sql).toBe(filtered);
  });

  it("excludes probe traffic in a way that survives rows older than the column", async () => {
    // `<>` would drop rows written before `usage_type` existed, which are NULL.
    const { sql } = await run();
    expect(sql).toContain("usage_type IS DISTINCT FROM 'test'");
  });

  it("selects the rule by the window that contains the request, not by is_active", async () => {
    const { sql } = await run();

    // Usage-record batch 3: WHEN a call ran is started_at; created_at only for
    // rows written before incr/05.
    expect(sql).toContain("pr.effective_at <= coalesce(r.started_at, r.created_at)");
    expect(sql).toContain(
      "pr.expires_at IS NULL OR pr.expires_at > coalesce(r.started_at, r.created_at)",
    );
    expect(sql).toContain("pr.deleted_at IS NULL");
    // A present-tense switch must not decide what last month cost.
    expect(sql).not.toContain("pr.is_active");
  });

  it("keeps unpriced traffic instead of inner-joining it away", async () => {
    // An INNER JOIN here would silently drop every request for a model nobody
    // has priced, and the total would look complete.
    const { sql } = await run();
    expect(sql).toContain("LEFT JOIN model.models");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).not.toMatch(/\bINNER JOIN\b/u);
  });

  it("returns money as text so it cannot arrive as a float", async () => {
    const { sql } = await run();
    for (const column of [
      "input_unit_price",
      "output_unit_price",
      "request_unit_price",
      "cached_input_unit_price",
    ]) {
      expect(sql).toContain(`p.${column}::text`);
    }
  });

  it("buckets by UTC hour-of-week and leaves the window definition out of SQL", async () => {
    const { sql } = await run();

    // The bucket is in SQL because only SQL can derive it from the row's time -
    // started_at since incr/05, created_at for older rows.
    expect(sql).toContain(
      "EXTRACT(isodow FROM coalesce(r.started_at, r.created_at) AT TIME ZONE 'UTC')",
    );
    expect(sql).toContain(
      "EXTRACT(hour   FROM coalesce(r.started_at, r.created_at) AT TIME ZONE 'UTC')",
    );
    expect(sql).toContain("(pv.config -> 'pricing')::text");

    // The RULE is not: which hours count as peak is provider configuration.
    // A window hard-coded here would mean every provider shares one schedule
    // and changing it means editing a query string.
    //
    // Comments are stripped first, deliberately. The claim being made is about
    // EXECUTABLE sql - a comment explaining why the bucket exists is wanted,
    // and an assertion that forbids the word outright fails on its own
    // documentation, which is how a good check gets weakened into a bad one.
    const executable = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/u, ""))
      .join("\n");

    expect(executable).not.toMatch(/peak/iu);
    expect(executable).not.toMatch(/CASE\s+WHEN/iu);
    // No comparison of the bucket against an hour literal - that would be
    // the window, inlined.
    expect(executable).not.toMatch(
      /EXTRACT\(hour[^)]*\)[^,]*(BETWEEN|IN\s*\(|[<>=])/iu,
    );
  });

  it("joins the provider on the code the row recorded", async () => {
    // Not through the model: a model repointed later must not re-price traffic
    // an older provider actually served. LEFT so a deleted provider does not
    // remove its traffic from the total.
    const { sql } = await run();
    expect(sql).toContain("LEFT JOIN model.model_providers pv");
    expect(sql).toContain("pv.provider_code = r.provider_code");
  });
});
