import { HttpStatus } from "@nestjs/common";

import { ModelRuntimeException } from "./runtime.errors";
import type { AiModelRecord } from "../types/runtime.types";

/** Providers whose api key is optional (endpoint-local auth, e.g. bearer baked into config). */
const API_KEY_OPTIONAL_PROVIDERS = new Set(["private", "custom", "self-hosted"]);

export interface ResolveApiKeyDeps {
  /** Looks up a provider-key-vault secret. */
  resolveManagedKey: (
    providerCode: string,
    keyAlias: string,
  ) => Promise<string | null>;
}

/**
 * The vault is the ONLY source of an upstream key (ADR-003).
 *
 * `config.apiKeyEnvVar` was the pre-vault path: the key came from a process
 * environment variable, so adding or rotating one meant editing deployment env
 * and redeploying. ADR-003 replaced it and this function kept it as a
 * fallback, which left a credential with two sources - the thing a vault
 * exists to prevent. Removed 2026-08-17. Production carried zero models on
 * that path (`/readyz` reported `envVarModels: []`), so nothing was serving
 * through it.
 *
 * The empty-key fallthrough went with it. A model with no key source used to
 * get `""` and call upstream with it; the 401 that came back was reported as
 * `PROVIDER_UNAVAILABLE`, so a configuration hole arrived wearing an upstream
 * outage's face. It is now refused here, naming the model, before any request
 * is made.
 */
/**
 * The vault alias a model's calls go out on - with the provider code it names
 * one vault row, i.e. one vendor account. Usage-record batch 2 (C5) writes it on
 * every row; `resolveApiKey` below resolves the same alias to the secret.
 */
export function managedKeyAliasOf(model: AiModelRecord): string | undefined {
  const config = model.config as Record<string, unknown> | null;
  const alias =
    typeof config?.["managedKeyAlias"] === "string"
      ? config["managedKeyAlias"].trim()
      : "";
  return alias || undefined;
}

export async function resolveApiKey(
  deps: ResolveApiKeyDeps,
  model: AiModelRecord,
  requestId?: string,
): Promise<string> {
  const config = model.config as Record<string, unknown> | null;

  const managedKeyAlias =
    typeof config?.["managedKeyAlias"] === "string"
      ? config["managedKeyAlias"].trim()
      : "";

  // Endpoint-local auth: the credential is baked into the endpoint config, so
  // there is no key to resolve and no hole to report.
  const keyOptional = API_KEY_OPTIONAL_PROVIDERS.has(model.provider);

  if (!managedKeyAlias) {
    if (keyOptional) return "";
    throw new ModelRuntimeException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "PROVIDER_UNAVAILABLE",
      `Model "${model.modelCode}" has no provider key: set one through ` +
        `POST /capability/provider-keys and reference it from the model's ` +
        `keyReference. The environment-variable key path was retired with ` +
        `ADR-003 - the vault is the only source.`,
      {
        ...(requestId !== undefined ? { requestId } : {}),
        modelCode: model.modelCode,
        provider: model.provider,
      },
    );
  }

  const apiKey = await deps.resolveManagedKey(model.provider, managedKeyAlias);
  if (!apiKey && !keyOptional) {
    throw new ModelRuntimeException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "PROVIDER_UNAVAILABLE",
      `No active provider key found for alias "${managedKeyAlias}" for model "${model.modelCode}"`,
      {
        ...(requestId !== undefined ? { requestId } : {}),
        modelCode: model.modelCode,
        provider: model.provider,
      },
    );
  }
  return apiKey ?? "";
}
