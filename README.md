# Watch Monitor MCP — v7.1

An MCP server that monitors ICT sniper setups and `TRAP_NOT_CONFIRMED`
reads to a deterministic conclusion, notifies a human over Telegram, and
— when auto-trade is explicitly armed — **submits the entry order
itself** the moment the confirmation sequence completes.

Auto-trade is **off by default**. With it off, v7 behaves exactly like
v6: it watches, it confirms, it tells you, and it never touches the
account.

## The entry sequence

A setup watch does not enter because price reached the entry. It enters
because the market did all of this, in this order, after the touch:

```
REGISTERED_WATCH
  → WAITING_FOR_SETUP_CONFIRMATION   the setup's own prerequisite has not printed
  → READY_FOR_ENTRY                  prerequisite satisfied, entry live
  → ENTRY_TOUCHED                    price entered the zone — nothing is entered yet
  → REJECTION_DETECTED               a closed bar took the zone and failed to hold it
  → M5_MSS_CONFIRMED                 a closed M5 bar broke a real pivot against the prior leg
  → DISPLACEMENT_CONFIRMED           that break arrived with a real impulse body
     (or → M1_CONTINUATION_CONFIRMED  the skill-context fast lane, below)
  → ENTRY_CONFIRMED                  evidence held, kill zone / news / spread gates passed
  → ORDER_SUBMITTED
  → EXECUTED
```

Anything that fails ends at `INVALIDATED`, `EXPIRED` or `CANCELLED`.
`QUARANTINED` is entered when the feed cannot be trusted to describe the
instrument at all.

None of these, on their own or in the wrong order, produces an entry:

- the entry zone being touched;
- a wick into the zone;
- price reaching either edge of the zone;
- one bar in the trade's direction with no structure shift;
- a structure shift with no displacement;
- anything that printed **before** the touch;
- a rejection that price then traded back through (the sequence resets).

Every step is proven on a **closed** bar that closed **after** the touch,
and the current stage of every watch is reported as `stage` by
`list_watches`.

### What the setup can declare about itself

`register_watch` takes the analyst's own rules, not just levels:

| Field | Meaning |
|---|---|
| `entry_zone_low` / `entry_zone_high` | the entry band, e.g. `4330` / `4334`. Touched at the edge price approaches from, never at the midpoint |
| `prerequisite_level` + `prerequisite_timeframe` + `prerequisite_rule` | what must print before entry is live at all, e.g. an M15 **body close** below `4324.71`. A wick through it is not a close, and until it prints the watch reports `WAITING_FOR_SETUP_CONFIRMATION` |
| `invalidation_rule: "body_close"` + `invalidation_timeframe` | a wick above `4368.31` is not invalidation if the rule says body close. The **stop loss stays a hard price line either way**, so this can never leave a position unprotected |
| `risk_percent` / `volume` | per-setup sizing overrides |
| `auto_trade: false` | monitor this setup but never execute it, even while auto-trade is armed |
| `skill_context` | what the analysis already proved before the touch — see below |

## What the analysis already knows

The analysis skill confirms things this monitor never sees: the HTF
market-structure shift it read half an hour ago, the trap phase, the
liquidity it watched get swept, and — the one that costs real time — the
M5 structure shift that printed *before* price came back to the entry
zone. Without that, the monitor re-derives the same sequence after the
touch and confirms five to fifteen minutes behind the move the analyst
called.

`register_watch` therefore takes an optional `skill_context`. It decides
**which live proof is required** and **how long it must hold** — never
that no proof is required:

```jsonc
"skill_context": {
  "m5_mss_already_observed": true,      // the claim that makes the M5 sequence a re-derivation
  "htf_mss_confirmed": true,
  "liquidity_swept": true,
  "trap_phase": "delivery",
  "htf_bias": "bullish",                // cross-checked against direction
  "conviction": "HIGH",                 // only HIGH can shorten the hold
  "suggested_min_hold_ms": 15000,       // never below the 15s floor
  "suggested_max_age_ms": 180000,       // after this the context confers nothing
  "skip_m5_sequence_if": "m5_mss_already_observed"
}
```

