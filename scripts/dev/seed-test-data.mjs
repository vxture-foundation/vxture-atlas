#!/usr/bin/env node
/**
 * seed-test-data.mjs - local test data for the Atlas registry.
 *
 * NOT a deployment artifact. The production data path is operator writes
 * through /capability/*; this script only fills a local database so the
 * operator console and the S2S surface have something real to work against.
 *
 * Idempotent by full replace: it deletes every registry row it owns and
 * re-inserts, so re-running converges instead of duplicating.
 *
 * One provider is real: doubao, whose key comes from .env.provider-keys and
 * whose two models answer real calls. Everything else is plausible fixture
 * data - correct in shape, not backed by a live account.
 *
 * Usage: node scripts/dev/seed-test-data.mjs
 */
import { readFileSync } from "node:fs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvFile(file) {
  let raw;
  try {
    raw = readFileSync(path.join(root, file), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(i + 1).trim();
  }
}
loadEnvFile(".env");
loadEnvFile(".env.provider-keys");

const { PrismaClient } = await import(
  pathToFileURL(path.join(root, "service/src/generated/prisma/index.js")).href
);
// Prisma 7 is driver-adapter only - a bare `new PrismaClient()` throws
// ("A driver adapter is required to connect to your database"). Same wiring
// as service/src/prisma.ts, which is the shape this has to mirror.
const { PrismaPg } = await import(
  pathToFileURL(
    path.join(root, "service/node_modules/@prisma/adapter-pg/dist/index.js"),
  ).href
);
if (!process.env["DATABASE_URL"]) {
  throw new Error("DATABASE_URL is not set - .env missing or not loaded?");
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] }),
});

/** Real tenants and workspaces from the local platform DB, so grants line up. */
const TENANT = {
  acme: "00000000-0000-4000-b000-000000002001",
  globex: "00000000-0000-4000-b000-000000002002",
  initech: "00000000-0000-4000-b000-000000002003",
  personal: "00000000-0000-4000-a000-000000000200",
  personal2: "00000000-0000-4000-b000-000000002004",
};
const WORKSPACE = {
  acme: "00000000-0000-4000-b000-000000003001",
  globex: "00000000-0000-4000-b000-000000003002",
  initech: "00000000-0000-4000-b000-000000003003",
  personal: "00000000-0000-4000-a000-000000000210",
  personal2: "00000000-0000-4000-b000-000000003004",
};
/** A stable fake agent id, so agent-scoped grants are exercised. */
const AGENT = "00000000-0000-4000-c000-00000000a001";
const OPERATOR = "00000000-0000-4000-a000-0000000000ff";

// --------------------------------------------------------------------------
// Providers - who, commercially. The wire quirks live in config.wire so that
// onboarding a new OpenAI-dialect vendor stays a data operation (design 100).
// --------------------------------------------------------------------------
const PROVIDERS = [
  {
    providerCode: "doubao",
    providerName: "火山引擎豆包",
    providerType: "online",
    description: "ByteDance Volcano Ark - the one provider wired to a real account here",
    homepageUrl: "https://www.volcengine.com/product/doubao",
    consoleUrl: "https://console.volcengine.com/ark",
    isActive: true,
    config: {
      egressRoute: "direct",
      wire: {
        schemaVersion: 1,
        chatPath: "/chat/completions",
        auth: { style: "bearer" },
        streamUsage: "stream_options",
        supports: { tools: true, toolChoice: true, topP: true },
      },
    },
  },
  {
    providerCode: "zhipu",
    providerName: "智谱 BigModel",
    providerType: "online",
    description: "OpenAI-compatible chat plus native embedding and rerank",
    homepageUrl: "https://bigmodel.cn",
    isActive: true,
    config: {
      egressRoute: "direct",
      wire: {
        schemaVersion: 1,
        chatPath: "/chat/completions",
        auth: { style: "bearer" },
        streamUsage: "stream_options",
        supports: { tools: true, toolChoice: true, topP: true },
      },
    },
  },
  {
    providerCode: "deepseek",
    providerName: "深度求索 DeepSeek",
    providerType: "online",
    description: "Onboarded by data alone - no adapter code, just protocol + wire",
    homepageUrl: "https://platform.deepseek.com",
    isActive: true,
    config: {
      egressRoute: "direct",
      wire: {
        schemaVersion: 1,
        chatPath: "/chat/completions",
        auth: { style: "bearer" },
        streamUsage: "stream_options",
        supports: { tools: true, toolChoice: false, topP: true },
        paramMap: { maxTokens: "max_tokens" },
      },
    },
  },
  {
    providerCode: "anthropic",
    providerName: "Anthropic",
    providerType: "online",
    description: "Different wire format - anthropic-messages, its own adapter",
    homepageUrl: "https://www.anthropic.com",
    isActive: false,
    config: {
      egressRoute: "proxy",
      wire: {
        schemaVersion: 1,
        auth: { style: "x-api-key" },
        headers: { "anthropic-version": "2023-06-01" },
        streamUsage: "native",
        supports: { tools: true, toolChoice: true, topP: true },
      },
    },
  },
  {
    providerCode: "private",
    providerName: "内网 vLLM",
    providerType: "private",
    description: "Self-hosted vLLM on the tailnet - no API key, endpoint-local auth",
    isActive: true,
    config: {
      egressRoute: "internal",
      wire: {
        schemaVersion: 1,
        chatPath: "/v1/chat/completions",
        auth: { style: "none" },
        streamUsage: "none",
        supports: { tools: false, toolChoice: false, topP: true },
      },
    },
  },
];

// --------------------------------------------------------------------------
// Models - dispatch is by `protocol`, never by provider_code (design 100 §6).
// --------------------------------------------------------------------------
const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const MODELS = [
  {
    providerCode: "doubao",
    modelCode: "doubao-seed-2-0-lite-260428",
    modelType: "chat",
    protocol: "openai-chat-completions",
    modelName: "豆包 Seed 2.0 Lite",
    description: "REAL - resolves its key from the managed vault (ADR-003)",
    endpointUrl: ARK,
    contextWindow: 262144,
    maxOutputTokens: 32768,
    capabilities: ["chat", "tools", "streaming"],
    supportsStreaming: true,
    isActive: true,
    sort: 1,
    config: { managedKeyAlias: "primary" },
  },
  {
    providerCode: "doubao",
    modelCode: "doubao-seed-2-0-pro-260215",
    modelType: "chat",
    protocol: "openai-chat-completions",
    modelName: "豆包 Seed 2.0 Pro",
    description: "REAL - resolves its key from the legacy env-var path, so both paths are exercised",
    endpointUrl: ARK,
    contextWindow: 262144,
    maxOutputTokens: 32768,
    capabilities: ["chat", "tools", "streaming"],
    supportsStreaming: true,
    isActive: true,
    sort: 2,
    config: { apiKeyEnvVar: "DOUBAO_API_KEY" },
  },
  {
    providerCode: "zhipu",
    modelCode: "glm-5.2",
    modelType: "chat",
    protocol: "openai-chat-completions",
    modelName: "GLM-5.2",
    description: "Fixture - shape is real, the account behind it is not",
    endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: ["chat", "tools", "streaming"],
    supportsStreaming: true,
    isActive: true,
    sort: 10,
    config: { managedKeyAlias: "primary" },
  },
  {
    providerCode: "zhipu",
    modelCode: "embedding-3",
    modelType: "embedding",
    protocol: "openai-chat-completions",
    modelName: "智谱 Embedding-3",
    description: "A1 - dimension is immutable for this model_code; a new dimension is a new code",
    endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
    capabilities: ["embedding"],
    supportsStreaming: false,
    isActive: true,
    sort: 20,
    config: { managedKeyAlias: "primary", dimension: 2048 },
  },
  {
    providerCode: "zhipu",
    modelCode: "rerank-v1",
    modelType: "rerank",
    protocol: "openai-chat-completions",
    modelName: "智谱 Rerank",
    description: "A3 - served through the special-case layer, rerank is not an OpenAI-protocol call",
    endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
    capabilities: ["rerank"],
    supportsStreaming: false,
    isActive: true,
    sort: 21,
    config: { managedKeyAlias: "primary", upstreamModel: "rerank" },
  },
  {
    providerCode: "deepseek",
    modelCode: "deepseek-chat-v3",
    modelType: "chat",
    protocol: "openai-chat-completions",
    modelName: "DeepSeek Chat V3",
    description: "Zero-code onboarding: model_code is a dispatch key, upstreamModel is the wire value (TD-012)",
    endpointUrl: "https://api.deepseek.com/v1",
    contextWindow: 65536,
    maxOutputTokens: 8192,
    capabilities: ["chat", "streaming"],
    supportsStreaming: true,
    isActive: true,
    sort: 30,
    config: { managedKeyAlias: "primary", upstreamModel: "deepseek-chat" },
  },
  {
    providerCode: "anthropic",
    modelCode: "claude-sonnet-4",
    modelType: "chat",
    protocol: "anthropic-messages",
    modelName: "Claude Sonnet 4",
    description: "Different wire format - dispatches to the Claude adapter, not the generic one",
    endpointUrl: "https://api.anthropic.com/v1",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    capabilities: ["chat", "tools", "streaming"],
    supportsStreaming: true,
    isActive: false,
    sort: 40,
    config: { managedKeyAlias: "primary" },
  },
  {
    providerCode: "private",
    modelCode: "qwen3-8b-internal",
    modelType: "chat",
    protocol: "openai-chat-completions",
    modelName: "Qwen3 8B (内网)",
    description: "Endpoint-local auth - no API key required at all",
    endpointUrl: "http://100.76.219.48:8000",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    capabilities: ["chat", "streaming"],
    supportsStreaming: true,
    isActive: true,
    sort: 50,
    config: {},
  },
  {
    providerCode: "private",
    modelCode: "layout-parse-v1",
    modelType: "parse",
    protocol: "openai-chat-completions",
    modelName: "版面解析 (内网)",
    description: "A2 - the registry entry TD-003 lacked; still 501 until a provider implements parseDocument",
    endpointUrl: "http://100.76.219.48:8001",
    capabilities: ["parse"],
    supportsStreaming: false,
    isActive: true,
    sort: 25,
    config: {},
  },
  {
    providerCode: "doubao",
    modelCode: "doubao-seed-2-0-lite-no-tools",
    modelType: "chat",
    protocol: "openai-chat-completions",
    modelName: "豆包 Lite (禁用 tools)",
    description: "Model-level config.wire deep-merged over the provider's - same account, narrower capability",
    endpointUrl: ARK,
    contextWindow: 262144,
    maxOutputTokens: 32768,
    capabilities: ["chat", "streaming"],
    supportsStreaming: true,
    isActive: true,
    sort: 3,
    config: {
      managedKeyAlias: "primary",
      upstreamModel: "doubao-seed-2-0-lite-260428",
      wire: { supports: { tools: false, toolChoice: false } },
    },
  },
  {
    providerCode: "zhipu",
    modelCode: "glm-4-legacy",
    modelType: "chat",
    protocol: "openai",
    modelName: "GLM-4 (legacy protocol value)",
    description: "Deliberately carries the un-normalized protocol alias, so the fallback layer is observable",
    endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
    contextWindow: 131072,
    capabilities: ["chat"],
    supportsStreaming: true,
    isActive: false,
    sort: 60,
    config: { managedKeyAlias: "primary" },
  },
];

