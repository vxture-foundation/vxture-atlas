import { Injectable } from "@nestjs/common";

import { prisma, type GatewayApiKeyRow } from "../prisma";

@Injectable()
export class GatewayApiKeyRepository {
  /**
   * Deleted rows are invisible here, not just absent from `list()`: every
   * mutation on this resource - activate, deactivate, rotate, revoke, delete -
   * resolves through this method, so an invisible-but-active credential cannot
   * exist. Keys authenticate nothing today (TD-034) - the moment they do, that
   * is the worst state this table can be in.
   */
  findById(id: string): Promise<GatewayApiKeyRow | null> {
    return prisma.gatewayApiKey.findFirst({ where: { id, deletedAt: null } });
  }

  list(): Promise<GatewayApiKeyRow[]> {
    return prisma.gatewayApiKey.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  create(data: {
    name: string;
    kind: string;
    owner: string | null;
    keyPrefix: string;
    keyHash: string;
    expiresAt?: Date | null;
    createdBy?: string | null;
  }): Promise<GatewayApiKeyRow> {
    return prisma.gatewayApiKey.create({ data });
  }

  update(
    id: string,
    data: Partial<{
      keyPrefix: string;
      keyHash: string;
      status: string;
      expiresAt: Date | null;
      deletedAt: Date | null;
      updatedBy: string | null;
    }>,
  ): Promise<GatewayApiKeyRow> {
    return prisma.gatewayApiKey.update({ where: { id, deletedAt: null }, data });
  }
}