When a context asks for it *and* price has moved in the setup's favour
since the touch, the post-touch M5 sequence is replaced by **M1
continuation**: an M1 structure shift and an M1 displacement, both on
bars that closed after the touch. Same obligation, faster clock. On a
`STRONG_MOVE` with `HIGH` conviction the hold drops to the 15 s floor —
still with the M1 proof, still with the evidence machine, still behind
every gate.

Five forward-validation states decide what a context is worth once the
touch happens:

| State | Meaning | Effect |
|---|---|---|
| `WITHIN_ZONE` | nothing decisive yet | standard sequence |
| `FAVORABLE_EARLY` | ≥ 0.15R in favour | fast lane, pending M1 proof |
| `STRONG_MOVE` | ≥ 0.5R in favour | fast lane; hold at the floor on HIGH conviction |
| `STALE` | freshness window closed | fast lane refused, one Telegram message |
| `FAILED` | ≥ 0.5R against | fast lane and hold shortening both revoked |

Nothing in this path touches safety: stop loss, invalidation, expiry,
spread, news, kill zone and the price-scale falsification are unchanged
in every lane. A context whose `htf_bias` disagrees with its own setup
gets no fast lane at all. Omit `skill_context` and the monitor behaves
exactly as it did before it existed.

`get_skill_context_audit` scores every claim against what the market then
did — `skill_said_HIGH_but_failed`, `skill_said_LOW_and_confirmed` — so
the conviction scale can be calibrated and fast-lane outcomes compared
against standard-sequence ones before the lane is widened.

Full contract, including what the skill should send and how to read the
result back: [`docs/skill-context.md`](docs/skill-context.md).

## Auto-trade

### Arming it

Two independent switches, because one boolean is too easy to set by
accident — by a copied env file, a template, or a redeploy inheriting
someone else's variables:

```bash
AUTO_TRADE_ENABLED=true
AUTO_TRADE_CONFIRMED="I ACCEPT AUTOMATED ORDER EXECUTION"
```

`get_auto_trade_status` reports whether it is armed and, if not, exactly
which condition is missing. `pause_auto_trade` is a kill switch that
takes effect immediately and survives until `resume_auto_trade`; neither
can arm auto-trade — only the environment can.

### Before you trust it with real money

Three things about the upstream connector cannot be verified from inside
this process, and each can place a *wrong* trade rather than no trade:

1. **the name of the order tool** — discovered from the upstream's own
   `tools/list`, and its declared `inputSchema` decides which arguments
   are sent. Override with `AUTO_TRADE_ORDER_TOOL` if the connector uses
   a name this monitor does not know.
2. **the unit its `volume` field counts in** — `AUTO_TRADE_VOLUME_UNIT`
   is `lots`, `units` or `centi_units`. cTrader's Open API counts
   centi-units (0.01 lots of XAUUSD = 100), but connectors vary.
3. **whether its price fields are real prices or feed-scaled integers** —
   `AUTO_TRADE_PRICE_FORMAT` is `raw` or `scaled`.

So run it once in dry run first:

```bash
AUTO_TRADE_DRY_RUN=true
```

Everything runs — the sequence, the checklist, the sizing, the Telegram
message — except the call itself, and the exact payload is written to the
logs and to the resolution record. Read that payload against your
broker's API before turning the dry run off.

If the connector declares no stop-loss field, the monitor **refuses to
submit** rather than opening an unprotected position.

### Sizing

```bash
AUTO_TRADE_VOLUME_MODE=fixed      # or risk
AUTO_TRADE_FIXED_VOLUME=0.01      # lots; required in fixed mode
```

```bash
AUTO_TRADE_VOLUME_MODE=risk
AUTO_TRADE_RISK_PERCENT=0.5       # of balance, per trade
AUTO_TRADE_ACCOUNT_CURRENCY=USD
```

