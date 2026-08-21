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
 */
import { afterEach, describe, expect, it } from "vitest";

import { resolveBackchannelBase } from "./jwt-shared";

const ENV_KEY = "OIDC_BACKCHANNEL_ISSUER";

describe("resolveBackchannelBase", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("defaults to the issuer when no override is set", () => {
    expect(resolveBackchannelBase("https://accounts.vxture.com")).toBe(
      "https://accounts.vxture.com",
    );
  });

  it("strips a trailing slash from the issuer default", () => {
    expect(resolveBackchannelBase("https://accounts.vxture.com/")).toBe(
      "https://accounts.vxture.com",
    );
  });

  it("prefers OIDC_BACKCHANNEL_ISSUER when set, independent of the issuer used for iss matching", () => {
    process.env[ENV_KEY] = "http://host.docker.internal:3081";

    expect(resolveBackchannelBase("http://localhost:3081")).toBe(
      "http://host.docker.internal:3081",
    );
  });

  it("strips a trailing slash from the override", () => {
    process.env[ENV_KEY] = "http://host.docker.internal:3081/";

    expect(resolveBackchannelBase("http://localhost:3081")).toBe(
      "http://host.docker.internal:3081",
    );
  });
});
