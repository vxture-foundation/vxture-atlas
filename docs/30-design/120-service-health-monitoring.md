# 120 - Service health monitoring

Status: design, accepted 2026-10-02 (ADR-013). Not yet implemented; the
workplan's section F tracks it.

## 1. Why

On 2026-09-30 DeepSeek started answering `402` (balance exhausted). On
2026-10-01 a usage cap set on the Volcengine account paused
`doubao-seed-2-0-lite` (`429 SetLimitExceeded`). `chat/fast` has the second as
its primary and the first as its fallback, and that evening 180 of 188
tenderforge calls on it failed. Nobody was told. It was found two days later by
reading Atlas's database by hand.

A survey of both repos on 2026-10-02 found the chain broken in four places:

1. **Passive only.** Atlas learns of a failure only when a real call hits it.
   With no traffic it knows nothing, so "is it fixed?" cannot be answered either
   (after the DeepSeek top-up, six hours passed with no call to prove it).
2. **Failures, no warnings.** A balance running down is invisible until it is
   zero.
3. **Signals nobody reads.** `upstream_http_errors_total` and the other counters
   live in process memory, reset on every restart, and nothing scrapes them: no
   Prometheus, Grafana or alert configuration exists on either side. Opera's
   health page reads `/readyz` only while someone has it open.
4. **Models, not routes.** A model failing behind a healthy fallback and a route
   with both candidates dead look the same in the data.

One fact shapes the split of work: **Atlas cannot report its own death.** If
the process or container is down, nothing it would send gets sent. Something
outside has to watch it.

## 2. Failure sources

| Layer | Failure | Signal | Class |
|---|---|---|---|
| Vendor account | balance exhausted | `402` | `account` |
| | usage cap reached, model paused | `429` whose body names an account limit | `account` |
| | key expired / revoked | `401` | `account` |
| | forbidden for this key | `403` | `account` |
| | model not found / withdrawn by the vendor | `404` | `model_missing` |
| | **balance running low** | none - calls succeed | balance warning (§4.3) |
| Vendor service | outage | `5xx` | `unavailable` |
| | no response | header / deadline timeout | `unavailable` |
| | network (DNS / TLS / connect) | fetch failure | `unreachable` |
| | throttling | plain `429` | `rate_limited` |
| | degradation (slow, empty, truncated) | `200` | P2 (§7) |
| Route | primary and fallback both down | every candidate failing | route `down` |
| | fallback cannot serve the capability | configuration | `misconfigured` |
| Atlas itself | process / container down | `/healthz` unreachable | outside watcher only |
| | database, vault, issuer | `/readyz` `blocked` | `atlas` component |
| | reqlog writes failing, consume refused, partitions running out | counters / DDL state | `atlas` component |
| Idle | no traffic, no knowledge | absence | `unknown` until probed |

The `account` / `rate_limited` split for a vendor `429` is ADR-011's rule
applied to status: decided from the vendor's own error code, from a list of
codes actually observed (`ACCOUNT_LIMIT_SIGNATURES`), never guessed.

## 3. Responsibilities

| Who | Does |
|---|---|
| **Atlas** | Detects (passive classification, active probes, balance polling, config checks); holds a **durable** state per vendor model and per route; records state **transitions** as events; serves both over the operator plane |
| **Platform** | Watches Atlas from outside (a server-side job, not a page); pulls Atlas's events; turns them into **admin** operator notices; shows current state in admin. Other channels (IM, email) are not connected yet (owner, 2026-10-02) |
| **Owner / operations** | Acts: top up, rotate a key, lift a cap, or point a route's fallback elsewhere. Every event names the vendor's own words and the console to go to |

How the platform implements its half is the platform's decision; this document
fixes only Atlas's side of the interface.

## 4. Detection (Atlas)

### 4.1 Passive

Every real call is classified as in §2. No extra upstream traffic.

