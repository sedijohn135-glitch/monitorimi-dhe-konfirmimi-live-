# Watch Monitor MCP — v7.3

An MCP server that monitors ICT sniper setups and `TRAP_NOT_CONFIRMED`
reads to a deterministic conclusion, notifies a human over Telegram, and
— when auto-trade is explicitly armed — **submits the entry order
itself** the moment the confirmation sequence completes.

It can also promote a confirmed trap watch into a live setup on its own,
closing the last manual step in the chain.

Both are **off by default**, under separate switches. With both off it
behaves exactly like v6: it watches, it confirms, it tells you, and it
never touches the account.

## The setup lifecycle

A setup watch does not enter because price reached the entry. It enters
because the market did all of this, in this order, after the touch —
and it does not die because price reached the stop before any of it
happened, because at that point nothing was entered and nothing was
stopped out.

Four questions, answered separately, because collapsing any two of them
is how a system kills a setup that was still alive or enters a trade that
no longer exists:

| | Question | Terminal state when the answer is no |
|---|---|---|
| **A** | is the thesis still true? | `INVALIDATED` |
| **B** | is the price still enterable? | `ENTRY_MISSED` |
| **C** | has the market defended the setup? | keeps waiting |
| **D** | what happened after ENTER NOW? | `TRADE_STOPPED` / `TARGET_REACHED` |

Full contract: [`docs/setup-lifecycle.md`](docs/setup-lifecycle.md).

## The entry sequence

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

Anything that fails ends at `INVALIDATED`, `ENTRY_MISSED`,
`REANALYSIS_REQUIRED`, `EXPIRED` or `CANCELLED`. `ANTI_SL_EVALUATION` is
entered when price reaches the stop before any entry was taken, and
`QUARANTINED` when the feed cannot be trusted to describe the instrument
at all. After an entry the trade continues on its own record:
`ACTIVE_TRADE → TP1 · TP2 · TP3 · TRADE_STOPPED`.

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

### When price goes to the stop before you are in

Nothing about this runs on a setup that never went near its stop, and no
normal entry waits for it. **Do not wait for a problem that has not
happened.** But when the problem does happen, it gets classified rather
than assumed:

```
             SL excursion event?
                ╱             ╲
             no               yes
              │                │
     continue normally   ANTI_SL_EVALUATION
                               │
                 ┌─────────────┼─────────────┐
             SURVIVES      UNCERTAIN     INVALIDATED
                 │             │              │
          back to defence   bounded, then  setup dead,
           evaluation      fresh analysis  no resurrection
```

