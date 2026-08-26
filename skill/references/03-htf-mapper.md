# 03 · HTF STRUCTURE MAPPER (Liquidity-First)

Ky modul transformon të dhënat MCP nga D1/H4/H1 në një **Strategic JSON** që përdoret nga të gjitha modulet e tjera.

---

## 1 · INPUT CONTRACT

### 1.1 · MCP Calls (detyrim)

```
market.get_candles("XAUUSD", "D1", 100, false)  # 100 qirinjtë e fundit
market.get_candles("XAUUSD", "H4", 100, false)
market.get_candles("XAUUSD", "H1", 100, false)
market.get_quote("XAUUSD")
market.get_atr("XAUUSD", "M5", 14)
market.get_spread("XAUUSD")
session.status("XAUUSD", now_et)
session.get_range("XAUUSD", "London", today)
session.get_range("XAUUSD", "Asia", today)
```

### 1.2 · SMT (Opsionale)

- `XAGUSD` (direct) + `EURUSD` (inverse) kur Primary = XAUUSD
- `ETHUSD` (direct) kur Primary = BTCUSD

⚠️ **Jo `DXY`** — në këtë connector çdo `DXY_*` është kontratë e datuar dhe e
çaktivizuar, pra nuk zgjidhet dot. EURUSD i lexuar së prapthi e zë vendin e tij.

Monitori e llogarit SMT-në live në M5 dhe e numëron si provë të fortë për
`ENTER NOW`. Rregulli i saktë që zbaton → [13-smt-engine.md](13-smt-engine.md)

### 1.3 · Vështirësi

- Vetëm static data nga MCP (jo live chart vizual).
- Asnjë ticks, volum live, spread dinamik.
- Nëse vlerat numerike mungojnë → përdor vlerësim vizual nga candles. Mos shpik numra.

---

## 2 · MARKET MODEL (ICT / IPDA)

### 2.1 · Core Doctrine

```
IPDA delivers price via two mechanisms only:
  1. Liquidity Pools   → stops above Old Highs / below Old Lows; EQH/EQL; session H/L
  2. Fair Value Gaps   → FVG/IFVG; imbalances; voids requiring rebalancing

When price is NOT hunting liquidity → it is rebalancing an imbalance (FVG/Void).
Markets are fractal: same mechanics on D1, H4, H1, M15, M5, M1.
Time is primary. Price is secondary.

CAUSAL HIERARCHY (LIQUIDITY-FIRST):
  Liquidity is the root of all PDA formation.
  A PD Array (OB, FVG, BB, etc.) is an ARTIFACT of a liquidity sweep event.
  No PDA can be evaluated for institutional validity without first
  identifying the sweep that generated it.
```

### 2.2 · IRL ↔ ERL Cycle

```
IRL (Internal Range Liquidity) → FVG/IFVG/OB inside dealing range
ERL (External Range Liquidity) → Old High/Low, PDH/PDL, EQH/EQL, session extremes

Rule:
  Price just rebalanced IRL   → DOL shifts to ERL
  Price just swept an ERL     → DOL shifts to IRL
```

---

## 3 · STEP 0 — LIQUIDITY DISCOVERY ENGINE

### 3A · External Liquidity Scan (D1 → H4 → H1)

Për çdo TF, identifiko dhe regjistro:

```
Old Highs / Old Lows       → multi-swing extremes
PDH / PDL                  → previous day high/low
PWH / PWL                  → previous week high/low
PMH / PML                  → previous month high/low
Session Highs / Session Lows → London, NY AM, NY PM, Asia
Swing Highs / Swing Lows   → every identifiable swing
Algorithmic Liquidity Magnets → price levels repeatedly revisited (3+ touches)
```

### 3B · Internal Liquidity Scan

```
Equal Highs (EQH)   → 2+ candle highs at same price level (tolerance: 0.1% of price)
Equal Lows (EQL)    → 2+ candle lows at same price level
Range Highs / Lows  → local H/L within active dealing range
Liquidity Clusters  → 3+ pools within 5-price-unit zone (count as cluster)
Engineered Liquidity → stop clusters from prior inducement runs
Resting Liquidity   → untouched pools older than 3 sessions
```

### 3C · Structural Void Scan

```
Liquidity Voids   → price ranges with incomplete delivery (partial FVG)
Liquidity Vacuums → zero price prints between two closes (SIBI/BISI)
```

### 3D · Sweep Status Classification

```
UNTOUCHED:        Price has never reached this pool. Highest targeting priority.
SWEPT (BODY):     Body close through pool occurred.
SWEPT (WICK):     Wick reached pool only; body did not close through.
BEING_TARGETED:   Price is within 0.5 × session_ATR of this pool.
PDA_GENERATING:   This specific sweep created the currently active PDA.
```

