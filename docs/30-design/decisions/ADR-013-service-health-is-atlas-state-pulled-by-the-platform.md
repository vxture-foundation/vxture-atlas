# ADR-013: Service health is durable Atlas state, pulled by the platform

- Status: Accepted (owner, 2026-10-02)
- Date: 2026-10-02
- Deciders: owner

## Context

A DeepSeek balance ran out on 2026-09-30 and a Volcengine usage cap paused a
Doubao model on 2026-10-01. `chat/fast` had both as its candidates, and 180 of
188 calls on it failed one evening. Nobody was told; it was found two days
later by reading Atlas's database by hand. Atlas only noticed failures when real
calls hit them, kept its signals in in-memory counters nothing scraped, and had
no notion of a route being down. Design: `../120-service-health-monitoring.md`.

## Decision

1. **Atlas detects and holds the state**: passive classification of every call,
   an active probe every 10 minutes for any model without real traffic in that
   window (smallest call, never billed to a tenant), hourly balance polling where
   a vendor offers it, and configuration checks. State is per vendor model and
   per route, stored in Atlas's database, and **only transitions** become events.
2. **Severity is decided per route**: a failing model behind a working fallback
   is a warning; a route with no working candidate is critical.
3. **Balance warnings use two thresholds, either one triggers**: a minimum amount
   and a minimum number of projected days left, set per vendor from admin.
4. **The platform pulls** current state and events from the operator plane and
   watches Atlas's liveness itself, because Atlas cannot report its own death.
   Notices go to **admin** first; other channels are not connected yet.
5. **Every setting has a default** (owner, 2026-10-02): probe interval and
   on/off, balance thresholds and poll interval resolve model -> vendor ->
   server `.env` -> built-in, are edited from **opera**, and are reported with
   the value in effect and where it came from. Notification channels are the
   platform's, edited in admin.
6. Atlas defines the interface; the platform decides how it consumes it.

## Consequences

- Probes cost one minimal call per idle model per interval.

## Amendment (owner, 2026-10-02)

The default probe interval is **60 minutes**, not 10: probes spend tokens, and
10 minutes for every idle model was too much. About 24 calls a day per idle
model instead of 144. A tighter cadence is a per-model or per-vendor override.
The allowed range stays 5-60 minutes (the database CHECK enforces it).
- A new `health` schema arrives through db-init.
- Until the platform's watcher exists, the state is readable but nobody is
  notified - the same gap as today, now with a place to close it.
- A vendor without a balance API stays failure-only for balance; the health
  view says so rather than showing a threshold that cannot fire.
