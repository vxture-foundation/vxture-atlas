/**
 * service-health-s2s.controller.spec.ts - real HTTP health-read admission.
 * @package @atlas/service
 * @layer Domain
 * @category test
 * @author AI-Generated
 * @date 2026-10-19
 */
import "reflect-metadata";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ServiceHealthS2sController } from "./service-health-s2s.controller";
import {
  ServiceHealthService,
  type ServiceHealthView,
} from "./service-health.service";

// ============================================================================
// Isolated HTTP service and signing authority
// ============================================================================

const ISSUER = "https://synthetic-accounts.example";
const KID = "health-http-test";
const snapshot: ServiceHealthView = {
  generatedAt: "2026-10-19T00:00:00.000Z",
  models: [],
  routes: [],
  vendors: [],
  atlas: [],
};
const current = vi.fn(async () => snapshot);

@Module({
  controllers: [ServiceHealthS2sController],
  providers: [{ provide: ServiceHealthService, useValue: { current } }],
})
class HealthHttpTestModule {}

describe("GET /s2s/health", () => {
  let app: INestApplication | undefined;
  let keyServer: Server | undefined;
  let privateKey: CryptoKey;
  let base: string;
  let keyBase: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicKey = await exportJWK(pair.publicKey);
    keyServer = createServer((req, res) => {
      if (req.url !== "/oidc/jwks") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          keys: [{ ...publicKey, kid: KID, alg: "RS256", use: "sig" }],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      keyServer!.listen(0, "127.0.0.1", resolve),
    );
    keyBase = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}`;
    app = await NestFactory.create(HealthHttpTestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OIDC_ISSUER", ISSUER);
    vi.stubEnv("OIDC_BACKCHANNEL_ISSUER", keyBase);
    vi.stubEnv("S2S_AUDIENCE", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    if (keyServer)
      await new Promise<void>((resolve, reject) =>
        keyServer!.close((err) => (err ? reject(err) : resolve())),
      );
  });

  function sign(claims: Record<string, unknown> = {}, audience = "atlas") {
    return new SignJWT({
      act: { sub: "opera" },
      scope: "health:atlas",
      mode: "service",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  function request(token?: string, query = "") {
    return fetch(`${base}/s2s/health${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  // ============================================================================
  // Admission, claim isolation and controller delegation
  // ============================================================================

  it("reads the existing snapshot after remote JWKS verification", async () => {
    const response = await request(await sign());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(current).toHaveBeenCalledExactlyOnceWith();
  });

  it("requires bearer authentication before invoking the service", async () => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "HEALTH_TOKEN_MISSING",
      retryable: false,
    });
    expect(current).not.toHaveBeenCalled();
  });

  it.each([
    [{ scope: "tool:atlas" }, "HEALTH_TOKEN_WRONG_SCOPE"],
    [{ scope: "mgmt:atlas", mode: "operator" }, "HEALTH_TOKEN_WRONG_SCOPE"],
    [{ mode: "obo" }, "HEALTH_TOKEN_INVALID_MODE"],
    [{ act: { sub: "" } }, "HEALTH_TOKEN_MISSING_ACT"],
  ])("rejects credentials for another surface: %j", async (claims, code) => {
    const response = await request(await sign(claims));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code, retryable: false });
    expect(current).not.toHaveBeenCalled();
  });

  it("rejects another audience before reaching the snapshot", async () => {
    const response = await request(await sign({}, "runos"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "HEALTH_TOKEN_INVALID",
    });
    expect(current).not.toHaveBeenCalled();
  });

  it("fails closed without issuer configuration", async () => {
    vi.stubEnv("OIDC_ISSUER", "");
    const response = await request(await sign());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "AUTH_ISSUER_NOT_CONFIGURED",
    });
    expect(current).not.toHaveBeenCalled();
  });

  it("derives both audience and scope from configured S2S_AUDIENCE", async () => {
    vi.stubEnv("S2S_AUDIENCE", "atlas-beta");
    const token = await sign({ scope: "health:atlas-beta" }, "atlas-beta");
    const response = await request(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(current).toHaveBeenCalledOnce();
  });

  it.each(["?workspace_id=other", "?scope=health:atlas", "?limit=1"])(
    "refuses unsupported filters %s",
    async (query) => {
      const response = await request(await sign(), query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "HEALTH_UNKNOWN_FILTER",
        retryable: false,
      });
      expect(current).not.toHaveBeenCalled();
    },
  );
});