// --------------------------------------------------------------------------
// Grants - who may call what. taskProfile lets a caller ask for a capability
// instead of naming a model (design 200 §5).
// --------------------------------------------------------------------------
const GRANTS = [
  { tenant: "acme", modelCode: "doubao-seed-2-0-lite-260428", taskProfile: "chat-default", priority: 10, reason: "默认对话模型" },
  { tenant: "acme", modelCode: "doubao-seed-2-0-pro-260215", taskProfile: "long-context", priority: 10, reason: "长上下文场景" },
  { tenant: "acme", modelCode: "doubao-seed-2-0-lite-260428", taskProfile: "summarization", priority: 20, reason: "摘要,便宜优先" },
  { tenant: "acme", modelCode: "embedding-3", taskProfile: "embedding", priority: 10, reason: "karda 知识库向量化" },
  { tenant: "acme", modelCode: "rerank-v1", taskProfile: "retrieval-rerank", priority: 10, reason: "检索重排" },
  { tenant: "acme", modelCode: "glm-5.2", taskProfile: "summarization", priority: 50, reason: "摘要备选,优先级更低" },
  { tenant: "globex", modelCode: "doubao-seed-2-0-lite-260428", taskProfile: "chat-default", priority: 10, reason: "默认对话模型" },
  { tenant: "globex", modelCode: "deepseek-chat-v3", taskProfile: null, priority: 100, reason: "仅授权,不参与画像路由" },
  { tenant: "globex", modelCode: "qwen3-8b-internal", taskProfile: "chat-internal", priority: 10, applicationType: "agent", reason: "内网 agent 专用" },
  { tenant: "initech", modelCode: "glm-5.2", taskProfile: "chat-default", priority: 10, reason: "默认对话模型" },
  { tenant: "initech", modelCode: "claude-sonnet-4", taskProfile: "long-context", priority: 10, isActive: false, reason: "模型未启用,授权先挂着" },
  { tenant: "personal", modelCode: "doubao-seed-2-0-lite-260428", taskProfile: "chat-default", priority: 10, reason: "个人租户试用" },
  { tenant: "personal", modelCode: "doubao-seed-2-0-pro-260215", taskProfile: null, priority: 100, expiresInDays: -3, reason: "已过期,用于验证过期不被选中" },
  { tenant: "acme", modelCode: "layout-parse-v1", taskProfile: "document-parse", priority: 10, reason: "karda 文档加工管线" },
  { tenant: "acme", modelCode: "doubao-seed-2-0-lite-no-tools", taskProfile: null, priority: 100, applicationId: AGENT, applicationType: "agent", reason: "指定 agent 专用,精确范围优先于租户通配" },
  { tenant: "acme", modelCode: "doubao-seed-2-0-lite-260428", taskProfile: "chat-default", priority: 5, applicationId: AGENT, applicationType: "agent", reason: "同一画像下 agent 精确匹配,优先于上面的租户级 chat-default" },
  { tenant: "globex", modelCode: "embedding-3", taskProfile: "embedding", priority: 10, reason: "第二个租户也做向量化" },
  { tenant: "personal2", modelCode: "glm-5.2", taskProfile: "chat-default", priority: 10, expiresInDays: 30, reason: "限期试用,30 天后过期" },
];

// --------------------------------------------------------------------------
// Prices - operations data. Atlas meters quantities; it does not bill.
// --------------------------------------------------------------------------
const PRICES = [
  { modelCode: "doubao-seed-2-0-lite-260428", input: "0.30", output: "3.00" },
  { modelCode: "doubao-seed-2-0-pro-260215", input: "2.00", output: "20.00" },
  { modelCode: "glm-5.2", input: "1.00", output: "6.00" },
  { modelCode: "embedding-3", input: "0.50", output: "0", request: "0" },
  { modelCode: "rerank-v1", input: "0", output: "0", request: "0.002", billingMode: "request" },
  { modelCode: "deepseek-chat-v3", input: "0.50", output: "8.00" },
  { modelCode: "claude-sonnet-4", input: "21.00", output: "105.00", currency: "USD" },
  { modelCode: "qwen3-8b-internal", input: "0", output: "0" },
  { modelCode: "layout-parse-v1", input: "0", output: "0", request: "0.05", billingMode: "request" },
  { modelCode: "doubao-seed-2-0-lite-no-tools", input: "0.30", output: "3.00" },
  // Price rules are versioned by append, not edited in place (98_column_locks
  // grants UPDATE only on the lifecycle columns). This is last quarter's rate
  // for the same model, expired rather than deleted.
  { modelCode: "doubao-seed-2-0-lite-260428", input: "0.50", output: "4.00", expiredDaysAgo: 30 },
];

// --------------------------------------------------------------------------
// Policies - the rate gate. RATE_LIMITED is specified but not yet enforced;
// this is the configuration it will read.
// --------------------------------------------------------------------------
const POLICIES = [
  { modelCode: "doubao-seed-2-0-lite-260428", tenant: null, name: "全局默认", rateLimitRpm: 600, rateLimitTpm: 800000n, maxConcurrent: 32, maxContextTokens: 262144 },
  { modelCode: "doubao-seed-2-0-lite-260428", tenant: "personal", name: "个人租户收紧", rateLimitRpm: 20, rateLimitTpm: 40000n, maxConcurrent: 2, priority: 10 },
  { modelCode: "doubao-seed-2-0-pro-260215", tenant: null, name: "全局默认", rateLimitRpm: 120, rateLimitTpm: 200000n, maxConcurrent: 8 },
  { modelCode: "glm-5.2", tenant: null, name: "全局默认", rateLimitRpm: 300, rateLimitTpm: 300000n, maxConcurrent: 16 },
  { modelCode: "embedding-3", tenant: null, name: "批量向量化", rateLimitRpm: 1200, rateLimitTpd: 50000000n, maxConcurrent: 64 },
];

