/**
 * Atomic current-policy and immutable revision persistence.
 * @package @atlas/service
 * @layer Domain
 * @category Repository
 * @author AI-Generated
 * @date 2026-11-18
 */
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { prisma, type AtlasPrismaClient } from "../prisma";
import type { Prisma } from "../generated/prisma";
import {
  validateRules,
  type GrantContribution,
  type PolicyResource,
  type GrantRule,
} from "./product-grant-policy";

export const PRODUCT_GRANT_POLICY_PRISMA = Symbol(
  "PRODUCT_GRANT_POLICY_PRISMA",
);

export interface PolicyDocument {
  productCode: string;
  revision: number;
  rules: GrantRule[];
  updatedBy: string | null;
  updatedAt: Date | null;
}
function staleRevision(): ConflictException {
  return new ConflictException({
    code: "GRANT_POLICY_REVISION_CONFLICT",
    message: "Policy changed; reload before saving",
    retryable: false,
  });
}

// Persistence ---------------------------------------------------------------
@Injectable()
export class ProductGrantPolicyRepository {
  constructor(
    @Optional()
    @Inject(PRODUCT_GRANT_POLICY_PRISMA)
    private readonly client: AtlasPrismaClient = prisma,
  ) {}

  async get(productCode: string): Promise<PolicyDocument> {
    const row = await this.client.productGrantPolicy.findFirst({
      where: { productCode },
    });
    return row
      ? { ...row, rules: validateRules(row.rules) }
      : {
          productCode,
          revision: 0,
          rules: [],
          updatedBy: null,
          updatedAt: null,
        };
  }

  async list(): Promise<PolicyDocument[]> {
    const rows = await this.client.productGrantPolicy.findMany();
    return rows.map((row) => ({ ...row, rules: validateRules(row.rules) }));
  }

  async loadResources(): Promise<PolicyResource[]> {
    const rows = await this.client.modelEndpoint.findMany({
      where: { deletedAt: null },
    });
    return rows.map((row) => ({
      id: row.code,
      category: row.category,
      tags: row.tags ?? [],
      eligible: row.isActive,
    }));
  }

  async loadManual(
    productCode: string,
  ): Promise<Map<string, GrantContribution[]>> {
    const rows = await this.client.productEndpointGrant.findMany({
      where: {
        productCode,
        applicationId: null,
        applicationType: null,
        isActive: true,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    return new Map(
      rows.map((row) => [
        row.endpointCode,
        [
          {
            source: `manual:${row.id}`,
            direct: true,
            riskScope: "read",
            criticalRequiresApproval: true,
          },
        ],
      ]),
    );
  }

  history(productCode: string) {
    return this.client.productGrantPolicyRevision.findMany({
      where: { productCode },
      orderBy: { revision: "desc" },
      take: 50,
    });
  }

  async save(
    productCode: string,
    expectedRevision: number,
    rules: GrantRule[],
    actorId: string,
  ): Promise<PolicyDocument> {
    const revision = expectedRevision + 1;
    const updatedAt = new Date();
    const data = {
      productCode,
      revision,
      rules: rules as unknown as Prisma.InputJsonValue,
      updatedBy: actorId,
      updatedAt,
    };
    try {
      await this.client.$transaction(async (tx) => {
        if (expectedRevision === 0) {
          await tx.productGrantPolicy.create({ data });
        } else {
          const changed = await tx.productGrantPolicy.updateMany({
            where: { productCode, revision: expectedRevision },
            data: {
              revision,
              rules: data.rules,
              updatedBy: actorId,
              updatedAt,
            },
          });
          if (changed.count !== 1) throw staleRevision();
        }
        await tx.productGrantPolicyRevision.create({ data });
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      )
        throw staleRevision();
      throw error;
    }
    return { productCode, revision, rules, updatedBy: actorId, updatedAt };
  }
}
