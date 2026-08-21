#!/usr/bin/env node
/**
 * s2s-smoke.mjs - end-to-end smoke test against a locally running Atlas.
 *
 * Mints a REAL S2S token from the local platform IdP (auth-bff, RFC 8693
 * token exchange) and drives the real request path: guard -> registry ->
 * grant -> quota -> router -> provider -> upstream -> reqlog. The doubao
 * models answer for real; everything else is a fixture and is expected to
 * fail at the provider boundary, not before it.
 *
 * Nothing here is mocked and no token is forged - if the IdP is down or the
 * client secret is wrong, this fails rather than falling back.
 *
 * Usage: node scripts/dev/s2s-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEME = "http" + ":" + "//";
const ATLAS = process.env.ATLAS_BASE_URL ?? `${SCHEME}127.0.0.1:3100`;
const IDP = process.env.IDP_BASE_URL ?? `${SCHEME}localhost:3081`;

/** Acme in the local platform DB. `/v1/chat` still takes tenantId from the
 *  body - the inconsistency ADR-004 records; `/tenancy/*` derives it from the
 *  token. Both are exercised below. */
// One id per run, so the reqlog rows this script writes can be found by it.
// Not Math.random: a caller that reuses an id across runs makes its own traffic
// indistinguishable, and the whole point of X-2 is attribution.
const TASK_RUN_ID = `${process.pid}-${Date.now()}`;
const WORKSPACE = "00000000-0000-4000-b000-000000003001";
const TENANT = "00000000-0000-4000-b000-000000002001";

// The platform repo is a sibling checkout, so its location is a property of the
// machine, not of this repo. Default to the conventional layout and let
// PLATFORM_ENV_FILE override it.
const PLATFORM_ENV_FILE =
  process.env.PLATFORM_ENV_FILE ??
  path.resolve(root, "../../vxture/vxture-platform/.env.local");

