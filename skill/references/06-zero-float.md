# 06 · ZERO FLOAT ENGINE — Entry pa Drawdown

> **Qëllimi:** Inxhinier entry-n ku çmimi prek nivelin dhe lëviz menjëherë në fitim pa drawdown.

---

## 1 · 5 KONCEPTET BËRTHAMË

### 1.1 · Shadow Entry

Hyrje në wick (jo body) të qirit që mbledh likuiditetin.

```
Logjika:
  Qiri me long wick tregon absorption institucionale.
  Entry vendoset në wick, jo në close të qirit.
  Kjo jep entry me adverse excursion minimal.

Përfitimi:
  - Stop i ngushtë (nën wick + buffer)
  - R:R i lartë
  - Drawdown ≈ 0
```

### 1.2 · Fibo Master Zones (5.0 / 11.0 / 16.8)

```
Fibonacci extensions nga swing leg.
Zonat 5.0, 11.0, 16.8 janë extensions të thella.

Përdorimi:
  Pas collection-i të likuiditetit dhe MSS,
  çmimi rikthehet në Fibo Master Zone.
  Entry kur çmimi prek 5.0, 11.0, ose 16.8 extension.

Origjina swing: 4220 (low)
High swing: 4250
Range: 30 pips
- 5.0 extension: 4220 + (30 × 5) = 4370
- 11.0 extension: 4220 + (30 × 11) = 4550
- 16.8 extension: 4220 + (30 × 16.8) = 4724
```

### 1.3 · Displacement Analysis

```
Qiri i vetëm masiv me wicks të vogla pas candles të vogla = gjurmë institucionale.

Karakteristikat:
  - Body e madhe (≥3× mesatarja e body-ve paraardhëse)
  - Wicks minimale (<20% e range-it)
  - FVG gjithmonë krijohet nën/mbi displacement
  - Volume i lartë (nëse disponohet)

Identifikimi:
  LONG:  Pas candles të vogla → 1 qiri i madh bullish me wicks të shkurtra
  SHORT: Pas candles të vogla → 1 qiri i madh bearish me wicks të shkurtra

FVG nga displacement = prime entry zone në retracement.
```

### 1.4 · Quasimodo MSS

```
Quasimodo = pattern i veçantë MSS.

Bearish Quasimodo:
  1. Çmimi bën higher low (pritje bullish)
  2. Higher low thyhet me displacement
  3. Entry në FVG e re pas MSS

Bullish Quasimodo:
  1. Çmimi bën lower high (pritje bearish)
  2. Lower high thyhet me displacement
  3. Entry në FVG e re pas MSS

Karakteristikë: MSS ndodh në M5/M1 me displacement
→ FVG e re krijohet
→ Entry në CE e FVG
→ 0 float drawdown
```

### 1.5 · Volume Exhaustion

```
Volum i lartë + çmimi nuk përparon = absorption institucional.

Kushtet:
  - Volume spike (≥1.5× mesatarja)
  - Çmimi bën range të ngushtë
  - Body e vogël
  - Pas kësaj → reversal me displacement

Identifikimi:
  - M5/M1 candle me volume të lartë
  - Wick e gjatë në drejtimin e volumit
  - Body nuk arrin në extremum
```

---

## 2 · SWEEP CEILING FORMULA

```
Standard deviation projection i Central Delivery Range (CDR).

SC_BSL = High_pivot + 1σ(CDR)
SF_SSL = Low_pivot - 1σ(CDR)

Nëse çmimi kalon 1σ → nuk është sweep, është displacement real.
Nëse çmimi mbetet brenda 1σ → sweep i mundshëm.

Për Judas Swing (Asian Range → London):
  1σ projection nga Asian H/L = target i manipulation move.

Kalibrim:
  - 1σ = deviation standard e CDR-së
  - CDR = range i fundit i balancuar (Asia + London pjesërisht)
```

---

## 3 · STANDARD DEVIATION PROJECTIONS (Asian Range, M5 vetëm)

```
Projections nga Asian Range High/Low:
  1.0σ, 1.5σ, 2.0σ, 2.5σ

Përdorimi:
  - 1.0σ = target primar i Judas Swing
  - 1.5σ = extension i parë
  - 2.0σ = extension i dytë
  - 2.5σ = extension final / TP3

Scale out çdo 2σ gjatë Model 2 trades.
```

---

## 4 · OTE — OPTIMAL TRADE ENTRY