The `account` / `rate_limited` split for a `429` reads the vendor's own code.
Zhipu answers arrears and package exhaustion with `429` plus a business code
(`1113` arrears; `1308`-`1321` package, quota and account conditions), so
those codes are `account`; its throttling codes (`1302`, `1305`, `1313`) stay
`rate_limited`.

### 4.2 Active probes

- **Every 60 minutes by default** (owner, 2026-10-02; first set at 10 and
  lowered the same day - probes spend tokens), each probe target with **no
  result in its interval** gets one probe. A model with traffic is not probed -
  the traffic is the probe. A tighter cadence is an override (section 4.5).
- **Targets**: the active models a route names (primary or fallback), plus
  any model already seen. That is what callers depend on; probing every
  registered model would spend calls on models nothing routes to (the dev
  registry holds 128 chat models).
- **Smallest possible call.** Chat: one prompt, `thinking: "off"` where the
  model supports it, the smallest output budget. A model that cannot turn
  reasoning off gets the budget the existing probe uses, so the reasoning chain
  cannot eat it and report a false failure (fixed once already, 2026-08-25).
  Embed: one short text. Rerank: one query, one candidate.
- **Reuses the operator probe's path.** Rows go to `reqlog` with
  `usage_type = 'test'` under the platform sentinel and are **never reported to
  platform metering** - no tenant is billed for a probe.
- **Also probes a model in a failing state**, on the same 10-minute cadence, so
  recovery is noticed without waiting for a user to try.

### 4.3 Balance warnings

- Atlas reads the balance of every active vendor it can, every 60 minutes by
  default, with the same key its calls use. Which vendor can be read is decided
  by the **host** its models call, not the provider code:

  | Vendor | Host | Balance |
  |---|---|---|
  | DeepSeek | `api.deepseek.com` | `GET /user/balance` (Bearer key): currency, total, `is_available` |
  | Volcengine Ark | `*.volces.com` | `not_supported`: only the billing API (`QueryBalanceAcct`) reports it, and that needs an account AK/SK; Atlas holds an Ark API key |
  | Zhipu | `open.bigmodel.cn` | `not_supported`: no balance API; arrears show on calls as `1113` (§4.1) |
  | any other | - | `not_supported`, naming the host |

  A vendor that cannot be read stays failure-only for balance, and says why
  (ADR-011's vocabulary: `not_supported`).
- Two thresholds per vendor, **either one triggers** (owner, 2026-10-02):
  - `minBalance`: an amount in the vendor's currency;
  - `minDays`: projected days left = balance / average daily spend, the spend
    taken from the balance's own decline over the trailing 7 days (top-ups
    excluded: spend is the sum of the decreases between readings). Needs 6
    hours of history and some spend; until then days left is unknown and only
    the amount can warn. Atlas's own price rules are not used: the vendor's
    balance is the authority on what was spent, including spend that did not
    go through Atlas.
- Every reading is kept in `health.balance_samples` (append-only).
- Severity: `warning` when a threshold is crossed; `critical` when the vendor
  says the key can no longer spend (`is_available: false`) or nothing is left.
- The state is re-judged every minute from the last reading, so a threshold
  edited in opera takes effect within a minute without another read.
- A read that keeps failing for two poll intervals moves the vendor to
  `unknown` with the error (`warning`): a stale `ok` is not one Atlas can vouch
  for.
- Thresholds are set from opera (§4.5). A configured threshold must take effect
  (no configurable-but-inert): on a `not_supported` vendor a threshold is
  refused with the reason, and the settings view marks it not applicable.

### 4.4 Configuration checks

Every model a route names must be able to serve it: exist, be active under an
active vendor, have a usable key, and - for a `chat` / `embedding` / `rerank`
route - be of that type. The embed and rerank paths call the vendor's
embedding / rerank API, so a chat model named there fails on every call.

Production, 2026-10-02: seven of twelve routes named a model of the wrong type.
`embedding/default` / `fast` / `quality` and `rerank/default` / `fast` have a
chat model as fallback; `rerank/quality` has one as its **primary**.