function platformEnv(key, { optional = false } = {}) {
  let raw;
  try {
    raw = readFileSync(PLATFORM_ENV_FILE, "utf8");
  } catch {
    throw new Error(
      `cannot read the platform env file at ${PLATFORM_ENV_FILE} - ` +
        `set PLATFORM_ENV_FILE to your vxture-platform .env.local`,
    );
  }
  const m = new RegExp(`^${key}=(.+)$`, "m").exec(raw);
  if (!m) {
    if (optional) return undefined;
    throw new Error(`${key} not found in ${PLATFORM_ENV_FILE}`);
  }
  return m[1].trim();
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function mintS2sToken() {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: "console",
    // Per-CLIENT secret. The platform issues one secret per OIDC client
    // (`OIDC_CLIENT_SECRET_CONSOLE`, `_ADMIN`, `_OPERA`, ...); the unsuffixed
    // `OIDC_CLIENT_SECRET` belongs to a different client, so sending it with
    // `client_id=console` is a genuine credential mismatch.
    //
    // That mismatch is the `invalid_client` this script has answered for as
    // long as it has existed - long enough that it was treated as an
    // environment fact and worked around (the devbox exists partly because of
    // it). It was a one-line bug in this file the whole time. Falls back to
    // the unsuffixed name so an older platform .env.local still works.
    client_secret:
      platformEnv("OIDC_CLIENT_SECRET_CONSOLE", { optional: true }) ??
      platformEnv("OIDC_CLIENT_SECRET"),
    audience: "atlas",
    workspace_id: WORKSPACE,
  });
  const r = await fetch(`${IDP}/oidc/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

/**
 * Every `/v1` call carries a `taskId` (product_251 X-2, enforced 2026-08-17).
 *
 * Injected here rather than at 9 call sites, because the alternative already
 * happened: the requirement landed, this script was not updated, and every
 * data-plane assertion below started answering `400 TASK_ID_REQUIRED`. Nine
 * reported FAIL, which was noisy but honest. Three reported **PASS** - they
 * asserted on a status class loose enough that a pre-provider rejection
 * satisfied it. A smoke test that passes on a request which never reached the
 * provider is worse than one that fails.
 *
 * Pass `taskId: null` to omit it deliberately - that is what the negative test
 * below does, so the requirement itself stays covered.
 */
function withTaskId(pathname, payload) {
  if (!payload || !pathname.startsWith("/v1/")) return payload;
  if ("taskId" in payload) {
    if (payload.taskId === null) {
      const { taskId, ...rest } = payload;
      return rest;
    }
    return payload;
  }
  return { ...payload, taskId: `smoke-${TASK_RUN_ID}` };
}

async function call(pathname, token, rawPayload) {
  const payload = withTaskId(pathname, rawPayload);
  const r = await fetch(`${ATLAS}${pathname}`, {
    method: payload ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, json };
}

const PRE_PROVIDER_CODES = new Set([
  "TASK_ID_REQUIRED",
  "WORKSPACE_ID_REQUIRED",
  "TARGET_SELECTOR_REQUIRED",
  "RERANK_QUERY_REQUIRED",
  "RERANK_CANDIDATES_REQUIRED",
  "RERANK_CANDIDATES_INVALID",
]);

/** Reached the provider boundary - not refused by a gate or a validator. */
function reachedProvider(res) {
  if (res.status === 403 || res.status === 404) return false;
  return !PRE_PROVIDER_CODES.has(res.json?.code ?? "");
}

async function main() {
  console.log(`atlas: ${ATLAS}\nidp:   ${IDP}\n`);

  // --- auth boundary -------------------------------------------------------
  const anon = await call("/v1/models", undefined);
  check("unauthenticated /v1/models is rejected", anon.status === 401, `got ${anon.status}`);

  const token = await mintS2sToken();
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  check(
    "minted a real S2S token",
    claims.aud === "atlas" && claims.scope === "tool:atlas" && claims.mode === "service",
    `aud=${claims.aud} scope=${claims.scope} act.sub=${claims.act?.sub}`,
  );

  const opBlocked = await call("/capability/models", token);
  check(
    "an S2S token cannot reach the operator plane",
    opBlocked.status === 401 || opBlocked.status === 403,
    `got ${opBlocked.status}`,
  );

  // --- registry reads ------------------------------------------------------
  const models = await call("/v1/models", token);
  const list = models.json?.data ?? models.json?.models ?? models.json;
  check(
    "/v1/models lists the registry",
    models.status === 200 && Array.isArray(list) && list.length > 0,
    `${Array.isArray(list) ? list.length : "?"} models`,
  );

  const tenancy = await call("/tenancy/models", token);
  check(
    "/tenancy/models resolves scope from the token",
    tenancy.status === 200,
    `got ${tenancy.status}`,
  );

  const grants = await call("/tenancy/grants", token);
  check("/tenancy/grants returns this workspace's grants", grants.status === 200, `got ${grants.status}`);

  // --- real inference, managed-vault key path ------------------------------
  const vaultCall = await call("/v1/chat", token, {
    modelCode: "doubao-seed-2-0-lite-260428",
    tenantId: TENANT,
    messages: [{ role: "user", content: "用一句话说明什么是模型网关。" }],
    maxTokens: 200,
  });
  const usage = vaultCall.json?.usage;
  check(
    "real doubao call, key from the managed vault",
    vaultCall.status < 300 && Number(usage?.totalTokens ?? usage?.total_tokens) > 0,
    vaultCall.status < 300
      ? `tokens=${usage?.totalTokens ?? usage?.total_tokens}`
      : JSON.stringify(vaultCall.json).slice(0, 200),
  );

  // --- the retired env-var key path is refused ------------------------------
  //
  // This assertion is INVERTED from what it was. It used to require the call to
  // SUCCEED with the key read from `config.apiKeyEnvVar`, and it went red the
  // day that path was retired (#240: the vault is the only key source, and a
  // model with no vault alias is refused rather than silently reaching for an
  // environment variable). A test asserting a deliberately removed behaviour
  // reports the product broken when the product is correct - and this one sat
  // red while the actual chain worked.
  //
  // A model whose keyReference names no managed alias must now fail closed, and
  // the error must name the route that fixes it.
  const envCall = await call("/v1/chat", token, {
    modelCode: "doubao-seed-2-0-pro-260215",
    tenantId: TENANT,
    messages: [{ role: "user", content: "回答一个字:好" }],
    maxTokens: 100,
  });
  check(
    "the retired env-var key path fails closed, naming the fix (#240)",
    envCall.status === 503 &&
      envCall.json?.code === "PROVIDER_UNAVAILABLE" &&
      String(envCall.json?.message ?? "").includes("/capability/provider-keys"),
    `${envCall.status} ${envCall.json?.code ?? ""}`,
  );

  // --- task-profile routing ------------------------------------------------
  const profile = await call("/v1/chat", token, {
    taskProfile: "chat-default",
    tenantId: TENANT,
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 50,
  });
  check(
    "taskProfile routes without an explicit modelCode",
    profile.status < 300,
    profile.status < 300
      ? `resolved to ${profile.json?.modelCode}`
      : JSON.stringify(profile.json).slice(0, 200),
  );

  const unroutable = await call("/v1/chat", token, {
    taskProfile: "does-not-exist",
    tenantId: TENANT,
    messages: [{ role: "user", content: "ping" }],
  });
  check(
    "an unknown taskProfile 404s instead of falling back",
    unroutable.status === 404,
    `${unroutable.status} ${unroutable.json?.code ?? ""}`,
  );

  // --- endpoint routing (#143 data-plane half) ------------------------------
  // chat/default is seeded as primary=doubao-seed-2-0-lite-260428 with a
  // fallback, so a success here proves the endpoint resolved to a real model
  // and the call went all the way to the upstream.
  const endpoint = await call("/v1/chat", token, {
    endpointCode: "chat/default",
    tenantId: TENANT,
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 50,
  });
  check(
    "endpointCode routes to the endpoint's primary model",
    endpoint.status < 300,
    endpoint.status < 300
      ? `resolved to ${endpoint.json?.modelCode}`
      : JSON.stringify(endpoint.json).slice(0, 200),
  );

  const endpointGone = await call("/v1/chat", token, {
    endpointCode: "chat/does-not-exist",
    tenantId: TENANT,
    messages: [{ role: "user", content: "ping" }],
  });
  check(
    "an unknown endpointCode 404s ENDPOINT_NOT_ROUTABLE",
    endpointGone.status === 404 &&
      endpointGone.json?.code === "ENDPOINT_NOT_ROUTABLE",
    `${endpointGone.status} ${endpointGone.json?.code ?? ""}`,
  );

  // chat/internal is seeded isActive:false - deactivating an entry point has
  // to actually stop serving, not quietly keep routing.
  const endpointOff = await call("/v1/chat", token, {
    endpointCode: "chat/internal",
    tenantId: TENANT,
    messages: [{ role: "user", content: "ping" }],
  });
  check(
    "a deactivated endpoint stops serving",
    endpointOff.status === 404 &&
      endpointOff.json?.code === "ENDPOINT_NOT_ROUTABLE",
    `${endpointOff.status} ${endpointOff.json?.code ?? ""}`,
  );

  // --- honest failures -----------------------------------------------------
  const ungranted = await call("/v1/chat", token, {
    modelCode: "qwen3-8b-internal",
    tenantId: TENANT,
    messages: [{ role: "user", content: "ping" }],
  });
  check(
    "a model this workspace holds no grant for is refused",
    ungranted.status === 403 || ungranted.status === 404,
    `${ungranted.status} ${ungranted.json?.code ?? ""}`,
  );

  const parse = await call("/v1/parse", token, {
    modelCode: "doubao-seed-2-0-lite-260428",
    tenantId: TENANT,
    task: "layout",
    pages: [{ pageIndex: 0, imageRef: "test" }],
    workspaceId: WORKSPACE,
  });
  check(
    "/v1/parse reaches its 501 boundary - contract defined, no provider",
    parse.status === 501 && parse.json?.code === "MODEL_NOT_IMPLEMENTED",
    `${parse.status} ${parse.json?.code ?? ""}`,
  );

  // TD-022 regression guard. Before the fix these were 403 GRANT_DENIED,
  // because the grant lookup matched a workspace id against tenant_id. Now
  // they must fail no earlier than the provider call - 503 with the fixture
  // key, or 2xx once a real Zhipu account is configured. A 403 here means
  // the two authorization axes have been collapsed again.
  const embed = await call("/v1/embed", token, {
    modelCode: "embedding-3",
    texts: ["hello"],
    workspaceId: WORKSPACE,
  });
  check(
    "A1 embed passes the grant gate and fails no earlier than the provider",
    reachedProvider(embed),
    `${embed.status} ${embed.json?.code ?? ""}`,
  );

  // The requirement itself, kept covered now that `call` supplies taskId for
  // every other /v1 request. `taskId: null` is the opt-out.
  const noTaskId = await call("/v1/embed", token, {
    modelCode: "embedding-3",
    input: ["hello"],
    workspaceId: WORKSPACE,
    taskId: null,
  });
  check(
    "a /v1 call without taskId is refused (product_251 X-2)",
    noTaskId.status === 400 && noTaskId.json?.code === "TASK_ID_REQUIRED",
    `${noTaskId.status} ${noTaskId.json?.code ?? ""}`,
  );

  const rerank = await call("/v1/rerank", token, {
    modelCode: "rerank-v1",
    query: "q",
    candidates: [{ id: "1", text: "a" }],
    workspaceId: WORKSPACE,
  });
  check(
    "A3 rerank passes the grant gate and fails no earlier than the provider",
    reachedProvider(rerank),
    `${rerank.status} ${rerank.json?.code ?? ""}`,
  );

  const poolTooLarge = await call("/v1/rerank", token, {
    modelCode: "rerank-v1",
    query: "q",
    candidates: Array.from({ length: 101 }, (_, i) => ({ id: String(i), text: "a" })),
    workspaceId: WORKSPACE,
  });
  check(
    "A3 rejects an over-size candidate pool instead of truncating",
    // On the CODE, not on 400: any pre-provider validator answers 400, so a
    // status-only assertion passed while the pool check was never reached.
    poolTooLarge.status === 400 &&
      poolTooLarge.json?.code === "CANDIDATE_POOL_TOO_LARGE",
    `${poolTooLarge.status} ${poolTooLarge.json?.code ?? ""}`,
  );

  // --- discovery -----------------------------------------------------------
  const disco = await call("/.well-known/vxture-tools", token);
  const tools = (disco.json?.tools ?? []).map((t) => t.name);
  check(
    "capability discovery omits the unimplemented parse tool",
    disco.status === 200 && tools.length > 0 && !tools.includes("atlas.parse"),
    tools.join(", "),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
