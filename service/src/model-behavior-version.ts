/**
 * model-behavior-version.ts - what a consumer watches to notice that a model
 * changed underneath a stable `modelCode`.
 *
 * ## The problem this closes
 *
 * Atlas's version policy, sent to karda 2026-07-27 and restated in #205, is
 * that `modelCode` IS the version identifier: a new version means a new code,
 * never a silent `latest` drift. The policy is right and it was unenforced in
 * one specific way - an operator may repoint a registered model at a different
 * upstream (`endpointUrl`, `providerId`, `config.wire`) while the code stays
 * the same. The consumer-visible symptom is "the same prompt worked yesterday
 * and is wrong today", with nothing to attribute it to. Worse than a delete,
 * which at least 404s.
 *
 * Repointing MUST stay possible - a supplier changes their base URL, a gateway
 * migration happens, and forcing delete-plus-recreate would drop every grant
 * that references the model. So the fix is not a lock. It is a signal.
 *
 * ## Why this is not "a second source of truth"
 *
 * #206/#205 rejected adding a `version` COLUMN, on an argument this design
 * accepts: two independently writable statements of one fact drift, and then a
 * consumer has to ask which one is authoritative.
 *
 * This is not that. It is a pure function of the fields it describes, computed
 * at the mapping boundary and stored nowhere - the same technique M-B3 already
 * uses for `state`, which is derived so "the database keeps `is_active
 * boolean` and no DDL is involved". A fingerprint cannot disagree with what it
 * fingerprints. There is no write path that could set it wrong, because there
 * is no write path at all.
 *
 * ## What a consumer does with it
 *
 * Compare it to the last value seen for the same `modelCode`. Equal means the
 * upstream and wire configuration are unchanged. Different means the model's
 * behaviour may have changed and a golden-output check is worth re-running.
 * The value is OPAQUE - not ordered, not a semver, and carrying no claim about
 * how big the change was. Whether an agent surfaces it to a human is the
 * agent's decision; Atlas's obligation is to make the fact observable.
 */

import { createHash } from "node:crypto";

import type { AiModelRecord, ModelConfig } from "./types/runtime.types";

/**
 * Scheme tag. It changes only if the inputs or the algorithm below change, and
 * when it does EVERY model's version changes at once - which a consumer must be
 * able to tell apart from "every model was repointed". The prefix is what lets
 * them: same scheme + different digest is a real change; different scheme is
 * ours, and gets a liaison note.
 */
const SCHEME = "b1";

/**
 * Fields excluded from `config` because they do not describe behaviour.
 *
 * `keyReference` names WHICH managed credential is used, not what the model
 * does with it. Rotating a key would otherwise bump the version and tell every
 * consumer their golden outputs might have moved, for a change that cannot
 * affect a single token of output. A false positive here is not harmless: a
 * signal that cries wolf gets filtered out, and then the real repoint is
 * filtered out with it.
 */
const NON_BEHAVIORAL_CONFIG_KEYS = new Set(["keyReference", "apiKeyEnvVar"]);

/**
 * Locale-INDEPENDENT string order.
 *
 * A bare `.sort()` already does this (UTF-16 code unit order), but implicitly,
 * and SonarQube S2871 flags the implicitness with a suggestion to use
 * `localeCompare`. Taking that suggestion here would be a real defect:
 * `localeCompare` is locale-sensitive, so the same model would fingerprint
 * differently on two machines with different locales, and a consumer comparing
 * versions across them would read "the model changed" every time.
 *
 * `audit.middleware.ts` DOES use `localeCompare` for `changed_fields`, and that
 * is correct there - it orders a list a human reads, where "alphabetical" should
 * mean what the reader expects. This orders bytes going into a hash. Different
 * job, opposite answer.
 */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Deterministic JSON: object keys sorted at every depth, so two configs that
 *  differ only in insertion order fingerprint identically. Without this the
 *  version would change on a re-save that changed nothing. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort(byCodeUnit);
  for (const key of keys) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

function behavioralConfig(config: ModelConfig | null): unknown {
  if (!config) return null;
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    if (!NON_BEHAVIORAL_CONFIG_KEYS.has(key)) kept[key] = config[key];
  }
  return canonical(kept);
}

/**
 * The behaviour fingerprint of one model.
 *
 * The input set is deliberately narrow: everything here changes what a call
 * DOES, and nothing here is presentation. `modelName`, `description` and `sort`
 * are excluded - an operator fixing a typo in a display name must not tell every
 * consumer that the model may have changed.
 *
 * `providerConfig` IS included even though it belongs to another row. The
 * provider's `wire` defaults are what the model's own config overrides, so
 * changing them changes this model's behaviour without touching its row. A
 * fingerprint that missed it would report "unchanged" through exactly the kind
 * of change this exists to surface.
 *
 * `isActive` and `deprecatedAt` are excluded: they are already reported as
 * `state`, and lifecycle is not behaviour - a deprecated model still answers
 * identically, which is the whole point of having the state.
 */
export function modelBehaviorVersion(model: AiModelRecord): string {
  const material = canonical({
    providerId: model.providerId,
    endpointUrl: model.endpointUrl,
    protocol: model.protocol,
    modelType: model.modelType,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: [...model.capabilities].sort(byCodeUnit),
    supportsStreaming: model.supportsStreaming,
    config: behavioralConfig(model.config),
    providerConfig: behavioralConfig(model.providerConfig),
  });

  const digest = createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")
    .slice(0, 12);

  return `${SCHEME}-${digest}`;
}
