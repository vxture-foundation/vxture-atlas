# 210 - Usage metering and request history: platform / Atlas boundary

Which side **provides** and **stores** what, for usage accounting and detailed
per-request history across workspace / product / user.

Upstream authority (do not restate contradictions here, fix them there first):
`vxture-platform` `docs/30-design/data_commerce_200_metering.md` (metering
kernel) and `data_platform_100_architecture.md` §2.2.4 (the eight iron rules,
including boundary #1, cross-database no-FK).

## 1. Two layers, and why they are two

| | Platform `metering.*` | Atlas `reqlog.*` |
|---|---|---|
| Purpose | money: quota balance, billing basis | operations/analytics: what actually happened |
| Grain | `(workspace, product, metric_key)` | one row per request |
| Cardinality | bounded - a few metrics per workspace/product | unbounded - every inference call |
| Dimensions | workspace, product, metric | + user, model, provider, application, agent, feature |
| Correctness bar | financial (append-only by trigger, idempotent, single-transaction) | best-effort observability |
| Owner of writes | the platform's `consume` service, exclusively | Atlas |

They are separate because they answer different questions with different
failure tolerances. Billing must stay correct even when Atlas's database is
unavailable, so the billing kernel cannot depend on Atlas's tables (boundary
#1). Conversely, per-request model-level rows would swamp a kernel whose whole
premise is bounded cardinality.

There is also a vocabulary reason: `model_code`, `provider_code` and the
prompt/completion token split are Atlas's domain language. The platform
deliberately does not learn them - it sees a `metric_key` and an amount.

## 2. Platform side

- **`metering.quota_pools`** - real-time balance, source of truth. Atlas reads
  it for the quota gate and **never writes it**.
- **`metering.usage_events`** (+ `usage_event_pools`) - append-only, monthly
  partitioned: `workspace_id`, `product_id`, `metric_key`, `total_amount`,
  `requested_amount`, `idempotency_key`, `request_id`. Note what is
  deliberately absent: **no `user_id`, no model/provider, no token split**. The
  cost centre is the workspace, not the person.
- **`metering.usage_idempotencies`** - global uniqueness, non-partitioned so
  the PK actually holds; cross-month retries do not double-charge.
- **`metering.usage_summary_{hours,days,weeks,months,years}`** - staged
  downsampling with widening retention (~3mo / ~13mo / ~2y / ~5y / long).
  **Never a billing basis** - billing sums `usage_events` over the
  subscription-anchored window.
- **`POST /usage/consume`** - the sole write path, one transaction: idempotency
  claim, lock candidate pools, lazy period reset, atomic or waterfall
  deduction, update pools, insert event head plus per-pool detail. Products,
  Atlas included, must not write the usage tables directly.

## 3. Atlas side

> **Superseded in part by ADR-010 (2026-09-30).** The metric table below is
> the wire Atlas still sends (`product: "atlas"`, `atlas.*` metrics), and the
> platform refuses all of it since atlas left the product catalog (TD-056).
> ADR-010 replaces it with raw tokens in four dimensions under the caller's
> product; this section is rewritten when that payload lands.

`reqlog.request_records` (monthly `PARTITION BY RANGE (created_at)`) is the
detailed history layer:

- Attribution: `tenant_id`, `workspace_id`, `product_id`, **`user_id`**,
  `application_id`, `application_type`, `agent_id`, `feature_id`,
  `downstream_identity_hash`
- Atlas domain facts: `model_code`, `provider_code`, `input_tokens`,
  `output_tokens`, `total_tokens`, `latency_ms`, `usage_type`
  (normal/retry/test), `status` (success/error/timeout)
- Token splits (subsets, NULL = not reported, never 0): `cached_input_tokens`,
  `cache_write_input_tokens`, `cache_write_1h_input_tokens` (of `input_tokens`);
  `reasoning_tokens` (of `output_tokens`)
- What the vendor said (`incr/04`, ADR-010 usage-record batch 1):
  `upstream_request_id`, `upstream_model`, `upstream_usage` (the vendor's usage
  object verbatim), `finish_reason` (stop/length/tool_calls/content_filter/
  other) with `native_finish_reason`, and `usage_source` (reported/absent/
  partial - NULL on a row that never reached an upstream)
- What Atlas knew at the call (`incr/05`, batch 2): `started_at` (completion =
  `started_at + latency_ms`), `first_token_at` (streams), `selector_kind` /
  `selector_value` (what the caller named), `provider_key_alias`,
  `thinking_mode`, `max_tokens`, `streamed`, `cancelled_by` (client/deadline)
- The row's own price (`incr/05`): `upstream_cost`, `cost_currency`,
  `price_rule_id`, `pricing_window` - by the rule in force at `started_at`,
  with the same formula as the cost rollup; NULL = unpriced, never free.
  Cache writes are priced at the rule's cache-write rates (`incr/06`); an
  undeclared rate falls back to the input rate
- Analysis facts (`incr/06`, batch 3): `token_jti`, `deploy_stage` (as
  `/healthz` reports it), `model_behavior_version`, `tool_count` /
  `tool_calls_made`, `message_count`, `vector_count` / `vector_dimension`
- Billing correlation: `billed_metric_key`, `billed_amount`, `cost_unit`,
  `usage_event_id`

**Token convention.** `input_tokens` counts every input token on every
adapter - uncached, cache read and cache write - so the uncached part is
`input_tokens - cached_input_tokens - cache_write_input_tokens`. OpenAI-
compatible upstreams report `prompt_tokens` this way already; Anthropic reports
`input_tokens` excluding both cache kinds, and the Claude adapter adds them
back. Rows written before `incr/04` stored Anthropic's figure as-is.

`cost_unit` says what `billed_amount` counts, and it exists because one column
carries three units:

| metric | `billed_amount` is | `cost_unit` |
|---|---|---|
| `atlas.chat` | realized total tokens | `token` |
| `atlas.embed` | realized total tokens | `token` |
| `atlas.rerank` | candidate pool size | `candidate` |
| `atlas.parse` | page count | `page` |

Without it `SUM(billed_amount)` over a mixed window adds tokens to pages and
returns a number that looks entirely reasonable. The value is derived from the
metric rather than passed at each call site - the two cannot disagree that way,
and the alternative had already gone wrong in the published tool descriptors,
which declared `per_call` for three capabilities that bill per unit.

Rows predating `incr/14` carry NULL. The unit is still recoverable from
`billed_metric_key` with the table above; they are not backfilled because
`request_records` is append-only by design (`98_column_locks.sql` revokes
UPDATE, cleanup is DROP PARTITION), and a migration doing what the model
forbids the service to do would be worse than a NULL.
  (a bare cross-database reference to the platform's `usage_events.id`, no FK),
  `request_id`

`reqlog.error_records` is the failure-side companion (`error_code`,
`error_message`, `provider_code`, `model_code`).

**`user_id` lives only here.** The platform's metering has no user dimension by
design, so "which user burned what" is answerable only from Atlas. That is the
right home for it - an operational question, not a billing one - but it means
Atlas's history is not optional if per-user reporting is a product requirement.

Two columns stay NULL by design until their prerequisite lands: `product_id`
(the token carries a product *code*, the column wants the platform's product
uuid) and, for A1/A3, the token counts an upstream that reports none cannot
supply. Invented numbers would be worse than NULL.

## 4. How the two join

`request_id` is generated per call and written to both sides; `usage_event_id`
is the platform's event id echoed back into Atlas's row. Neither is an FK
(boundary #1).

- "what did workspace W spend this cycle" -> platform, authoritative
- "which model/user/agent produced that spend" -> Atlas, joined on
  `request_id` / `usage_event_id`
- an Atlas row with `usage_event_id IS NULL` means the consume call did not
  land - the reconciliation signal that makes the split safe to operate

## 5. Retention

- Platform: monthly partitions on `usage_events(_pools)`; tiered summary
  retention, expiry by partition DROP.
- Atlas: **6 months** (owner decision 2026-07-28) - twice the platform's finest
  summary tier, so cross-quarter reconciliation and incident lookback both
  work, while staying bounded for a one-row-per-request table. Deliberately
  shorter than the platform's tiers: operational detail, not a financial
  record, and the higher-volume of the two.
- Mechanism: `reqlog.ensure_partitions(months_ahead)` and
  `reqlog.drop_expired_partitions(retain_months, dry_run)` in
  `deploy/database/ddl/incr/02_reqlog_partition_maintenance.sql`. Applying that
  file extends the runway 12 months, so a db-init run is itself a complete
  maintenance pass. Expiry is never implicit - dropping data requires a
  deliberate call with `dry_run=false`.
- **Why db-init and not an in-app job**: creating a partition is a DDL
  structure change, and `140-repo-governance-standard.md` §6 makes db-init the
  sole sanctioned path. An in-app scheduler would make the application itself
  an unaudited structure-change path.
- **Exhaustion must be loud**: `/readyz` carries a `reqlogPartitions` check
  reporting `monthsAhead` (warn below 2) and `defaultPartitionRows` (fail above
  0 - rows there mean retention is already broken, not merely about to be).
