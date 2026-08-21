/**
 * internal-diagnostics.guard.spec.ts - 内部诊断访问保护测试
 * @package @atlas/service
 * @layer Domain
 * @category test
 */

import type { ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";

import { InternalDiagnosticsGuard } from "./internal-diagnostics.guard";

function makeContext(
  headers: Record<string, string | string[]>,
  ip?: string,
  remoteAddress?: string,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip, socket: { remoteAddress } }),
    }),
  } as unknown as ExecutionContext;
}

describe("InternalDiagnosticsGuard", () => {
  afterEach(() => {
    delete process.env["ALLOW_INTERNAL_DIAGNOSTICS"];
    delete process.env["INTERNAL_DIAGNOSTICS_TOKEN"];
    delete process.env["INTERNAL_DIAGNOSTICS_ALLOW_IPS"];
  });

  it("rejects the x-internal-call header as an auth factor", () => {
    const guard = new InternalDiagnosticsGuard();

    // 明文 header 任何网络调用方都能伪造，空白名单 + 无 token 必须拒绝。
    expect(
      guard.canActivate(makeContext({ "x-internal-call": "1" }, "203.0.113.5")),
    ).toBe(false);
    expect(guard.canActivate(makeContext({ "x-internal-call": "1" }))).toBe(
      false,
    );
  });

  it("allows internal env override", () => {
    process.env["ALLOW_INTERNAL_DIAGNOSTICS"] = "1";
    const guard = new InternalDiagnosticsGuard();

    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it("rejects public requests by default", () => {
    const guard = new InternalDiagnosticsGuard();

    expect(guard.canActivate(makeContext({}))).toBe(false);
  });

  it("allows loopback source without explicit auth", () => {
    const guard = new InternalDiagnosticsGuard();

    // 容器内 docker exec curl localhost/metrics 的典型来源。
    expect(guard.canActivate(makeContext({}, "127.0.0.1"))).toBe(true);
    expect(guard.canActivate(makeContext({}, "::1"))).toBe(true);
    expect(
      guard.canActivate(makeContext({}, undefined, "::ffff:127.0.0.1")),
    ).toBe(true);
  });

  it("still rejects non-loopback public ip without auth", () => {
    const guard = new InternalDiagnosticsGuard();

    expect(guard.canActivate(makeContext({}, "203.0.113.5"))).toBe(false);
  });

  it("allows internal call when token matches", () => {
    process.env["INTERNAL_DIAGNOSTICS_TOKEN"] = "secret";
    const guard = new InternalDiagnosticsGuard();

    expect(
      guard.canActivate(makeContext({ "x-internal-token": "secret" })),
    ).toBe(true);
  });

  it("allows token presented as an array header element", () => {
    process.env["INTERNAL_DIAGNOSTICS_TOKEN"] = "secret";
    const guard = new InternalDiagnosticsGuard();

    expect(
      guard.canActivate(
        makeContext({ "x-internal-token": ["wrong", "secret"] }),
      ),
    ).toBe(true);
  });

  it("rejects wrong token", () => {
    process.env["INTERNAL_DIAGNOSTICS_TOKEN"] = "secret";
    const guard = new InternalDiagnosticsGuard();

    expect(
      guard.canActivate(makeContext({ "x-internal-token": "wrong" })),
    ).toBe(false);
    // 长度不同的候选值同样只能拒绝，不能因长度检查提前短路抛错。
    expect(
      guard.canActivate(makeContext({ "x-internal-token": "much-longer-value" })),
    ).toBe(false);
  });

  it("rejects an allowlisted ip that carries no token", () => {
    // 白名单是 token 之上的收窄，不是独立放行路径：源 IP 是拓扑属性，
    // 不是调用方出示的凭据（runos#101 / atlas#189 两仓一致）。
    process.env["INTERNAL_DIAGNOSTICS_ALLOW_IPS"] = "10.1.0.0/24";
    const guard = new InternalDiagnosticsGuard();

    expect(guard.canActivate(makeContext({}, "10.1.0.1"))).toBe(false);
    expect(guard.canActivate(makeContext({}, "10.2.0.1"))).toBe(false);
  });

  it("narrows the token path to the allowlist when one is configured", () => {
    process.env["INTERNAL_DIAGNOSTICS_TOKEN"] = "secret";
    process.env["INTERNAL_DIAGNOSTICS_ALLOW_IPS"] = "10.1.0.0/24";
    const guard = new InternalDiagnosticsGuard();
    const withToken = { "x-internal-token": "secret" };

    expect(guard.canActivate(makeContext(withToken, "10.1.0.1"))).toBe(true);
    // 令牌正确但来源不在白名单内：仍然拒绝。
    expect(guard.canActivate(makeContext(withToken, "10.2.0.1"))).toBe(false);
  });

  it("supports exact ip entries in the allowlist", () => {
    process.env["INTERNAL_DIAGNOSTICS_TOKEN"] = "secret";
    process.env["INTERNAL_DIAGNOSTICS_ALLOW_IPS"] = "100.64.0.7";
    const guard = new InternalDiagnosticsGuard();
    const withToken = { "x-internal-token": "secret" };

    expect(guard.canActivate(makeContext(withToken, "100.64.0.7"))).toBe(true);
    expect(guard.canActivate(makeContext(withToken, "100.64.0.8"))).toBe(false);
  });
});
