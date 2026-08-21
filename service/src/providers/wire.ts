import { Logger } from "@nestjs/common";

import type { ModelConfig } from "../types/runtime.types";

/**
 * 线格式怪癖描述符（docs/30-design/100-model-onboarding-and-protocol-adapters.md §6）。
 *
 * 同一个 protocol 下，各家上游仍有参数级差异：端点后缀、鉴权头样式、流式要不要
 * 显式 opt-in usage、支不支持 tool calling。这些**不是**协议差异，写进代码就意味着
 * 每接一家改一次代码 —— 所以它们住在 `model_providers.config.wire` 与
 * `model.models.config.wire` 两个**已存在**的 jsonb 列里，零 DDL。
 *
 * 判据是一条线：线格式不同才写代码，参数不同一律写数据。
 */

const logger = new Logger("ModelWire");

/** 当前描述符 schema 版本。新增键要发版，所以这个数字变动很慢。 */
export const WIRE_SCHEMA_VERSION = 1;

export type WireAuthStyle = "bearer" | "x-api-key" | "none";

/**
 * 流式响应里 usage 怎么来：
 * - `stream_options` - 需要在请求体里显式 opt-in（OpenAI 规范行为）
 * - `native`         - 上游自己就会在流里带 usage，不要多发参数
 * - `none`           - 上游根本不在流里回 usage
 */
export type WireStreamUsage = "stream_options" | "native" | "none";

export interface WireSupports {
  tools: boolean;
  toolChoice: boolean;
  topP: boolean;
  temperature: boolean;
}

export interface ResolvedWire {
  schemaVersion: number;
  /** 端点后缀；`null` 表示用适配器默认。 */
  chatPath: string | null;
  authStyle: WireAuthStyle;
  /** 附加的静态请求头（如 Anthropic 的 `anthropic-version`）。 */
  headers: Readonly<Record<string, string>>;
  streamUsage: WireStreamUsage;
  supports: Readonly<WireSupports>;
  /** 规范参数名 -> 上游线上字段名，仅记录与默认不同的。 */
  paramMap: Readonly<Record<string, string>>;
}

const KNOWN_KEYS = new Set([
  "schemaVersion",
  "chatPath",
  "auth",
  "headers",
  "streamUsage",
  "supports",
  "paramMap",
]);

const KNOWN_SUPPORTS = new Set<keyof WireSupports>([
  "tools",
  "toolChoice",
  "topP",
  "temperature",
]);

const AUTH_STYLES = new Set<WireAuthStyle>(["bearer", "x-api-key", "none"]);
const STREAM_USAGES = new Set<WireStreamUsage>([
  "stream_options",
  "native",
  "none",
]);

/**
 * `openai-chat-completions` 的默认怪癖。
 *
 * `streamUsage` 默认 `stream_options` 是一个**有意的行为变更**：此前代码里一处
 * 都没有下发 `stream_options.include_usage`，而 OpenAI 系上游流式默认不回
 * usage，`runtime.service` 又只在 `done` 带 usage 时才写计量 —— 相乘的结果是
 * 流式调用大概率从未被计量（TD-017 流式那一半，设计文档 §9）。
 *
 * 如果某家上游拒绝这个参数，修法是给它写一条 `wire.streamUsage: "none"`
 * 的注册表数据，不需要改代码 —— 这正是本描述符存在的意义。
 */
export const OPENAI_WIRE_DEFAULTS: ResolvedWire = Object.freeze({
  schemaVersion: WIRE_SCHEMA_VERSION,
  chatPath: null,
  authStyle: "bearer",
  headers: Object.freeze({}),
  streamUsage: "stream_options",
  supports: Object.freeze({
    tools: true,
    toolChoice: true,
    topP: true,
    temperature: true,
  }),
  paramMap: Object.freeze({}),
});

/** `anthropic-messages` 的默认怪癖。Anthropic 原生就在流里回 usage。 */
export const ANTHROPIC_WIRE_DEFAULTS: ResolvedWire = Object.freeze({
  schemaVersion: WIRE_SCHEMA_VERSION,
  chatPath: null,
  authStyle: "x-api-key",
  headers: Object.freeze({ "anthropic-version": "2023-06-01" }),
  streamUsage: "native",
  supports: Object.freeze({
    tools: true,
    toolChoice: true,
    topP: true,
    temperature: true,
  }),
  paramMap: Object.freeze({}),
});

/**
 * 合并顺序：适配器默认 <- 服务商 config.wire <- 模型 config.wire。
 *
 * **写入时严格、运行时宽松**（§6）：未知键在 `/capability/*` 的写路径上就被拒；
 * 到了这里只忽略并告警。运营改配置比服务发版快，一个旧版本服务读到新版本写入
 * 的键，不该让一个正在跑的模型停摆。
 */
export function resolveWire(
  defaults: ResolvedWire,
  ...configs: Array<ModelConfig | null | undefined>
): ResolvedWire {
  let result: ResolvedWire = defaults;

  for (const config of configs) {
    const raw = config?.["wire"];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      logger.warn("ignoring config.wire: expected an object");
      continue;
    }
    result = applyOverlay(result, raw as Record<string, unknown>);
  }

  return result;
}

