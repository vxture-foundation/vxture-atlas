# 30-design - Architecture, ADRs, domain design

Three-digit bands: `1xx` design, `2xx` contracts and schema, `3xx`
implementation. `decisions/` holds ADRs, keyed by ADR number.

| File | Covers |
|------|--------|
| [`100-model-onboarding-and-protocol-adapters.md`](./100-model-onboarding-and-protocol-adapters.md) | Onboarding a provider or model as a data operation: `protocol` as the dispatch key (closed vocabulary in code) and `config.wire` as the quirk descriptor (data, zero DDL) |
| [`110-management-plane.md`](./110-management-plane.md) | The rules governing `/capability/*`: derive-don't-cascade, counts that equal delete preconditions, deactivate-then-delete, verify-the-source-don't-re-judge, record-don't-refuse, revoke-means-revoke |
| [`200-s2s-provider-surface.md`](./200-s2s-provider-surface.md) | The A1 embed / A2 parse / A3 rerank contracts Atlas exposes as a supplier, plus tenant model lists and task-profile routing |
| [`210-usage-metering-and-history.md`](./210-usage-metering-and-history.md) | The platform `metering.*` / Atlas `reqlog.*` boundary: who stores what, how they join, retention |
| [`decisions/`](./decisions/00-index.md) | ADR register (stable append-only IDs) |

Atlas's data-model narrative (`key`/`reqlog`/`model`/`provisioning`/`audit`) and the
rationale for the physical DB separation (boundary #1, zero cross-database FK)
are documented in the platform repo (`docs/design/data_model_200_schema.md`
§4), not here.
