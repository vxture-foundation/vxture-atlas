/**
 * 线协议词表（docs/30-design/100-model-onboarding-and-protocol-adapters.md §5）。
 *
 * 这是一个**封闭**词表，按线格式命名而不是按厂商命名：`doubao` 是厂商，
 * `openai-chat-completions` 才是协议。一家上游讲什么协议决定用哪个适配器；
 * 它是谁（provider_code）与它有什么参数怪癖（config.wire）都不在这里。
 *
 * 新增一个取值 = 新增一个适配器 = 一次发版。这是有意的门槛：只有真正不同的
 * 线格式（请求形状 / 响应形状 / 流式事件模型）才配拥有一个 protocol 值。
 */
export const MODEL_PROTOCOLS = [
  "openai-chat-completions",
  "anthropic-messages",
] as const;

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

/**
 * 存量与手写值的别名。
 */
const ALIASES: Record<string, ModelProtocol> = {
  openai: "openai-chat-completions",
  "openai-compatible": "openai-chat-completions",
  "chat-completions": "openai-chat-completions",
  anthropic: "anthropic-messages",
  claude: "anthropic-messages",
  messages: "anthropic-messages",
};

/**
 * 归一化一个 protocol 取值；无法识别时返回 undefined（由调用方决定回退还是
 * 报错，见 `ModelRouterService`）。
 *
 * 大小写、首尾空白、下划线与连字符一律不敏感 —— 这些差异是录入习惯，不是
 * 语义。
 */
export function normalizeProtocol(
  value: string | null | undefined,
): ModelProtocol | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;

  if ((MODEL_PROTOCOLS as readonly string[]).includes(normalized)) {
    return normalized as ModelProtocol;
  }

  return ALIASES[normalized];
}

/** 某个规范值可接受的所有别名（供管理面展示，说明为什么旧值仍能录入）。 */
export function aliasesFor(protocol: ModelProtocol): string[] {
  return Object.entries(ALIASES)
    .filter(([, target]) => target === protocol)
    .map(([alias]) => alias)
    .sort();
}

export interface ProtocolDescriptor {
  protocol: ModelProtocol;
  /** 面向运营的一句话说明：这个 protocol 覆盖哪些上游。 */
  description: string;
  /** 已知讲这套方言的上游，仅作录入提示，**不是**白名单。 */
  knownUpstreams: string[];
  aliases: string[];
}

/**
 * 管理面的下拉数据源。
 *
 * `knownUpstreams` 是提示而非约束 —— 词表按线格式定义，任何讲这套方言的上游
 * 都能用，哪怕它不在这个列表里。把它当白名单就又把"接入"变回了发版。
 */
export const PROTOCOL_CATALOG: readonly ProtocolDescriptor[] = Object.freeze([
  {
    protocol: "openai-chat-completions",
    description:
      "OpenAI /chat/completions dialect - the default for any OpenAI-compatible upstream.",
    knownUpstreams: [
      "doubao",
      "zhipu",
      "deepseek",
      "qwen",
      "moonshot",
      "siliconflow",
      "openai",
      "vllm",
      "ollama",
    ],
    aliases: aliasesFor("openai-chat-completions"),
  },
  {
    protocol: "anthropic-messages",
    description:
      "Anthropic /v1/messages - distinct request, response and streaming event model.",
    knownUpstreams: ["anthropic"],
    aliases: aliasesFor("anthropic-messages"),
  },
]);