// --------------------------------------------------------------------------
// Bulk fixtures. Everything above is hand-written: those rows carry the real
// wire descriptors, the deliberate edge cases (retired key, expired price,
// agent-scoped grant beating a tenant-wide one) and the one live provider.
// They are the rows worth reading.
//
// What follows scales the same shapes to a volume that actually exercises the
// operator surfaces: client-side pagination (opera pages offer 10/20/50/100
// page sizes - a 5-row table never leaves page one), search and filter, and
// the GROUP BY keys behind Metering. Bounded-by-reality tables are NOT padded
// to hit a number - see the per-table note at each generator.
//
// Deterministic: one shared PRNG seed, so a value that looks wrong on a page
// reproduces on the next run instead of moving.
// --------------------------------------------------------------------------
let bulkRng = 0x5f3a91c;
const brnd = () => {
  bulkRng = (bulkRng * 1103515245 + 12345) & 0x7fffffff;
  return bulkRng / 0x7fffffff;
};
const bpick = (arr) => arr[Math.floor(brnd() * arr.length)];
const bint = (lo, hi) => lo + Math.floor(brnd() * (hi - lo + 1));
const uuid = (prefix, n) =>
  `00000000-0000-4000-${prefix}-${String(n).padStart(12, "0")}`;

/**
 * More tenants. Grants, policies, provisionings and the whole reqlog are all
 * keyed by tenant, so five of them capped every one of those tables at a
 * dozen-ish rows regardless of what else was generated.
 */
/**
 * More providers. NOT padded to 100+: this table is one row per commercial
 * model vendor an org has actually onboarded, and there are not a hundred of
 * those in existence - a padded list would be inventing vendors. These are
 * real ones a China-based platform plausibly evaluates, several deliberately
 * left with no models attached (onboarding a provider before registering its
 * models is a real intermediate state the page should render).
 */
const EXTRA_PROVIDERS = [
  { code: "openai", name: "OpenAI", type: "online", home: "https://openai.com" },
  { code: "azure-openai", name: "Azure OpenAI", type: "online", home: "https://azure.microsoft.com" },
  { code: "aws-bedrock", name: "AWS Bedrock", type: "online", home: "https://aws.amazon.com/bedrock" },
  { code: "google-vertex", name: "Google Vertex AI", type: "online", home: "https://cloud.google.com/vertex-ai" },
  { code: "moonshot", name: "月之暗面 Kimi", type: "online", home: "https://www.moonshot.cn" },
  { code: "minimax", name: "MiniMax", type: "online", home: "https://www.minimaxi.com" },
  { code: "baichuan", name: "百川智能", type: "online", home: "https://www.baichuan-ai.com" },
  { code: "stepfun", name: "阶跃星辰", type: "online", home: "https://www.stepfun.com" },
  { code: "01ai", name: "零一万物", type: "online", home: "https://www.01.ai" },
  { code: "sensetime", name: "商汤日日新", type: "online", home: "https://www.sensetime.com" },
  { code: "qwen-cloud", name: "阿里云百炼", type: "online", home: "https://bailian.console.aliyun.com" },
  { code: "vllm-gpu-a", name: "自建 vLLM A 区", type: "self_hosted", home: null },
  { code: "vllm-gpu-b", name: "自建 vLLM B 区", type: "self_hosted", home: null },
  { code: "ollama-edge", name: "边缘 Ollama", type: "private", home: null },
];
for (const p of EXTRA_PROVIDERS) {
  PROVIDERS.push({
    providerCode: p.code,
    providerName: p.name,
    providerType: p.type,
    description: "generated fixture - onboarded, not wired to a real account",
    ...(p.home ? { homepageUrl: p.home } : {}),
    isActive: brnd() < 0.75,
    config: { egressRoute: p.type === "online" ? "direct" : "internal" },
  });
}

/**
 * 运营链接：控制台（换密钥、看限流）与账单页（对账）。**不是外观，是运营动线**——
 * 密钥要轮换时去前者，成本异常时去后者。
 *
 * 每一条都做过 HTTP 探测（2026-08-16），不是凭印象写的。探测顺带推翻了三个候选，
 * 也发现两家换了域名：
 *
 * - `anthropic` 的 `console.anthropic.com/*` **整体跳到 `platform.claude.com`**
 * - `moonshot` 的 `platform.moonshot.cn/*` **整体跳到 `platform.kimi.com`**
 * - `minimax` 的 `user-center/basic-information/interface-key` 已改为
 *   `console/access?tab=api-keys`
 *
 * **billing 留空的三家是查证结论，不是漏填**：`01ai` 的账单路径直接 404；
 * `baichuan` 与 `minimax` 的候选路径被站点兜底重定向到首页 / 个人信息页，说明路径
 * 不存在。给一个会把人送到无关页面的链接，比留空更糟——留空时界面至少不出这个按钮。
 *
 * **自建与内网四家（vllm-gpu-a / vllm-gpu-b / ollama-edge / private）没有这两项**，
 * 因为它们根本没有「对方控制台」和「对方账单」。这是不适用，不是待补。
 *
 * `google-vertex` 两条是 Google Cloud 控制台的固定路径，但**本机到
 * console.cloud.google.com 不通，未能探测**——待验证。
 */
const PROVIDER_LINKS = {
  openai: {
    console: "https://platform.openai.com/settings/organization/api-keys",
    billing: "https://platform.openai.com/account/billing/overview",
  },
  anthropic: {
    console: "https://platform.claude.com/settings/keys",
    billing: "https://platform.claude.com/settings/billing",
  },
  deepseek: {
    console: "https://platform.deepseek.com/api_keys",
    billing: "https://platform.deepseek.com/usage",
  },
  moonshot: {
    console: "https://platform.kimi.com/console/api-keys",
    billing: "https://platform.kimi.com/console/account",
  },
  zhipu: {
    console: "https://open.bigmodel.cn/usercenter/apikeys",
    billing: "https://open.bigmodel.cn/usercenter/financialaccount",
  },
  "qwen-cloud": {
    console: "https://bailian.console.aliyun.com/",
    billing: "https://usercenter2.aliyun.com/finance/expense-report/overview",
  },
  doubao: {
    console: "https://console.volcengine.com/ark",
    billing: "https://console.volcengine.com/finance/bill",
  },
  minimax: {
    console: "https://platform.minimaxi.com/console/access?tab=api-keys",
  },
  stepfun: {
    console: "https://platform.stepfun.com/interface-key",
    billing: "https://platform.stepfun.com/account-overview",
  },
  "01ai": {
    console: "https://platform.lingyiwanwu.com/apikeys",
  },
  baichuan: {
    console: "https://platform.baichuan-ai.com/",
  },
  sensetime: {
    console: "https://console.sensecore.cn/",
    billing: "https://console.sensecore.cn/finance/bill",
  },
  "aws-bedrock": {
    console: "https://console.aws.amazon.com/bedrock/home",
    billing: "https://console.aws.amazon.com/billing/home",
  },
  "azure-openai": {
    /* 控制台与账单在两个门户：模型与密钥在 AI Foundry，费用只在 Azure 门户的
       Cost Management。深层 blade 地址带租户态，写死会失效，所以指到门户根。 */
    console: "https://ai.azure.com/",
    billing: "https://portal.azure.com/",
  },
  "google-vertex": {
    console: "https://console.cloud.google.com/vertex-ai",
    billing: "https://console.cloud.google.com/billing",
  },
};
for (const prov of PROVIDERS) {
  const link = PROVIDER_LINKS[prov.providerCode];
  if (!link) continue;
  if (link.console) prov.consoleUrl = link.console;
  if (link.billing) prov.billingUrl = link.billing;
}

const ORG_NAMES = [
  "northwind", "umbrella", "stark", "wayne", "tyrell", "cyberdyne", "aperture",
  "soylent", "weyland", "abstergo", "vehement", "massive-dynamic", "oscorp",
  "hooli", "pied-piper", "vandelay", "sterling-cooper", "prestige-worldwide",
  "duff", "krusty", "gringotts", "acme-labs", "monarch", "venture", "sirius",
  "encom", "lacuna", "rekall", "omni-consumer", "blue-sun", "nakatomi",
  "yoyodyne", "genco", "bluth", "dinoco",
];
ORG_NAMES.forEach((name, i) => {
  TENANT[name] = uuid("b000", 2100 + i);
  WORKSPACE[name] = uuid("b000", 3100 + i);
});
const ALL_TENANTS = Object.keys(TENANT);

/**
 * More models. Real vendors ship many dated variants of the same family, and
 * every one of them is a row here - this is genuinely high-cardinality, so it
 * gets generated rather than capped. The curated 11 above keep their real
 * configs; these are shape-correct filler that the registry page paginates.
 */
