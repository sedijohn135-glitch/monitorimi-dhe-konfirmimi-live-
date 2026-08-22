# 08 · RISK MANAGEMENT — ATR-Based, Volatility-Adjusted

> **⛔ NUK përdorim stop fiks në pips. Stop-i duhet të jetë volatility-adjusted (ATR-based).**

---

## 1 · ATR FORMULA

```
True Range (TR) = max(
  high - low,
  |high - prev_close|,
  |low - prev_close|
)

ATR(n) = EMA(TR, n)  # zakonisht 14-period
```

---

## 2 · STOP LOSS PLACEMENT

### 2.1 · ATR-Based Stop

```
LONG:
  SL = entry - (k × ATR)

SHORT:
  SL = entry + (k × ATR)

Ku:
  k = 1.5 deri 2.0 (default 1.5)
  ATR = ATR(14) në TF e entry-t
```

### 2.2 · Shembull (XAUUSD M1)

```
Çmimi aktual: 4225.50 (LONG entry)
ATR(14) M1: 1.20 USD ($1.20 = 12 pips)
k = 1.5

SL = 4225.50 - (1.5 × 1.20) = 4223.70
```

### 2.3 · Volatility Regime Multiplier

| Regime | k |
|--------|---|
| Normal | 1.5 |
| Elevated (pre-news) | 1.75 |
| High (news release) | 2.0+ |
| Extreme (FOMC, NFP) | 2.5 |

---

## 3 · STRUCTURAL STOP LOGJIKA

### 3.1 · Stop Placement Priority

```
1. ANCHOR:  Wick i qirit që ka shkaktuar sweep
            PLUS ATR buffer 1-2 pips

2. FALLBACK: Structural level (OB low, FVG low, swing low)
            PLUS ATR buffer 1-2 pips

3. LAST RESORT: ATR × k

Kurrë mos vendos stop VETËM me ATR nëse ka anchor strukturor.
```

### 3.2 · Shembull i Plotë

```
Setup: LONG pas SSL sweep në 4218 (wick në 4217.50)
Entry: 4225.50
ATR(14) M5: 8 pips

SL calcluation:
  Anchor: 4217.50
  ATR buffer: 1.5 × 8 = 12 pips
  SL = min(4217.50, 4225.50 - 12) = 4217.50 - 2 = 4215.50

TP1: 4240 (Equilibrium 50% e dealing range)
TP2: 4260 (DOL final)

R:R TP1 = (4240 - 4225.50) / (4225.50 - 4215.50) = 14.5 / 10 = 1.45R
R:R TP2 = (4260 - 4225.50) / (4225.50 - 4215.50) = 34.5 / 10 = 3.45R
```

---

## 4 · POSITION SIZING

```
Lot Size = Risk_USD / (Stop_Distance_Pips × Pip_Value)

Risk_USD = Account_Balance × Risk_Per_Trade_Percent
Risk_Per_Trade_Percent = 0.5% deri 2% (default 1%)

Shembull:
  Account: $10,000
  Risk: 1% = $100
  Stop Distance: 10 pips
  Pip Value: $1.0 per pip per micro lot
  Lot Size = $100 / (10 × $1.0) = 10 micro lots = 0.1 lot standard
```

### 4.1 · ATR-Based Position Sizing

```
Kur ATR rritet (volatility e lartë), Stop Distance rritet
→ Lot Size duhet të ulet (inverse correlation)
→ Risk_USD mbetet konstant

Shembull:
  Setup 1 (normal vol): ATR=8 pips, SL=12 pips → 8.3 micro lots
  Setup 2 (high vol):   ATR=20 pips, SL=30 pips → 3.3 micro lots
  Risk i njëjtë: 1% e account
```

---

## 5 · SWEEP BUFFER (Detyrim)

```
Shto 1-3 pips buffer për slippage në live execution.

LONG:  SL = calculated_SL - 1_to_3_pips
SHORT: SL = calculated_SL + 1_to_3_pips

Pse: Spread zgjerohet në momente të likuiditet sweep.
Broker-at mund të kenë slippage 1-3 pips.
```

---

## 6 · COMMISSION & SLIPPAGE

```
Faktor në expectancy calculation:
  - Round-trip commission: $5 - $10 per lot standard
  - Spread widening gjatë sweeps: 1-3 pips

Llogaritja:
  Gross_Profit = (TP - Entry) × Lot × Pip_Value
  Commission = 2 × $7.5 (round-trip) = $15 per lot standard
  Net_Profit = Gross_Profit - Commission - Slippage_Adjustment
```

### 6.1 · expectancy Formula

