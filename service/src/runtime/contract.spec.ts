import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { buildAtlasContract, contractFingerprint } from "./contract";
import { ContractController } from "./contract.controller";
import { MODEL_RUNTIME_ERROR_CODES } from "./runtime.errors";

/**
 * The committed artifact lives at the repo root so a consumer can vendor it or
 * fetch it by raw URL without knowing anything about this service's layout.
 */
const ARTIFACT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contract/atlas-contract.json",
);

const render = (): string =>
  `${JSON.stringify(buildAtlasContract(), null, 2)}\n`;

describe("atlas contract artifact", () => {
  it("matches the committed file", () => {
    // This is the whole mechanism. The artifact is only worth vendoring if it
    // cannot drift from the code, and nothing else in CI would notice: adding
    // an error code is a normal, green change that silently invalidates every
    // consumer's pinned copy.
    //
    // Regenerate with: UPDATE_CONTRACT=1 pnpm --filter @atlas/service test
    const expected = render();

    if (process.env["UPDATE_CONTRACT"] === "1") {
      writeFileSync(ARTIFACT, expected, "utf8");
    }

    const actual = readFileSync(ARTIFACT, "utf8");
    expect(actual).toBe(expected);
  });

  it("publishes every code the vocabulary declares, and nothing else", () => {
    // A published table that is a SUBSET is the same defect as a wrong one: the
    // consumer writes no branch for what it never saw, and the symptom is again
    // that nothing happens.
    const published = buildAtlasContract().errorCodes.map((e) => e.code);

    expect(published.sort()).toEqual([...MODEL_RUNTIME_ERROR_CODES].sort());
  });

  it("carries a retry class for every code", () => {
    const contract = buildAtlasContract();

    expect(
      contract.errorCodes.every((e) => typeof e.retryable === "boolean"),
    ).toBe(true);
  });
});

describe("the fingerprint is derived, not written", () => {
  it("is stable across calls", () => {
    // TD-044's failure inverted: a version that never moves tells a consumer
    // "nothing changed" through a field that cannot change. This one moves iff
    // the content does - so it must also NOT move when the content does not.
    expect(buildAtlasContract().fingerprint).toBe(
      buildAtlasContract().fingerprint,
    );
  });

  it("is a function of its inputs, not a constant", () => {
    // Fed two different contents through the SAME implementation rather than
    // recomputing the digest here: a test that reimplements the hashing rule is
    // a second copy of it, which is the disease this whole issue is about.
    const real = buildAtlasContract();

    const oneCodeFewer = contractFingerprint(
      real.errorCodes.slice(1),
      real.requests,
    );
    const noRequestRules = contractFingerprint(real.errorCodes, {});

    expect(oneCodeFewer).not.toBe(real.fingerprint);
    expect(noRequestRules).not.toBe(real.fingerprint);
  });

  it("moves when a required field is added", () => {
    // The `taskId` case, replayed. That change reached one consumer as seven
    // point releases of 400s (TD-044) because nothing they could poll moved.
    const real = buildAtlasContract();

    const withNewRequirement = contractFingerprint(real.errorCodes, {
      ...real.requests,
      "/v1/chat": [
        ...(real.requests["/v1/chat"] ?? []),
        { kind: "always", fields: ["somethingNew"], code: "TASK_ID_REQUIRED" },
      ],
    });

    expect(withNewRequirement).not.toBe(real.fingerprint);
  });

  it("carries a scheme tag a consumer can tell apart from a content change", () => {
    // Same-scheme-different-digest is a real change; a different scheme is ours
    // and comes with a liaison note. Without the prefix a consumer cannot tell
    // "the vocabulary moved" from "Atlas changed how it hashes", and the second
    // one moves every fingerprint at once.
    expect(buildAtlasContract().fingerprint).toMatch(/^c1-[0-9a-f]{12}$/);
  });
});

describe("ContractController", () => {
  it("serves what THIS build declares, not what a file says", () => {
    // The reason the endpoint exists alongside the committed artifact: the file
    // answers "what did main declare", the endpoint answers "what does the
    // deployment I am calling declare". Only the second one is useful while a
    // consumer is broken, and version skew between the two is the failure #21
    // is about.
    const served = new ContractController().read();

    expect(served).toEqual(buildAtlasContract());
    expect(served.fingerprint).toMatch(/^c1-/);
  });
});