Risk sizing refuses — rather than guessing — when the balance cannot be
read, when the stop is so wide that the risk-correct size is below the
minimum lot, or when the instrument's quote currency is not the account
currency (converting that needs an FX rate this service does not have).
Contract sizes come from a small table plus `CONTRACT_SIZE_<SYMBOL>`
overrides.

### The pre-submission checklist

Every one of these must pass, and **every unknown counts as a failure** —
the cost of a wrong order is unrecoverable, the cost of a missed one is a
Telegram message:

symbol matches the watch · direction matches the watch · broker symbol id
resolved · live price usable · quote fresh (`AUTO_TRADE_MAX_PRICE_AGE_MS`)
· price has not run away from the confirmation price · stop present and on
the correct side · target not already through · volume computed and
expressible in the connector's units · risk within
`AUTO_TRADE_MAX_RISK_PERCENT` · open positions **readable** and none for
this symbol · position and daily-trade limits · watch still live · nothing
already submitted for it · confirmation timestamped after the touch ·
sequence complete.

Fail a *retryable* check (stale quote, unreadable positions) and the watch
steps back and tries again next tick, up to `AUTO_TRADE_MAX_ATTEMPTS`.
Fail anything else and it resolves `CONFIRMED` — the v6 outcome, an
actionable Telegram alert naming the check that stood the order down.

### What happens when the network fails mid-order

The submission flag is written and flushed to disk **before** the request
leaves the process, so no path can produce two orders for one setup.
After that:

- **transport error, and open positions read back with a matching
  position** → treated as filled and reconciled.
- **transport error, and open positions read back empty** → provably
  nothing opened, so a retry is safe.
- **transport error, and positions cannot be read** → resolves
  `EXECUTION_UNKNOWN` with a critical alert telling you to check the
  terminal. Never assumed in either direction.
- **process died between sending and recording** → the same, on the next
  boot. The watch is never re-armed, so it can never resubmit.

## Layout

```
index.js            server, scheduler, both engines, execution driver, MCP + REST surface
lib/core.mjs        pure logic — scaling, bar discipline, analytics, evidence, entry
                    sequence, skill context, sizing, the pre-submission checklist
lib/execution.mjs   upstream tool discovery, schema-driven order payloads, submission
lib/upstream.mjs    managed cTrader MCP client + coalescing market-data layer
lib/store.mjs       watch registry + durable atomic snapshot
lib/notify.mjs      Telegram outbox with retry and delivery accounting
test/adversarial.test.mjs   the 25 required attack scenarios
test/execution.test.mjs     the entry sequence, sizing, checklist and payload construction
test/skill-context.test.mjs the skill-context fast lane and the guardrails around it
docs/skill-context.md       the contract the analysis skill fills in
test/smoke.mjs              boots the real server against a fake upstream, twice
test/smoke-autotrade.mjs    drives a scripted setup all the way to a placed order
skill/                      the ICT Sniper Liquidity Engine analysis skill that fills it
```

The `skill/` directory holds the analysis skill itself — the thing that runs in
Gemini Spark and calls `register_watch`. It lives here so both halves of the
`skill_context` contract are versioned together: when the monitor's schema
changes, the skill that fills it changes in the same commit. `skill/SKILL.md`
§15.5 is the skill-side rule, and `skill/scripts/mcp_discovery.py` reads the
monitor's own `inputSchema` from `tools/list` to report which fields *this*
deployment accepts — so an older monitor is detected rather than assumed.

`lib/core.mjs` performs no I/O and reads no environment at call time.
That is what makes the suites meaningful: they drive the same functions
the live loop drives, not a reimplementation of them.

```bash
npm install
npm test                     # unit suites
npm run smoke                # both end-to-end runs, need nothing external
npm start
```

## The security boundary

The client-facing MCP surface is **unchanged** by auto-trade. It exposes
market data plus the monitor's own tools, and still refuses every account
and execution tool the upstream has — filtered out of `tools/list` so a
client never learns they exist, and refused again on `tools/call` so a
guessed name cannot be invoked.

