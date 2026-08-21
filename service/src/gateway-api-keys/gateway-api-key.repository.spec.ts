/**
 * gateway-api-key.repository.spec.ts - soft-delete visibility
 * @package @atlas/service
 * @layer Domain
 * @category test
 *
 * @description
 *   Asserts the `where` clause itself rather than a returned value.
 *
 *   That is deliberate. The behaviour under test lives entirely in the query:
 *   whether a soft-deleted row is reachable is decided by one property in the
 *   filter, and there is no database in CI to observe the effect through. A
 *   test that mocked the repository and checked "returns null for a deleted
 *   key" would pass whether or not the filter exists, because the mock would
 *   be the thing deciding. Pinning the query is the only assertion here that
 *   can actually fail when the filter is removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    gatewayApiKey: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

const { GatewayApiKeyRepository } = await import("./gateway-api-key.repository");

describe("GatewayApiKeyRepository soft-delete visibility", () => {
  let repository: InstanceType<typeof GatewayApiKeyRepository>;

  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue(null);
    findMany.mockReset().mockResolvedValue([]);
    repository = new GatewayApiKeyRepository();
  });

  it("excludes deleted rows when resolving a single key by id", async () => {
    await repository.findById("key_1");

    // Every mutation - activate / deactivate / rotate / revoke / delete -
    // resolves through findById, so this one filter is what stops a deleted
    // key from being flipped back to active while staying invisible.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "key_1", deletedAt: null },
    });
  });

  it("excludes deleted rows from the list", async () => {
    await repository.list();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });
});
