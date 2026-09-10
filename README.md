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

### When a trap's trigger counts as taken

A trap watch waits for a level to be **crossed**, and the direction is
fixed by the bias: a `buy` read is taken by a body closing **above** its
trigger, a `sell` read by one closing **below** it. That is the
convention the arming message prints, and the one registration enforces
by requiring a buy's flip level to sit below its trigger — invert it and
a single close could be both the confirmation and the flip.

Taking a level is a **transition, not a state**. A close beyond a level
price was already beyond breaks nothing; it is just where the market
already was. So the take requires the previous closed body to have been
on the un-taken side, and two things follow:

- a trap whose trigger price has already gone past is **refused at
  registration** (`TRIGGER_ALREADY_PASSED`), naming the live price — the
  read has been overtaken by the market and belongs back with the
  analyst;
- one already armed that way simply never reports a take. It is not
  killed: if price returns to the un-taken side and genuinely closes back
  through, the crossing is seen and the watch works from then on.

Every trigger test is logged with the exact comparison it made — close,
operator, trigger, previous close, and the verdict — so a disputed
notification can be read straight from the log rather than reconstructed.

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

The confirmation deadline is only **enforced** where the operator armed
one with `CONFIRMATION_DEADLINE_MINUTES`, which is off by default. A
setup's own `confirmation_deadline_minutes` refines that deadline where
it applies and is always recorded and reported — it cannot arm one, the
same way `max_entry_deviation` cannot arm the entry-distance cap. The
field sits in the analysis template, so a value arrives on every setup —
twenty minutes on one, seventy-five on the next — and enforcing whatever
turned up killed setups whose confirmation was still coming. Confirmation
legitimately arrives later than an analysis guessed: the evidence machine
waits for proof that persists, and a level can take longer than a
declared twenty minutes to deliver it. `expiration_minutes` still bounds
the setup's life either way, so nothing runs forever.

### When the entry runs away

Price reaching TP1 without you always resolves `ENTRY_MISSED` — not an
expiry, not a failure, and never a reason to chase.

A confirmation that completes with price far from the planned entry does
**not**, by default. The evidence engine's own hold-and-fade check (§7)
already discards a move that reverses: a signal fades and resets the
moment price trades back against it, before it can graduate. A signal
that *does* graduate has proven itself by not reversing — and by the time
that persistence check completes on a genuine momentum move, price is
often well past the zone that first drew attention to it. That distance
is the proof, not a defect; capping it stands an entry down for the exact
reason it was safe.

`ENTRY_DEVIATION_CHECK_ENABLED=true` restores the cap, and it is the
**only** thing that can. A setup's own `max_entry_deviation` refines the
cap where capping is already armed; it cannot arm it. It used to, and
that quietly undid the default for every setup: the field sits in the
analysis template, so the skill sends one every time, and a real BTCUSD
entry was refused for running 91 past its entry against a declared cap of
70 — confirmed on acceptance, a graduated pattern and PDA confluence,
with 0.87R still on the table. A registering client can withhold
permission, never add it, exactly as `auto_promote` already works.

The distance that counts as too far, where the check does apply, is
derived from the instrument's volatility and the setup's own risk, never
a fixed number of points, and only drift that makes the fill *worse*
counts.

### The fill contract

The argument above holds, and it is still not the whole answer, because it
answers the wrong question. Distance is a proxy: it measures how far
price ran and *infers* a worse trade from it. The thing worth protecting
is not the distance — it is whether the trade on offer is still the trade
that was analysed. Those come apart, and the monitor's own live
confirmations are where they came apart:

| Setup | Analysed | At the fill | Slippage | Deviation cap |
|---|---|---|---|---|
| `XAUUSD_1788545` | 5.08R | **3.09R** | 2.92 | 1.80 |
| `XAUUSD_1788372` | 2.33R | **0.85R** | 3.99 | 1.50 |
| `XAUUSD_1788270` | 2.65R | **1.22R** | 6.45 | 3.00 |

All three were notified as `ENTER NOW` carrying the analysed ratio. Two of
them had stopped being that trade. And arming the cap would have refused
all three — including the 3.09R one, which was exactly the trade it
claimed to be. The cap is wrong in both directions here: too blunt to keep
the good fill, and not the measurement that catches the bad ones.