Both lazy readings are forbidden — *"gold hunts stops, so ignore it"* and
*"price touched the stop, so it is dead"* — because each replaces
evidence with a prior. What is measured is this excursion: whether any
**closed body** printed beyond the level, how deep it went against ATR
(and against the setup's own risk when ATR cannot be read), how long
price actually spent there, how fast it went and came back, whether the
reclaim held for a closed bar, and whether structure broke against the
setup with displacement behind it. Swept liquidity from `skill_context`
is reported as supporting context and never decides.

Surviving is **not** confirming: the setup goes back to defence
evaluation and has to earn the entry on price action that printed after
the reclaim. Invalidation is final — price running to the original target
later does not mean the old setup was right.

Turn the branch off with `ANTI_SL_ENABLED=false` and price reaching the
stop before entry kills the setup outright, as it used to.

### From a trap straight into a setup

A trap watch used to prove one thing and stop: the level was taken with
delivery. Turning that into something tradeable meant re-running the
analysis by hand and registering a setup — and by the time that happened
the entry zone had often been and gone.

With `AUTO_PROMOTE_TRAPS=true` the monitor closes that gap itself:

```
TRAP CONFIRMED  →  geometry recomputed  →  SETUP REGISTERED
                                                  ↓
                                    the ordinary lifecycle, unchanged:
                                    touch → defence → gates → ENTER NOW
```

What comes out is an **ordinary setup**. It is touched, it proves the
same defence, it passes the same gates, and it is refused by the same
entry-opportunity and anti-SL rules. Promotion removes the human *read*
between the trap and the setup; it removes nothing from the confirmation
that follows.

Six binary gates decide whether a confirmed trap is promoted at all, and
**every unknown fails** — an unmeasurable ratio, a missing trap score, an
unreadable feed:

| Gate | Passes when |
|---|---|
| `auto_promote_enabled` | promotion is armed and this trap did not opt out |
| `kill_zone` | a zone is open or opens within the lookahead; never NY lunch or the weekend |
| `news` | no lockout and no high-impact event in the blackout window |
| `displacement` | the **confirming candle itself** carries ≥ `PROMOTE_DISPLACEMENT_MULTIPLE` |
| `trap_score` | the recorded score, normalised to /9, is at least `PROMOTE_MIN_TRAP_SCORE` |
| `invalidation_untouched` | the flip level has not been reached, wicks included |

The trap's **flip level becomes the setup's `thesis_invalidation`**, and
the recomputed stop stays the stop. That is what lets a promoted setup
tell the two apart: price reaching the stop opens the anti-SL branch,
price reaching the flip level ends the setup.

`AUTO_PROMOTE_TRAPS` is the only thing that arms promotion — a trap's own
`auto_promote: true` does **not** opt in, so a client registering a trap
can never escalate past the operator's environment. `auto_promote: false`
opts a single trap out.

By default a promoted setup proves exactly what a hand-registered one
proves. `PROMOTE_DEFENCE_PROFILE` and `PROMOTE_URGENCY` can speed it up
afterwards — deliberately left for afterwards, because promotion already
removes the human read, and changing both at once leaves no way to tell
which one was responsible for the outcome.

### Three clocks, not one

Collapsing them is how a setup that is still perfectly alive gets killed
by the wrong one.

| Field | Bounds | Runs from |
|---|---|---|
| `entry_monitoring_window_minutes` | how long to wait for price to reach the zone | registration |
| `confirmation_deadline_minutes` | how long confirmation may take **once it has something to confirm** | **the touch** |
| `expiration_minutes` | when the setup is over regardless | registration |

Before the touch there is no confirmation to bound, so a confirmation
deadline measured from registration is really a second entry window
wearing the wrong name — a shorter one that silently overrides the entry
window the analyst declared.

Past the **entry window** with no touch: `ENTRY_MISSED` if price has left
the entry behind, `EXPIRED` if it is still nearby and nothing happened.
Past the **confirmation deadline**: `EXPIRED` if the read never
completed, `REANALYSIS_REQUIRED` if it completed and a gate held it.

### When the entry runs away

Price reaching TP1 without you, or a confirmation that arrives with price
too far from the planned entry, both resolve `ENTRY_MISSED`. Not an
expiry, not a failure — the thesis may have been perfectly right — and
never a reason to chase. The distance that counts as too far is derived
from the instrument's volatility and the setup's own risk, not from a
fixed number of points, and only drift that makes the fill *worse*
counts.

### What the setup can declare about itself

`register_watch` takes the analyst's own rules, not just levels:

| Field | Meaning |
|---|---|
| `entry_zone_low` / `entry_zone_high` | the entry band, e.g. `4330` / `4334`. Touched at the edge price approaches from, never at the midpoint |
| `potential_trade_sl` (= `sl`) + `thesis_invalidation` (= `invalidation`) | where a trade **would be stopped**, and where the **analysis is wrong**. Send both whenever they differ: a setup that declares only one number has declared a stop, and before entry a stop alone invalidates nothing — it opens the anti-SL branch instead |
| `defence_profile` | what **this** setup must prove after the touch: `standard`, `m1_continuation` or `rejection_displacement`. The monitor never picks one for you |
| `urgency` | `LOW`/`NORMAL`/`HIGH`/`CRITICAL`. Scales how long evidence must hold and nothing else — it cannot remove a proof, open a gate, or outrank an invalidation |
| `max_entry_deviation` | how far past the planned entry is still worth entering. Never honoured beyond half the entry-to-stop distance |
| `confirmation_deadline_minutes` | how long confirmation may take **once the zone is touched** — the clock runs from the touch, not from registration |
| `entry_monitoring_window_minutes` | how long to wait for price to reach the zone at all |
| `prerequisite_level` + `prerequisite_timeframe` + `prerequisite_rule` | what must print before entry is live at all, e.g. an M15 **body close** below `4324.71`. A wick through it is not a close, and until it prints the watch reports `WAITING_FOR_SETUP_CONFIRMATION` |
| `invalidation_rule: "body_close"` + `invalidation_timeframe` | a wick above `4368.31` is not invalidation if the rule says body close. Once a trade is open the **stop loss is a hard price line either way**, so this can never leave a position unprotected |
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

## Trap promotion

A trap watch answers one falsifiable question — did the level get taken
with delivery — and then hands the question back to a human, who re-runs
the analysis and registers a setup. With `AUTO_PROMOTE_TRAPS=true` the
server closes that gap itself: on confirmation it recomputes the
geometry and registers the setup, so trap → setup → entry → order runs
with nobody in the loop.

That is a bigger step than arming auto-trade, because it removes the last
human read. It has its own switch, off by default, independent of
`AUTO_TRADE_ENABLED`. Armed with auto-trade off it still earns its keep:
the setup is registered and monitored, and the confirmation arrives as an
actionable alert with levels instead of a "re-run the pipeline" one.

### The hard gates

Not the 23-item scored checklist — scoring is judgement, and judgement
nobody reads is not judgement. What runs is the load-bearing binary
subset, and **every one of them must pass**:

| Gate | Passes when |
|---|---|
| `auto_promote_enabled` | promotion is armed and this trap did not opt out |
| `kill_zone` | a kill zone is open, or opens within `PROMOTE_KILL_ZONE_LOOKAHEAD_MIN` — never in NY lunch or at the weekend |
| `news` | no manual lockout and no high-impact event inside the blackout window |
| `displacement` | the **confirming candle itself** carries ≥ `PROMOTE_DISPLACEMENT_MULTIPLE` (default 3.0x) against its own 20-bar trailing average |
| `trap_score` | the trap's recorded score, normalised to /9, is at or above `PROMOTE_MIN_TRAP_SCORE` |
| `invalidation_untouched` | the trap's flip level has not been reached, wick included |

A gate whose input cannot be read fails. An unmeasurable displacement
ratio, a missing `trap_score`, an unreadable news feed — each is a no,
because this decision creates orders and an unanswerable question is not
a yes. Register traps with a score the parser can read (`"7/9"`,
`"Grade B (6/9)"`, `"7"`) or they will never promote.

The displacement threshold here is the analysis pipeline's **3.0x**, not
the execution sequence's 1.8x. They answer different questions: 3.0x
decides whether this move deserves a setup at all, 1.8x decides whether a
setup that already exists is being entered at the right moment. The
looser one still runs downstream, on top of this.

### The geometry

Computed with the same primitives as `scripts/ict_levels.py`, ported to
`lib/ict.mjs` — strict 3-candle swings, body-close structure breaks, FVGs
with CE and penetration:

- **Entry** is a PDA array, never the level price just displaced through:
  the nearest unfilled FVG's CE first, the order block's mean threshold
  second, the trigger level as a breaker retest only if neither exists.
  The array's bounds become the setup's `entry_zone_low`/`high`.
- **Stop** goes beyond the nearest strict swing on the far side of the
  zone, plus a `PROMOTE_SL_BUFFER_ATR_FRACTION` buffer.
- **Targets** are real levels, nearest first: the working range's
  equilibrium, pooled EQH/EQL, swing liquidity, then the higher
  timeframe's range. Each is at least half an R past the last.
- **TP1 must clear `PROMOTE_MIN_RR`** (default 1R) or the promotion is
  refused — a trap that has run out of room is not a setup.

Every refusal names what stopped it, in the same spirit as a trap's own
`what_is_missing`, and the trap still resolves and still notifies. A
promotion that failed silently would be indistinguishable from one that
never ran.

### What it does not touch

`AUTO_TRADE_DRY_RUN` stays a deploy-level switch; promotion never flips
it, and a promoted setup runs the same dry run as a hand-registered one.
`AUTO_TRADE_MAX_OPEN_POSITIONS`, `AUTO_TRADE_MAX_TRADES_PER_DAY`,
`AUTO_TRADE_MAX_SLIPPAGE_RISK_FRACTION` and the downstream kill-zone and
news gates are unchanged: promotion is an **extra upstream filter**, not
a replacement for anything below it. A promoted setup still has to be
touched, still has to show rejection → M5 MSS → displacement, and still
has to clear the whole pre-submission checklist.

### Rolling it out

1. `AUTO_PROMOTE_TRAPS=true` with auto-trade still off. Confirm in the
   logs and Telegram that the *computed setups* look like setups you
   would have taken: right model, right array, right stop, sane targets,
   and the right gate decisions on the ones that were refused.
2. Then arm auto-trade with `AUTO_TRADE_DRY_RUN=true` and check the
   order payload separately.
3. Only once both have been read in the logs, drop the dry run.

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
                    sequence, skill context, setup lifecycle, anti-SL-Hunter,
                    entry opportunity, event trail, sizing, the pre-submission checklist
lib/promotion.mjs   the promotion gates and the geometry a confirmed trap becomes
lib/ict.mjs         the analysis pipeline's own primitives — swings, FVGs, displacement
lib/execution.mjs   upstream tool discovery, schema-driven order payloads, submission
lib/ict.mjs         the analysis pipeline's primitives, ported: swings, FVGs,
                    displacement, structure, sweeps, premium/discount
lib/promotion.mjs   trap-confirmation gates and the setup geometry they produce
lib/upstream.mjs    managed cTrader MCP client + coalescing market-data layer
lib/store.mjs       watch registry + durable atomic snapshot
lib/notify.mjs      Telegram outbox with retry and delivery accounting
test/adversarial.test.mjs   the 25 required attack scenarios
test/execution.test.mjs     the entry sequence, sizing, checklist and payload construction
test/skill-context.test.mjs the skill-context fast lane and the guardrails around it
test/lifecycle.test.mjs     the setup lifecycle, anti-SL-Hunter and entry opportunity
test/promotion.test.mjs     the ported primitives, the promotion gates and the geometry
docs/skill-context.md       the contract the analysis skill fills in
docs/setup-lifecycle.md     the setup lifecycle contract, in full
test/smoke.mjs              boots the real server against a fake upstream, twice
test/smoke-autotrade.mjs    drives a scripted setup all the way to a placed order
test/smoke-promotion.mjs    promotes a delivered trap and refuses a drifting one
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

### Setup lifecycle

| Variable | Default | Notes |
|---|---|---|
| `ANTI_SL_ENABLED` | `true` | `false` restores the old behaviour: price reaching the stop before entry kills the setup outright |
| `ANTI_SL_WICK_DEPTH_ATR` / `ANTI_SL_MAX_DEPTH_ATR` | `0.5` / `1` | how deep a sweep may be, and past what depth it is a move rather than a sweep |
| `ANTI_SL_WICK_DEPTH_RISK` / `ANTI_SL_MAX_DEPTH_RISK` | `0.15` / `0.35` | the same two bounds as fractions of the setup's own risk, used when ATR cannot be read. With neither available the excursion is unclassifiable, which is `UNCERTAIN` and never `SURVIVES` |
| `ANTI_SL_WICK_DURATION_MS` / `ANTI_SL_MAX_DURATION_MS` | `300000` / `900000` | how long price may sit beyond the line |
| `ANTI_SL_RECLAIM_HOLD_MS` | `60000` | a reclaim has to hold for a closed bar |
| `ANTI_SL_FAST_ATR_PER_MIN` | `1` | the speed at which a deeper excursion is still credible as a sweep |
| `ANTI_SL_MAX_EVALUATION_MS` | `1800000` | past this an unclassified excursion goes back to the analyst |
| `ENTRY_DEVIATION_ATR_FRACTION` | `0.75` | volatility term of the entry-deviation cap |
| `ENTRY_DEVIATION_RISK_FRACTION` | `0.3` | ceiling as a fraction of entry-to-stop |
| `ENTRY_MIN_REMAINING_RR` | `0.5` | floor on what remains of the R:R **at the fill**. Deliberately below the 1R registration demands — the acceptance requirement moves the fill up to 0.35R past entry by design, so a 1R floor here would contradict it |
| `CONFIRMATION_DEADLINE_MINUTES` | `0` (off) | service-wide default for the per-setup deadline |
| `TRADE_TRACKING_ENABLED` | `true` | the post-entry TP/SL lifecycle |
| `TRADE_WATCH_INTERVAL_MS` / `MAX_TRADE_WATCHES` | `10000` / `10` | its cadence and capacity |

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

### Trap promotion

| Variable | Default | Notes |
|---|---|---|
| `AUTO_PROMOTE_TRAPS` | `false` | the only thing that arms promotion; a trap's own `auto_promote:true` cannot |
| `PROMOTE_DISPLACEMENT_MULTIPLE` | `3` | the confirming candle's ratio against its 20-bar trailing average |
| `PROMOTE_DISPLACEMENT_WINDOW` | `20` | bars in that average |
| `PROMOTE_MIN_TRAP_SCORE` | `6` | out of 9; an unreadable or missing score fails |
| `PROMOTE_REQUIRE_KILL_ZONE` | `true` | |
| `PROMOTE_KILL_ZONE_LOOKAHEAD_MIN` | `10` | a zone opening this soon counts as open |
| `PROMOTE_REQUIRE_NEWS_CLEAR` | `true` | |
| `PROMOTE_SL_BUFFER_ATR_FRACTION` | `0.15` | buffer beyond the structural swing |
| `PROMOTE_MIN_RR` | `1` | refuse the promotion if TP1 is closer than this |
| `PROMOTE_EXPIRATION_MINUTES` | `120` | expiry on the promoted setup |
| `PROMOTE_RISK_PERCENT` | account default | per-promotion sizing override |
| `PROMOTE_LTF_BARS` / `PROMOTE_HTF_BARS` | `120` / `60` | history pulled for the recomputation |
| `PROMOTE_DEFENCE_PROFILE` | `standard` | what a promoted setup must prove after its touch |
| `PROMOTE_URGENCY` | `NORMAL` | how patient its confirmation hold is |
| `PROMOTE_CONFIRMATION_DEADLINE_MINUTES` | `0` (off) | deadline on the promoted setup's confirmation |

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
- `get_setup_trail` (MCP tool) — one setup's whole ordered history: every
  state transition, defence step, stop excursion, anti-SL verdict and
  outcome, each with its own event id and the setup's correlation id,
  plus the excursion measurements and the measured decision latency.
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