The monitor's own loop is a separate code path and is deliberately not
filtered: it calls the balance, positions and order tools. A client can
ask this server to *watch* a setup; only the server, having watched it to
a complete confirmation sequence, can ask the broker for a position.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `CTRADER_MCP_URL` | `https://mcp.ctrader.com/trading/mcp` | upstream |
| `CTRADER_MCP_TOKEN` | — | upstream bearer token |
| `WATCH_MONITOR_AUTH_TOKEN` | — | **set this.** Unset leaves the endpoint open; the service warns loudly at boot |
| `STATE_FILE` | `./data/watch-state.json` | put this on a persistent volume |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | notifications |
| `SCHEDULER_TICK_MS` | `2500` | how often the scheduler looks for due watches |
| `WATCH_INTERVAL_MS` | `10000` | per-setup-watch cadence |
| `TRAP_WATCH_INTERVAL_MS` | `30000` | per-trap-watch cadence |
| `CTRADER_PRICE_SCALE` | `100000` | uniform on this connector; validated at runtime, never trusted blindly |
| `SCALE_TOLERANCE` | `0.35` | how far a feed price may sit from a registered level before quarantine |
| `MIN_CONFIRMATION_HOLD_MS` | `60000` | wall-clock hold before evidence graduates |
| `REQUIRE_NEW_M1_CANDLE` | `true` | evidence must also survive a bar boundary |
| `ACCEPTANCE_ATR_FRACTION` | `0.5` | acceptance buffer, capped by `ACCEPTANCE_RISK_FRACTION` |
| `ACCEPTANCE_RISK_FRACTION` | `0.35` | ceiling as a fraction of entry-to-invalidation |
| `NEWS_FAIL_CLOSED` | `true` | unknown news state blocks new confirmations |
| `MAX_ACTIVE_WATCHES` / `MAX_TRAP_WATCHES` | `25` / `25` | registration refuses beyond this |
| `KILL_ZONE_FILTER_ENABLED` / `SPREAD_CHECK_ENABLED` / `NEWS_FILTER_ENABLED` | `true` | entry gates |
| `SPREAD_CAP_<SYMBOL>` | derived | per-symbol hard cap override |

### Entry sequence

| Variable | Default | Notes |
|---|---|---|
| `ENTRY_SEQUENCE_REQUIRED` | `true` | set `false` to fall back to v6 evidence only — **not recommended with auto-trade armed** |
| `ENTRY_DISPLACEMENT_MULTIPLE` | `1.8` | trigger body vs the recent average body |
| `ENTRY_DISPLACEMENT_LOOKBACK` | `10` | bars in that average |
| `ENTRY_MSS_SWING_STRENGTH` | `2` | bars either side that make a pivot a pivot |
| `ENTRY_FADE_ATR_FRACTION` | `0.5` | how far outside the zone price may drift before the sequence resets |

### Skill context

| Variable | Default | Notes |
|---|---|---|
| `SKILL_CONTEXT_ENABLED` | `true` | `false` still records and audits contexts, but lets none of them change anything |
| `SKILL_CONTEXT_FAST_LANE_ENABLED` | `true` | `false` keeps hold tuning but always requires the M5 sequence |
| `SKILL_CONTEXT_MIN_HOLD_FLOOR_MS` | `15000` | the shortest hold any context can buy; floor of `5000` |
| `SKILL_CONTEXT_M1_MIN_BARS` | `2` | closed M1 bars required since the touch before continuation can be proven |
| `SKILL_CONTEXT_FAVORABLE_R` | `0.15` | `FAVORABLE_EARLY` threshold, in entry-to-invalidation multiples |
| `SKILL_CONTEXT_STRONG_R` | `0.5` | `STRONG_MOVE` threshold |
| `SKILL_CONTEXT_ADVERSE_R` | `0.5` | `FAILED` threshold |

### Auto-trade

