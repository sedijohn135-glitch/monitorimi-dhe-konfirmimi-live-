# Watch Monitor MCP — v7.0

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
                    sequence, sizing, the pre-submission checklist
lib/execution.mjs   upstream tool discovery, schema-driven order payloads, submission
lib/upstream.mjs    managed cTrader MCP client + coalescing market-data layer
lib/store.mjs       watch registry + durable atomic snapshot
lib/notify.mjs      Telegram outbox with retry and delivery accounting
test/adversarial.test.mjs   the 25 required attack scenarios
test/execution.test.mjs     the entry sequence, sizing, checklist and payload construction
test/smoke.mjs              boots the real server against a fake upstream, twice
test/smoke-autotrade.mjs    drives a scripted setup all the way to a placed order
```

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
