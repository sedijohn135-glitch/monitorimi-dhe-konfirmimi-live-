# Confirmation rules

What has to be true before the monitor says **ENTER NOW**, and what it says
instead when it is not.

The operator opens a market order from the Telegram message without opening
a chart. Two sentences therefore have to be trustworthy in both directions:

- **ENTER NOW** — this is the trade the analysis described, at a price that
  is still that trade.
- **dead** — this setup is finished, and it will not quietly go on to work.

Everything below exists because one of those two sentences was false in
production, with the money on the line.

---

## The failure these rules come from

XAUUSD, 2026-09-10. The analysis (MULTISNIPER07 v6, six MT5 screenshots
through Gemini 3.1 Pro) declared:

```
ENTRY   4361.50          zone 4360.00 – 4365.00 (PDA Bearish FVG)
SL      4378.00          risk 16.50
TP1     4344.00          TP3 4314.00 (DOL)
KONFIRM M1/M5 body close below 4355.00
INVALID body close above 4376.00
```

The market, from the feed's own bars:

| M1 (UTC) | high | low | close | closed below 4355.00? |
|---|---|---|---|---|
| 14:16 | 4361.35 | 4358.09 | 4359.79 | no |
| 14:17 | 4360.20 | 4355.07 | **4355.43** | no — by 0.43 |
| 14:18 | 4359.96 | 4354.11 | 4359.59 | no |
| 14:19 | 4363.11 | 4359.31 | 4361.62 | no |
| 14:24 | 4373.47 | 4359.43 | 4371.18 | no |
| 14:25 | **4376.37** | 4371.05 | 4371.53 | no |

**The declared confirmation never happened.** The lowest close in the whole
window missed it by 0.43. Price wicked to 4354.11 and closed back at 4359.59.

The monitor sent `REAL CONFIRMATION — ENTER NOW` anyway, at **4355.91**, on
its own generic rule — live acceptance plus a graduated technical signal.
That is 4.09 below the entry zone and 5.59 below the analysed entry, which
inflated the risk from 16.50 to 22.09, **+34%**.

Price then ran to 4376.37: **93% of the stop consumed, 1.63 from being
stopped out.** The analyst's own invalidation — body close above 4376.00 —
never fired either, so the setup was still alive the whole time. The
analysis was right. The monitor's entry was wrong.

**The monitor had an opinion about confirmation and it overrode the one the
analyst wrote down.**

---

## R1 — The analyst's declared conditions are gates *(specified, not yet built)*

An analysis that writes `KONFIRM: M1/M5 body close below 4355.00` has
stated a falsifiable condition and staked the trade on it. The monitor does
not get a second opinion.

- When the setup declares a confirmation condition, **no ENTER NOW is sent
  until a closed bar satisfies it.** Body close means body close: a wick
  through the level is not the event.
- A declared condition that never fires means **no entry**. That is a
  correct outcome, not a missed one — the analyst said this is what the
  trade rests on.
- When no condition is declared, the monitor's own evidence rules apply
  unchanged.

Field: `confirm_level` + `confirm_rule` (`body_close`) + `confirm_timeframe`.
Parsed from `KONFIRM:` on the paste path.

## R2 — ENTER NOW names the analysed price, not wherever price is

This is the rule that matters most, because it applies to every setup
whether or not the analyst declared anything.

Confirmation validates **the setup**. It does not license entry at whatever
price the market happens to be at when the evidence completes. Where price
sits at that moment decides which message goes out:

| Where price is | Message | Why |
|---|---|---|
| Inside the entry zone | **ENTER NOW** at market | This is the analysed trade |
| Outside the zone, setup still alive | **CONFIRMED — WAIT FOR THE ZONE**, with the limit price | The trade is valid; this price is not the one that was analysed |
| Already ran ≥ `ENTRY_LATE_TP1_FRACTION` toward TP1 | **SETUP LATE — NO ENTRY** | The move is spent; what is left is the retracement |
| Stop breached, or R:R to the objective collapsed | **SETUP DEGRADED** | Existing behaviour, unchanged |

"Wait for the zone" is deliberately **not a refusal**. On the failure above,
price returned to 4362–4367 within six minutes: a limit at 4361.50 would
have filled at the analysed price, on the analysed risk, and the 4376.37
spike would have taken 90% of the stop instead of 93% — surviving instead
of nearly stopping out.

This is what the operator asked for when he asked whether to drop live
confirmation and use a limit order instead. The answer is neither: keep the
confirmation, and let it point at the analysed price.

## R3 — A setup that has already delivered is late, not confirmable

From the operator's own V14 spec: *"çmimi ka kaluar 30% drejt TP1 →
SETUP KA VONUAR — MOS HYR."*

If price has already travelled `ENTRY_LATE_TP1_FRACTION` of the distance
from entry to TP1 before the evidence completes, the entry is late. Entering
there means taking the retracement, which is the drawdown the operator keeps
reporting.

On the failure above the confirmation landed **32% of the way to TP1**.

## R4 — Acceptance is proven on closed bars *(specified, not yet built)*

Acceptance asks whether price has accepted a level. A live mid that is
beyond the level for one tick has not shown acceptance — it has shown a
wick. The 14:18 bar reached 4354.11 and closed at 4359.59; nothing was
accepted there.

Acceptance is measured on the last closed bar's body, not on the tick.

---

## What these rules do NOT promise

**They do not remove drawdown.** Every trade has it. On the failure above,
even a perfect fill at the analysed 4361.50 would have sat 14.87 underwater
at the spike — 90% of the stop.

What the rules do is make the drawdown **the one the analysis budgeted for**
rather than one inflated by entering 5.59 late on 34% more risk. A trade
that was designed to risk 16.50 should risk 16.50.

Any claim beyond that would be a lie, and the operator is trading real money
on these messages.

---

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ENTRY_ZONE_ONLY` | `true` | R2. `false` restores entry at market wherever confirmation lands |
| `ENTRY_LATE_TP1_FRACTION` | `0.3` | R3. `0` disables the lateness gate |

R1 and R4 are specified above but **not implemented yet**. R2 and R3 already
refuse the failure this document is written from — the replay below — so
they ship first and alone. R1 needs a parser change to read `KONFIRM:`;
R4 changes what acceptance means for every setup and deserves its own
evidence.

## The failure, replayed through R2 and R3

| Moment | Price | Verdict now | |
|---|---|---|---|
| touches the zone | 4360.84 | `ENTER NOW` | in the zone — the analysed trade |
| **the old confirmation** | **4355.91** | **`SETUP LATE`** | **32% to TP1 already gone** |
| returns to the zone | 4362.13 | `ENTER NOW` | back at the analysed price |
| breaks upward | 4373.47 | `WAIT FOR THE ZONE` | 4.53 of room left, limit at 4361.50 |
| the high | 4376.37 | `WAIT FOR THE ZONE` | 1.63 of room — never an entry |

The watch stays alive at every step. The setup was never called dead,
because it never was.

Every rule is switchable, and every default is the safe side. A rule that
cannot be turned off is a rule nobody can debug at three in the morning.
