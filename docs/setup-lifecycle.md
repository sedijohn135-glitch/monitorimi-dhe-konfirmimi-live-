# The setup lifecycle

This is the contract between the analysis skill and the monitor for
everything that happens between a setup being written and a trade being
over. It is the companion to [`skill-context.md`](skill-context.md),
which covers what the analysis already proved before the touch; this
document covers what the monitor does with the setup afterwards.

The optimisation target is **the earliest defensible entry** — not the
earliest possible one, and not the most confirmed one. Every rule below
exists to move one of those two failure modes out of the way.

## The four questions

These are four different questions and the monitor answers them
separately. Collapsing any two of them into one boolean is how a system
kills a setup that was still alive, or enters a trade that no longer
exists.

| | Question | Where it is answered |
|---|---|---|
| **A** | **Setup validity** — is the thesis still true? | `evaluateSafety`, `evaluateAntiSl` |
| **B** | **Entry opportunity** — is the price still enterable? | `evaluateEntryOpportunity` |
| **C** | **Entry confirmation** — has the market defended the setup? | `defenceSatisfied`, `evaluateConfirmation` |
| **D** | **Trade outcome** — what happened after ENTER NOW? | `evaluateTradeProgress`, on a separate record |

A setup can be perfectly valid and completely unenterable. That is
`ENTRY_MISSED`, and it is not an expiry, not a failure, and never a
reason to chase.

## The states

```
REGISTERED_WATCH
  → WAITING_FOR_SETUP_CONFIRMATION   the setup's own prerequisite has not printed
  → READY_FOR_ENTRY                  prerequisite satisfied, entry live
  → ENTRY_TOUCHED                    price entered the zone — nothing is entered yet
  → REJECTION_DETECTED               a closed bar took the zone and failed to hold it
  → M5_MSS_CONFIRMED                 a closed M5 bar broke a real pivot
     (or M1_CONTINUATION_CONFIRMED   the M1 lane — same obligation, faster clock)
  → DISPLACEMENT_CONFIRMED           that break arrived with a real impulse body
  → ENTRY_CONFIRMED                  evidence held, entry still actionable, gates passed
  → ORDER_SUBMITTED → EXECUTED       (auto-trade only)

           ┌── ANTI_SL_EVALUATION    price went to the stop before any entry
           │      ├── SURVIVES       → back to defence evaluation
           │      ├── UNCERTAIN      → stays here, bounded, then REANALYSIS_REQUIRED
           │      └── INVALIDATED    → INVALIDATED
           │
Terminal:  INVALIDATED · ENTRY_MISSED · REANALYSIS_REQUIRED · EXPIRED · CANCELLED
           QUARANTINED (the feed cannot be trusted to describe the instrument)

After ENTER NOW, on its own record:
ACTIVE_TRADE → TP1 · TP2 · TP3 · TRADE_STOPPED · TARGET_REACHED
```

`stage` is derived from what a watch has actually proven, never stored,
so it cannot disagree with the evidence behind it. `list_watches` reports
it for every watch; `get_setup_trail` returns the whole ordered history.

## Before entry vs after entry

This is the distinction the rest of the document rests on.

**Before ENTER NOW there is no position.** Price reaching the level where
a trade *would have been* stopped costs nothing, because nothing was
entered. It is an excursion to be classified, not an invalidation to be
assumed.

**After ENTER NOW there is a position.** The same number is now a real
risk boundary, and reaching it is the trade being stopped —
`TRADE_STOPPED`, on the trade's own record, with no interpretation.

So the two levels must be distinguishable:

| Field | Alias | Meaning |
|---|---|---|
| `sl` | `potential_trade_sl` | where a trade **would be stopped** |
| `invalidation` | `thesis_invalidation` | where the **analysis is wrong** |

**Send both whenever they differ.** A setup that declares only one number
has declared a stop, and a stop alone never invalidates a thesis before
entry — it opens the anti-SL branch instead. A declared thesis line that
price actually breaches kills the setup immediately, whether or not the
stop was reached.