const MODEL_FAMILIES = [
  { providerCode: "doubao", family: "doubao-seed", protocol: "openai-chat-completions", endpointUrl: ARK, ctx: 262144 },
  { providerCode: "zhipu", family: "glm", protocol: "openai-chat-completions", endpointUrl: "https://open.bigmodel.cn/api/paas/v4", ctx: 131072 },
  { providerCode: "deepseek", family: "deepseek", protocol: "openai-chat-completions", endpointUrl: "https://api.deepseek.com/v1", ctx: 65536 },
  { providerCode: "anthropic", family: "claude", protocol: "anthropic-messages", endpointUrl: "https://api.anthropic.com/v1", ctx: 200000 },
  { providerCode: "private", family: "qwen3", protocol: "openai-chat-completions", endpointUrl: "http://100.76.219.48:8000", ctx: 32768 },
];
const TIERS = ["lite", "pro", "max", "flash", "turbo"];
for (const fam of MODEL_FAMILIES) {
  for (let v = 0; v < 24; v++) {
    const tier = TIERS[v % TIERS.length];
    const gen = 1 + Math.floor(v / TIERS.length);
    const date = `25${String(1 + (v % 12)).padStart(2, "0")}${String(1 + (v % 28)).padStart(2, "0")}`;
    const modelCode = `${fam.family}-${gen}-${tier}-${date}`;
    if (MODELS.some((m) => m.modelCode === modelCode)) continue;
    MODELS.push({
      providerCode: fam.providerCode,
      modelCode,
      modelType: "chat",
      protocol: fam.protocol,
      modelName: `${fam.family} ${gen}.0 ${tier}`,
      description: "generated fixture - shape only, not a real upstream model",
      endpointUrl: fam.endpointUrl,
      contextWindow: fam.ctx,
      maxOutputTokens: bint(2, 16) * 1024,
      capabilities: ["chat"],
      supportsStreaming: brnd() < 0.85,
      sort: 500 + v,
      isActive: brnd() < 0.8,
      config: { upstreamModel: modelCode },
    });
  }
}

/**
 * More grants. tenants x models x application scope - the single
 * fastest-growing registry table in production, so nothing about a large
 * number here is artificial.
 */
const CHAT_MODEL_CODES = MODELS.filter((m) => m.modelType === "chat").map((m) => m.modelCode);
const APP_TYPES = ["agent", "workflow", "api_client", "internal_service"];
for (let i = 0; i < 170; i++) {
  const tenant = bpick(ALL_TENANTS);
  const modelCode = bpick(CHAT_MODEL_CODES);
  const scoped = brnd() < 0.45;
  GRANTS.push({
    tenant,
    modelCode,
    applicationType: scoped ? bpick(APP_TYPES) : null,
    applicationId: scoped ? uuid("c000", 5000 + i) : null,
    taskProfile: brnd() < 0.3 ? bpick(["chat-default", "chat-cheap", "chat-long", "summarize"]) : null,
    priority: bpick([5, 10, 50, 100, 100, 100]),
    isActive: brnd() < 0.88,
    reason: "generated fixture",
    ...(brnd() < 0.15 ? { expiresInDays: bint(7, 180) } : {}),
  });
}

/**
 * More price rules. Versioned by append (98_column_locks grants UPDATE only
 * on lifecycle columns), so every rate change in a model's life is a row -
 * high-cardinality by design, not padding.
 */
for (const modelCode of CHAT_MODEL_CODES) {
  if (PRICES.some((p) => p.modelCode === modelCode)) continue;
  const inp = (brnd() * 4 + 0.2).toFixed(2);
  const out = (Number(inp) * bint(5, 12)).toFixed(2);
  PRICES.push({ modelCode, input: inp, output: out });
  // Roughly a third carry a superseded rate, expired rather than deleted.
  if (brnd() < 0.35) {
    PRICES.push({
      modelCode,
      input: (Number(inp) * 1.4).toFixed(2),
      output: (Number(out) * 1.4).toFixed(2),
      expiredDaysAgo: bint(20, 120),
    });
  }
  // Expired but STILL is_active. Nothing flips is_active when expires_at
  // passes (no sweeper, by design), so this state is real in production and
  // is precisely what `?asOf=` exists to tell apart - without a sample of it,
  // the filter would look correct against data that could not disprove it.
  if (brnd() < 0.15) {
    PRICES.push({
      modelCode,
      input: (Number(inp) * 1.8).toFixed(2),
      output: (Number(out) * 1.8).toFixed(2),
      staleActiveDaysAgo: bint(10, 200),
    });
  }
  // Not yet in force - effective_at in the future, also is_active.
  if (brnd() < 0.12) {
    PRICES.push({
      modelCode,
      input: (Number(inp) * 0.85).toFixed(2),
      output: (Number(out) * 0.85).toFixed(2),
      effectiveInDays: bint(3, 45),
    });
  }
}

/**
 * More policies. UNIQUE(model_id, tenant_id) caps this at one row per pair,
 * so it is generated against distinct pairs rather than at random.
 */
const policySeen = new Set(POLICIES.map((p) => `${p.modelCode}|${p.tenant ?? ""}`));
for (const modelCode of CHAT_MODEL_CODES) {
  for (const tenant of [null, bpick(ALL_TENANTS)]) {
    const k = `${modelCode}|${tenant ?? ""}`;
    if (policySeen.has(k) || POLICIES.length >= 130) continue;
    policySeen.add(k);
    POLICIES.push({
      modelCode,
      tenant,
      name: tenant ? "租户限额" : "全局默认",
      rateLimitRpm: bpick([60, 120, 300, 600, 1200]),
      rateLimitTpm: BigInt(bpick([40000, 200000, 400000, 800000])),
      maxConcurrent: bpick([2, 8, 16, 32, 64]),
      ...(tenant ? { priority: 10 } : {}),
      // Coverage, not decoration: every generated policy used to be active,
      // so nothing exercised deactivate, and findApplicablePolicy's
      // is_active/effective_at/expires_at predicate had no negative case to
      // filter. ~18% inactive, plus a slice that is active but already
      // expired - the state only an asOf-style read can tell apart.
      ...(brnd() < 0.18 ? { isActive: false } : {}),
      ...(brnd() < 0.12 ? { expiredDaysAgo: bint(5, 90) } : {}),
      ...(brnd() < 0.08 ? { effectiveInDays: bint(3, 60) } : {}),
    });
  }
}
// --------------------------------------------------------------------------
/**
 * Logical capability entry points (vxture-atlas#143). These back BOTH operator
 * pages: the Endpoint list, and the Router view - "router" is not its own
 * resource, it is the same row read for its failover pair, so a mix of single
 * (fallbackModelCode null) and failover (set) rows is what makes the Router
 * page show anything at all.
 */
const ENDPOINTS = [
  { code: "chat/default", category: "chat", primaryModelCode: "doubao-seed-2-0-lite-260428", fallbackModelCode: "glm-5.2" },
  { code: "chat/pro", category: "chat", primaryModelCode: "doubao-seed-2-0-pro-260215", fallbackModelCode: "doubao-seed-2-0-lite-260428" },
  { code: "chat/cheap", category: "chat", primaryModelCode: "deepseek-chat-v3", fallbackModelCode: null },
  { code: "embedding/default", category: "embedding", primaryModelCode: "embedding-3", fallbackModelCode: null },
  { code: "rerank/default", category: "rerank", primaryModelCode: "rerank-v1", fallbackModelCode: null },
  { code: "chat/internal", category: "chat", primaryModelCode: "qwen3-8b-internal", fallbackModelCode: null, isActive: false },
];

/**
 * Per-scenario entry points on top of the six canonical ones. NOT padded to
 * 100+: `code` is a curated, caller-facing namespace that business systems
 * hard-code (the page says as much - "创建后改动等于让调用方 404"). A platform
 * with a hundred distinct capability names has a naming problem, not a
 * scale one. ~35 is enough to page through and still be believable.
 */
const ENDPOINT_SCENARIOS = ["summarize", "classify", "extract", "translate", "rewrite", "code", "sql", "vision", "long-context", "cheap-bulk", "eval", "draft"];
for (const [i, s] of ENDPOINT_SCENARIOS.entries()) {
  for (const suffix of ["default", "pro"]) {
    ENDPOINTS.push({
      code: `${s}/${suffix}`,
      category: "chat",
      primaryModelCode: CHAT_MODEL_CODES[(i * 3 + suffix.length) % CHAT_MODEL_CODES.length],
      fallbackModelCode: brnd() < 0.4 ? CHAT_MODEL_CODES[(i * 7 + 1) % CHAT_MODEL_CODES.length] : null,
      isActive: brnd() < 0.85,
    });
  }
}