### 3E · Liquidity Priority Score (LPS)

```
BASE SCORE (from timeframe):
  D1 pool: 60
  H4 pool: 40
  H1 pool: 20

TYPE MULTIPLIER:
  PMH/PML:                          × 1.00
  PWH/PWL:                          × 0.95
  Old Swing H/L (age > 5 days):     × 0.92
  EQH/EQL (3+ touches):             × 0.88
  Algo Magnet (3+ revisits):        × 0.85
  PDH/PDL:                          × 0.83
  Session H/L:                      × 0.78
  Resting Liquidity (>3 sessions):  × 0.75
  EQH/EQL (2 touches):              × 0.72
  Engineered Liquidity:             × 0.65
  Range Liquidity:                  × 0.62
  Liquidity Void / Vacuum:          × 0.70

BONUSES (max +35):
  Multi-TF confluence:             +12
  Status = UNTOUCHED:              +10
  Cluster (3+ pools / 5 unit):     +8
  Aligns with active HTF PDA:      +5

Final LPS = round((base × multiplier) + bonuses), capped 100.
```

**Thresholds:** LPS ≥ 80 = CRITICAL · 65-79 = HIGH · 50-64 = MEDIUM · < 50 = LOW

---

## 4 · STEP 1 — Session Context

```
current_session    → "Asia" | "London" | "New York" | "NY_Lunch" | "Off-Hours"
current_local_time → "HH:MM CET (Tirana)"

If session_ATR provided:
  intraday_reachability_filter = 0.4 × session_ATR
```

---

## 5 · STEP 2 — Structural Context

### 5A · Dealing Range

```
Identify: Last Confirmed Swing High → Swing Low (D1 Dealing Range)
Upper boundary = Buy-Side Liquidity (BSL)
Lower boundary = Sell-Side Liquidity (SSL)
Midpoint       = Equilibrium (50%)

Premium (above 50%) → focus: Bearish PD Arrays
Discount (below 50%) → focus: Bullish PD Arrays
```

### 5B · Strategic Bias Derivation

```
strategic_bias is NOT independently determined.
strategic_bias is derived from the liquidity_registry[] output of Step 0.

Derivation rule:
  Identify the highest-LPS UNTOUCHED pool in liquidity_registry[].
  If that pool is ABOVE current price (BSL) → delivery direction is upward → bias = buy
  If that pool is BELOW current price (SSL) → delivery direction is downward → bias = sell
  If highest-LPS pools on both sides within 10 pts → use D1 candle narrative to break tie.
```

### 5C · Bias Hierarchy

```
LTH → from D1/Weekly context (long-term trend)
ITH → from D1/H4 (intermediate swings, valid ONLY with sweep + displacement/CISD)
STH → from H1 (intraday, corrective against LTH/ITH)

Subordination Rule:
  LTH/ITH bearish → bullish STH = corrective → expect failure at HTF ERL
  LTH/ITH bullish → bearish STH = corrective → expect failure at HTF discount
```

### 5D · PO3 Phase (Power of 3)

```
po3_phase = "Accumulation" | "Manipulation" | "Distribution"

Accumulation  → Asia session; consolidation near NY Midnight Open
Manipulation  → London/NY; Judas Swing opposite to daily bias
Distribution  → Main move toward DOL

NY Midnight Anchor (00:00 NY):
  Bias buy  → low of day expected below NY Midnight Open (sell-side sweep first)
  Bias sell → high of day expected above NY Midnight Open (buy-side sweep first)
```

### 5E · Weekly Profile

```
weekly_profile = "Weekly Expansion" | "Weekly Reversal" | "Range"
Reference: D1 candles for the week; midweek (Tue/Wed) typically set weekly H/L.
```

### 5F · Special Day Protocols

```
Inside Day → compression day; expect breakout in DOL direction
Big Event Range (NFP / large Friday candle) → dominant dealing range until broken
Daily Discount Wick → if D1 open ≈ prev close with long lower wick:
  CE of wick = high-sensitivity IRL; tag in static_anchors
```

---

## 6 · STEP 3 — H4 Structure

```
Identify:
  - H4 dealing range (swing H/L on H4)
  - MSS / BOS with displacement (body close beyond swing)
  - Unmitigated H4 OB, FVG, IFVG, BB
  - Premium/Discount position relative to H4 range
  - H4 session liquidity pools (prev PM, London, NY AM ranges)
  - Intermediate-Term Highs/Lows (ITH/ITL):
      ITL → forms when a bullish displacement leg is FULLY rebalanced
      ITH → symmetric
```

---

## 7 · STEP 4 — H1 Structure Reference