`invalidation_rule: "body_close"` still means a wick through the level is
not invalidation. A closed body beyond it is, and that holds whichever
name the level goes by.

## Anti-SL-Hunter

It is a **conditional branch, not a stage**. Nothing about it runs on a
setup that never went near its stop, and no normal entry waits for it:

```
                    NORMAL CONFIRMATION FLOW
                              │
                    SL excursion event?
                       ╱             ╲
                    no               yes
                     │                │
            continue normally   ANTI_SL_EVALUATION
                                      │
                        ┌─────────────┼─────────────┐
                    SURVIVES      UNCERTAIN     INVALIDATED
                        │             │              │
                 back to defence   reassess,     setup dead,
                  evaluation       then fresh    no resurrection
                                    analysis
```

Two readings are explicitly forbidden, because both replace evidence
with a prior:

- *"price wicked the stop, gold hunts stops, so ignore it"*
- *"price touched the stop, so the setup is dead"*

What is measured instead, on this excursion:

| Evidence | How it is read |
|---|---|
| **Closure** | did any **closed body** print beyond the level? This is the strongest single discriminator: price *visiting* a level and the market *accepting* price beyond it are different events |
| **Depth** | against ATR first, against the setup's own risk when ATR cannot be read. The same number of dollars means different things in different volatility regimes |
| **Duration** | how long price actually spent beyond the line, accumulated from observed samples — a monitoring gap is not evidence that price sat there |
| **Speed** | depth over duration. A violent excursion that violently reversed is allowed more depth than a slow drift, and only when it did reverse |
| **Reclaim** | did price come back, and did the reclaim hold for a closed bar? A one-tick flicker back across the line is the excursion continuing |
| **Structure** | did structure break *against* the setup after the excursion began? |
| **Follow-through** | did opposing displacement follow that break? |
| **Time** | did it resolve inside the setup's allowed window? |
| **Liquidity** | swept pools and declared targets from `skill_context` — **supporting only**, reported in the verdict and never decisive |

Every observation is three-valued. Before any bar has closed since the
excursion began, "nothing closed beyond the level" is not yet a fact, so
it reads as unknown and the verdict stays `UNCERTAIN`. An unknown is
never the permissive answer.

**Surviving is not confirming.** A survived excursion returns the setup
to defence evaluation, and the defence has to be proven again on price
action that printed *after the reclaim* — bars from before the excursion
describe a market that has since been somewhere the setup said it would
not go.

**Uncertain is bounded.** An excursion nobody can classify does not park
the setup indefinitely: past `ANTI_SL_MAX_EVALUATION_MS` it resolves
`REANALYSIS_REQUIRED`. That bound is enforced from outside the evaluation
as well as inside it, so an excursion the monitor cannot classify
*because it cannot read the candles* is bounded too.

**Invalidated is final.** §16: the setup is dead and stays dead. Price
running to the original target thirty seconds later does not mean the
old setup was right, and nothing re-arms it. A new opportunity is a fresh
analysis with a new `setup_id`.

## Entry opportunity

Two ways the opportunity closes, both terminal, neither a chase:

1. **Price reached TP1 without an entry.** The thesis was right and you
   were not in it. `ENTRY_MISSED`.
2. **Confirmation arrived with price too far from the planned entry.**
   Checked at the moment the defence completes — deliberately not
   earlier, since price drifting while defence is still forming is
   normal, and killing the setup for it would be the mirror image of
   chasing.

The deviation cap is context-aware rather than a fixed number of points:

```
cap = min( max(tolerance, ATR × ENTRY_DEVIATION_ATR_FRACTION),
           risk × ENTRY_DEVIATION_RISK_FRACTION )
```

A declared `max_entry_deviation` replaces that derivation — it is the
analyst's setup — but is never honoured beyond **half the entry-to-stop
distance**, because past that the R:R the setup was accepted on no longer
exists.

Only drift that makes the fill *worse* counts. A buy filling below its
planned entry is a better trade, not a missed one.