```
E = (W × P_w) - (L × P_l)

Ku:
  W = win rate (decimal)
  P_w = average win (në R)
  P_l = average loss (në R, zakonisht 1R)

Shembull:
  W = 0.60 (60% win rate)
  P_w = 2.5R (average win)
  P_l = 1.0R
  E = (0.60 × 2.5) - (0.40 × 1.0) = 1.5 - 0.4 = 1.1R per trade
```

---

## 7 · PROP FIRM CONSTRAINTS

### 7.1 · FTMO / Topstep / etc.

```
Kushtet tipike:
  - Daily loss limit: 5% e account
  - Total loss limit: 10% e account
  - Profit target: 8-10% për Phase 1, 4-5% për Phase 2
  - Min trading days: 4-10
  - Max lot size: zakonisht 5-10 lote standard
```

### 7.2 · ICT Model Pass Rates

| Model | Win Rate | R:R | Pass Rate (6 month) |
|-------|----------|-----|---------------------|
| Silver Bullet (mechanical) | 34-36% | 1:2 | 34% |
| Silver Bullet (filtered) | 60-66% | 1:2.8 | High |
| OB + FVG Confluence | 63% | 1:2.8 | 41% |
| Turtle Soup | 68% | 1:1.6 | 27% |
| MMXM/MMBM (proper) | 65-70% | 1:2.5+ | High |

**RREGULL:** Për prop firm, përdor setup me win rate + R:R të kombinuar që prodhon expectancy > 0.5R dhe drawdown të ulët.

---

## 8 · TRADE MANAGEMENT

### 8.1 · Partial Profit Taking

```
TP1: 30-50% e pozicionit në R1 (oose Equilibrium)
TP2: 30-50% në R2 (DOL ose R2-R3)
TP3: trailing 20% deri në fund

Logjika:
  - Siguron fitim (lock-in)
  - Lejon pjesën tjetër të shkojë te DOL
  - Redukton risk nëse tregu kthehet
```

### 8.2 · Break-Even Stop

```
Pas TP1:
  - Move SL to break-even + commission

Pas TP2:
  - Move SL to TP1 (lock profit)
```

### 8.3 · Trailing Stop

```
ATR-based trailing:
  Pas TP1: trailing_stop = current_price - (1.5 × ATR)
  Pas TP2: trailing_stop = current_price - (2.0 × ATR)

Structural trailing:
  Pas TP1: trailing_stop = swing_low (nëse LONG)
  Pas TP2: trailing_stop = VP (Visible Range VP) ose swing low i ri
```

---

## 9 · NEWS RISK

### 9.1 · High-Impact Events

```
⛔ ASNJË TRADE gjatë:
  - NFP (Non-Farm Payrolls) — 1 orë para + 30 min pas
  - FOMC — 1 orë para + 1 orë pas
  - CPI — 30 min para + 30 min pas
  - GDP — 30 min para + 30 min pas
  - ECB / BoE / BoJ — 15 min para + 15 min pas

Nëse setup ndodh para news:
  - Mbyll para news
  - OSE ngushto SL shumë
  - OSE shty entry deri pas news + 30 min
```

### 9.2 · News Trading (Strategji Advanced)

```
Nëse vendos të tregtojë news:
  - Spread zgjerohet 3-10× normal
  - Slippage 5-15 pips normale
  - Stop ATR duhet 2.0+ × normal
  - Position size 50% e normal
```

---

## 10 · LARGE RANGE DAY PROTOCOL

```
Nëse dita e kaluar ishte Large Range Day (BTCUSD specifike):
  - 9:30 - 10:30 AM NY ET = NO TRADE
  - Identifiko vetëm Lunch Macro Target
  - Resume pas 10:30 AM me setup të ri
```

---

## 11 · GAP RISK PROTOCOL

```
Kur tregu hapet me gap:
  1. Identifiko prior session settlement
  2. Shiko PDA arrays mbi/nën gap
  3. Prit retracement brenda ose nën opening level
  4. Konfirmo distancë minimale (10 handles / 15 pips) pas gap

Kur gap-i ndodh:
  - Setup frequency ulet
  - Selektiviteti rritet
  - Mos e ndiq gap-in — prit discount
```

---

## 12 · RISK OUTPUT

```json
{
  "risk": {
    "account_balance_usd": 10000.0,
    "risk_per_trade_pct": 1.0,
    "risk_usd": 100.0,
    "stop_distance_pips": 10.0,
    "pip_value_usd": 1.0,
    "lot_size_micro": 10.0,
    "lot_size_standard": 0.1,
    "spread_pips": 1.2,
    "slippage_buffer_pips": 1.5,
    "commission_round_trip_usd": 7.5,
    "expected_slippage_cost_usd": 1.5,
    "total_transaction_cost_usd": 9.0,
    "atr_m5_14": 8.0,
    "atr_multiplier_k": 1.5,
    "volatility_regime": "normal|elevated|high|extreme"
  }
}
```
