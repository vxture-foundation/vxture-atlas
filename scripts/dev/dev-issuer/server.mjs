#!/usr/bin/env node
/**
 * dev-issuer - a local OIDC issuer for the devbox stack, and nothing else.
 *
 * SELF-TEST ONLY - not for integration with other products (owner,
 * 2026-08-14). When a real caller is involved, the token must come from the
 * platform IdP on the normal stack (`docker-compose.yml`); a token minted here
 * would test Atlas against a claim shape this repo chose for itself, which is
 * the one assumption an integration test exists to stop trusting.
 *
 * WHY THIS EXISTS. Every guarded route in Atlas needs a signed token, and the
 * only issuer that could mint one was the platform IdP. Against it the local
 * smoke script has failed on `invalid_client` for as long as it has existed,
 * so every local verification of a guarded route could only ever reach "401 -
 * the route is registered". Nothing behind the guard - grant resolution,
 * quota, routing, failover, reqlog - was reachable without deploying.
 *
 * WHY IT CANNOT LEAK INTO PRODUCTION. Not by convention - by construction:
 *
 *   1. The keypair is generated at startup, in memory, and never persisted.
 *      Production's JWKS cannot contain it, so a token minted here fails
 *      signature verification there. Restarting the issuer invalidates every
 *      token it ever minted, which is the correct property for a dev issuer.
 *   2. `iss` is the devbox URL. Production verifies `iss` against its own
 *      issuer, so the claim check rejects a devbox token before the signature
 *      is even considered - and a production token fails here for the mirror
 *      reason.
 *
 * The two directions are independent, so neither is a single point of failure.
 *
 * It mints whatever it is asked for, with no client authentication. That is
 * appropriate precisely BECAUSE of the above: the tokens are worthless outside
 * this stack. Do not add client secrets here to make it feel safer - it would
 * be theatre, and it would make the thing harder to use for its one job.
 *
 * Zero dependencies: Node's crypto does RS256 and JWK export natively, so the
 * container is a plain node image with this file mounted - no build, no
 * install, nothing to drift.
 */
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";

const PORT = Number(process.env["PORT"] ?? 3081);
/** What goes in `iss`. Must equal the app's OIDC_ISSUER exactly. */
const ISSUER = process.env["DEV_ISSUER_URL"] ?? `http://dev-issuer:${PORT}`;
const KID = "devbox-" + randomUUID().slice(0, 8);

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// `publicKey` is already a public KeyObject, so it exports directly. Wrapping
// it in createPublicKey() throws ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE - that
// helper takes a private key or an encoded one, not a public KeyObject.
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const payload = b64u(
    JSON.stringify({
      iss: ISSUER,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomUUID(),
      ...claims,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64u(signer.sign(privateKey))}`;
}

/**
 * The two token shapes Atlas accepts, kept here so a caller does not have to
 * remember which claim each guard checks. Getting one wrong produces a 401
 * that looks like a bug in the thing under test rather than in the request.
 *
 * `aud`/`scope`/`realm`/`userType` mirror what S2sAuthGuard and
 * OperatorAuthGuard actually assert - see docs/20-specs/10-http-surface.md.
 */
const SHAPES = {
  /** Data plane: /v1/*, /tenancy/*. `act.sub` is the calling PRODUCT, which is
   *  what product_endpoint_grants authorizes against. */
  s2s: (q) => ({
    aud: q.get("aud") ?? "atlas",
    // `scope` is overridable, and `scope=none` omits the claim entirely, so a
    // caller can exercise the guard's scope judgement IN ISOLATION - wrong
    // scope while every other claim, `mode` included, stays valid. Without
    // that, the only way to produce a rejectable token is one that some other
    // check would also reject, and a passing test would not tell you which
    // judgement fired. That ambiguity is the whole of TD-036.
    ...(q.get("scope") === "none"
      ? {}
      : { scope: q.get("scope") ?? "tool:atlas" }),
    mode: q.get("mode") ?? "service",
    act: { sub: q.get("product") ?? "karda" },
    ...(q.get("tenantId") ? { tenant_id: q.get("tenantId") } : {}),
    ...(q.get("workspaceId") ? { workspace_id: q.get("workspaceId") } : {}),
    ...(q.get("sub") ? { sub: q.get("sub") } : {}),
  }),
  /** Operator plane: /capability/*. `sub` is the operator, `act.sub` the
   *  workforce RP that minted the exchange. */
  operator: (q) => ({
    aud: q.get("aud") ?? "atlas",
    scope: "mgmt:atlas",
    realm: "workforce",
    userType: "operator",
    mode: "operator",
    sub: q.get("sub") ?? "opr_00000000-0000-4000-8000-000000000001",
    act: { sub: q.get("actor") ?? "console" },
  }),
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/oidc/jwks") {
    return json(res, 200, { keys: [jwk] });
  }

  // Discovery, so anything expecting a standard issuer can find the JWKS.
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/oidc/jwks`,
      token_endpoint: `${ISSUER}/oidc/token`,
    });
  }

  // GET /mint?kind=s2s|operator&... - the human-facing path. curl it, paste
  // the token. Deliberately a GET so it works from a browser and a shell
  // without a body.
  if (url.pathname === "/mint" || url.pathname === "/oidc/token") {
    const kind = url.searchParams.get("kind") ?? "s2s";
    // Own-property lookup only: a crafted kind like "constructor" must not
    // reach Object.prototype and get invoked as a shape.
    const shape = Object.hasOwn(SHAPES, kind) ? SHAPES[kind] : undefined;
    if (!shape) {
      return json(res, 400, {
        error: "unsupported_kind",
        error_description: `kind must be one of: ${Object.keys(SHAPES).join(", ")}`,
      });
    }
    const ttl = Number(url.searchParams.get("ttl") ?? 900);
    const token = sign(shape(url.searchParams), ttl);
    return json(res, 200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: ttl,
      issuer: ISSUER,
      kind,
    });
  }

  if (url.pathname === "/healthz") {
    return json(res, 200, { status: "ok", issuer: ISSUER, kid: KID });
  }

  json(res, 404, { error: "not_found" });
}).listen(PORT, () => {
  console.log(`[dev-issuer] listening on ${PORT}`);
  console.log(`[dev-issuer] iss = ${ISSUER}   kid = ${KID}`);
  console.log(`[dev-issuer] keypair is in-memory only - a restart invalidates every token minted so far`);
});
