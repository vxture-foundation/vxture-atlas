import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

/**
 * The trap: `.env` carries the HOST-oriented `@127.0.0.1:5432` because host
 * tools reach the database through the dev-only forwarder. docker-compose.yml
 * ALSO interpolates `.env` into the app container's `DATABASE_URL`, where that
 * address is the app itself.
 *
 * It fails quietly - `/healthz` still says `ok`, because it never touches the
 * database. It is documented, and it still cost time again on 2026-08-17,
 * which is why it is a startup failure now rather than a note.
 */
async function loadEnvModule(url: string | undefined, inContainer: boolean) {
  vi.resetModules();
  const mocked = vi.mocked(existsSync);
  mocked.mockImplementation((p) =>
    String(p) === "/.dockerenv" ? inContainer : false,
  );
  if (url === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = url;
  return import("./env");
}

describe("DATABASE_URL reachability at startup", () => {
  const saved = process.env["DATABASE_URL"];

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (saved === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = saved;
    vi.restoreAllMocks();
  });

  it("refuses 127.0.0.1 inside a container", async () => {
    await expect(
      loadEnvModule("postgresql://atlas_svc:pw@127.0.0.1:5432/vx_atlas_db", true),
    ).rejects.toThrow(/this container, not the database/);
  });

  it("refuses localhost inside a container too", async () => {
    // Same mistake, different spelling - and the spelling is not the point.
    await expect(
      loadEnvModule("postgresql://atlas_svc:pw@localhost:5432/vx_atlas_db", true),
    ).rejects.toThrow(/not the database/);
  });

  it("names the fix, including the compose interpolation half", async () => {
    // "Use @db:5432" alone is not enough advice: APP_ENV_FILE does not replace
    // what compose interpolates from ./.env, which is why this recurs.
    let message = "";
    try {
      await loadEnvModule("postgresql://u:p@127.0.0.1:5432/d", true);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("@db:5432");
    expect(message).toContain("./.env");
  });

  it("accepts the compose service alias", async () => {
    await expect(
      loadEnvModule("postgresql://atlas_svc:pw@db:5432/vx_atlas_db", true),
    ).resolves.toBeDefined();
  });

  it("allows 127.0.0.1 when NOT in a container", async () => {
    // On the host that address IS the forwarder, which is its whole purpose.
    await expect(
      loadEnvModule("postgresql://atlas_svc:pw@127.0.0.1:5432/vx_atlas_db", false),
    ).resolves.toBeDefined();
  });

  it("does nothing when DATABASE_URL is unset", async () => {
    // Absent is a different problem with a different owner; this guard is
    // about a URL that is present and points somewhere impossible.
    await expect(loadEnvModule(undefined, true)).resolves.toBeDefined();
  });
});

/**
 * The release tag reaches the container at RUN time, under its own name.
 *
 * Not as an override of APP_VERSION: compose's `environment:` map always sets
 * its keys, so writing the override straight into APP_VERSION would blank the
 * image's baked value whenever no tag was on offer, with nothing to fall back
 * to. These tests are that distinction - the third one is the whole reason the
 * variable has a separate name.
 */
describe("RELEASE_VERSION promotion", () => {
  const savedApp = process.env["APP_VERSION"];
  const savedRelease = process.env["RELEASE_VERSION"];

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    restore("APP_VERSION", savedApp);
    restore("RELEASE_VERSION", savedRelease);
    vi.restoreAllMocks();
  });

  async function loadWith(release: string | undefined, baked: string | undefined) {
    restore("RELEASE_VERSION", release);
    restore("APP_VERSION", baked);
    vi.mocked(existsSync).mockImplementation(() => false);
    delete process.env["DATABASE_URL"];
    await import("./env");
    return process.env["APP_VERSION"];
  }

  it("promotes the deploy tag over the baked build value", async () => {
    // v0.18.0 shipped an image baked as `dev`, because the release build was
    // deduped away by an earlier branch build of the same commit (#245).
    expect(await loadWith("v0.18.0", "dev")).toBe("v0.18.0");
  });

  it("leaves the baked value alone when no tag is offered", async () => {
    // A bare `deploy.sh start` on the host has no tag. The image still knows
    // what it was built as, and that is better than a blank.
    expect(await loadWith(undefined, "v0.17.0")).toBe("v0.17.0");
  });

  it("does not blank the baked value when the tag is an empty string", async () => {
    // This is the case a plain `APP_VERSION: ${APP_VERSION:-}` in compose gets
    // wrong: the key is always set, so the baked value is replaced by "" and
    // the identity reports `dev` with no way to recover the real version.
    expect(await loadWith("", "v0.17.0")).toBe("v0.17.0");
  });
});
