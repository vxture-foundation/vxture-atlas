# ADR-016: Product route grants have continuous policies

Status: accepted for implementation, 2026-11-18.

## Decision

Atlas owns versioned product policy documents, edited through operator-OBO from
Opera. Selectors cover all routes, categories, tags (any/all), or explicit route
codes, with explicit exclusions. Empty selectors are invalid. Policies follow
current metadata, including new routes; automatic grants apply only to active,
non-deleted routes. Tags are endpoint metadata, never model metadata inferred
by the caller.

Manual grants remain separate. Allow contributions form a union; explicit deny
wins, including over manual grants. Removing a rule removes only that rule's
contribution. Effective reads expose rule and manual-grant provenance. Both
endpoint discovery and runtime authorization consume the effective product
grant path. An explicit product deny cannot be bypassed by the legacy tenant
grant fallback. Existing application-scoped manual grants retain their scope.

Policy changes use optimistic revisions. Current configuration and immutable
history commit atomically. The actor comes from a verified operator token;
clients cannot supply an actor. No policy engine or persistence lives in the
Opera BFF. Schema increments follow the existing db-init deployment path.

## Consequences

Snapshot grants and continuous grants are distinct UI actions. Rule matching is
read from authoritative Atlas data; a failed read cannot silently become an
empty policy. Runtime authorization never serves an unbounded stale allow.
