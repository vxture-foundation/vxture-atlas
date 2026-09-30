# ADR-011: Every empty usage dimension says why it is empty

- Status: Accepted (owner, 2026-09-30)
- Date: 2026-09-30
- Deciders: owner

## Context

The usage-record checklist (ADR-010) closed with 12 dimensions Atlas had no
data for today: batch mode, service tier, reasoning budget, image / audio /
file inputs, per-modality tokens, tool-use prompt tokens, server-side tool
calls, generated media, content filtering, queue wait. The first proposal was
to leave them unbuilt until a capability needed them, so no column would be
permanently empty.

The owner rejected that: Atlas is a base platform, and the record must show
the mechanism exists. A bare NULL cannot say whether Atlas has no mechanism,
the other side has no such field, or the two have simply not been connected -
and that ambiguity was already present in the columns batches 1-3 had built
(an empty `cache_write_input_tokens` read the same whether the vendor never
reports writes or this response lacked them).

## Decision

1. **Every dimension is a column**, collected or not.
2. **Every row carries `dimension_status`**: for each usage dimension that is
   NULL on the row, the reason, from a closed vocabulary of eight words. A
   value present needs no mark.
3. **The vocabulary is chosen by who acts on it**. Two causes get two words
   exactly when different people fix them:

   | word | meaning | acts on it |
   |---|---|---|
   | `not_integrated` | Atlas has no mechanism to collect it | Atlas dev |
   | `not_supported` | the other side does not offer it at all | nobody |
   | `not_reported` | the other side should have, this time did not | investigate |
   | `not_configured` | the mechanism exists, operator config is missing | operator |
   | `capture_failed` | it was given, Atlas failed to take it | Atlas (defect) |
   | `not_specified` | the caller did not specify it | caller |
   | `not_applicable` | this kind of call has no such thing | nobody |
   | `not_reached` | the request never reached the other side | the error code |

   Five words were proposed first. They merged "the vendor has no such field"
   with "it did not come this time" (one needs no action, the other needs
   investigation), and had no word for a missing operator configuration or for
   Atlas's own capture failure - the last being the silent failure this repo
   exists to stop producing.
4. **`not_supported` is declared, never inferred**: an adapter states the
   fields its protocol lacks. An inferred "not supported" and a "missing this
   time" are identical in the data.
5. **Enforced three ways**: the database CHECK
   (`reqlog.dimension_status_valid`) admits only the eight words; a test
   requires every nullable column of `request_records` to be registered in
   `reqlog/dimension-status.ts`, with its real column name; the writer derives
   the map from the row it is about to insert, so a status cannot disagree
   with the value beside it.

## Consequences

- `dimension_status` is NULL only on rows written before `incr/07` - which is
  itself the answer: the mechanism did not exist yet.
- Atlas now shows its own gaps in the data. The S2S surfaces never wired
  `attempt_index`, and their rows say `not_integrated` for it rather than
  looking like a vendor omission.
- A column added later without a registration fails CI.
- Adding a word means a new increment (the CHECK function), a code change and
  this ADR amended - the vocabulary does not grow by drift.
