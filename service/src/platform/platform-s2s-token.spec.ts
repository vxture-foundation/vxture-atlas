import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PlatformS2sMintError,
  PlatformS2sTokenProvider,
} from "./platform-s2s-token";

function tokenResponse(
  body: unknown,
  ok = true,
  status = 200,
): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

/** The arguments of the last fetch call, as [url, init]. */
function lastFetch(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mock.mock.calls.at(-1);
  return [call?.[0] as string, call?.[1] as RequestInit];
}

describe("PlatformS2sTokenProvider", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_S2S_AUTH_MODE", "bearer");
    vi.stubEnv("OIDC_CLIENT_ID", "atlas");
    vi.stubEnv("OIDC_CLIENT_SECRET", "s3cr3t");
    vi.stubEnv("PLATFORM_OIDC_TOKEN_URL", "http://idp.test/oidc/token");
    vi.stubEnv("OIDC_ISSUER", "");
    vi.stubEnv("OIDC_BACKCHANNEL_ISSUER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mode() is bearer only when explicitly set, header otherwise", () => {
    expect(new PlatformS2sTokenProvider().mode()).toBe("bearer");
    vi.stubEnv("PLATFORM_S2S_AUTH_MODE", "header");
    expect(new PlatformS2sTokenProvider().mode()).toBe("header");
    vi.stubEnv("PLATFORM_S2S_AUTH_MODE", "");
    expect(new PlatformS2sTokenProvider().mode()).toBe("header");
  });

  it("isConfigured needs client id, secret and a token url", () => {
    expect(new PlatformS2sTokenProvider().isConfigured()).toBe(true);
    vi.stubEnv("OIDC_CLIENT_SECRET", "");
    expect(new PlatformS2sTokenProvider().isConfigured()).toBe(false);
  });

  it("derives the token url from the backchannel issuer when none is explicit", () => {
    vi.stubEnv("PLATFORM_OIDC_TOKEN_URL", "");
    vi.stubEnv("OIDC_BACKCHANNEL_ISSUER", "http://100.100.0.1:8081/");
    vi.stubEnv("OIDC_ISSUER", "https://accounts.vxture.com");
    expect(new PlatformS2sTokenProvider().isConfigured()).toBe(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "tkt", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);
    return new PlatformS2sTokenProvider().bearerToken().then(() => {
      expect(lastFetch(fetchMock)[0]).toBe("http://100.100.0.1:8081/oidc/token");
    });
  });

  it("mints a delegated-reporter ticket: POST, Basic auth, audience=vxture, no workspace", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "tkt-1", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await new PlatformS2sTokenProvider().bearerToken();

    expect(token).toBe("tkt-1");
    const [url, init] = lastFetch(fetchMock);
    expect(url).toBe("http://idp.test/oidc/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("atlas:s3cr3t").toString("base64")}`,
    );
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:token-exchange",
    );
    expect(body.get("audience")).toBe("vxture");
    expect(body.has("workspace_id")).toBe(false);
    expect(body.has("subject_token")).toBe(false);
  });

  it("caches the ticket and serves it without re-minting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "tkt-2", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new PlatformS2sTokenProvider();
    const a = await provider.bearerToken();
    const b = await provider.bearerToken();

    expect(a).toBe("tkt-2");
    expect(b).toBe("tkt-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight mint across concurrent callers (no stampede)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "tkt-3", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new PlatformS2sTokenProvider();
    const [a, b, c] = await Promise.all([
      provider.bearerToken(),
      provider.bearerToken(),
      provider.bearerToken(),
    ]);

    expect([a, b, c]).toEqual(["tkt-3", "tkt-3", "tkt-3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the cached ticket is within the refresh skew of expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: "old", expires_in: 300 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "new", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new PlatformS2sTokenProvider();
    expect(await provider.bearerToken()).toBe("old");
    // 300s TTL minus 30s skew = fresh for <270s. Jump past that.
    vi.setSystemTime(new Date("2026-10-05T00:04:40.000Z")); // +280s
    expect(await provider.bearerToken()).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws PlatformS2sMintError on a rejected exchange and does not cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ message: "invalid_client" }, false, 401))
      .mockResolvedValueOnce(tokenResponse({ access_token: "recovered", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new PlatformS2sTokenProvider();
    await expect(provider.bearerToken()).rejects.toBeInstanceOf(
      PlatformS2sMintError,
    );
    // Not cached: the next call retries rather than serving a failure.
    expect(await provider.bearerToken()).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the exchange returns no access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(tokenResponse({ expires_in: 300 })),
    );
    await expect(
      new PlatformS2sTokenProvider().bearerToken(),
    ).rejects.toBeInstanceOf(PlatformS2sMintError);
  });

  it("throws when not configured (missing secret)", async () => {
    vi.stubEnv("OIDC_CLIENT_SECRET", "");
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      new PlatformS2sTokenProvider().bearerToken(),
    ).rejects.toBeInstanceOf(PlatformS2sMintError);
  });
});
