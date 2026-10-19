/**
 * jwt-shared.spec.ts - backchannel/issuer split for the JWKS fetch.
 *
 * Docker Desktop repro (see .env / .env.example): this app runs
 * containerized while the local IdP is a host process, so `OIDC_ISSUER`
 * (must equal the token's `iss`, e.g. http://localhost:3081) is not
 * reachable as a network path from inside the container. Without this
 * split, `resolveRemoteJwks` fetched JWKS from the unreachable issuer
 * origin and every verification failed closed with a generic
 * OPERATOR_TOKEN_INVALID/S2S_TOKEN_INVALID, masking the real cause.
 * @package @atlas/service
 * @layer Domain
 * @category test
 * @author AI-Generated
 * @date 2026-10-19
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractBearerToken,
  requireIssuer,
  resolveBackchannelBase,
  resolveRemoteJwks,
} from "./jwt-shared";

const ENV_KEY = "OIDC_BACKCHANNEL_ISSUER";

afterEach(() => vi.unstubAllEnvs());

// ============================================================================
// Request extraction and issuer configuration
// ============================================================================

describe("extractBearerToken", () => {
  it.each([
    [{ authorization: "Bearer token-1" }, "token-1"],
    [{ Authorization: "  bEaReR token-2  " }, "token-2"],
    [{ authorization: ["Bearer first", "Bearer second"] }, "first"],
    [
      { authorization: "Bearer primary", Authorization: "Bearer fallback" },
      "primary",
    ],
    [{}, undefined],
    [{ authorization: [] }, undefined],
    [{ authorization: 42 }, undefined],
    [{ authorization: "Basic token" }, undefined],
    [{ authorization: "Bearer " }, undefined],
  ])("extracts only the supported bearer header: %j", (headers, expected) => {
    expect(extractBearerToken(headers)).toBe(expected);
  });
});

describe("requireIssuer", () => {
  it("uses the configured issuer without normalizing its identity", () => {
    vi.stubEnv("OIDC_ISSUER", "https://accounts.example/");
    expect(requireIssuer()).toBe("https://accounts.example/");
  });

  it("fails closed when the issuer is missing", () => {
    vi.stubEnv("OIDC_ISSUER", "");
    expect(requireIssuer).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "AUTH_ISSUER_NOT_CONFIGURED",
          retryable: false,
        }),
      }),
    );
  });
});

// ============================================================================
// Backchannel resolution and per-URI key cache
// ============================================================================

describe("resolveRemoteJwks", () => {
  it("reuses a resolver until the actual JWKS network address changes", () => {
    vi.stubEnv(ENV_KEY, "https://keys-a.example/");
    const first = resolveRemoteJwks("https://issuer.example");
    expect(resolveRemoteJwks("https://other-issuer.example")).toBe(first);
    vi.stubEnv(ENV_KEY, "https://keys-b.example");
    expect(resolveRemoteJwks("https://issuer.example")).not.toBe(first);
  });
});

describe("resolveBackchannelBase", () => {
  it("defaults to the issuer when no override is set", () => {
    vi.stubEnv(ENV_KEY, undefined);
    expect(resolveBackchannelBase("https://accounts.vxture.com")).toBe(
      "https://accounts.vxture.com",
    );
  });

  it("strips a trailing slash from the issuer default", () => {
    vi.stubEnv(ENV_KEY, undefined);
    expect(resolveBackchannelBase("https://accounts.vxture.com/")).toBe(
      "https://accounts.vxture.com",
    );
  });

  it("prefers OIDC_BACKCHANNEL_ISSUER when set, independent of the issuer used for iss matching", () => {
    vi.stubEnv(ENV_KEY, "http://host.docker.internal:3081");

    expect(resolveBackchannelBase("http://localhost:3081")).toBe(
      "http://host.docker.internal:3081",
    );
  });

  it("strips a trailing slash from the override", () => {
    vi.stubEnv(ENV_KEY, "http://host.docker.internal:3081/");

    expect(resolveBackchannelBase("http://localhost:3081")).toBe(
      "http://host.docker.internal:3081",
    );
  });
});