```
Fibonacci retracement pas BOS në LTF.

LONG:
  Fibo nga swing low → swing high
  Entry zone: 0.618 - 0.79
  Target: -0.5 to -1.0 extension

SHORT:
  Fibo nga swing high → swing low
  Entry zone: 0.618 - 0.79
  Target: -0.5 to -1.0 extension

Shembull (LONG):
  Low: 4220.00
  High: 4250.00
  Range: 30 pips
  - 0.618: 4220 + (30 × 0.618) = 4238.54
  - 0.79:  4220 + (30 × 0.79)  = 4243.70
  Entry zone: 4238.54 - 4243.70
  Target (-0.5 ext): 4250 + (30 × 0.5) = 4265.00
  Target (-1.0 ext): 4250 + (30 × 1.0) = 4280.00
```

---

## 5 · ZERO FLOAT ENTRY SEQUENCE

```
1. CONFIRM Bias HTF
   - D1/H4 alignment i qartë
   - DOL i identifikuar

2. CONFIRM Trap Engine
   - 8 Pyetjet TIP-1 → TIP-8 janë përgjigjur
   - Kurth i identifikuar

3. CONFIRM Collection
   - 4 konfirmime (50% FVG, wick 3×, MSS, volume)
   - Grade A ose B

4. WAIT for MSS with Displacement (M5/M1)
   - Body close beyond swing
   - FVG e re e pambuluar

5. IDENTIFY Entry Zone
   - CE e FVG
   - OSE OB i re
   - OSE Fibo Master Zone 5.0/11.0/16.8

6. PLACE Entry
   - Shadow entry në wick
   - Stop nën wick + ATR buffer

7. WAIT for confirmation
   - M1 candle close mbi entry zone
   - OSE displacement fillestar

8. SET TP1, TP2
   - TP1 = Equilibrium ose R1
   - TP2 = DOL final
```

---

## 6 · CONVICTION GRADING

```
CONVICTION A:
  - Trap Confirmed + Grade A
  - HTF alignment
  - 3+ PDA confluence
  - M5/M1 displacement
  - 4/4 collection confirmations

CONVICTION B:
  - Trap Confirmed + Grade B
  - HTF alignment
  - 2+ PDA confluence
  - M5/M1 displacement
  - 3/4 collection confirmations

CONVICTION C:
  - Trap Active por jo Confirmed
  - Grade C
  - Displacement mungon
  - PA ZERO FLOAT — mos lësho Zero Float Entry
```

⛔ **Zero Float Entry section OMISSO nëse CONVICTION = C.**

---

## 7 · FIBO MASTER 16.8 (Extension Strategy)

```
Origjina swing: 4220 (LOD ose MSS trigger)
Swing Leg: deri në 4250 (HOD i leg-ut)
Fib Extension 16.8: 4220 + (30 × 16.8) = 4724

Përdorimi:
  - Vetëm kur Collection Grade = A
  - Vetëm kur target-i është HTF BSL/SSL me LPS ≥ 80
  - Nuk përdoret për normal entries

Logjika:
  Kur tregu ka nevojë të kërkojë likuiditet shumë të thellë,
  Fibo Master 16.8 = targeti i probabilitetit të lartë.
```

---

## 8 · ZERO FLOAT VALIDATION

```
Para çdo Zero Float Entry, verifiko:

□ Trap Confirmed (Type 1-6)
□ Collection Grade A ose B
□ HTF DOL alignment
□ MSS me displacement në M5 ose M1
□ FVG ose OB i identifikuar
□ R:R minimum 1:2
□ Stop ATR-based
□ Vëllimi më i lartë mesatar (nëse disponohet)
□ Wick ≥ 3× body në qirin e fundit para entry
□ Body close brenda PDA zone
```

Nëse **të gjitha** janë ✅ → Lësho Zero Float Entry.
Nëse **ndonjë** është ❌ → Prit ose refuzo.

---

## 9 · ZERO FLOAT OUTPUT

```json
{
  "zero_float": {
    "status": "AUTHORIZED|SUSPENDED|DENIED|CONFIRMED",
    "conviction": "A|B|C",
    "entry_price": 4225.50,
    "shadow_entry": 4225.20,
    "entry_basis": "FVG CE | OB CISD | Fibo Master 5.0/11.0/16.8",
    "stop_loss": 4217.00,
    "stop_basis": "ATR 1.5× + sweep buffer 1.5 pips",
    "tp1": 4240.00,
    "tp1_basis": "Equilibrium 50% of dealing range",
    "tp2": 4260.00,
    "tp2_basis": "DOL final (HTF BSL)",
    "rr_tp1": 2.4,
    "rr_tp2": 5.5,
    "entry_model": "ICT 2022|Market Anchor|Model 2|Silver Bullet|Unicorn|..."
  }
}
```
