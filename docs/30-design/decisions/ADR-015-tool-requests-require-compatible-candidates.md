# ADR-015: Tool requests require compatible candidates

Status: Accepted
Date: 2026-11-15
Tracking: [Atlas #141](https://github.com/vxture-foundation/vxture-atlas/issues/141)

## Context

The OpenAI-compatible adapter discarded `tools` and `toolChoice` when the
wire descriptor did not support them. A successful text answer therefore
looked like a successful agent request even though no tool could run. Runos
[#130](https://github.com/vxture-foundation/vxture-runos/issues/130) and
[#131](https://github.com/vxture-foundation/vxture-runos/issues/131) track the
separate supply and result-delivery parts of the consumer incident.

## Decision

Keep the existing route and fallback order. For chat requests, discard candidates
that cannot honor supplied tool definitions, tool-result/call history, or an
explicit `toolChoice`. Do not contact, charge or count an incompatible candidate
as a failed provider. Preserve original chain ordinals in request logs when
skipping a model. Apply the same rule to JSON and SSE requests; streaming still
requires a streaming-capable candidate. Existing thinking-mode requirements
remain unchanged, including refusal when the primary cannot honor the mode.

If no candidate can honor tools, return `422 TOOL_CALLING_UNSUPPORTED`,
`retryable: false`, with the normal request correlation and error record.
The caller must select a compatible route or the operator must update model
configuration; retrying unchanged is not a recovery strategy. The adapters
also reject unsupported tool semantics rather than deleting parameters.

Expose additive `toolSupport: {tools, toolChoice}` on granted routes.
`tools` means at least one active candidate supports tools; `toolChoice` means
at least one such candidate also supports explicit tool choice. A missing
primary gives false for both. These are configuration claims, not a live
vendor certification; streaming and thinking restrictions still apply.

## Compatibility and limits

Text-only requests keep existing behavior. Clients may receive the new explicit
error where they previously received a misleading text success. No identity,
quota, reasoning envelope, metering, DB or request schema changes are needed.
Model/protocol defaults and per-provider/per-model overlays remain the source
of truth. No internet search provider is introduced in Atlas.

Regression tests cover both response modes, incompatible primary/fallback
chains, tool-choice-only restrictions, continuation turns and ordinary chat.
Production model configuration and end-to-end internet research require separate
live verification; unit tests cannot certify them.
