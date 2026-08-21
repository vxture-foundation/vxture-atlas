/**
 * internal-diagnostics.guard.ts - 模型平台内部诊断访问保护
 * @package @atlas/service
 * @layer Domain
 * @category guard
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

@Injectable()
export class InternalDiagnosticsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const headers = (req.headers ?? {}) as Record<string, unknown>;

    const allowInternalAll = process.env["ALLOW_INTERNAL_DIAGNOSTICS"] === "1";
    if (allowInternalAll) {
      return true;
    }

    const sourceIp = getRequestIp(req.ip, req.socket?.remoteAddress);

    // 容器内 loopback 访问（如 docker exec curl localhost/metrics、部署后 40-verify 巡检）
    // 来自服务自身网络命名空间，天然内部可信；外部访问仍需 token / IP 白名单。
    if (isLoopbackIp(sourceIp)) {
      return true;
    }

    // 明文 header（如 x-internal-call）任何调用方都能伪造，不构成认证因子。
    // 非 loopback 来源必须持有密钥 token —— IP 白名单只是 token 之上的收窄，
    // 不是独立放行路径：源 IP 是网络拓扑的属性，不是调用方出示的凭据。
    // 与 vxture-runos 同一守卫保持一致（runos#101 / atlas#189）。
    if (!hasInternalToken(headers, process.env["INTERNAL_DIAGNOSTICS_TOKEN"])) {
      return false;
    }

    const allowIps = parseAllowList(
      process.env["INTERNAL_DIAGNOSTICS_ALLOW_IPS"],
    );
    return allowIps.length === 0 || isIpAllowed(sourceIp, allowIps);
  }
}

function parseAllowList(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRequestIp(ip?: string, remoteAddress?: string): string | undefined {
  return normalizeIp(ip) || normalizeIp(remoteAddress);
}

function isLoopbackIp(ip?: string): boolean {
  if (!ip) {
    return false;
  }

  // normalizeIp 已去除 ::ffff: 前缀，故 ::ffff:127.0.0.1 → 127.0.0.1。
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
}

function normalizeIp(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/^::ffff:/i, "");
}

function hasInternalToken(
  headers: Record<string, unknown>,
  token: string | undefined,
): boolean {
  if (!token) {
    return false;
  }

  const tokenHeader = headers["x-internal-token"];
  const candidates = Array.isArray(tokenHeader) ? tokenHeader : [tokenHeader];

  // 先各自 sha256 再 timingSafeEqual：摘要定长，长度差异不提前泄露，
  // 比较耗时与匹配位置无关。
  const expected = sha256(token);
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      timingSafeEqual(sha256(candidate), expected),
  );
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isIpAllowed(
  remoteIp: string | undefined,
  allowList: string[],
): boolean {
  // 空白名单不匹配任何来源：未配置即拒绝，而非放行。
  if (allowList.length === 0) {
    return false;
  }

  if (!remoteIp) {
    return false;
  }

  for (const allow of allowList) {
    if (isIpMatch(remoteIp, allow)) {
      return true;
    }
  }

  return false;
}

function isIpMatch(remoteIp: string, allow: string): boolean {
  if (allow === "*") {
    return true;
  }

  if (allow.includes("/")) {
    return isIpInCidr(remoteIp, allow);
  }

  return remoteIp === allow;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, bitsStr] = cidr.split("/", 2);
  if (!network || !bitsStr) {
    return false;
  }

  const bits = Number(bitsStr);

  if (
    !isValidIp4(network) ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > 32
  ) {
    return false;
  }

  const ipValue = parseIp4(ip);
  const netValue = parseIp4(network);

  if (ipValue === null || netValue === null) {
    return false;
  }

  if (bits === 0) {
    return true;
  }

  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipValue & mask) === (netValue & mask);
}

function isValidIp4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function parseIp4(value: string): number | null {
  if (!isValidIp4(value)) {
    return null;
  }

  const parts = value.split(".").map((item) => Number(item));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }

  return (
    ((parts[0]! << 24) >>> 0) +
    ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) +
    (parts[3]! >>> 0)
  );
}
