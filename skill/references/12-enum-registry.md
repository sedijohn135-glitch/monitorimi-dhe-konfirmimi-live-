# 12 · ENUM REGISTRY — Vlerat e Lejuara (Master List)

Përdor **VETËM** këto vlera në çdo field. Mos shpik, mos riemërto, mos shto.

---

## 1 · ILOS STATE ENUMS

```
CONFIDENCE:            HIGH / MEDIUM / LOW
TRAP_STATUS:           NOT_DETECTED / ACTIVE / CONFIRMED
MANIPULATION_PHASE:    ENGINEERING / ACTIVE / COMPLETE
DELIVERY_PHASE:        NOT_STARTED / INITIATED / CONFIRMED
OBJECTIVE_LOCK:        LOCKED / UNLOCKED
COLLECTION_STATUS:     CONFIRMED / UNCONFIRMED
COLLECTION_GRADE:      A / B / C / D
ZERO_FLOAT_STATUS:     AUTHORIZED / SUSPENDED / DENIED / CONFIRMED
STRUCTURE_VALIDITY:    VALID / INVALID / MANIPULATION_ARTIFACT
CONVICTION:            A / B / C
SKILL_CONTEXT_CONVICTION: HIGH / MEDIUM / LOW   (= CONFIDENCE, jo A/B/C)
SKILL_CONTEXT_TRAP_PHASE: accumulation / manipulation / distribution / delivery / unknown
SKILL_CONTEXT_CONDITION:  never / always / m5_mss_already_observed /
                          htf_mss_confirmed / liquidity_swept
SKILL_CONTEXT_BIAS:       bullish / bearish  (monitori i përkthen në buy / sell)
FORWARD_VALIDATION:       WITHIN_ZONE / FAVORABLE_EARLY / STRONG_MOVE / STALE / FAILED
CONFIRMATION_LANE:        STANDARD / M1_FAST / SKILL_VALIDATED
THESIS_INTEGRITY:      INTACT / REVISED — v1 / REVISED — v2 / REVISED — v3 / ...
DELIVERY_STRUCTURE:    Bullish / Bearish / Unclear
TRAP_IDENTIFIED:       YES / NO / INSUFFICIENT_EVIDENCE
KILL_ZONE:             AKTIVE / INAKTIVE
POOL_STRENGTH:         STRONG / WEAK / MAGNET
POOL_SIDE:             BSL / SSL
TRAP_SUB_TYPE:         Type 1 / Type 2 / Type 3 / Type 4 / Type 5 / Type 6 / TYPE 0 — UNCLASSIFIED
```

---

## 2 · BIAS & DIRECTION

```
BIAS:                  buy / sell / neutral
DIRECTION:             buy / sell / null
```

---

## 3 · STRUCTURE ENUMS

```
PD_STATUS:             Discount / Premium / Equilibrium

ANCHOR_TYPE:           CISD / CE / SWEEP / STRUCTURAL (CISD) / STRUCTURAL (FVG)

ZONE_TYPE:             OB / BB / FVG / IFVG / REJECTION_BLOCK / LIQUIDITY_POOL / BPR / VI / VOID / BISI / SIBI / RIFVG / PB / RB

SWEEP_TYPE:            TYPE_1 / TYPE_2 / TYPE_3 / TYPE_4 / TYPE_5 / TYPE_6 / TYPE_0

SWEEP_STATUS:          UNTOUCHED / SWEPT (WICK) / SWEPT (BODY) / BEING_TARGETED / PDA_GENERATING

FVG_FILL:              0-49% / 50% (CE REACHED) / 51-99% / 100% (FILLED)
```

---

## 4 · KURTHI STATUS

```
KURTHI_STATUS:         INTAKT / PJESËRISHT_MARRË / MARRË

PO3_PHASE:             Accumulation / Manipulation / Distribution

LIFECYCLE_STAGE:       Accumulation / Reaccumulation / Distribution / Redistribution / Unicorn

CURVE_SIDE:            Buy Side / Sell Side / Both
```

---

## 5 · TIME & SESSION

```
SESSION:               Asia / London / NY_AM / NY_PM / NY_Lunch / Off-Hours

KILL_ZONE_NAME:        London Open / London Silver Bullet / NY Pre-Open / RTH Open / AM Silver Bullet / PM Session / PM Silver Bullet / Last Hour / none

MACRO_NAME:            London Open / London Continuation / Pre-NY Open / Pre-Open / NY Open / London Close / NY Lunch / PM Session Start / PM Macro / Last Hour / none

NY_LUNCH:              true / false

TIME_DISTORTION:       true / false
```

---

## 6 · VERDICT

```
VERDICT:               A+ SETUP / SETUP / RESET / NO-SETUP / NO-TRADE / POLICY_FAIL
```

---

## 7 · RISK ENUMS

```
VOLATILITY_REGIME:     normal / elevated / high / extreme

STOP_BASIS:            ATR-based / Structural+ATR / Sweep wick + ATR / Fibo extension

ENTRY_BASIS:           FVG CE / OB CISD / Fibo Master 5.0/11.0/16.8 / OTE 0.618-0.79 / OTE 0.705 / BPR / Inversion FVG / Vault Pocket

TP_BASIS:              Equilibrium 50% / DOL final / R1 / R2 / R3 / SD projection 1.0σ / SD projection 1.5σ / SD projection 2.0σ / SD projection 2.5σ / Fibo extension -0.5 / Fibo extension -1.0
```

