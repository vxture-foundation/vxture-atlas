import { describe, it, expect } from "vitest";

import { generateGatewayApiKey, hashGatewayApiKey } from "./gateway-api-key-crypto";

describe("generateGatewayApiKey", () => {
  it("tags the secret and prefix with the kind", () => {
    const internal = generateGatewayApiKey("internal");
    const external = generateGatewayApiKey("external");

    expect(internal.secret.startsWith("vxk_int_")).toBe(true);
    expect(internal.keyPrefix.startsWith("vxk_int_")).toBe(true);
    expect(external.secret.startsWith("vxk_ext_")).toBe(true);
    expect(external.keyPrefix.startsWith("vxk_ext_")).toBe(true);
  });

  it("the prefix is a short, non-recoverable slice of the secret", () => {
    const { secret, keyPrefix } = generateGatewayApiKey("internal");

    expect(keyPrefix.length).toBeLessThan(secret.length);
    expect(secret.startsWith(keyPrefix)).toBe(true);
  });

  it("the hash is a valid sha256 hex digest of the full secret", () => {
    const { secret, keyHash } = generateGatewayApiKey("internal");

    expect(keyHash).toBe(hashGatewayApiKey(secret));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never persists or exposes the plaintext secret outside the one return value", () => {
    const { secret, keyPrefix, keyHash } = generateGatewayApiKey("internal");

    expect(keyPrefix).not.toBe(secret);
    expect(keyHash).not.toContain(secret);
  });

  it("generates unique secrets across calls", () => {
    const a = generateGatewayApiKey("internal");
    const b = generateGatewayApiKey("internal");

    expect(a.secret).not.toBe(b.secret);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe("hashGatewayApiKey", () => {
  it("is deterministic for the same input", () => {
    expect(hashGatewayApiKey("vxk_int_abc")).toBe(
      hashGatewayApiKey("vxk_int_abc"),
    );
  });

  it("differs for different inputs", () => {
    expect(hashGatewayApiKey("vxk_int_abc")).not.toBe(
      hashGatewayApiKey("vxk_int_abd"),
    );
  });
});