/**
 * Gateway caller keys (vxture-atlas#144) - the INBOUND direction, distinct
 * from the provider vault below. `keyHash` is sha256 of a fake secret nobody
 * holds: these are list-view fixtures, and nothing authenticates against them
 * anyway (TD-029 - the keys are not wired into any auth path yet). Prefixes
 * follow the real generator's shape so the masked column renders truthfully.
 */
const GATEWAY_KEYS = [
  // All `external`: incr/08 retired the internal kind, and the check
  // constraint refuses one on INSERT. That is why there are no legacy internal
  // rows here even though production still holds some - a seed builds the
  // database the way the APPLICATION would, and a fixture that needs the
  // constraint bypassed is a fixture of a state the system cannot produce.
  //
  // `lastUsedAt` is null on every row on purpose. Nothing authenticates with
  // these keys (TD-029), so the real column can never be anything else;
  // populating it would fabricate evidence of a capability that does not
  // exist.
  // Four operator-visible states need three stored ones plus the clock: an
  // active key past its term reads `expired` without anything writing it.
  { name: "partner-sandbox", kind: "external", owner: "acme-partner", status: "active", lastUsedAt: null, expiresInDays: 90 },
  { name: "partner-expired", kind: "external", owner: "acme-partner", status: "active", lastUsedAt: null, expiresInDays: -14 },
  { name: "partner-batch", kind: "external", owner: "acme-partner", status: "disabled", lastUsedAt: null },
  { name: "partner-legacy", kind: "external", owner: "globex-partner", status: "revoked", lastUsedAt: null },
];

/**
 * More gateway keys. Keys are issued per consuming service AND rotated over
 * time, and rotation/revocation keeps the old row (status=revoked) rather
 * than deleting it - so the table accumulates well past the count of live
 * callers. Generated below the curated five.
 */
const KEY_SERVICES = ["karda", "terra", "ontos", "varda", "arda", "runos", "opera-bff", "admin-bff", "console-bff", "batch-worker", "eval-harness", "migration-tool"];
const KEY_PARTNERS = ["acme-partner", "globex-integration", "initech-poc", "northwind-trial", "stark-labs"];

// --------------------------------------------------------------------------

/**
 * AES-256-GCM, laid out as `iv || authTag || ciphertext`.
 *
 * Note the layout: provider-key-crypto.ts's own header comment and
 * 00_baseline.sql's schema comment both describe `nonce || ciphertext || tag`,
 * but the code writes and reads the tag second. The code is internally
 * consistent, so nothing is broken - the comments are wrong, and anything
 * written from them (this script, at first) fails to decrypt.
 */
function envelopeEncrypt(plaintext, masterKeyB64) {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function resolveMasterKey() {
  const raw = process.env["PROVIDER_KEY_ENCRYPTION_KEYS"];
  const activeId = process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"];
  if (!raw || !activeId) {
    throw new Error(
      "PROVIDER_KEY_ENCRYPTION_KEYS / _ACTIVE_KEY_ID are not set - the managed vault cannot be seeded",
    );
  }
  const keys = JSON.parse(raw);
  if (!keys[activeId]) throw new Error(`active key id "${activeId}" is not in the key set`);
  return { activeId, key: keys[activeId] };
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400_000);
}

function hoursAgo(n) {
  return new Date(Date.now() - n * 3600_000);
}

/** sha256 of a value nobody holds - see GATEWAY_KEYS. */
function fakeKeyHash(seed) {
  return createHash("sha256").update(`seed:${seed}`, "utf8").digest("hex");
}

