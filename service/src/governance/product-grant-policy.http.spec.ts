/**
 * Real HTTP transport with signed operator tokens and policy validation.
 * @package @atlas/service
 * @layer Domain
 * @category Test
 * @author AI-Generated
 * @date 2026-11-18
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Module,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  verifyOperatorToken,
  type OperatorAuthenticatedRequest,
} from "../runtime/guards/operator-auth.guard";
import { ProductGrantPolicyController } from "./product-grant-policy.controller";
import {
  ProductGrantPolicyRepository,
  type PolicyDocument,
} from "./product-grant-policy.repository";
import type { GrantRule } from "./product-grant-policy";

// Isolated HTTP stack ------------------------------------------------------
const issuer = "https://accounts.example.invalid";
const actor = `opr_${randomUUID()}`;
const keys = await generateKeyPair("RS256");
let stored: PolicyDocument = {
  productCode: "fixture",
  revision: 0,
  rules: [],
  updatedBy: null,
  updatedAt: null,
};
const repository = {
  get: async () => stored,
  history: async () => (stored.revision ? [stored] : []),
  loadResources: async () => [
    {
      id: "fixture.resource",
      category: "data",
      tags: ["safe"],
      eligible: true,
    },
  ],
  loadManual: async () => new Map(),
  save: async (
    productCode: string,
    revision: number,
    rules: GrantRule[],
    actorId: string,
  ) => {
    if (revision !== stored.revision)
      throw new ConflictException({
        code: "GRANT_POLICY_REVISION_CONFLICT",
        message: "Reload",
        retryable: false,
      });
    stored = {
      productCode,
      revision: revision + 1,
      rules,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    return stored;
  },
};
const originalGuards = Reflect.getMetadata(
  "__guards__",
  ProductGrantPolicyController,
);
class FixtureOperatorGuard {
  async canActivate(context: ExecutionContext) {
    const req = context
      .switchToHttp()
      .getRequest<OperatorAuthenticatedRequest>();
    const token = String(req.headers["authorization"] ?? "").replace(
      /^Bearer /,
      "",
    );
    req.operatorAuth = await verifyOperatorToken(token, {
      jwks: async () => keys.publicKey,
      issuer,
    });
    return true;
  }
}
Reflect.defineMetadata(
  "__guards__",
  [FixtureOperatorGuard],
  ProductGrantPolicyController,
);

@Module({
  controllers: [ProductGrantPolicyController],
  providers: [{ provide: ProductGrantPolicyRepository, useValue: repository }],
})
class HttpFixtureModule {}
let app: INestApplication;
let base: string;
let token: string;
beforeAll(async () => {
  token = await new SignJWT({
    realm: "workforce",
    userType: "operator",
    mode: "operator",
    scope: "mgmt:atlas",
    act: { sub: "opera" },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience("atlas")
    .setSubject(actor)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(randomUUID())
    .sign(keys.privateKey);
  app = await NestFactory.create(HttpFixtureModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  base = `${await app.getUrl()}/capability/product-grant-policies/fixture`;
});
afterAll(async () => {
  await app?.close();
  Reflect.defineMetadata(
    "__guards__",
    originalGuards,
    ProductGrantPolicyController,
  );
});
const request = (path: string, body?: unknown, authenticated = true) =>
  fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// Transport authorization and error contracts ------------------------------
describe("policy HTTP surface", () => {
  it("requires verified authentication on every route", async () => {
    for (const [path, body] of [
      ["", undefined],
      ["/history", undefined],
      ["/effective", undefined],
      ["/preview", {}],
      ["", {}],
    ] as const)
      expect((await request(path, body, false)).status).toBe(401);
  });
  it("rejects a request-supplied actor before persistence", async () => {
    expect(
      (await request("", { expectedRevision: 0, rules: [], actorId: "forged" }))
        .status,
    ).toBe(400);
    expect(stored.revision).toBe(0);
  });
  it("previews without writing and saves with verified attribution", async () => {
    const body = {
      expectedRevision: 0,
      rules: [
        {
          id: "all",
          name: "All",
          enabled: true,
          effect: "allow",
          selector: {
            mode: "all",
            values: [],
            tagMatch: "any",
            excludedIds: [],
          },
          riskScope: "read",
          criticalRequiresApproval: true,
        },
      ],
    };
    const preview = await request("/preview", body);
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { matched: number }).matched).toBe(1);
    expect(stored.revision).toBe(0);
    const saved = await request("", body);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { updatedBy: string }).updatedBy).toBe(actor);
    expect((await request("", body)).status).toBe(409);
    expect(((await (await request("/effective")).json()) as { matched: number }).matched).toBe(1);
    expect(((await (await request("/history")).json()) as unknown[]).length).toBe(1);
  });
});
