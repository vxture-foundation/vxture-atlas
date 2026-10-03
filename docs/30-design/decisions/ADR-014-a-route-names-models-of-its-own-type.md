# ADR-014: A route names models of its own type

- Status: Accepted (owner, 2026-10-03)
- Date: 2026-10-03
- Deciders: owner
- Supersedes: the contract "an endpoint may point at any model" in
  `../../20-specs/20-product-definition.md`

## Context

The product definition recorded, as a contract, that an endpoint may point at
any model: the registry would not check a route's `category` against the
model's `modelType`, and whether the upstream implements the call would be
answered at call time by `501`.

A read-only check of production on 2026-10-02 found six of twelve routes naming
a model of the wrong type: `embedding/default`, `embedding/fast`,
`embedding/quality`, `rerank/default` and `rerank/fast` with a chat model as
fallback, and `rerank/quality` with one as its primary. The audit trail shows
all six were **created** that way through the operator plane; none drifted
there. Their fallbacks could never serve - the embed and rerank paths call the
vendor's embedding and rerank APIs - so those routes had no real failover, and
`rerank/quality` failed once on every call before its fallback answered.

The contract's premise did not hold either. A Zhipu chat model named on a
rerank route does not get a `501`: Zhipu's adapter implements rerank, so the
call reaches Zhipu's rerank API and is refused there. No legitimate cross-type
use exists - Atlas has no implementation in which a chat model answers an
embed or rerank call. Route writes are rare (19 creates, 5 updates in the month
before), so a check costs almost nothing.

## Decision

1. A route of category `chat`, `embedding` or `rerank` must name models of that
   type. A write that would break this is refused with
   `400 MODEL_ADMIN_VALIDATION_FAILED`, naming the field and both types.
2. Only what the write **changes** is judged. A route already naming a wrong
   model can still be edited, deactivated and repointed - repointing it is how
   it gets fixed. A category change re-judges both named models, because the
   change is what makes them wrong.
3. Any other category is not judged by type.
4. Routes written before this keep being reported, not rewritten:
   `/capability/health` `routes[].configIssues`, `/readyz`
   `routeHealth.routesMisconfigured`, and the route's state counts such a model
   as not serving it (design 120 section 4.4).

## Consequences

- Opera receives the 400 on a wrong-type save, with the same code it already
  receives when a model code matches no model.
- If Atlas ever implements a cross-type call (a chat model answering rerank),
  this rule is relaxed for that pair in the same change; it lives in one
  function, `assertModelServesCategory`.
- The six existing routes are fixed by an operator in opera (owner, 2026-10-03):
  production has one embedding and one rerank model, both Zhipu, so the
  fallbacks are cleared and `rerank/quality` is pointed at `rerank`. Embedding
  and rerank then have no failover until a second vendor's model is registered.
