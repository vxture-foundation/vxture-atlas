import { Injectable } from "@nestjs/common";

import { prisma, type ProviderApiKeyRow } from "../prisma";

@Injectable()
export class ProviderKeyRepository {
  findByCodeAndAlias(
    providerCode: string,
    keyAlias: string,
  ): Promise<ProviderApiKeyRow | null> {
    return prisma.providerApiKey.findFirst({
      where: { providerCode, keyAlias, deletedAt: null },
    });
  }

  findById(id: string): Promise<ProviderApiKeyRow | null> {
    return prisma.providerApiKey.findFirst({ where: { id, deletedAt: null } });
  }

  list(providerCode?: string): Promise<ProviderApiKeyRow[]> {
    return prisma.providerApiKey.findMany({
      where: providerCode ? { providerCode, deletedAt: null } : { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  create(data: {
    providerCode: string;
    keyAlias: string;
    encryptedKey: Buffer;
    encryptionKeyId: string;
    keyScope: string;
  }): Promise<ProviderApiKeyRow> {
    return prisma.providerApiKey.create({ data });
  }

  update(
    id: string,
    data: Partial<{
      encryptedKey: Buffer;
      encryptionKeyId: string;
      isActive: boolean;
      lastRotatedAt: Date;
      deletedAt: Date;
    }>,
  ): Promise<ProviderApiKeyRow> {
    return prisma.providerApiKey.update({ where: { id }, data });
  }

  recordRotation(data: {
    providerApiKeyId: string;
    rotatedBy?: string | null;
    reason?: string | null;
  }): Promise<unknown> {
    return prisma.keyRotationLog.create({
      data: {
        providerApiKeyId: data.providerApiKeyId,
        rotatedBy: data.rotatedBy ?? null,
        reason: data.reason ?? null,
      },
    });
  }
}