async function main() {
  // Full replace, and DELETE rather than TRUNCATE. This script connects as
  // atlas_svc, exactly like the application: SELECT/INSERT/DELETE plus a
  // column-level UPDATE whitelist, no TRUNCATE, and no UPDATE on identity
  // columns (98_column_locks.sql, enforced by Postgres). An upsert would try
  // to write provider_code / model_code and be refused - correctly. Deleting
  // and re-inserting is both permitted and idempotent.
  console.log("clearing registry tables");
  await prisma.modelGrant.deleteMany({});
  await prisma.modelPriceRule.deleteMany({});
  await prisma.modelPolicy.deleteMany({});
  await prisma.keyRotationLog.deleteMany({});
  await prisma.providerApiKey.deleteMany({});
  await prisma.gatewayApiKey.deleteMany({});
  await prisma.modelEndpoint.deleteMany({});
  await prisma.modelDefinition.deleteMany({});
  await prisma.modelProvider.deleteMany({});

  const providerIds = new Map();
  for (const p of PROVIDERS) {
    const row = await prisma.modelProvider.create({
      data: { ...p, createdBy: OPERATOR, updatedBy: OPERATOR },
    });
    providerIds.set(p.providerCode, row.id);
  }
  console.log(`providers: ${PROVIDERS.length}`);

  const modelIds = new Map();
  for (const m of MODELS) {
    const { providerCode, ...rest } = m;
    const data = { ...rest, providerId: providerIds.get(providerCode) };
    const row = await prisma.modelDefinition.create({
      data: { ...data, createdBy: OPERATOR, updatedBy: OPERATOR },
    });
    modelIds.set(m.modelCode, row.id);
  }
  console.log(`models: ${MODELS.length}`);

  for (const g of GRANTS) {
    await prisma.modelGrant.create({
      data: {
        modelId: modelIds.get(g.modelCode),
        tenantId: TENANT[g.tenant],
        applicationId: g.applicationId ?? null,
        applicationType: g.applicationType ?? null,
        taskProfile: g.taskProfile ?? null,
        priority: g.priority ?? 100,
        isActive: g.isActive ?? true,
        reason: g.reason ?? null,
        expiresAt: g.expiresInDays === undefined ? null : daysFromNow(g.expiresInDays),
        createdBy: OPERATOR,
        updatedBy: OPERATOR,
      },
    });
  }
  console.log(`grants: ${GRANTS.length} (tenant axis, legacy)`);

  /**
   * Product-scoped authorization (incr/06) - the axis that replaces the one
   * above. A product holds ENTRY POINTS; the models it may name fall out of
   * what those entry points reach, so there is nothing here keyed on a model.
   *
   * Seeded ALONGSIDE the tenant grants, not instead of them: both axes are
   * live during the migration, and a fixture carrying only the new axis could
   * not exercise the fallback that keeps existing traffic working.
   */
  await prisma.productEndpointGrant.deleteMany({});
  const PRODUCT_CODES = ["karda", "arda", "varda", "runos"];
  const productGrants = [];
  for (const [pi, productCode] of PRODUCT_CODES.entries()) {
    for (const [ei, endpoint] of ENDPOINTS.entries()) {
      // Each product holds a different slice, so "which products can reach
      // this endpoint" is a question with a non-trivial answer.
      if ((ei + pi) % 3 !== 0) continue;
      const scoped = brnd() < 0.2;
      productGrants.push({
        productCode,
        endpointCode: endpoint.code,
        applicationId: scoped ? uuid("c000", 7000 + pi) : null,
        applicationType: scoped ? "agent" : null,
        isActive: brnd() < 0.9,
        reason: `${productCode} holds ${endpoint.code}`,
        createdBy: OPERATOR,
        updatedBy: OPERATOR,
      });
    }
  }
  await prisma.productEndpointGrant.createMany({ data: productGrants });
  console.log(
    `product endpoint grants: ${productGrants.length} ` +
      `(${PRODUCT_CODES.length} products x a slice of ${ENDPOINTS.length} endpoints, ` +
      `${productGrants.filter((g) => !g.isActive).length} deactivated)`,
  );

  for (const p of PRICES) {
    await prisma.modelPriceRule.create({
      data: {
        modelId: modelIds.get(p.modelCode),
        billingMode: p.billingMode ?? "token",
        currency: p.currency ?? "CNY",
        unitTokens: 1000000,
        inputUnitPrice: p.input,
        outputUnitPrice: p.output,
        requestUnitPrice: p.request ?? "0",
        // Three distinct lifecycle states, all of which occur in production:
        //   expiredDaysAgo     superseded AND deactivated (the tidy case)
        //   staleActiveDaysAgo expired but still is_active - nothing flips it,
        //                      there is no sweeper by design, so only an
        //                      `?asOf=` read can tell this apart
        //   effectiveInDays    scheduled, not yet in force
        isActive: p.expiredDaysAgo === undefined,
        ...(p.expiredDaysAgo !== undefined
          ? { effectiveAt: daysFromNow(-90), expiresAt: daysFromNow(-p.expiredDaysAgo) }
          : {}),
        ...(p.staleActiveDaysAgo !== undefined
          ? {
              effectiveAt: daysFromNow(-p.staleActiveDaysAgo - 60),
              expiresAt: daysFromNow(-p.staleActiveDaysAgo),
            }
          : {}),
        ...(p.effectiveInDays !== undefined
          ? { effectiveAt: daysFromNow(p.effectiveInDays) }
          : {}),
        createdBy: OPERATOR,
        updatedBy: OPERATOR,
      },
    });
  }
  console.log(`price rules: ${PRICES.length}`);

  for (const p of POLICIES) {
    const modelId = modelIds.get(p.modelCode);
    const tenantId = p.tenant ? TENANT[p.tenant] : null;
    const data = {
      modelId,
      tenantId,
      name: p.name,
      priority: p.priority ?? 100,
      maxConcurrent: p.maxConcurrent ?? null,
      rateLimitRpm: p.rateLimitRpm ?? null,
      rateLimitTpm: p.rateLimitTpm ?? null,
      rateLimitTpd: p.rateLimitTpd ?? null,
      maxContextTokens: p.maxContextTokens ?? null,
      // findApplicablePolicy filters on is_active AND effective_at <= now AND
      // (expires_at IS NULL OR expires_at > now). All three need a negative
      // sample or the predicate is never actually exercised.
      isActive: p.isActive ?? true,
      ...(p.expiredDaysAgo !== undefined
        ? { effectiveAt: daysFromNow(-p.expiredDaysAgo - 60), expiresAt: daysFromNow(-p.expiredDaysAgo) }
        : {}),
      ...(p.effectiveInDays !== undefined
        ? { effectiveAt: daysFromNow(p.effectiveInDays) }
        : {}),
      updatedBy: OPERATOR,
    };
    await prisma.modelPolicy.create({ data: { ...data, createdBy: OPERATOR } });
  }
  console.log(`policies: ${POLICIES.length}`);

  for (const e of ENDPOINTS) {
    await prisma.modelEndpoint.create({
      data: {
        code: e.code,
        category: e.category,
        primaryModelCode: e.primaryModelCode,
        fallbackModelCode: e.fallbackModelCode ?? null,
        isActive: e.isActive ?? true,
        createdBy: OPERATOR,
        updatedBy: OPERATOR,
      },
    });
  }
  const failoverCount = ENDPOINTS.filter((e) => e.fallbackModelCode).length;
  console.log(
    `endpoints: ${ENDPOINTS.length} (${failoverCount} failover, ${ENDPOINTS.length - failoverCount} single) - backs both the Endpoint and Router pages`,
  );

  for (let i = 0; i < 115; i++) {
    const external = true; // the only kind that can be issued (incr/08)
    const owner = external ? bpick(KEY_PARTNERS) : bpick(KEY_SERVICES);
    // Weighted toward historical (revoked/disabled) rows: rotation keeps the
    // old key, so a mature table is mostly not-live.
    const status = brnd() < 0.4 ? "active" : brnd() < 0.5 ? "disabled" : "revoked";
    GATEWAY_KEYS.push({
      name: `${owner}-${external ? "ext" : "svc"}-${String(i).padStart(3, "0")}`,
      kind: external ? "external" : "internal",
      owner,
      status,
      // Always null - see the note above. Nothing authenticates with these.
      lastUsedAt: null,
      // ~18% carry a term, half of those already past it, so the `expired`
      // state has rows and is not a code path nobody has seen.
      expiresInDays: brnd() < 0.18 ? (brnd() < 0.5 ? -bint(1, 60) : bint(30, 365)) : null,
    });
  }

  for (const [i, k] of GATEWAY_KEYS.entries()) {
    const tag = k.kind === "internal" ? "vxk_int_" : "vxk_ext_";
    await prisma.gatewayApiKey.create({
      data: {
        name: k.name,
        kind: k.kind,
        owner: k.owner,
        keyPrefix: `${tag}${fakeKeyHash(k.name).slice(0, 8)}`,
        keyHash: fakeKeyHash(`${i}:${k.name}`),
        status: k.status,
        lastUsedAt: k.lastUsedAt,
        expiresAt:
          k.expiresInDays === undefined || k.expiresInDays === null
            ? null
            : daysFromNow(k.expiresInDays),
        createdBy: OPERATOR,
        updatedBy: OPERATOR,
      },
    });
  }
  console.log(
    `gateway api keys: ${GATEWAY_KEYS.length} (fixtures only - not wired into any auth path, TD-029)`,
  );

  // Managed provider keys. Only doubao's is real; the rest are placeholders
  // that encrypt and decrypt correctly but will not authenticate upstream.
  const { activeId, key } = resolveMasterKey();
  const realDoubao = process.env["DOUBAO_API_KEY"];
  if (!realDoubao) throw new Error("DOUBAO_API_KEY is not set - .env.provider-keys missing?");
  const VAULT = [
    { providerCode: "doubao", keyAlias: "primary", secret: realDoubao, scope: "shared" },
    // A retired key kept alongside the live one: same provider, different
    // alias, inactive. Deactivating rather than deleting is what the rotation
    // flow does, so the registry must be readable in that state.
    { providerCode: "doubao", keyAlias: "retired-2026q2", secret: "fixture-doubao-old-key", scope: "shared", isActive: false },
    // key_scope=dedicated: a key reserved for one tenant rather than shared
    // across the provider.
    { providerCode: "zhipu", keyAlias: "acme-dedicated", secret: "fixture-zhipu-dedicated", scope: "dedicated" },
    { providerCode: "zhipu", keyAlias: "primary", secret: "fixture-zhipu-key-not-real", scope: "shared" },
    { providerCode: "deepseek", keyAlias: "primary", secret: "fixture-deepseek-key-not-real", scope: "shared" },
    { providerCode: "anthropic", keyAlias: "primary", secret: "fixture-anthropic-key-not-real", scope: "shared" },
  ];
  // Provider keys are bounded by providers, NOT padded to 100+: a key is
  // (provider_code, key_alias) and there are five providers. What genuinely
  // accumulates is the alias history - rotation deactivates rather than
  // deletes - so each provider carries several retired aliases. ~40 rows is
  // the honest ceiling for 5 providers; a hundred would mean 20 live keys per
  // vendor, which no one operates.
  for (const p of PROVIDERS) {
    for (let q = 1; q <= 7; q++) {
      VAULT.push({
        providerCode: p.providerCode,
        keyAlias: `retired-2025q${q <= 4 ? q : q - 4}-${q}`,
        secret: `fixture-${p.providerCode}-retired-${q}`,
        scope: brnd() < 0.25 ? "dedicated" : "shared",
        isActive: false,
      });
    }
  }

  for (const v of VAULT) {
    const encryptedKey = envelopeEncrypt(v.secret, key);
    const row = await prisma.providerApiKey.create({
      data: {
        providerCode: v.providerCode,
        keyAlias: v.keyAlias,
        encryptedKey,
        encryptionKeyId: activeId,
        keyScope: v.scope,
        isActive: v.isActive ?? true,
        lastRotatedAt: new Date(),
      },
    });
    // Append-only rotation audit (no UPDATE granted on this table at all).
    // The live doubao key gets a history, not a single row, so the log is
    // exercised as a series rather than a one-off.
    const history =
      v.keyAlias === "primary" && v.providerCode === "doubao"
        ? [
            { reason: "initial onboarding", at: daysFromNow(-120) },
            { reason: "quarterly rotation", at: daysFromNow(-30) },
            { reason: "seeded by scripts/dev/seed-test-data.mjs", at: new Date() },
          ]
        : [
            { reason: "seeded by scripts/dev/seed-test-data.mjs", at: new Date() },
            // Every key carries a rotation history. This log is append-only
            // and never pruned, so in production it is strictly larger than
            // the key table - generated accordingly rather than one-per-key.
            ...Array.from({ length: bint(1, 4) }, () => ({
              reason: bpick([
                "quarterly rotation",
                "scheduled rotation",
                "credential exposure drill",
                "vendor-initiated reissue",
                "operator offboarding",
              ]),
              at: daysFromNow(-bint(10, 400)),
            })),
          ];
    for (const h of history) {
      await prisma.keyRotationLog.create({
        data: {
          providerApiKeyId: row.id,
          rotatedBy: OPERATOR,
          reason: h.reason,
          rotatedAt: h.at,
        },
      });
    }
  }
  console.log(`provider keys: ${VAULT.length} (doubao real, rest fixtures)`);

  // Request log. This backs THREE operator surfaces that were otherwise
  // reading whatever incidental traffic a local smoke test happened to leave
  // behind: /capability/usage-summaries (Metering), /capability/logs and
  // /logs/summary (log search), and /tenancy/usage. Before this, a dev
  // database typically held one tenant on one day, so Metering aggregated to
  // a single row and looked broken.
  //
  // Spread deliberately across two months, five tenants, four application
  // types and every seeded chat model, because every one of those is a GROUP
  // BY key or a filter on one of those three surfaces. Only 2026-07 and
  // 2026-08 partitions are targeted - writing outside the provisioned range
  // would land rows in the DEFAULT partition, which is exactly the silent
  // failure mode TD-018 exists about.
  await prisma.errorRecord.deleteMany({});
  await prisma.requestRecord.deleteMany({});

  // Which product made the call - `act.sub` on the verified S2S token. This is
  // an AGGREGATION axis (what does karda cost to run), distinct from the
  // billing subject, which is the (tenant, workspace) pair.
  const PRODUCTS = ["karda", "arda", "varda", "runos"];

  /**
   * tenant -> workspaces is 1:N, and the fixture has to show it. Every tenant
   * carried exactly one workspace until now, which made the (tenant,
   * workspace) billing subject indistinguishable from tenant alone - the core
   * metering axis would have looked correct against data that could not
   * disprove it, and opera would have built a page on that illusion.
   *
   * Distribution is deliberately uneven: most tenants have one workspace, some
   * have a few, one has many. A uniform fan-out would hide the case where a
   * single workspace dominates a tenant's spend, which is the reason the pair
   * is the subject rather than the tenant.
   */
  const WORKSPACES_OF = new Map();
  const workspacesFor = (tenantKey, tenantIndex) => {
    if (!WORKSPACES_OF.has(tenantKey)) {
      const n = tenantIndex % 7 === 0 ? 5 : tenantIndex % 3 === 0 ? 3 : 1;
      const base = WORKSPACE[tenantKey] ?? uuid("b000", 3300 + tenantIndex * 8);
      WORKSPACES_OF.set(
        tenantKey,
        [base, ...Array.from({ length: n - 1 }, (_, k) =>
          uuid("b000", 3300 + tenantIndex * 8 + k + 1))],
      );
    }
    return WORKSPACES_OF.get(tenantKey);
  };

  const CALLERS = [
    { tenant: "acme", workspace: "acme", appType: "agent", app: AGENT },
    { tenant: "acme", workspace: "acme", appType: "workflow", app: "00000000-0000-4000-c000-00000000b001" },
    { tenant: "globex", workspace: "globex", appType: "agent", app: "00000000-0000-4000-c000-00000000a002" },
    { tenant: "globex", workspace: "globex", appType: "api_client", app: "00000000-0000-4000-c000-00000000c001" },
    { tenant: "initech", workspace: "initech", appType: "internal_service", app: "00000000-0000-4000-c000-00000000d001" },
    { tenant: "personal", workspace: "personal", appType: "agent", app: "00000000-0000-4000-c000-00000000a003" },
    // Plus the generated orgs, so Metering's per-tenant grouping has real
    // breadth instead of six rows.
    ...ORG_NAMES.slice(0, 18).map((name, i) => ({
      tenant: name,
      workspace: name,
      appType: APP_TYPES[i % APP_TYPES.length],
      app: uuid("c000", 6000 + i),
    })),
  ];
  const CALL_MIX = [
    { modelCode: "doubao-seed-2-0-lite-260428", providerCode: "doubao", weight: 30 },
    { modelCode: "doubao-seed-2-0-pro-260215", providerCode: "doubao", weight: 12 },
    { modelCode: "glm-5.2", providerCode: "zhipu", weight: 18 },
    { modelCode: "deepseek-chat-v3", providerCode: "deepseek", weight: 14 },
    { modelCode: "qwen3-8b-internal", providerCode: "private", weight: 10 },
    { modelCode: "embedding-3", providerCode: "zhipu", weight: 12 },
    { modelCode: "rerank-v1", providerCode: "zhipu", weight: 4 },
  ];
  const FAILURES = [
    { status: "error", errorCode: "PROVIDER_UNAVAILABLE", errorMessage: "upstream returned 503" },
    { status: "error", errorCode: "RATE_LIMITED", errorMessage: "provider rate limit hit" },
    { status: "timeout", errorCode: "UPSTREAM_TIMEOUT", errorMessage: "no first byte within 30000ms" },
  ];

  // Deterministic PRNG - a fixed seed keeps re-runs byte-identical, so a
  // number that looks wrong on a page can be reproduced instead of chased.
  let rngState = 0x2f6e2b1;
  const rnd = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const weightedModel = () => {
    const total = CALL_MIX.reduce((n, m) => n + m.weight, 0);
    let r = rnd() * total;
    for (const m of CALL_MIX) if ((r -= m.weight) < 0) return m;
    return CALL_MIX[0];
  };

  /**
   * Which entry points could plausibly have routed a call to a given model:
   * the endpoints naming it as primary or as fallback. Attribution has to be
   * CONSISTENT - an endpoint row whose modelCode is not reachable from that
   * endpoint would make an operator drilling endpoint -> model see nonsense,
   * and would quietly teach us to trust a join that does not hold.
   *
   * Deactivated endpoints stay in the map on purpose: traffic that ran
   * through an entry point later switched off is a real historical state, and
   * the read path must survive it.
   */
  const PROVIDER_BY_MODEL = new Map(
    MODELS.map((m) => [m.modelCode, m.providerCode]),
  );
  /**
   * Endpoint-routed calls are generated FROM the endpoint, not matched to it
   * afterwards: pick an entry point, then use the model it actually routes to.
   * Deriving it the other way round covered only the handful of models in
   * CALL_MIX, so 23 of 30 endpoints carried zero traffic and the endpoint
   * dimension looked broken rather than sparse.
   *
   * Deactivated endpoints are included on purpose - traffic through an entry
   * point later switched off is a real historical state the read path has to
   * survive.
   */
  const ENDPOINT_CALLS = ENDPOINTS.flatMap((e) =>
    [e.primaryModelCode, e.fallbackModelCode]
      .filter(Boolean)
      .filter((code) => PROVIDER_BY_MODEL.has(code))
      .map((code) => ({
        endpointCode: e.code,
        modelCode: code,
        providerCode: PROVIDER_BY_MODEL.get(code),
      })),
  );

  const requests = [];
  const errors = [];
  // July gets fewer calls than August, so the Metering page shows movement
  // month over month rather than two identical-looking rows.
  // Volume is set so the DERIVED table clears 100 too: error_records is ~7%
  // of this, so a few hundred requests would leave the error log (and the
  // log-search error join) under-populated.
  for (const [month, count] of [["2026-07", 700], ["2026-08", 1150]]) {
    const [y, m] = month.split("-").map(Number);
    const daysInMonth = m === 8 ? 12 : 31; // August is the current month - stop mid-month
    for (let i = 0; i < count; i++) {
      const caller = pick(CALLERS);
      // ~60% of calls arrive through an entry point; the rest name a model or
      // taskProfile directly. NULL endpointCode is a real routing mode, NOT
      // missing data - the endpoint rollup excludes it rather than bucketing
      // it, and a fixture set with no NULLs would hide that behaviour.
      const viaEndpoint = rnd() < 0.6 ? pick(ENDPOINT_CALLS) : null;
      const model = viaEndpoint ?? weightedModel();
      const endpointCode = viaEndpoint ? viaEndpoint.endpointCode : null;
      const day = 1 + Math.floor(rnd() * daysInMonth);
      const createdAt = new Date(Date.UTC(y, m - 1, day, Math.floor(rnd() * 24), Math.floor(rnd() * 60)));
      // ~7% failures, enough for an error rate that is visibly non-zero
      // without drowning the success path.
      const failed = rnd() < 0.07;
      const failure = failed ? pick(FAILURES) : null;
      const requestId = `seed-${month}-${String(i).padStart(4, "0")}`;
      const input = 80 + Math.floor(rnd() * 900);
      const output = failed ? 0 : 40 + Math.floor(rnd() * 700);

      requests.push({
        requestId,
        tenantId: TENANT[caller.tenant],
        // Weighted toward the first workspace so one of a tenant's workspaces
        // dominates - the realistic shape, and the one that makes grouping by
        // tenant alone visibly wrong.
        workspaceId: (() => {
          const ws = workspacesFor(caller.tenant, CALLERS.indexOf(caller));
          return rnd() < 0.6 ? ws[0] : pick(ws);
        })(),
        productCode: pick(PRODUCTS),
        applicationId: caller.app,
        applicationType: caller.appType,
        agentId: caller.appType === "agent" ? caller.app : null,
        modelCode: model.modelCode,
        providerCode: model.providerCode,
        endpointCode,
        inputTokens: BigInt(input),
        outputTokens: BigInt(output),
        totalTokens: BigInt(input + output),
        latencyMs: failure?.status === "timeout"
          ? 30000 + Math.floor(rnd() * 2000)
          : 200 + Math.floor(rnd() * 3200),
        // TD-024: the real chat path still writes NULL here. These fixtures
        // write the intended values so the filter can be exercised - do not
        // read this as evidence the write path is fixed.
        usageType: rnd() < 0.06 ? "retry" : "normal",
        status: failure ? failure.status : "success",
        createdAt,
      });

      if (failure) {
        errors.push({
          requestId,
          providerCode: model.providerCode,
          modelCode: model.modelCode,
          endpointCode,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          createdAt,
        });
      }
    }
  }
  await prisma.requestRecord.createMany({ data: requests });
  await prisma.errorRecord.createMany({ data: errors });
  console.log(
    `reqlog: ${requests.length} requests (${errors.length} failed) over 2 months, ` +
      `${CALLERS.length} caller scopes, ${CALL_MIX.length} models, ` +
      `${requests.filter((r) => r.endpointCode).length} via an endpoint ` +
      `(${new Set(requests.map((r) => r.endpointCode).filter(Boolean)).size} distinct), ` +
      `${new Set(requests.map((r) => r.productCode)).size} products`,
  );

  // C3 provisioning receiver state. The webhook is implemented and tested but
  // its two tables had no seeded rows at all, so nothing exercised a read of
  // them. Deliveries are the append-only idempotency ledger; the
  // provisionings row is the per-workspace status with a monotonic seq.
  await prisma.webhookDelivery.deleteMany({});
  await prisma.workspaceProvisioning.deleteMany({});
  const PROVISIONED = [
    { key: "acme", status: "provisioned", seq: 3n },
    { key: "globex", status: "provisioned", seq: 1n },
    // Only pending/provisioned/deprovisioned exist - the DDL CHECK
    // constraint rejects anything else, which is how it should be.
    { key: "initech", status: "pending", seq: 5n },
    { key: "personal2", status: "deprovisioned", seq: 2n },
    // One row per workspace Atlas has ever been provisioned for - grows with
    // the customer base, so it is generated across every tenant above rather
    // than left at the four hand-written ones. Deliveries below are the
    // append-only ledger and are strictly larger again (seq per workspace).
    ...ORG_NAMES.map((name) => ({
      key: name,
      status: brnd() < 0.8 ? "provisioned" : brnd() < 0.5 ? "pending" : "deprovisioned",
      seq: BigInt(bint(1, 6)),
    })),
    // Workspaces without a named tenant of their own. Provisioning is keyed
    // by (workspace_id, product_code) and a workspace is provisioned the
    // moment a customer enables Atlas, so this table tracks the customer base
    // and is not bounded by how many orgs the rest of this script names.
    ...Array.from({ length: 90 }, (_, i) => ({
      workspaceId: uuid("b000", 3200 + i),
      tenantId: uuid("b000", 2200 + i),
      label: `ws${String(i).padStart(3, "0")}`,
      status: brnd() < 0.82 ? "provisioned" : brnd() < 0.5 ? "pending" : "deprovisioned",
      seq: BigInt(bint(1, 4)),
    })),
  ];
  for (const w of PROVISIONED) {
    const workspaceId = w.workspaceId ?? WORKSPACE[w.key];
    const tenantId = w.tenantId ?? TENANT[w.key];
    const label = w.key ?? w.label;
    await prisma.workspaceProvisioning.create({
      data: {
        workspaceId,
        tenantId,
        productCode: "atlas",
        status: w.status,
        seq: w.seq,
        provisionedAt: daysFromNow(-60),
        ...(w.status === "deprovisioned" ? { deprovisionedAt: daysFromNow(-5) } : {}),
      },
    });
    for (let i = 1n; i <= w.seq; i++) {
      await prisma.webhookDelivery.create({
        data: {
          deliveryId: `seed-${label}-${i}`,
          workspaceId,
          productCode: "atlas",
          eventType: i === 1n ? "workspace.provisioned" : "workspace.updated",
          seq: i,
          receivedAt: daysFromNow(-60 + Number(i)),
        },
      });
    }
  }
  console.log(
    `provisioning: ${PROVISIONED.length} workspaces, ${PROVISIONED.reduce((n, w) => n + Number(w.seq), 0)} webhook deliveries`,
  );

  await seedAuditTrail();
}