There is also a floor on what remains of the reward-to-risk **at the
fill** (`ENTRY_MIN_REMAINING_RR`, default `0.5`). It is deliberately
below the 1R that registration demands, because this engine does not
enter at the planned entry by design: the acceptance requirement makes
price travel up to 0.35 of the risk distance beyond entry before it will
confirm at all. A 1R floor here would refuse the very entries the
confirmation rules exist to produce.

## Setup-specific defence

§22: confirmation is setup-specific. The analyst declares what this setup
has to prove, and the monitor never picks for them.

| `defence_profile` | Required after the touch | Use it when |
|---|---|---|
| `standard` *(default)* | rejection → M5 structure shift → displacement | the LTF structure has not already been read |
| `m1_continuation` | rejection → M1 structure shift → M1 displacement | the M5/HTF shift is already established. Withdrawn automatically once price moves against the setup |
| `rejection_displacement` | rejection → displacement | the thesis is a reaction from a declared array, not a structural break |

Every profile requires the zone rejection. `m1_continuation` is a faster
clock, not a weaker one: the same three-step obligation, proven on bars
that closed after the touch.

This is the answer to *"what new information does the M5 structure shift
bring?"*. For a setup whose M5 shift the analysis already read, the
post-touch re-derivation brings none and costs five to fifteen minutes —
so it comes off the critical path, by the analyst's declaration or
through the `skill_context` fast lane. For a setup where the shift has
not been read, it is the only structural proof there is, and it stays.

## Time

Three clocks, bounding three different things.

| Field | Bounds | Runs from |
|---|---|---|
| `entry_monitoring_window_minutes` | how long to wait for price to reach the zone | registration |
| `confirmation_deadline_minutes` | how long confirmation may take **once it has something to confirm** | **the touch** |
| `expiration_minutes` | when the setup is over regardless | registration |

**The confirmation deadline runs from the touch.** Before the touch there
is no confirmation to bound, so measuring it from registration turns it
into a second entry window — a shorter one that silently overrides the
entry window the analyst actually declared. A setup whose zone price
never reached would then die at the confirmation deadline with its thesis
intact and its own entry window still open.

Past the **entry window** with no touch: `ENTRY_MISSED` if price has left
the entry behind, `EXPIRED` if it is still nearby and nothing happened.
Past the **confirmation deadline**: `EXPIRED` if the read never
completed, `REANALYSIS_REQUIRED` if it completed and a gate held it.

The clock is a **boundary, never a delay**. Inside the window nothing
waits for a next candle, a next minute or a round number: the entry fires
on the tick it becomes true.

## Urgency

`urgency` scales how long evidence must persist, and nothing else.

| | Hold |
|---|---|
| `LOW` | ×1.5 |
| `NORMAL` | ×1 |
| `HIGH` | ×0.5 |
| `CRITICAL` | ×0.25 |

Never below the shared floor, and it **cannot** remove a required proof,
open a gate, or outrank an invalidation. A fast market with no defence
still waits. A fast market with a hard invalidation still refuses.

## Observability

`get_setup_trail` returns the setup's whole ordered history — every state
transition, price event, defence step, stop excursion, anti-SL verdict
and outcome — each event carrying its own `event_id`, the setup's
`correlation_id`, and a timestamp, alongside the excursion record, the
anti-SL measurements, the defence state and the measured decision
latency. The trail is bounded and persisted with the watch, so it
survives a restart: it is a record of what happened, not an observation
that stopped.

`list_watches` reports `entry_latency` in `monitor_health` — the
market-event-to-decision latency the last entries actually ran at, read
off the entries themselves rather than estimated.

## After ENTER NOW

The trade gets its own record, and the setup's resolution stays final.
Nothing that happens to the trade can reopen the setup, which is what
keeps *one ENTER_NOW per setup* true no matter how the trade goes.

Targets are reported once each, in order. The stop is checked first, so a
bar that spanned both the target and the stop resolves `TRADE_STOPPED`
rather than reporting itself as a winner. A restart brings the trade back
with its reported targets intact — re-announcing TP1 after a redeploy
would be a false signal.

Set `TRADE_TRACKING_ENABLED=false` to turn the whole post-entry lifecycle
off; the setup side is unchanged by it.