So the cap stays off and `ENTRY_MIN_REMAINING_RR` does the work, raised
from `0.5` to `1.5`. It asks the question directly — what ratio would this
fill actually get? — and on the same three confirmations it keeps the
3.09R and refuses the 0.85R and the 1.22R. Below the floor no entry
notification is sent at all; a `SETUP DEGRADED` message goes out instead,
naming both ratios, because the operator opens a market order from that
message without opening a chart and "entry missed" would send him looking
for the next one when it was the setup that failed, not his timing.

Every confirmation now carries the arithmetic in the message — slippage
against the cap, risk against plan, R:R against what was analysed — and
`get_skill_context_audit` reports the same numbers across every
confirmation under `fill_contract`, so the floor can be judged on
evidence rather than argued about. An empty `degraded` list over many
confirmations means it is too loose; degraded entries whose fills were
fine mean it is too tight.

### The floor is measured to the objective, not to the first partial

A floor is only as good as the target it answers to, and TP1 is not always
the trade. An analysis that names a **Draw On Liquidity** is describing a
delivery *to the DOL*; the nearer targets are scale-outs on the way, and
in the v6 template TP1 is literally labelled "Low Hanging Fruit".

Judging such a setup on TP1 answers a question nobody asked. It happened
live:

| | XAUUSD short, entry 4404.50, stop 4415.50 |
|---|---|
| TP1 4384.66 — *Low Hanging Fruit* | 1.80R planned → **1.23R** at the fill |
| TP2 4354.10 — *DOL Final* | 4.58R planned → **3.43R** at the fill |

The monitor measured TP1, saw 1.23R against a 1.5R floor, and sent
`SETUP DEGRADED`. Price then ran from 4404 to 4396 — the trade the
operator was told not to open was delivering while the message sat in his
phone. Refusing a 3.4R fill is the same failure as notifying a 0.85R one,
pointed the other way.

`rr_target` fixes it. It names which target the floor answers to —
`tp1` (the default, so nothing existing changes), `tp2` or `tp3` — and the
paste path fills it in on its own by matching the declared `DOL:` level
against the declared targets. Matching is by **level, not by label**: the
label is prose ("DOL Final / H1 EQL Strong Magnet") and the level is not.
A DOL that matches no target leaves the default alone rather than guessing.

The promised ratio is then quoted to the same target as the live one —
4.58R against 3.43R, never 1.80R against 3.43R, which would read as a
setup that improved. Every message and the audit name the target they
measured.

The guards that stop this becoming a loophole are the ones already there:
`RISK_INVERTED` runs first, so a distant DOL cannot make a trade whose
stop is already breached look generous, and registration refuses an
`rr_target` naming a target the setup never sent rather than silently
falling back.

### The entry zone is the band the analysis declared

The same setup declared `PDA: … [4404.00 - 4408.00]` and a trigger that
fires *inside* that band. The parser had no PDA label, so the zone fell
back to entry ± tolerance — **0.20 wide** on gold. Nothing lives inside a
0.20 band for long, which made every in-zone rule the monitor has
unreachable: the CISD fast lane, the shortened hold. The only confirmation
route left was the one that waits for price to travel away from the
entry — and that travel is exactly what the R:R floor then punished.

The PDA band is now read as a zone source, under the same consistency
check the KURTHI zone already answers to: adopted only when the entry sits
inside it and the stop sits clear of it, so a band quoted from another leg
cannot move the entry. The warning that reports it names the block it came
from, which it previously did not — every source was announced as the
KURTHI landing zone, including on pastes where the KURTHI zone was the one
rejected.

`INVALID:` is also read now. The v6 template writes the declared
invalidation under that spelling, and missing it meant the monitor
inferred a level past the stop and would have held a setup the analysis
had already called dead.

### What the setup can declare about itself

`register_watch` takes the analyst's own rules, not just levels:

