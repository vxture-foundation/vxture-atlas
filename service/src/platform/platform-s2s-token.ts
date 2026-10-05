/**
 * platform-s2s-token.ts — the delegated-reporter Bearer ticket Atlas presents
 * to the platform's product face (C2 entitlements read, C3 usage report).
 *
 * ## Why this exists (vxture-platform#591, 决策 3 PR C; design 120 / ADR-013)
 *
 * Atlas reports every inference under the CALLER product (ADR-010 / ADR-013 D1),
 * never under "atlas". The platform's `scopeToS2sCaller` therefore cannot bind
 * `act.sub == declared product` for Atlas — so the platform mints Atlas a
 * special **delegated-reporter** ticket: `aud = vxture`, `act.sub = "atlas"`,
 * `mode = service`, `delegated = true`, **no workspace**. One ticket (300s)
 * covers every workspace and every attributed product; the request body still
 * carries `product` (the caller) and `workspace_id`.
 *
 * Atlas gets that ticket with an RFC 8693 token exchange against the platform
 * IdP, authenticating as its own confidential client (`client_secret_basic`):
 *
 *   POST {tokenUrl}
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=urn:ietf:params:oauth:grant-type:token-exchange&audience=vxture
 *   (no workspace_id, no subject_token — the platform refuses them on this grant)
 *
 *   → 200 { access_token, token_type: "Bearer", expires_in, issued_token_type }
 *
 * ## Transitional by design — default is the old shared header
 *
 * The switch is gated by `PLATFORM_S2S_AUTH_MODE` (default `header`). Deploying
 * this code changes nothing until an operator sets it to `bearer` AND the
 * client secret is provisioned (`OIDC_CLIENT_SECRET`) AND the token endpoint is
 * reachable. That ordering is deliberate: the platform-side half (#591) must be
 * running first, and the secret must exist, or every exchange 401s. See the
 * platform's ADR-013 后果段 for the cutover sequence.
 *
 * The provider is process-wide: Atlas's `PlatformEntitlementClient` is a Nest
 * singleton, so its one provider caches one ticket for the whole process and
 * refreshes it a little before expiry. Concurrent callers share a single
 * in-flight mint (no stampede).
 */

/** RFC 8693. The platform's `TOKEN_EXCHANGE_GRANT_TYPE`. */
const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";

/** The platform's `PLATFORM_S2S_AUDIENCE`. The delegated-reporter grant mints nothing else. */
const DELEGATED_AUDIENCE = "vxture";

/** Mint a new ticket this many ms before the cached one expires — covers clock skew + the round-trip. */
const REFRESH_SKEW_MS = 30_000;

/** Floor for a ticket's lifetime if the platform ever returned a nonsensical `expires_in`. */
const MIN_TTL_MS = 10_000;

const DEFAULT_MINT_TIMEOUT_MS = 3_000;

export type PlatformS2sAuthMode = "header" | "bearer";

/** Raised when a Bearer mint was attempted (mode = bearer, configured) but failed. */
export class PlatformS2sMintError extends Error {}

interface CachedTicket {
  token: string;
  /** Absolute epoch ms when this ticket should be treated as expired (already skew-adjusted). */
  refreshAtMs: number;
}

export class PlatformS2sTokenProvider {
  private cached: CachedTicket | null = null;
  /** In-flight mint shared by concurrent callers so a cold cache makes one request, not N. */
  private inFlight: Promise<string> | null = null;

  /** `bearer` only when explicitly opted in; anything else (incl. unset) stays on the legacy header. */
  mode(): PlatformS2sAuthMode {
    return process.env["PLATFORM_S2S_AUTH_MODE"]?.trim() === "bearer"
      ? "bearer"
      : "header";
  }

  private get clientId(): string | undefined {
    return process.env["OIDC_CLIENT_ID"]?.trim() || undefined;
  }

  private get clientSecret(): string | undefined {
    return process.env["OIDC_CLIENT_SECRET"]?.trim() || undefined;
  }

  /**
   * The token endpoint to POST the exchange to. Prefer an explicit
   * `PLATFORM_OIDC_TOKEN_URL` (the tailnet IdP face, e.g.
   * `http://<worker>:8081/oidc/token` — S2S is never public, product_210 §4.2);
   * otherwise derive it from the network-reachable issuer, mirroring how the
   * JWKS fetch resolves (`OIDC_BACKCHANNEL_ISSUER` overrides `OIDC_ISSUER`).
   */
  private get tokenUrl(): string | undefined {
    const explicit = process.env["PLATFORM_OIDC_TOKEN_URL"]?.trim();
    if (explicit) return explicit.replace(/\/+$/, "");
    const base = (
      process.env["OIDC_BACKCHANNEL_ISSUER"]?.trim() ||
      process.env["OIDC_ISSUER"]?.trim() ||
      ""
    ).replace(/\/+$/, "");
    return base ? `${base}/oidc/token` : undefined;
  }

  /**
   * Bearer mode is usable only with a client id, a secret, and a token
   * endpoint. Missing any of them in bearer mode is a misconfiguration the
   * caller reports as "not configured" — it must NOT silently fall back to the
   * shared header, since the whole point of the switch is to stop using it.
   */
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.tokenUrl);
  }

  /**
   * A valid Bearer access token, from cache when fresh, minted otherwise.
   * Throws {@link PlatformS2sMintError} if the exchange fails — the caller turns
   * that into the same degradation it already has for an unreachable platform.
   */
  async bearerToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && now < this.cached.refreshAtMs) {
      return this.cached.token;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.mint().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async mint(): Promise<string> {
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;
    const url = this.tokenUrl;
    if (!clientId || !clientSecret || !url) {
      throw new PlatformS2sMintError("delegated-reporter client not configured");
    }
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString(
      "base64",
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_MINT_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        // No workspace_id / subject_token: the platform refuses them on this grant.
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
          audience: DELEGATED_AUDIENCE,
        }).toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 400 invalid_target / invalid_request from the grant, or 401 invalid_client
        // when the client row is inactive / the secret is wrong.
        let code = `http_${response.status}`;
        try {
          const body = (await response.json()) as { message?: unknown };
          if (typeof body.message === "string" && body.message.trim()) {
            code = body.message.trim().slice(0, 80);
          }
        } catch {
          // keep the status code
        }
        throw new PlatformS2sMintError(
          `token exchange rejected (${response.status}: ${code})`,
        );
      }
      const body = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof body.access_token !== "string" || !body.access_token.trim()) {
        throw new PlatformS2sMintError("token exchange returned no access_token");
      }
      const expiresInSec =
        typeof body.expires_in === "number" && body.expires_in > 0
          ? body.expires_in
          : 300;
      const ttlMs = Math.max(MIN_TTL_MS, expiresInSec * 1000 - REFRESH_SKEW_MS);
      this.cached = {
        token: body.access_token,
        refreshAtMs: Date.now() + ttlMs,
      };
      return body.access_token;
    } catch (error) {
      // A failed mint must not pin a stale ticket; drop the cache so the next
      // call retries rather than serving something that may already be revoked.
      this.cached = null;
      if (error instanceof PlatformS2sMintError) throw error;
      throw new PlatformS2sMintError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