```
Confirm H1 OB/FVG/BPR/RB from Step 0 registry. Add any H1 pools not yet in registry.

Identify:
  - H1 intraday OB, FVG, IFVG, BPR, RB
  - STH/STL (Short-Term Highs/Lows)
  - EQH/EQL clusters at H1 level
  - Session range boundaries visible on H1:
      Prev PM range (13:30–16:00 NY)
      London range (02:00–05:00 NY)
      NY AM range (07:00–10:30 NY)
  - H1 premium/discount within H4 dealing range

Session Priority for DOL:
  If price is near Prev PM range at 09:30 RTH:
    → H/L of prev PM range = primary intraday ERL
  Else:
    → London session range = primary intraday ERL
```

---

## 8 · STEP 5 — DOL Resolution

```
Primary DOL = highest-LPS UNTOUCHED pool in active strategic_bias direction.

Selection rule:
  1. Filter liquidity_registry[] by:
     status = UNTOUCHED or BEING_TARGETED
     direction consistent with strategic_bias
  2. Sort by LPS descending.
  3. Select highest-LPS pool as primary DOL.
  4. Select second-highest as secondary DOL (backup target).

NDOG/NWOG handling:
  NDOG → last print ~16:59 RTH vs. electronic open 18:00
  NWOG → Friday close vs. Sunday electronic open
  Both = anchor_type "STRUCTURAL (FVG)"

AOR (Algorithmic Opening Range = 09:30–10:00 NY):
  Only valid opening range from IPDA perspective for RTH instruments.

Previous 3-Day Highs/Lows:
  Always mark PDH/PDL of last 3 days as named ERL candidates.
```

---

## 9 · STEP 6 — HTF Sweep Alert Generation

```
Generate MT5-ready alarm data for all significant untouched or currently-targeted HTF liquidity levels.

CRITICAL DISTINCTION:
  htf_liquidity_alerts[] → fires when price REACHES a liquidity level
                           (the institutional event itself — SWEEP LEVEL)
  alarms[]               → fires when price REACHES a PDA entry level
                           (the entry signal)

GENERATION RULE:
For each pool where:
  status = UNTOUCHED or BEING_TARGETED
  AND lps ≥ 50
Generate one htf_liquidity_alert entry.
```

---

## 10 · STRATEGIC JSON OUTPUT FORMAT

```json
{
  "meta": {
    "timestamp_utc": "...",
    "instrument": "XAUUSD",
    "tick_size": 0.01,
    "spread_points": 12,
    "atr_m5_14": 12.5
  },
  "strategic_bias": "buy|sell|neutral",
  "po3_phase": "Accumulation|Manipulation|Distribution",
  "market_phase": "London Manipulation|NY AM Distribution|...",
  "smt_analysis": {"status": "aligned|divergent|n/a", "type": "...", "significance": "high|medium|low"},
  "static_anchors": {
    "ny_midnight": 4230.00,
    "weekly_open": 4220.00,
    "ny_830_open": 4232.00,
    "opening_gaps": []
  },
  "tp_policy": "R_MULTIPLE_LIQUIDITY_3R_MIN",
  "final_lrlr_objective": 4260.00,
  "liquidity_registry": [
    {"id": "L1", "level": 4260.00, "side": "BSL", "type": "EQH", "tf": "D1", "lps": 87, "status": "UNTOUCHED", "ownership": "retail_breakout"}
  ],
  "htf_liquidity_alerts": [
    {"level": 4260.00, "side": "BSL", "alert_when": "price_reaches", "distance": 28.50}
  ],
  "key_zones": [
    {"id": "CHAIN_A", "timeframe": "H4", "direction": "buy", "zone_type": "FVG", "zone_low": 4225.00, "zone_high": 4227.00, "anchor_price": 4226.00, "anchor_type": "CE", "pd_status": "Discount", "lps": 82, "target_liquidity_pool": "BSL 4260.00", "tp1": 4230.00, "tp2": 4260.00}
  ],
  "active_causal_chain": {
    "root_liquidity_id": "L1",
    "root_price_level": 4260.00,
    "root_lps": 87,
    "sweep_type": "TYPE_1",
    "active_pda_id": "CHAIN_A",
    "pda_confidence_inherited": 82,
    "chain_assigned": true
  },
  "weekly_profile": "Weekly Expansion",
  "bias_hierarchy": {"lth": "bullish", "ith": "bullish", "sth": "bullish"}
}
```

---

## 11 · NEVER / MANDATE

```
NEVER:
  - Issue entry signals or trade decisions
  - Generate stop loss or take profit prices
  - Execute or simulate trades
  - Use live price feeds, tick data, or spread (MCP i jep vetëm static)
  - Override or second-guess the Execution Engine

MANDATE:
  Mapper THINKS.
  Executor ACTS.
  Mapper cannot alter what Executor will compute.
```