| Field | Meaning |
|---|---|
| `entry_zone_low` / `entry_zone_high` | the entry band, e.g. `4330` / `4334`. Touched at the edge price approaches from, never at the midpoint |
| `potential_trade_sl` (= `sl`) + `thesis_invalidation` (= `invalidation`) | where a trade **would be stopped**, and where the **analysis is wrong**. Send both whenever they differ: a setup that declares only one number has declared a stop, and before entry a stop alone invalidates nothing — it opens the anti-SL branch instead |
| `defence_profile` | what **this** setup must prove after the touch: `standard`, `m1_continuation` or `rejection_displacement`. The monitor never picks one for you |
| `rr_target` | which target the R:R floor is measured to at the fill: `tp1` (default), `tp2` or `tp3`. Send the **objective**, not the first partial — a setup whose nearer targets are scale-outs on the way to a DOL is judged on the DOL. The paste path sets it from a declared `DOL:` level. Must name a target the setup actually sends |
| `urgency` | `LOW`/`NORMAL`/`HIGH`/`CRITICAL`. Scales how long evidence must hold and nothing else — it cannot remove a proof, open a gate, or outrank an invalidation |
| `max_entry_deviation` | how far past the planned entry is still worth entering. **Ignored unless the operator armed capping** with `ENTRY_DEVIATION_CHECK_ENABLED`; sending it cannot arm it. Where it does apply, never honoured beyond half the entry-to-stop distance |
| `confirmation_deadline_minutes` | how long confirmation may take **once the zone is touched** — the clock runs from the touch, not from registration. **Ignored unless the operator armed a deadline** with `CONFIRMATION_DEADLINE_MINUTES`; sending it cannot arm one |
| `entry_monitoring_window_minutes` | how long to wait for price to reach the zone at all |
| `prerequisite_level` + `prerequisite_timeframe` + `prerequisite_rule` | what must print before entry is live at all, e.g. an M15 **body close** below `4324.71`. A wick through it is not a close, and until it prints the watch reports `WAITING_FOR_SETUP_CONFIRMATION` |
| `invalidation_rule: "body_close"` + `invalidation_timeframe` | a wick above `4368.31` is not invalidation if the rule says body close. Once a trade is open the **stop loss is a hard price line either way**, so this can never leave a position unprotected |
| `risk_percent` / `volume` | per-setup sizing overrides |
| `auto_trade: false` | monitor this setup but never execute it, even while auto-trade is armed |
| `skill_context` | what the analysis already proved before the touch — see below |

## Confirmation

Every setup confirms the same way. There are two routes to an entry and
both are the same for every setup — no per-setup exception the monitor can
grant itself, and nothing a registering client can ask for that another
one cannot, which is the only way the operator can predict what it will
do.

**By default** (`ENTRY_SEQUENCE_REQUIRED=false`) the standard route needs:

- **live acceptance** — price has travelled far enough beyond the entry,
  and still sits far enough from the risk line, to call the level
  accepted rather than merely touched; and
- **at least one graduated technical signal** — CISD, SMT divergence, a
  price pattern (rejection wick / engulfing), a **Judas Swing at the New
  York midnight open** (the swing nearest the open swept, then price
  closes back through the open itself, against the swept side), or **PDA
  confluence** (an FVG, an order block, and/or an equal-highs/lows
  cluster all sitting within a tight tolerance of the entry level).

The last two were added from a direct read of ICT's own lecture material
rather than invented — the midnight open is the single most repeated
reference level across it, and array confluence is how it grades one
level as stronger evidence than another. Both are graduated technical
signals like the rest: they have to survive the same hold-and-fade rule,
and neither is required — they only add ways to graduate, never a way to
refuse. `ENTRY_CONFLUENCE_MIN_HITS` (default `2`) and
`ENTRY_CONFLUENCE_TOLERANCE_PCT` (default `0.1`) tune the confluence
read.

Each has to survive both wall-clock time and a market-time boundary
before it counts. Poll frequency is never a substitute for market time.

### The CISD fast lane

The second route, `CISD_FAST_LANE_ENABLED` (default on). It exists because
of an ordering problem in the standard one: acceptance cannot be satisfied
until price has already travelled a buffer beyond the entry, so it is a
late condition by construction — and CISD, which needs only two bars (a
sweep, and a close that reclaims it), is the earliest signal in the set.
The early signal therefore ends up waiting on the late one, and the fill
arrives well past the price the analysis named. That ordering is the
mechanism behind the fill table above.

The lane substitutes a different proof for the same question. Where
acceptance argues *price moved, so the level held*, this argues
*structure broke and price is still standing on the level*:

- **CISD graduated**, and
- **a strong rejection** printed with it — a strong wick or M5 engulfing,
  not the soft tier, which is the tier that fades; and
- **price still inside the entry zone**.

