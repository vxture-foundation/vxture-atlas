/**
 * legacy-path.http.spec.ts - authenticated compatibility routes on the wire.
 * @package @atlas/service
 * @layer Domain
 * @category test
 * @author AI-Generated
 * @date 2026-10-21
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

import { CAPABILITY_PATH_SUNSET } from "../capability-route-names";
import { ModelRegistryService } from "../registry/model-registry.service";
import { TenancyController } from "../tenancy/tenancy.controller";
import { TenancyService } from "../tenancy/tenancy.service";
import { ModelAdminController } from "./model-admin.controller";
import { ModelAdminService } from "./model-admin.service";
import { ModelProbeService } from "./model-probe.service";
import { ModelRuntimeController } from "./runtime.controller";
import { ModelRuntimeService } from "./runtime.service";
import { metricsRegistry } from "./metrics.registry";

// ============================================================================
// Real controllers, guards and interceptors; isolated persistence and issuer
// ============================================================================

const ISSUER = "https://migration-test.example";
const rows = [{ id: "compatibility-fixture" }];
const createEndpoint = vi.fn(async () => ({ id: "created-fixture" }));
const list = vi.fn(async () => rows);
const pairs = [
  [
    "/capability/endpoints",
    "/capability/model-routes",
    "operator",
    "@1787279434",
  ],
  [
    "/capability/grants",
    "/capability/tenant-model-grants",
    "operator",
    "@1787279434",
  ],
  [
    "/capability/product-grants",
    "/capability/product-endpoint-grants",
    "operator",
    "@1787279434",
  ],
  ["/v1/endpoints", "/v1/model-routes", "service", "@1787985435"],
  ["/tenancy/grants", "/tenancy/tenant-model-grants", "service", "@1787985435"],
] as const;

@Module({
  controllers: [
    ModelAdminController,
    ModelRuntimeController,
    TenancyController,
  ],
  providers: [
    {
      provide: ModelAdminService,
      useValue: {
        listEndpoints: list,
        listGrants: list,
        listProductGrants: list,
        createEndpoint,
      },
    },
    { provide: ModelProbeService, useValue: {} },
    { provide: ModelRuntimeService, useValue: {} },
    { provide: ModelRegistryService, useValue: { listGrantedEndpoints: list } },
    { provide: TenancyService, useValue: { listGrants: list } },
  ],
})
class CompatibilityHttpModule {}

describe("compatibility paths over authenticated HTTP", () => {
  let app: INestApplication | undefined;
  let keys: Server | undefined;
  let privateKey: CryptoKey;
  let base: string;
  let inc: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    keys = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "migration-test", alg: "RS256", use: "sig" }],
        }),
      );
    });
    await new Promise<void>((resolve) => keys!.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("OIDC_ISSUER", ISSUER);
    vi.stubEnv(
      "OIDC_BACKCHANNEL_ISSUER",
      `http://127.0.0.1:${(keys.address() as AddressInfo).port}`,
    );
    vi.stubEnv("S2S_AUDIENCE", "atlas");
    app = await NestFactory.create(CompatibilityHttpModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    inc = vi.spyOn(metricsRegistry, "incCounter").mockImplementation(() => {});
  }, 30_000);

  beforeEach(() => vi.clearAllMocks());

  afterAll(async () => {
    await app?.close();
    if (keys)
      await new Promise<void>((resolve, reject) =>
        keys!.close((err) => (err ? reject(err) : resolve())),
      );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function token(mode: "operator" | "service") {
    return new SignJWT(
      mode === "operator"
        ? {
            act: { sub: "opera" },
            mode,
            scope: "mgmt:atlas",
            realm: "workforce",
            userType: "operator",
            sub: "opr_11111111-1111-4111-8111-111111111111",
          }
        : {
            act: { sub: "karda" },
            mode,
            scope: "tool:atlas",
            workspace_id: "synthetic-workspace",
            org_id: "synthetic-tenant",
          },
    )
      .setProtectedHeader({ alg: "RS256", kid: "migration-test" })
      .setIssuer(ISSUER)
      .setAudience("atlas")
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  // ============================================================================
  // Compatibility, signal format and attribution
  // ============================================================================

  it.each(pairs)(
    "serves %s and its canonical route with the same body",
    async (legacy, canonical, mode, date) => {
      const headers = { authorization: `Bearer ${await token(mode)}` };
      const oldResponse = await fetch(`${base}${legacy}`, { headers });
      const newResponse = await fetch(`${base}${canonical}`, { headers });
      expect(oldResponse.status).toBe(200);
      expect(newResponse.status).toBe(200);
      expect(await oldResponse.json()).toEqual(await newResponse.json());
      expect(oldResponse.headers.get("deprecation")).toBe(date);
      const sunset = oldResponse.headers.get("sunset");
      expect(sunset).toMatch(
        /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
      );
      expect(Date.parse(sunset!)).toBeGreaterThanOrEqual(
        Number(date.slice(1)) * 1000,
      );
      expect(oldResponse.headers.get("link")).toBe(
        `<${canonical}>; rel="successor-version"`,
      );
      expect(oldResponse.redirected).toBe(false);
      for (const name of ["deprecation", "sunset", "link"]) {
        expect(newResponse.headers.get(name)).toBeNull();
      }
      expect(inc).toHaveBeenCalledExactlyOnceWith(
        mode === "operator"
          ? "capability_legacy_path_requests_total"
          : "data_plane_legacy_path_requests_total",
        mode === "operator"
          ? {
              path: legacy.split("/").at(-1),
              operator: "opr_11111111-1111-4111-8111-111111111111",
            }
          : { path: legacy.slice(1), product: "karda" },
      );
    },
  );

  it("keeps the operator alias after its advertised Sunset without redirecting a write", async () => {
    expect(Date.now()).toBeGreaterThan(Date.parse(CAPABILITY_PATH_SUNSET));
    const response = await fetch(`${base}/capability/endpoints`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token("operator")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ endpointCode: "synthetic" }),
    });
    expect(response.status).toBe(201);
    expect(response.redirected).toBe(false);
    expect(await response.json()).toEqual({ id: "created-fixture" });
    expect(createEndpoint).toHaveBeenCalledExactlyOnceWith({
      endpointCode: "synthetic",
    });
    expect(response.headers.get("deprecation")).toBe("@1787279434");
  });

  // ============================================================================
  // Authentication remains ahead of the compatibility signals and handlers
  // ============================================================================

  it("does not treat unauthenticated probes as route acceptance evidence", async () => {
    for (const [legacy, canonical] of pairs) {
      for (const path of [legacy, canonical]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(401);
        expect(response.headers.get("deprecation")).toBeNull();
      }
    }
    expect(list).not.toHaveBeenCalled();
    expect(inc).not.toHaveBeenCalled();
  });

  it.each(pairs)(
    "rejects the other plane's credential on %s",
    async (legacy, _canonical, mode) => {
      const response = await fetch(`${base}${legacy}`, {
        headers: {
          authorization: `Bearer ${await token(mode === "operator" ? "service" : "operator")}`,
        },
      });
      expect(response.status).toBe(401);
      expect(list).not.toHaveBeenCalled();
      expect(inc).not.toHaveBeenCalled();
    },
  );
});