- **Reported, on every read**: `/capability/health` `routes[].configIssues`,
  and `/readyz` `routeHealth.routesMisconfigured`. Computed from the routes as
  configured, so a fix shows at the next read.
- **Counted in the route's state**: a model that cannot serve the route counts
  as not serving it. Before this, `rerank/default` with its primary down and a
  healthy chat fallback read `degraded` ("callers are still served") while
  every caller failed; it now reads `down`. `rerank/quality` reads `degraded`
  for as long as its primary is a chat model.
- **Not refused at write time.** The product definition records the opposite
  as a contract ("an endpoint may point at any model", `20-specs/20`).
  Refusing such a write would reverse it; that is an open owner decision, not
  part of this check.
- **Not judged**: a capability no model declares. `chat/vision` needs an
  image-capable model and no model declares `vision`, so it is not judged by
  its name.
- **Probes skip a model with no usable key** and say so
  (`health-settings` `targets[].probeSkipped`), instead of sending an empty key
  that the vendor answers with `401` - which read as the vendor refusing
  Atlas.

### 4.5 Settings and defaults

Every detection setting is editable, and every one has a default, so nothing
has to be set for monitoring to work (owner, 2026-10-02). Atlas stores the
settings, serves them on the operator plane and makes them take effect; the
forms are **opera's** model-services page (owner, 2026-10-02). Notification
channels are the platform's, edited in **admin** (§3).

Resolution, most specific first:

| Level | Example | Set from |
|---|---|---|
| 1. model | one expensive model not probed, or probed every 30 minutes | opera -> operator plane |
| 2. vendor | DeepSeek: warn below CNY 100 or 3 days left | opera -> operator plane |
| 3. global | the server's `.env`, like every L0/L1 link | deployment |
| 4. built-in | code, when `.env` is silent too | - |

| Setting | Level | Built-in default | Allowed |
|---|---|---|---|
| probe interval | model / vendor | 60 minutes | 5-60 minutes |
| probe enabled | model | on | on / off |
| balance minimum | vendor | CNY 100 / USD 15, in the vendor's currency | >= 0; 0 = do not warn on amount |
| days left minimum | vendor | 3 days | 0-30; 0 = do not warn on days |
| balance poll interval | vendor | 60 minutes | 15-1440 minutes |
| notification channel and routing | platform (admin) | every severity to admin in-app notices | extended by the platform as channels connect |

The amount and days defaults are proposals the owner can change.

Interface: `GET /capability/health-settings` lists the global level, every
override and, for every probe target, the **value in effect and the level it
came from** (model / vendor / global / built-in), so the form can say "using
the default, 60 minutes". `PATCH /capability/health-settings/model:<code>` or
`/provider:<code>` writes an override; `null` clears it.

No configurable-but-inert: every value is reported with its source; an
unreadable `.env` value refuses start-up; a setting on a model or vendor that
does not exist is refused (`404 HEALTH_SETTING_UNKNOWN_SUBJECT`). A
vendor without a balance API reports its thresholds as not applicable, rather
than accepting a number that can never fire. A balance threshold on a model is
refused (a balance belongs to the account). A value outside its range is
refused on write with a 400 that says why.

The global level's `.env` names: `HEALTH_PROBE_INTERVAL_MINUTES`,
`HEALTH_PROBES_ENABLED`, `HEALTH_BALANCE_MIN_AMOUNT_CNY`,
`HEALTH_BALANCE_MIN_AMOUNT_USD`, `HEALTH_BALANCE_MIN_DAYS`,
`HEALTH_BALANCE_POLL_MINUTES`. A vendor whose currency has no global amount
has no amount threshold until one is set on the vendor; the view reports it as
`null`, not a guess.

## 5. State (Atlas)

### 5.1 Per vendor model