That last condition is what makes the substitution safe rather than merely
faster. Inside the zone, slippage is bounded by the zone's own width by
construction, so the fill cannot be a different trade from the planned
one — and invalidation sits close enough that a wrong read is discovered
immediately and survived cheaply. Outside the zone neither holds, and the
lane refuses.

Nothing is removed and no gate is skipped. It is an additional route to
`enter`; a setup that fails it still has the standard route waiting behind
it, and every downstream gate still applies — kill zone, spread, news, and
the R:R floor at the fill. When both routes qualify the standard one is
what gets recorded, because it is the stronger proof. Which route proved a
given entry is stored as `entry_lane`, named in the confirmation message,
and counted per lane in `get_skill_context_audit` under `fill_contract`.

That is the confirmation this monitor shipped with, and the one its
operator reports as the one that worked: later than the touch, and
reliably right when it fired.

**Set `ENTRY_SEQUENCE_REQUIRED=true`** and the post-touch sequence is
required on top — zone rejection, a structure shift, then displacement,
each proven on a closed bar that closed after the touch. It is stricter
and five to fifteen minutes slower. `defence_profile` chooses which
sequence a given setup must prove.

### The *skill-context* fast lane, and why that one is gone

Not to be confused with the CISD lane above. The difference is where the
proof comes from: the CISD lane reads live price and asks the market, this
one took the analysis at its word.

An earlier version let the analysis skill claim it had already read the
M5 structure shift, and accept an M1 proof in its place.

It could not work. The lane opened only while the analysis was still
inside its own freshness window — three minutes by default — but an
analysis is written, then registered, then waits for price to come back
to the zone. On the live setup that prompted its removal the context was
**six minutes past its window before the watch was even registered**, and
thirty-four minutes past it by the time price arrived. The lane never
opened. All it produced was a Telegram message announcing that it had
been refused, which read as a fault every time.

`skill_context` is still accepted and still worth sending — as a
**record**. `get_skill_context_audit` scores each claim against what the
market then did, which is the only way the conviction scale can be
calibrated. It changes no confirmation decision.

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

## After the entry: structural failure

TP1/2/3 and the stop are price lines. Structure can erode before price
ever reaches either — a fresh swing prints against the position and then
a bar closes through it, again and again, while the stop sits untouched.
Once `ACTIVE_TRADE_STRUCTURE_FAILURE_LIMIT` such closes have happened
(default `3`), one Telegram message fires: **STRUCTURE FAILING — CONSIDER
EXITING**.

This is advisory only, and fires once. It never closes the trade, adjusts
the stop, or changes anything the monitor tracks — TP1/2/3 and the stop
still apply exactly as before. There is no broker order behind a manual
position for it to act on; only the human holding the trade can.

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
| `IN_ZONE_HOLD_SHORTENING_ENABLED` | `true` | while price is still inside the entry zone the hold drops to `SKILL_CONTEXT_MIN_HOLD_FLOOR_MS`. Away from the level the evidence is all there is to trust, so it pays the full wait; on the level, waiting spends the entry it was protecting and invalidation is close enough to make a wrong read cheap. `false` serves the full hold everywhere |
| `REQUIRE_NEW_M1_CANDLE` | `true` | evidence must also survive a bar boundary — unaffected by the line above |
| `CISD_FAST_LANE_ENABLED` | `true` | a second route to entry: CISD graduated **and** a strong rejection **and** price still in the entry zone, without waiting for acceptance. Acceptance cannot be satisfied until price has already travelled, so it makes the earliest signal in the set wait on the latest and the fill lands away from the analysed entry. The in-zone requirement is what makes the substitution safe rather than merely faster — slippage is bounded by the zone's own width. Every downstream gate still applies, the R:R floor included. `false` leaves the standard rule exactly as it was |
| `CISD_FAST_LANE_REQUIRE_STRONG_PATTERN` | `true` | `false` lets CISD alone take the fast lane. Not recommended: soft is the tier that fades |
| `ACCEPTANCE_ATR_FRACTION` | `0.5` | acceptance buffer, capped by `ACCEPTANCE_RISK_FRACTION` |
| `ACCEPTANCE_RISK_FRACTION` | `0.35` | ceiling as a fraction of entry-to-invalidation |
| `NEWS_FAIL_CLOSED` | `true` | unknown news state blocks new confirmations |
| `MAX_ACTIVE_WATCHES` / `MAX_TRAP_WATCHES` | `25` / `25` | registration refuses beyond this |
| `KILL_ZONE_FILTER_ENABLED` / `SPREAD_CHECK_ENABLED` / `NEWS_FILTER_ENABLED` | `true` | entry gates |
| `SPREAD_CAP_<SYMBOL>` | derived | per-symbol hard cap override |