| Variable | Default | Notes |
|---|---|---|
| `AUTO_TRADE_ENABLED` | `false` | first switch |
| `AUTO_TRADE_CONFIRMED` | — | second switch; must equal `I ACCEPT AUTOMATED ORDER EXECUTION` |
| `AUTO_TRADE_DRY_RUN` | `false` | run the whole path and log the payload without sending it |
| `AUTO_TRADE_VOLUME_MODE` | `fixed` | `fixed` or `risk` |
| `AUTO_TRADE_FIXED_VOLUME` | — | lots; required in fixed mode |
| `AUTO_TRADE_RISK_PERCENT` | `0.5` | per trade, in risk mode |
| `AUTO_TRADE_MAX_RISK_PERCENT` | `2` | hard ceiling checked before submission |
| `AUTO_TRADE_VOLUME_UNIT` | `lots` | `lots`, `units` or `centi_units` — **verify against your connector** |
| `AUTO_TRADE_PRICE_FORMAT` | `raw` | `raw` or `scaled` — **verify against your connector** |
| `AUTO_TRADE_MIN_VOLUME` / `AUTO_TRADE_MAX_VOLUME` / `AUTO_TRADE_VOLUME_STEP` | `0.01` / — / `0.01` | lot bounds and rounding |
| `AUTO_TRADE_ACCOUNT_CURRENCY` | `USD` | risk sizing refuses when the quote currency differs |
| `CONTRACT_SIZE_<SYMBOL>` | table | units per lot |
| `AUTO_TRADE_MAX_OPEN_POSITIONS` | `1` | across the account |
| `AUTO_TRADE_MAX_TRADES_PER_DAY` | `3` | UTC day |
| `AUTO_TRADE_MAX_PRICE_AGE_MS` | `15000` | staleness ceiling at submission |
| `AUTO_TRADE_MAX_SLIPPAGE_RISK_FRACTION` | `0.25` | how far price may drift from the confirmation price, as a fraction of entry-to-invalidation |
| `AUTO_TRADE_MAX_ATTEMPTS` | `3` | retries for *retryable* check failures only |
| `AUTO_TRADE_SYMBOLS` | — | comma-separated allowlist; empty means all |
| `AUTO_TRADE_ORDER_TOOL` / `AUTO_TRADE_POSITIONS_TOOL` / `AUTO_TRADE_BALANCE_TOOL` | discovered | override tool discovery |
| `AUTO_TRADE_ORDER_TYPE` | `MARKET` | |
| `AUTO_TRADE_LABEL_PREFIX` | `WM` | order label prefix, followed by the setup id |
| `AUTO_TRADE_BALANCE_IS_SCALED` | `false` | some connectors report balance in cents |

## Endpoints

- `POST /mcp`, `/icmarkets/mcp`, `/watch-mcp` — the MCP server. `GET` on
  the same paths opens the streamable-HTTP channel.
- `GET /health` — full detail when authenticated, minimal otherwise;
  includes auto-trade arming state and today's trade count.
- `POST /register_watch`, `/register_trap_watch` — REST mirrors that share
  the exact tool code path, so the two surfaces cannot drift.
- `GET /skill_context_audit` — the same, for the skill-context audit.
- `GET /test-telegram`, `/test-news`.

## Deploying

This is a **directory**, not a single file. On Railway or any Node host:

1. Deploy the whole folder; entrypoint stays `node index.js`.
2. Add a persistent volume and point `STATE_FILE` at it — e.g.
   `/data/watch-state.json`. Without a volume the service still runs, but
   the restart-recovery guarantee is lost, and with auto-trade armed that
   guarantee is what stops a restart from resubmitting an order.

## The one thing to keep in mind when changing this code

An absent or unverifiable observation must never be silently coerced into
a permissive one. A bar with no timestamp is not a closed bar. A missing
partner feed is not an absence of divergence. An unverifiable price scale
is not a valid price. An unreadable positions list is not an absence of
positions. A `null` is not a zero — `Number(null)` is, which is why
`finiteNumber` refuses it explicitly. Each of those returns an explicit
unknown that the caller has to handle, because the alternative is an
infrastructure failure wearing the costume of market evidence — and now
that this service can place orders, that is the class of bug that can
cost real money quietly.