| State | Entered when | Left when |
|---|---|---|
| `ok` | a call or probe succeeds | any failure state below |
| `rate_limited` | throttling `429`s for 5 minutes | a success |
| `account_refused` | **one** `account` failure - it does not fix itself | a success (real or probe) |
| `unavailable` | the circuit breaker trips, or every call / probe in 10 minutes failed `unavailable` / `unreachable`, and the latest failure was an answer (5xx, timeout) | a success |
| `unreachable` | the same, but the latest failure never reached the vendor (DNS / TLS / connect). Split out because a different person fixes it: the network path from Atlas, not the vendor | a success |
| `model_missing` | `404` from the vendor | a success, or the model is re-pointed |
| `unknown` | never seen yet; or an `ok` model with no result for 2 intervals (quietly - idleness is not news). A failing model is never moved here: with no successful call there is no reason to think it recovered | any result |

### 5.1a Per vendor - balance

| State | Entered when | Left when |
|---|---|---|
| `ok` | the last reading is above both thresholds | a threshold crossed |
| `balance_low` | the last reading crossed a threshold (§4.3) | a reading above both |
| `not_supported` | Atlas cannot read this vendor's balance; `detail` says why (stored quietly - a fact, not news) | the vendor's models move to a readable host |
| `unknown` | not read yet; or reads failing for two poll intervals | a reading |

Independent of the model state: a vendor can be `balance_low` while its models
serve, which is the point - the warning comes before the `402`.

### 5.2 Per route - this is the severity

| Route state | Meaning | Severity |
|---|---|---|
| `ok` | primary `ok` | - |
| `degraded` | primary failing, fallback `ok`: callers are served | **warning** |
| `down` | no candidate `ok`: callers are failing | **critical** |
| `misconfigured` | a candidate cannot serve the capability | warning |

`chat/fast` on the evening of 2026-10-01 would have been `down`, critical,
from its first minute.

### 5.3 Durable, and transitions only

- State is stored in Atlas's database (a new `health` schema, through db-init
  like every structure change), so a restart loses nothing.
- **A route's state is decided at the moment a model changes**, from the
  states at that moment, against the routes as configured (cached, refreshed
  within a minute of an operator edit). Deciding it later, when the write is
  queued, reads states that have moved on and can miss a `down` that lasted
  seconds.
- **Only transitions become events** - `deepseek-v4-flash: ok ->
  account_refused (402, "Insufficient Balance")`, and later the recovery. A
  failing model does not produce one event per failed call.
- Each event carries: the subject (vendor model, route, vendor balance, or
  Atlas itself), from / to state, severity, the vendor's own status and words,
  the routes affected, and the time.

## 6. Interface (Atlas -> platform)

Pull, not push. The platform has to poll Atlas anyway to notice Atlas itself
dying (§1), and pulling keeps the link configured from the server's `.env`
like every L0/L1 link (owner, 2026-09-30).

| Endpoint | Returns |
|---|---|
| `GET /capability/health` | current state of every vendor model, vendor balance and route, with severity |
| `GET /capability/health/events?after=<cursor>` | transitions in order, cursor-paged; the platform keeps the cursor |
| `/healthz`, `/readyz` | unchanged; `/readyz` gains a non-blocking `routeHealth` check (`warn`, with `routesDown`, when a route has no working candidate) - non-blocking for the same reason as `registryDrift`: a vendor refusing Atlas is not Atlas failing to serve |

Open for the platform to settle: the credential its server-side job uses on
the operator plane (operator tokens are issued to people; a read-only machine
scope may be needed).

## 7. Phases

| Phase | Atlas | Platform | Closes |
|---|---|---|---|
| **P0** | durable state, route severity, transition events, `/capability/health[/events]`, `/readyz` attention; active probes with the settings and defaults of §4.5 | server-side watcher; events into admin notices; Atlas-unreachable notice; opera form for the probe settings | silent failures; the idle blind spot |
| **P1** | balance polling + two thresholds (DeepSeek first); `model_missing` / `unreachable` split | admin view of current state and history; opera form for the balance settings; opera request log shows error code and message | warnings before a balance hits zero |
| **P2** | configuration checks; degradation (latency, empty answers); Atlas's own items (partition runway, reqlog write failures, consume refusals) as `atlas` components | - | every failure source in one mechanism |