### Entry sequence

| Variable | Default | Notes |
|---|---|---|
| `ENTRY_SEQUENCE_REQUIRED` | `false` | evidence only, the confirmation this monitor shipped with. Set `true` to also require the post-touch sequence |
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
| `ENTRY_DEVIATION_CHECK_ENABLED` | `false` | off by default — a graduated signal has already proven it did not fade, distance from the zone notwithstanding, so capping distance stands down entries for the reason they were safe. The **only** thing that arms the cap: a setup's own `max_entry_deviation` refines it but cannot arm it. `true` requires every setup to stay within the cap |
| `ENTRY_DEVIATION_ATR_FRACTION` | `0.75` | volatility term of the cap, when it applies |
| `ENTRY_DEVIATION_RISK_FRACTION` | `0.3` | ceiling as a fraction of entry-to-stop, when it applies |
| `ENTRY_MIN_REMAINING_RR` | `1.5` | floor on what remains of the R:R **at the fill** — the fill contract, and the single most consequential number in this table. It was `0.5`, on the reasoning that acceptance moves the fill up to 0.35R past entry by design so a high floor would contradict it. Measured, that reasoning was wrong about the size of the effect: of the monitor's three live confirmations, setups analysed at 5.08R, 2.33R and 2.65R were confirmed at 3.09R, **0.85R** and **1.22R**, and all three were notified as `ENTER NOW` carrying the analysed ratio. Below this floor the entry notification is withheld and `SETUP DEGRADED` is sent instead. Lower it to `1.0` for more entries at a thinner promise; `0.5` restores the old behaviour |
| `CONFIRMATION_DEADLINE_MINUTES` | `0` (off) | the **only** thing that arms the confirmation deadline. Off by default, because confirmation legitimately arrives later than an analysis guessed; a setup's own `confirmation_deadline_minutes` refines the deadline but cannot arm it. `expiration_minutes` still bounds the setup either way |
| `TRADE_TRACKING_ENABLED` | `true` | the post-entry TP/SL lifecycle |
| `TRADE_WATCH_INTERVAL_MS` / `MAX_TRADE_WATCHES` | `10000` / `10` | its cadence and capacity |
| `ENTRY_CONFLUENCE_MIN_HITS` | `2` | distinct PDA array types that must cluster at the entry level for confluence to graduate |
| `ENTRY_CONFLUENCE_TOLERANCE_PCT` | `0.1` | how close, as a percent of price, counts as "the same level" |
| `ACTIVE_TRADE_STRUCTURE_FAILURE_LIMIT` | `3` | closes against an open position before the one advisory "consider exiting" alert fires |

### Skill context

| Variable | Default | Notes |
|---|---|---|
| `SKILL_CONTEXT_ENABLED` | `true` | contexts are recorded and audited; none of them change a confirmation either way |
| `SKILL_CONTEXT_MIN_HOLD_FLOOR_MS` | `15000` | the shortest hold urgency can reach; floor of `5000` |
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
- `POST /paste_setup`, `GET /paste` — the manual path, for a setup that
  was produced somewhere the MCP cannot reach. See below.
- `get_chart_image` (MCP tool) — a candlestick chart as a PNG, drawn from
  the feed's own OHLC bars. See below.
- `get_setup_trail` (MCP tool) — one setup's whole ordered history: every
  state transition, defence step, stop excursion, anti-SL verdict and
  outcome, each with its own event id and the setup's correlation id,
  plus the excursion measurements and the measured decision latency.
- `GET /test-telegram`, `/test-news`.

## Running the analysis from live data

`docs/v13-live-input.md` replaces the screenshot section of a
screenshot-based analysis prompt and nothing else: which tool serves each
timeframe role, and the two connector conventions that are silent when
you get them wrong — only `fromTimestamp`+`toTimestamp` works on
`get_trendbars`, and its OHLC are raw integers needing ÷100,000 while
`get_chart_image`'s axis is already real. Plus the rule that keeps the
two apart: **structure from the picture, every number from the bars.**

