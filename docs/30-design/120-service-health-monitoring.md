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

Every real call is classified as in §2 (v0.7.20 already does `account` and
`rate_limited`; `model_missing` and `unreachable` are split out of today's
`unavailable`). No extra upstream traffic.

### 4.2 Active probes

- **Every 10 minutes** (owner, 2026-10-02), each active model with **no real
  call in the last 10 minutes** gets one probe. A model with traffic is not
  probed - the traffic is the probe.
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

- For vendors with a balance API, Atlas polls the balance hourly. DeepSeek
  documents one (`GET /user/balance`). Whether Volcengine Ark and Zhipu can be
  queried with the same credential Atlas holds is **to be verified** before
  implementation; a vendor without one stays failure-only, and the health view
  says so (ADR-011's vocabulary: `not_supported`).
- Two thresholds per vendor, **either one triggers** (owner, 2026-10-02):
  - `minBalance`: an amount in the vendor's currency;
  - `minDays`: projected days left = balance / average daily spend, the spend
    taken from the balance's own decline over the trailing 7 days (top-ups
    excluded). Atlas's own price rules are not used: production has none, and
    the vendor's balance is the authority on what was spent.
- Thresholds live on the provider row and are set from admin. A configured
  threshold must take effect (no configurable-but-inert): if the vendor has no
  balance API, admin is told the field cannot apply.

### 4.4 Configuration checks

When a route is written, and by a periodic sweep: the fallback must be able to
serve the route's capability (an embedding route whose fallback is a chat
model cannot fail over), and every model a route names must exist and be
active. Today `embedding/fast`, `rerank/default`, `rerank/fast` and
`chat/vision` all have a fallback that cannot serve them.

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
| probe interval | model / vendor | 10 minutes | 5-60 minutes |
| probe enabled | model | on | on / off |
| balance minimum | vendor | CNY 100 / USD 15, in the vendor's currency | >= 0; 0 = do not warn on amount |
| days left minimum | vendor | 3 days | 0-30; 0 = do not warn on days |
| balance poll interval | vendor | 60 minutes | 15-1440 minutes |
| notification channel and routing | platform (admin) | every severity to admin in-app notices | extended by the platform as channels connect |

The amount and days defaults are proposals the owner can change.

No configurable-but-inert: `GET /capability/health` reports, for every
subject, the **value in effect and the level it came from** (model / vendor /
global / built-in), so the form can say "using the default, 10 minutes". A
vendor without a balance API reports its thresholds as not applicable, rather
than accepting a number that can never fire. A value outside its range is
refused on write with a 400 that says why.

## 5. State (Atlas)

### 5.1 Per vendor model

| State | Entered when | Left when |
|---|---|---|
| `ok` | a call or probe succeeds | any failure state below |
| `rate_limited` | throttling `429`s for 5 minutes | a success |
| `account_refused` | **one** `account` failure - it does not fix itself | a success (real or probe) |
| `unavailable` | the circuit breaker trips, or every call / probe in 10 minutes failed `unavailable` / `unreachable` | a success |
| `model_missing` | `404` from the vendor | a success, or the model is re-pointed |
| `unknown` | no call and no probe result for 2 intervals | any result |

Plus, per vendor: `balance_low` (from §4.3), independent of the model state.

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
| `/healthz`, `/readyz` | unchanged; `/readyz` gains a non-blocking `attention` list naming any route `down` |

Open for the platform to settle: the credential its server-side job uses on
the operator plane (operator tokens are issued to people; a read-only machine
scope may be needed).

## 7. Phases

| Phase | Atlas | Platform | Closes |
|---|---|---|---|
| **P0** | durable state, route severity, transition events, `/capability/health[/events]`, `/readyz` attention; active probes with the settings and defaults of §4.5 | server-side watcher; events into admin notices; Atlas-unreachable notice; opera form for the probe settings | silent failures; the idle blind spot |
| **P1** | balance polling + two thresholds (DeepSeek first); `model_missing` / `unreachable` split | admin view of current state and history; opera form for the balance settings; opera request log shows error code and message | warnings before a balance hits zero |
| **P2** | configuration checks; degradation (latency, empty answers); Atlas's own items (partition runway, reqlog write failures, consume refusals) as `atlas` components | - | every failure source in one mechanism |