function applyOverlay(
  base: ResolvedWire,
  overlay: Record<string, unknown>,
): ResolvedWire {
  const declaredVersion = readNumber(overlay["schemaVersion"]);
  if (declaredVersion !== undefined && declaredVersion > WIRE_SCHEMA_VERSION) {
    logger.warn(
      `config.wire declares schemaVersion ${declaredVersion} but this build understands ` +
        `${WIRE_SCHEMA_VERSION}; unknown keys will be ignored rather than rejected.`,
    );
  }

  for (const key of Object.keys(overlay)) {
    if (!KNOWN_KEYS.has(key)) {
      logger.warn(`ignoring unknown config.wire key "${key}"`);
    }
  }

  const auth = overlay["auth"];
  const authStyle =
    typeof auth === "object" && auth !== null
      ? readEnum((auth as Record<string, unknown>)["style"], AUTH_STYLES)
      : undefined;

  return {
    schemaVersion: declaredVersion ?? base.schemaVersion,
    chatPath: readString(overlay["chatPath"]) ?? base.chatPath,
    authStyle: authStyle ?? base.authStyle,
    headers: mergeStringMap(base.headers, overlay["headers"], "headers"),
    streamUsage:
      readEnum(overlay["streamUsage"], STREAM_USAGES) ?? base.streamUsage,
    supports: mergeSupports(base.supports, overlay["supports"]),
    paramMap: mergeStringMap(base.paramMap, overlay["paramMap"], "paramMap"),
  };
}

function mergeSupports(
  base: Readonly<WireSupports>,
  raw: unknown,
): Readonly<WireSupports> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return base;
  }

  const merged: WireSupports = { ...base };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_SUPPORTS.has(key as keyof WireSupports)) {
      logger.warn(`ignoring unknown config.wire.supports key "${key}"`);
      continue;
    }
    if (typeof value === "boolean") {
      merged[key as keyof WireSupports] = value;
    }
  }
  return Object.freeze(merged);
}

function mergeStringMap(
  base: Readonly<Record<string, string>>,
  raw: unknown,
  label: string,
): Readonly<Record<string, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return base;
  }

  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      merged[key] = value;
    } else {
      logger.warn(`ignoring non-string config.wire.${label}["${key}"]`);
    }
  }
  return Object.freeze(merged);
}

/**
 * 写入时的严格校验（§6：写入严格、运行时宽松）。
 *
 * 返回问题列表，空数组表示通过。与 `resolveWire` 的宽松读取是刻意的一对：
 * 未知键在**这里**被拒，所以运行时不会遇到它；而万一遇到（旧服务读新数据），
 * 运行时忽略而不是停摆。
 */
export function validateWire(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return ["config.wire must be an object"];
  }

  const wire = raw as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(wire)) {
    if (!KNOWN_KEYS.has(key)) {
      problems.push(
        `config.wire.${key} is not a known key (allowed: ${[...KNOWN_KEYS].sort().join(", ")})`,
      );
    }
  }

  const version = wire["schemaVersion"];
  if (version !== undefined) {
    if (typeof version !== "number" || !Number.isInteger(version)) {
      problems.push("config.wire.schemaVersion must be an integer");
    } else if (version > WIRE_SCHEMA_VERSION) {
      problems.push(
        `config.wire.schemaVersion ${version} is newer than this service understands (${WIRE_SCHEMA_VERSION})`,
      );
    }
  }

  if (wire["chatPath"] !== undefined && typeof wire["chatPath"] !== "string") {
    problems.push("config.wire.chatPath must be a string");
  }

  const auth = wire["auth"];
  if (auth !== undefined) {
    if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
      problems.push("config.wire.auth must be an object");
    } else {
      const style = (auth as Record<string, unknown>)["style"];
      if (style !== undefined && !AUTH_STYLES.has(style as WireAuthStyle)) {
        problems.push(
          `config.wire.auth.style must be one of: ${[...AUTH_STYLES].join(", ")}`,
        );
      }
    }
  }

  const streamUsage = wire["streamUsage"];
  if (
    streamUsage !== undefined &&
    !STREAM_USAGES.has(streamUsage as WireStreamUsage)
  ) {
    problems.push(
      `config.wire.streamUsage must be one of: ${[...STREAM_USAGES].join(", ")}`,
    );
  }

  const supports = wire["supports"];
  if (supports !== undefined) {
    if (
      typeof supports !== "object" ||
      supports === null ||
      Array.isArray(supports)
    ) {
      problems.push("config.wire.supports must be an object");
    } else {
      for (const [key, value] of Object.entries(
        supports as Record<string, unknown>,
      )) {
        if (!KNOWN_SUPPORTS.has(key as keyof WireSupports)) {
          problems.push(`config.wire.supports.${key} is not a known capability`);
        } else if (typeof value !== "boolean") {
          problems.push(`config.wire.supports.${key} must be a boolean`);
        }
      }
    }
  }

  problems.push(...validateStringMap(wire["headers"], "headers"));
  problems.push(...validateStringMap(wire["paramMap"], "paramMap"));

  return problems;
}

function validateStringMap(raw: unknown, label: string): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [`config.wire.${label} must be an object`];
  }

  return Object.entries(raw as Record<string, unknown>)
    .filter(([, value]) => typeof value !== "string")
    .map(([key]) => `config.wire.${label}.${key} must be a string`);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  return typeof value === "string" && allowed.has(value as T)
    ? (value as T)
    : undefined;
}