It ends by mapping V13's output onto `register_watch` and calling it. The
Kurthi's own landing zone becomes `entry_zone_low`/`entry_zone_high` —
that band is what Active validation waits at, and a bare entry price arms
the monitor on a single number price rarely touches exactly.

## Charts as pictures

`get_chart_image` renders candles to a PNG and returns it as an MCP image
block. It exists because an analysis that reads market structure —
displacement, swing points, fair value gaps, where a trap will land — is
doing pattern recognition, and a vision model does that far better from a
picture than from a JSON array of several hundred bars. The numbers are
richer than any screenshot; the picture is the interface the model reads
them best through. Drawing the chart here gets both: the levels in the
image ARE the live levels, to the tick, because they come from the same
bars the monitor watches.

Called with a symbol it fetches that timeframe and draws it. Called with
no symbol it returns a fixed demo chart, and that is the point of the
demo: **an MCP client that silently drops image content is
indistinguishable from one that had nothing to show.** Ask the model what
it sees. If it describes candles, that client delivers images to the
model and the whole approach is available; if it only reports the
metadata, it does not, and the images have to reach the model some other
way. Claude renders MCP image blocks; Gemini's `functionResponse` part
carries text only, which its CLI works around client-side
([gemini-cli#2136](https://github.com/google-gemini/gemini-cli/issues/2136))
— so the answer differs per client, and the demo chart is how you find
out in one call rather than after building a renderer.

`levels` draws dashed rules for the entry, stop and targets, and widens
the axis to include them: a stop beyond the highest high would otherwise
be clipped, and the chart would quietly omit the one line the read most
depends on.

The PNG encoder is written against `node:zlib` rather than pulled from
npm. A service whose job is to stay up for weeks should not take a
native-dependency risk for what amounts to rectangles and lines.

## The paste path

`GET /paste` serves a textarea; `POST /paste_setup` takes the same text
as a plain body. The text is parsed into the `register_watch` shape and
registered through the identical code path, so a pasted setup is
monitored exactly like a programmatic one. This is deliberate: the
analysis that produces a setup and the monitor that validates it are
separate systems, and the monitor never needs to know which tool wrote
the text it was handed.

What the parser will not do is guess. It reads labelled lines and leaves
a field out rather than invent it — but the analysis text describes *two*
moves, the trap and the trade, and three rules keep them apart:

- **A trap's direction is not the trade's direction.** `Direction: UP
  sweep` inside a KURTHI block is the manipulation move. Read as the
  trade side it inverts the setup, so sweep-shaped values are refused and
  `After trap → real move: BEARISH` is read instead.
- **Geometry outranks vocabulary.** `entry`, `sl` and `tp1` admit exactly
  one consistent side, and they are the numbers that reach the terminal.
  Where a direction word contradicts them, the word is corrected and the
  correction is reported in `warnings` — refusing the paste instead would
  reject a setup whose prices were never in doubt.
- **The KURTHI landing zone is the entry zone.** `Expected wick to:
  4372.50 – 4376.00` is the zone Active validation waits at, so it is
  adopted as `entry_zone_low`/`entry_zone_high` — but only when it sits
  consistently with the entry and the stop. An explicit `ENTRY ZONE`
  always outranks it.

Labels survive the decoration a chat model puts around them: bordered
tables, `**bold**`, bullets and numbered lists all parse. Comma group
separators are read as such, so `108,450.00` is a hundred and eight
thousand, not `108.45`.

Every field the parser filled in by inference is named in the response's
`warnings`, alongside `recognised` and the full `parsed` object. Read
them — a setup that registered is not the same as a setup that was read
the way you meant it.

The paste path does not arm auto-trade and does not choose a defence
profile. Without a `VALIDATION MODE` line the monitor uses `standard`:
zone rejection, then an M5 structure shift, then displacement — the
Active validation the analysis expects.

## Deploying

This is a **directory**, not a single file. On Railway or any Node host:

1. Deploy the whole folder; entrypoint stays `node index.js`.
2. Set the variables in `.env.example` — that file is the short list of
   what a deployment must be given, with no values in it. Everything it
   omits has a working default.
3. Add a persistent volume and point `STATE_FILE` at it — e.g.
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
