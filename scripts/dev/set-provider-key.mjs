#!/usr/bin/env node
/**
 * set-provider-key.mjs - put a real upstream credential into the managed vault.
 *
 * WHY THIS EXISTS. Rotating a provider key is supposed to happen through
 * `POST /capability/provider-keys/:id/rotate`, which needs an operator token.
 * Operator tokens come from a browser session exchange (admin-bff / opera-bff),
 * so there is no way to mint one from a shell - and provider keys have no
 * operator UI anywhere yet (TD-007). That left a real credential unable to
 * reach the vault by any route a person could actually take, which is how a
 * fixture value sat in `zhipu/primary` long enough to look like a real one.
 *
 * WHY IT TALKS TO psql AND NOT PRISMA. The generated Prisma client is emitted
 * into `service/src/generated/`, outside node_modules, so its runtime requires
 * resolve through the `service` package - and pnpm, correctly being strict,
 * does not put a transitive dependency where that lookup lands. Making it work
 * meant adding a direct dependency, which changed the lockfile, which
 * invalidated the Docker deps layer, which turned out to be the only reason
 * local image builds had ever succeeded without a GitHub Packages token.
 *
 * A one-row write does not justify that chain. This talks to the database
 * container directly, so the script has no dependencies at all and cannot
 * disturb the build.
 *
 * THE PLAINTEXT NEVER APPEARS IN AN ARGUMENT. It is read from --from-file,
 * PROVIDER_KEY_PLAINTEXT, or stdin. Arguments are visible in `ps` output and
 * land in shell history; a credential passed that way is disclosed to every
 * local user and to the next person who presses the up arrow. It also never
 * reaches a psql command line - the SQL is fed on stdin, and the value inside
 * it is already ciphertext. Nothing here prints it back, including on error.
 *
 *   # from a file - the least error-prone, and nothing reaches shell history:
 *   node scripts/dev/set-provider-key.mjs zhipu primary --from-file key.txt
 *
 *   # from stdin (the prompt says which keys end input on your platform):
 *   node scripts/dev/set-provider-key.mjs zhipu primary
 *
 *   # or via the environment, if you are scripting it:
 *   PROVIDER_KEY_PLAINTEXT='...' node scripts/dev/set-provider-key.mjs zhipu primary
 *
 * Encryption is byte-identical to the service (aes-256-gcm, iv|tag|body), so a
 * key written here is readable by the running app with no restart. An
 * append-only rotation-log row is written alongside, exactly as the rotate
 * endpoint does, so the vault's history gains no hole where the shell was used.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_CONTAINER =
  process.env["ATLAS_DB_CONTAINER"] ?? "vx-atlas-postgres-db-dev";
const DB_NAME = process.env["ATLAS_DB_NAME"] ?? "vx_atlas_db";

/** Reads .env for the encryption key set, so callers export nothing. */
function loadEnvFile(name) {
  const file = path.join(root, name);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(".env");

const argv = process.argv.slice(2);
const fileFlag = argv.indexOf("--from-file");
const secretFile = fileFlag === -1 ? undefined : argv[fileFlag + 1];
const [providerCode, keyAlias] = argv.filter(
  (a, i) => i !== fileFlag && i !== fileFlag + 1,
);

if (!providerCode || !keyAlias || (fileFlag !== -1 && !secretFile)) {
  console.error(
    "usage: set-provider-key.mjs <providerCode> <keyAlias> [--from-file <path>]",
  );
  console.error("");
  console.error("  the secret is read, in order, from:");
  console.error("    1. --from-file <path>          a file holding only the key");
  console.error("    2. PROVIDER_KEY_PLAINTEXT      environment variable");
  console.error("    3. stdin                       piped, or typed");
  console.error("");
  console.error("  never from an argument - argv is visible in `ps` and lands");
  console.error("  in shell history.");
  process.exit(2);
}

function readPlaintext() {
  if (secretFile) {
    try {
      const fromFile = readFileSync(secretFile, "utf8").trim();
      if (fromFile) return fromFile;
      console.error(`${secretFile} is empty`);
      process.exit(2);
    } catch {
      console.error(`cannot read ${secretFile}`);
      process.exit(2);
    }
  }

  const fromEnv = process.env["PROVIDER_KEY_PLAINTEXT"];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // Say so BEFORE blocking. Reading a TTY with no prompt is indistinguishable
  // from a hung process, and the key sequence that ends input is not the one
  // most people reach for on Windows - so the silent version of this looked
  // exactly like a broken script.
  if (process.stdin.isTTY) {
    console.error(`paste the key for ${providerCode}/${keyAlias}, then press:`);
    console.error(
      process.platform === "win32"
        ? "  Enter, then Ctrl-Z, then Enter   (Windows end-of-input)"
        : "  Enter, then Ctrl-D               (end-of-input)",
    );
  }

  try {
    const piped = readFileSync(0, "utf8").trim();
    if (piped) return piped;
  } catch {
    // no stdin attached at all
  }
  console.error(
    "no secret supplied - use --from-file, PROVIDER_KEY_PLAINTEXT, or stdin",
  );
  process.exit(2);
}

function resolveMasterKey() {
  const raw = process.env["PROVIDER_KEY_ENCRYPTION_KEYS"];
  const activeId = process.env["PROVIDER_KEY_ENCRYPTION_ACTIVE_KEY_ID"];
  if (!raw || !activeId) {
    console.error(
      "PROVIDER_KEY_ENCRYPTION_KEYS / _ACTIVE_KEY_ID are not set - is .env present?",
    );
    process.exit(2);
  }
  const keys = JSON.parse(raw);
  if (!keys[activeId]) {
    console.error(`active key id "${activeId}" is not in the key set`);
    process.exit(2);
  }
  return { activeId, masterKeyB64: keys[activeId] };
}

/** Identical layout to the service and the seed: iv | authTag | ciphertext. */
function envelopeEncrypt(plaintext, masterKeyB64) {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** SQL goes in on stdin, never on the command line. */
function psql(sql) {
  try {
    return execFileSync(
      "docker",
      [
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        DB_NAME,
        "-tAq",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: sql, encoding: "utf8" },
    ).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? "").trim();
    console.error(`psql failed against ${DB_CONTAINER}: ${detail.slice(0, 400)}`);
    console.error(
      "is the dev stack up?  docker compose up -d db   (or set ATLAS_DB_CONTAINER)",
    );
    process.exit(1);
  }
}

const plaintext = readPlaintext();
const { activeId, masterKeyB64 } = resolveMasterKey();
const encryptedHex = envelopeEncrypt(plaintext, masterKeyB64).toString("hex");

// One transaction, so a rotation-log entry cannot outlive a write that did not
// land - a history claiming a rotation that never happened is worse than no
// history at all.
const sql = `
BEGIN;
WITH upserted AS (
  INSERT INTO key.provider_api_keys
    (provider_code, key_alias, encrypted_key, encryption_key_id, key_scope,
     is_active, last_rotated_at)
  VALUES
    ('${providerCode}', '${keyAlias}', decode('${encryptedHex}', 'hex'),
     '${activeId}', 'shared', true, now())
  ON CONFLICT (provider_code, key_alias) DO UPDATE SET
    encrypted_key     = EXCLUDED.encrypted_key,
    encryption_key_id = EXCLUDED.encryption_key_id,
    is_active         = true,
    last_rotated_at   = now(),
    deleted_at        = NULL
  RETURNING id
)
INSERT INTO key.key_rotation_logs (provider_api_key_id, rotated_by, reason)
-- rotated_by stays NULL: a shell did this, not an operator. Naming a person
-- here would be a more useful-looking lie than naming nobody.
SELECT id, NULL, 'rotated via scripts/dev/set-provider-key.mjs' FROM upserted;
COMMIT;
SELECT id FROM key.provider_api_keys
 WHERE provider_code = '${providerCode}' AND key_alias = '${keyAlias}';
`;

const out = psql(sql);
const id = out.split("\n").filter(Boolean).pop() ?? "?";
console.log(
  `${providerCode}/${keyAlias} written (${id}) - ${plaintext.length} chars, encrypted with "${activeId}"`,
);
console.log("the running app reads the vault per request - no restart needed.");