/**
 * Operator change trail (vxture-atlas#159 §6).
 *
 * APPENDS - it cannot clear first, and that is not an oversight. This script
 * connects as `atlas_svc`, which holds INSERT and SELECT on
 * `audit.change_records` and deliberately nothing else: an audit trail the
 * service can erase is not an audit trail. So instead of deleting, it skips
 * when rows already exist. Resetting the fixture set is a superuser action:
 *
 *   docker exec vx-atlas-postgres-db-dev  *     psql -U postgres -d vx_atlas_db -c 'DELETE FROM audit.change_records'
 *
 * Coverage is deliberately not all-happy-path: failed attempts, unattributed
 * attempts, and destructive actions are all represented, because those are the
 * rows an auditor actually goes looking for.
 */
async function seedAuditTrail() {
  const existing = await prisma.changeRecord.findMany({ take: 1 });
  if (existing.length > 0) {
    console.log("audit: rows already present, skipping (append-only, see comment)");
    return;
  }

  const OPERATORS = [
    { sub: "opr_11111111-1111-4111-8111-111111111111", actor: "console" },
    { sub: "opr_22222222-2222-4222-8222-222222222222", actor: "console" },
    { sub: "opr_33333333-3333-4333-8333-333333333333", actor: "capconsole-bff" },
    { sub: "opr_44444444-4444-4444-8444-444444444444", actor: "console" },
  ];
  // Only combinations the HTTP surface can actually produce - a fixture set
  // containing a route that does not exist teaches a reader the wrong API.
  const SHAPES = [
    { resourceType: "providers", actions: ["create", "update", "activate", "deactivate", "delete", "probe"], fields: ["providerName", "description", "config"] },
    { resourceType: "models", actions: ["create", "update", "activate", "deactivate", "delete", "probe"], fields: ["modelName", "config", "sort"] },
    { resourceType: "endpoints", actions: ["create", "update", "activate", "deactivate", "delete"], fields: ["primaryModelCode", "fallbackModelCode"] },
    { resourceType: "grants", actions: ["create", "update", "activate", "deactivate", "delete"], fields: ["priority", "expiresAt", "reason"] },
    { resourceType: "price-rules", actions: ["create", "update", "activate", "deactivate"], fields: ["inputUnitPrice", "outputUnitPrice", "expiresAt"] },
    { resourceType: "policies", actions: ["create", "update", "activate", "deactivate"], fields: ["rpmLimit", "maxConcurrent"] },
    // Field NAMES only, never values - these two carry secrets in the body.
    { resourceType: "provider-keys", actions: ["create", "rotate", "activate", "deactivate"], fields: ["providerCode", "keyAlias", "apiKey"] },
    { resourceType: "api-keys", actions: ["create", "rotate", "activate", "deactivate", "revoke"], fields: ["name", "kind", "owner"] },
  ];

  let seed = 0x5eed17;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const rows = [];
  for (let i = 0; i < 240; i++) {
    const shape = pick(SHAPES);
    const action = pick(shape.actions);
    const operator = pick(OPERATORS);
    // ~12% failures: a rejected change is still an attempt, and a burst of
    // them is the shape most worth seeing.
    const failed = rnd() < 0.12;
    // ~3% with no attributable operator - a request the guard rejected before
    // any handler ran. Rare, and precisely what an auditor hunts for.
    const unattributed = rnd() < 0.03;

    rows.push({
      resourceType: shape.resourceType,
      resourceId: action === "create" ? null : uuid("d000", 1000 + (i % 60)),
      action,
      operatorSub: unattributed ? "unknown" : operator.sub,
      actorClientId: unattributed ? null : operator.actor,
      changedFields:
        action === "create" || action === "update"
          ? shape.fields.slice(0, 1 + Math.floor(rnd() * shape.fields.length))
          : [],
      requestId: `seed-audit-${String(i).padStart(4, "0")}`,
      outcome: unattributed || failed ? "failure" : "success",
      occurredAt: daysFromNow(-45 * rnd()),
    });
  }

  await prisma.changeRecord.createMany({ data: rows });
  const failures = rows.filter((r) => r.outcome === "failure").length;
  console.log(
    `audit: ${rows.length} change records (${failures} failed, ` +
      `${rows.filter((r) => r.operatorSub === "unknown").length} unattributed), ` +
      `${new Set(rows.map((r) => r.resourceType)).size} resource types, ` +
      `${OPERATORS.length} operators`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
