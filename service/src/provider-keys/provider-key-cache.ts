/**
 * provider-key-cache.ts - the vault is the only source; it must not be the
 * hot path.
 *
 * Making the vault the single source of an upstream key (ADR-003, enforced
 * 2026-08-17) put a database round trip plus an AES-256-GCM decrypt on EVERY
 * `/v1` call. The lookup is index-backed (`uq_provider_api_keys_code_alias`),
 * so it is fast - but it is paid per request, on a path that already spends a
 * grant check, a C2 entitlement read, a quota check and a rate gate before it
 * gets here.
 *
 * So: cache the resolved plaintext in the process.
 *
 * **Invalidation is the design; the TTL is only a backstop.** A revoked key
 * that keeps working until a timer expires is a security defect, not a caching
 * trade-off - so every mutation on the operator plane (`create`, `rotate`,
 * `remove`, `setActive`) drops the entry synchronously, before its own write
 * returns. The TTL exists for the cases invalidation cannot see: a row changed
 * by a DBA, or a second app instance if this ever runs more than one.
 *
 * Deliberately NOT here:
 *
 * - **No negative caching.** A miss means "no active key for this alias",
 *   which an operator fixes by creating one; caching that would make the fix
 *   appear not to work. A miss is also the cheap case - it never decrypts.
 * - **No refresh-ahead.** It would keep a revoked key alive past its
 *   invalidation for exactly the window this cache is supposed to close.
 * - **No size-based eviction beyond a hard cap.** The key space is the number
 *   of (provider, alias) pairs an operator has created - tens, not thousands.
 *   The cap is a runaway guard, not a working-set policy.
 *
 * The plaintext lives in process memory either way: it is handed to the
 * provider adapter on every call. Caching it does not widen that exposure, and
 * the entry is dropped the moment the key stops being valid.
 */

/** Backstop only - invalidation is what actually keeps this correct. */
const TTL_MS = 5 * 60 * 1000;

/** Runaway guard. An operator-created key space is tens of entries. */
const MAX_ENTRIES = 512;

interface Entry {
  value: string;
  expiresAt: number;
}

export class ProviderKeyCache {
  private readonly entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  private static key(providerCode: string, keyAlias: string): string {
    // The separator cannot appear in either half: provider codes and aliases
    // are identifiers, so a newline is unambiguous where ":" would not be.
    return `${providerCode}\n${keyAlias}`;
  }

  get(providerCode: string, keyAlias: string): string | undefined {
    const entry = this.entries.get(ProviderKeyCache.key(providerCode, keyAlias));
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(ProviderKeyCache.key(providerCode, keyAlias));
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(providerCode: string, keyAlias: string, value: string): void {
    if (this.entries.size >= MAX_ENTRIES) {
      // Oldest insertion first - Map preserves insertion order. Not an LRU:
      // at this size the distinction cannot matter, and pretending otherwise
      // would be a claim nothing holds.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(ProviderKeyCache.key(providerCode, keyAlias), {
      value,
      expiresAt: Date.now() + TTL_MS,
    });
  }

  /**
   * Drop one alias. Called by every operator mutation BEFORE it returns, so a
   * revoked key cannot answer one more request.
   */
  invalidate(providerCode: string, keyAlias: string): void {
    this.entries.delete(ProviderKeyCache.key(providerCode, keyAlias));
  }

  /**
   * Drop everything for a provider. `rotate` and `remove` know the row they
   * touched, but a provider-wide change (a code rename, a bulk deactivate)
   * does not map to one alias - clearing the provider is the honest response.
   */
  invalidateProvider(providerCode: string): void {
    const prefix = `${providerCode}\n`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** For `/readyz` and tests - never exposes a key, only counts. */
  stats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