---

## 8 · ENTRY MODELS

```
MODEL:                 ICT 2022 / Market Anchor / Model 2 Amplified / Silver Bullet / Turtle Soup / OB + FVG Confluence / Unicorn / RIFVG / MMXM / MMBM / BISI / SIBI / Vault Pocket / SDR / DRO / LSS / OSST / STRC / SRT / FBE / Venom
```

---

## 9 · PDA ZONE TYPES — Definicionet e Shkurtra

```
OB   — Order Block
BB   — Breaker Block (OB i dështuar)
RB   — Rejection Block
PB   — Propulsion Block
FVG  — Fair Value Gap (3-candle pattern)
IFVG — Inversion FVG (FVG me body close në drejtim të kundërt)
BPR  — Balanced Price Range (FVG overlap me FVG tjetër)
VI   — Volume Imbalance (dy candles me body jo të prekur)
VOID — Real Liquidity Void (zero print midis dy close-ve)
BISI — Buy Side Imbalance, Sell Side Inefficiency
SIBI — Sell Side Imbalance, Buy Side Inefficiency
RIFVG — Reaper Inversion FVG (FVG në Breaker leg)
```

---

## 10 · LIQUIDITY POOL TYPES

```
PMH / PML             — Previous Month High / Low
PWH / PWL             — Previous Week High / Low
PDH / PDL             — Previous Day High / Low
EQH / EQL             — Equal Highs / Lows
Session H / L         — Session High / Low
Old Swing H / L       — Old swing high / low (age > 5 days)
Algo Magnet           — Algorithmic magnet (3+ revisits)
Resting Liquidity     — Untouched > 3 sessions
Engineered Liquidity  — Synthetic; lower weight
Range Liquidity       — Internal range H/L
Liquidity Void        — Rebalancing target
NDOG / NWOG           — New Day / Week Opening Gap
RTH ORG               — Regular Trading Hours Opening Range Gap
NY Midnight Open      — 00:00 NY ET
```

---

## 11 · MCP TOOL NAMES (Kontrata)

```
time.now
time.convert
market.get_quote
market.get_candles
market.get_atr
market.get_spread
session.status
session.get_range
session.list_sessions
calendar.upcoming
```

Emrat mund të jenë prefixed sipas MCP server-it (p.sh. `mt5.get_quote`). Mjafton të jepni mapping table kur lidh.

---

## 12 · SESSION TYPES

```
Asia       — 7:00 PM - Midnight NY (ditën e kaluar)
London     — 2:00 - 5:00 AM NY ET
NY_AM      — 7:00 AM - 12:00 PM NY ET
NY_Lunch   — 12:00 - 13:00 NY ET
NY_PM      — 13:00 - 16:00 PM NY ET
Off-Hours  — Të tjerat
```

---

## 13 · SIDE ENUMS

```
SIDE:                  buy / sell (për direction)
POOL_SIDE:             BSL / SSL
SIDE_OF_CURVE:         Buy Side / Sell Side
```

---

## 14 · STAGE NUMBERS

```
STAGE_NUMBER:          1 (Accumulation/Distribution)
                       2 (Reaccumulation/Distribution — RUN)
                       3 (Polarity Flip)
                       4 (Redistribution/Reaccumulation — Unicorn)
```

---

## 15 · TIMEFRAME STANDARDS

```
M1, M2, M3, M5, M15, M30, H1, H4, D1, W1, MN
```

---

## 16 · THESIS FALSIFICATION

```
PRIMARY_THESIS:        Akive
ALTERNATIVE_THESIS:    Falsified / Preserved
DECISION:              CONFIRM_PRIMARY / REVISE_TO_ALTERNATIVE / THESIS_AMBIGUOUS / THESIS_INVALID
```

---

## 17 · PERSISTENCE & DURATION

```
DURATION:              session / daily / weekly / monthly

PERSISTENCE:           intakt / pending / swept / mitigated / expired (>60 days)
```

---

## 18 · ANCHOR TYPES (PDA)

```
anchor_type:           CISD       — Opening price e qirit decisive
                       CE         — 50% Mean Threshold (Consequent Encroachment)
                       SWEEP      — High/low i swept
                       STRUCTURAL — generic structural anchor
```

---

## 19 · HYBRID STATUS

```
HYBRID_STATUS:         AUTHORIZED (kushte të plota)
                       SUSPENDED (kushte të pjesshme)
                       DENIED (kushte të dështuara)
                       CONFIRMED (ekzekutim)
```

---

## 20 · REFERENCE KEYS (Kryesore për Cross-Reference Stability)

Këto fusha duhet të mbeten stabile nga Moduli 01 → 08:

```
- primary_objective.level
- pool_registry[].id + level
- pda_arrays[].id + zone + anchor
- active_causal_chain.root_liquidity_id
- active_causal_chain.active_pda_id
- thesis_integrity
- bias
- conviction
- collection.grade
- trap_sub_type
```

Çdo ndryshim = formal ILOS revision event.
