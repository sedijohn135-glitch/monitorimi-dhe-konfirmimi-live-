# 05 · PDA ARRAYS (Premium-Discount Arrays)

PDA Arrays = gjurmët institucionale në chart. Hierarchy e rëndësishme për entry.

---

## 1 · DEFINICIONET BAZË

| Array | Përkufizimi | Anchor |
|-------|-------------|--------|
| **OB** (Order Block) | Last down-close(s) para bullish displacement / up-close(s) para bearish displacement | CISD Open (e qirit decisive) |
| **BB** (Breaker Block) | OB i dështuar. Pattern: High→Low→Higher High (bearish BB) ose inverse | CISD Open në half-in relevant |
| **RB** (Rejection Block) | Valid vetëm kur down-close high thyhet dhe mbyllet mbi nga qiri tjetër | Body high/low |
| **PB** (Propulsion Block) | Qiri i vetëm me body të madhe brenda displacement leg | Mean threshold (50%) |
| **FVG** (Fair Value Gap) | Low_c1 > High_c2 (sell) ose High_c1 < Low_c2 (buy). Pa body overlap | 50% Mean Threshold (CE) |
| **IFVG** (Inversion FVG) | FVG respektuar në CE ose edge me body closes | 50% CE |
| **BPR** (Balanced Price Range) | FVG e mbuluar nga FVG e kundërt | Mean threshold i bodies |
| **VI** (Volume Imbalance) | Dy qirinj me bodies jo të prekur (vetëm wicks) | IRL e vogël |
| **VOID** (Real Liquidity Void) | Zero print midis dy close-ve. Pa wick/body overlap | SIBI/BISI |
| **BISI** | Buy Side Imbalance, Sell Side Inefficiency | Qiri lart pa delivery |
| **SIBI** | Sell Side Imbalance, Buy Side Inefficiency | Qiri poshtë pa delivery |

**RREGULL:** OB/BB/RB → anchor = CISD Open Price. FVG/IFVG/BPR/VI/NDOG/NWOG → anchor = 50% Mean Threshold (CE). **Mis-anchoring = critical failure; invalidates setup immediately.**

---

## 2 · HIERARKIA PDA (Prioritet i ICT)

### 2.1 · Bearish (Resistencë Institucionale) — Prioriteti nga lart-poshtë:

1. **Bearish Breaker Block** — Prioriteti MË I LARTË. Matet me range të plotë (high to low, wicks të përfshirë).
2. **Bearish Mitigation Block**
3. **Liquidity Void / FVG Bearish** — Bearish displacement (down-close qirinj)
4. **Fair Value Gap (FVG) Bearish** — Gap midis bodies (3-candle formation)
5. **Bearish Order Block** — Qirinjtë e fundit bullish para bearish move
6. **Rejection Block (Bearish)** — Matet STRICT mbi candle bodies, JO në wick tips. Boundary = pak mbi body tops e candles me long upper wicks.
7. **Old High / Historical High**

### 2.2 · Bullish (Support Institucional) — Prioriteti nga lart-poshtë:

1. **Bullish Breaker Block** — Prioriteti MË I LARTË. Matet me range të plotë (wicks të përfshirë).
2. **Bullish Mitigation Block**
3. **Liquidity Void / FVG Bullish** — Bullish displacement (up-close qirinj)
4. **Fair Value Gap (FVG) Bullish** — Gap midis bodies (3-candle formation)
5. **Bullish Order Block** — Qirinjtë e fundit bearish para bullish move
6. **Rejection Block (Bullish)** — Matet STRICT nën candle bodies, JO në wick tips. Boundary = pak nën body lows e candles me long lower wicks.
7. **Old Low / Historical Low**

---

## 3 · RREGULLAT E RËNDËSISHME

### 3.1 · Breaker Precedence Rule

⛔ **Nje Breaker Block ka prioritet absolut mbi çdo array nën të në hierarki.**

- Kur Breaker ndodhet midis çmimit aktual dhe një array më të lartë (Liquidity Void, FVG, etj.) → Breaker do ta ndalojë çmimin.
- **Bearish Breaker:** Ndalon rallies. Mos prit që çmimi të mbyllë Liquidity Void ose FVG mbi Breaker — Void mbetet i hapur.
- **Bullish Breaker:** Mban declines. Mos prit që çmimi të mbushë Liquidity Void ose FVG nën Breaker.

**Rregull praktik:** Kur skanon nga Equilibrium për PDA Array-in e ardhshëm HTF, kontrollo gjithmonë për Breaker të parë. Nëse ka → ai është ceiling/floor. Arrays përtej tij janë të parëndësishme derisa Breaker të kapërcehet.

**2017 Operational Rule (Intraday Cascade):** Breaker Precedence operon në çdo TF, jo vetëm HTF. *"Nëse Breaker është i pranishëm nën Liquidity Void — Void mbetet i hapur."* Algoritmi nuk do të kthehet nëpër Breaker për të mbushur ndonjë FVG ose Void mbi të (bearish context). Simetrikisht, Bullish Breaker mbi Bullish Liquidity Void e pengon atë Void nga mbushja nga sipër.

---

### 3.2 · HTF Cascade Rule

⭐ Nëse Daily PDA thyhet → algoritmi po kërkon recapitalizim të Weekly ose Monthly PDA. **Mos ndrysho bias-in menjëherë — ndjek kaskadën te HTF PDA.**

---

### 3.3 · Equilibrium Target

⭐ Kur hyn në Deep Discount ose Deep Premium, **targeti i parë (TP1) është gjithmonë Equilibrium (50%) e range-it aktual.**

---

### 3.4 · Immediate Rebalance Rule

⭐ Kur dy ose më shumë qirinj (nga çdo kombinim TF) kanë pika çmimi (open, close, high, low) që konvergojnë në saktësisht të njëjtin nivel PDA → **loaded deal**, conviction institucionale maksimale.

- Të dy pikat e çmimit duhet të referencojnë të **njëjtin PDA array** (e njëjta FVG, OB, Breaker, ose Liquidity Void).
- Konvergjenca brenda 1-2 pips / 2-4 ticks e së njëjtit array përbën stack valid.
- Konvergjenca e tretë (triple stack) e ngre probabilitetin në siguri institucionale.

**Protokoll:** Trajto zonën e konvergjencës si entry-në me conviction-in më të lartë në chart. *Stacking*-u i多点 price points në të njëjtin array — jo asnjë faktor konfluencë i vetëm — është sinjali operativ.

**Shënim:** Immediate Rebalance nuk e override-on Kill Zone ose Time Distortion filters — të gjitha kushtet standarde të entry-t zbatohen.

---

### 3.5 · 90% Rule — Wick Over FVG

Kur wick i qirit shtrihet mbi/nën FVG por body nuk hyn brenda → FVG do të rishikohet **90% të rasteve**.

---

### 3.6 · BISI / SIBI

- **BISI (Buy Side Imbalance, Sell Side Inefficiency):** Qiri lart pa sell-side delivery → algoritmi kthehet ta mbushë.
- **SIBI (Sell Side Imbalance, Buy Side Inefficiency):** Qiri poshtë pa buy-side delivery → algoritmi kthehet ta mbushë.

---

### 3.7 · Inversion FVG

Kur çmimi mbyllet mbi bearish FVG (ose nën bullish FVG), FVG invertëhet dhe bëhet support/resistance e kundërt. Termi i saktë: **Inversion** — JO "Inverse."

---

### 3.8 · Reclaimed FVG

Kur çmimi kthehet brenda FVG origjinale pasi ka vepruar si Inversion FVG dhe ri-konfirmon karakterin e tij origjinal. Mund të ndodhë shumë herë.

---

### 3.9 · Suspension Block

Qiri me volume imbalance në të dyja pjesët (lart dhe poshtë). Nuk është domosdoshmërisht inefficiency. Quadrants: Upper Volume Imbalance, CE (midpoint), Lower Volume Imbalance.

**Pas reversal brenda** → ndryshon karakter në Inversion FVG. Bodies duhet të respektojnë CE.

**Suspension Block Inversion Protocol:**
- Inversion-i shkaktohet **ekskluzivisht** nga displacement candle që kthehet nga brenda range-it të Suspension Block. Grind i ngadaltë, consolidation, ose wick-only penetration **NUK** përbën inversion trigger valid.
- Pas inversion-it valid: (1) CE funksionon si inversion boundary — operationally ekuivalent me Breaker CE. (2) Gjysma e block-ut në drejtim larg reversal bëhet active support/resistance zone; gjysma e afërt neglizhohet. (3) Bodies nuk duhet **kurrë** të mbyllen përtej CE pas inversion — body close përtej CE = inversion failure. (4) Wicks mund të depërtojnë CE; bodies jo.
- **Sinjal failure:** Nëse çmimi rihyn Suspension Block me body close përtej CE në drejtimin origjinal → inversion anulohet.

---

### 3.10 · Discount / Premium Sensitivity

Sa më pak çmimi depërton array-n → aq më e fortë reaksioni algoritmik. Vizato quadrants (75% / CE 50% / 25%) dhe vërej thellësinë e depërtimit.

---

### 3.11 · 3 PDA Array Confluence (G105 — Round 17)

Body close mbi 3 PDA arrays consecutive = **BIAS FLIP i detyrueshëm**.
- 1 PDA thyhet = warning
- 2 PDA = kujdes
- 3 PDA = flip i plotë

**Rregull:** Nëse çmimi NDALON ÇDO rezistencë para 3 PDA-ve → permissible range mbaron atje, bias mbetet valid.

**Konfluencë e dyfishtë PDA** = target i besueshëm (agreement).

---

## 4 · RIFVG — REAPER INVERSION FVG (G103)

**RIFVG Bullish** = FVG në DISCOUNT të leg-ut të parë të Bullish Breaker.
- Wicks bëjnë dëmin (sweep stops + depërtojnë RIFVG).
- Bodies respektojnë 50% e previous day range.
- Standard deviation projection: Low→High = 1 StdDev target.

**RIFVG Bearish** = FVG në PREMIUM të Bearish Breaker.

---

## 5 · SAMPLE PDA CHAIN (Output për Output Schema)

```json
{
  "pda_chains": [
    {
      "chain_id": "CHAIN_A",
      "direction": "buy",
      "root_pool_id": "L1",
      "root_pool_level": 4260.00,
      "root_pool_side": "BSL",
      "pda_sequence": [
        {"type": "OB", "tf": "H4", "zone": [4224.00, 4225.50], "anchor": 4224.50, "anchor_type": "CISD", "pd_status": "Discount", "sweep_event_id": "S1"},
        {"type": "FVG", "tf": "H1", "zone": [4225.00, 4227.00], "anchor": 4226.00, "anchor_type": "CE", "pd_status": "Discount"},
        {"type": "OB", "tf": "M15", "zone": [4225.00, 4226.00], "anchor": 4225.50, "anchor_type": "CISD", "pd_status": "Discount"}
      ],
      "target_pool": "BSL 4260.00",
      "tp1": 4240.00,
      "tp2": 4260.00,
      "chain_lps": 87,
      "status": "ACTIVE"
    }
  ]
}
```

---

## 6 · VALIDATION RULES

- Çdo PDA duhet të ketë **evidence të dukshme në të dhënat MCP** (qirinj, zona të vizatuara).
- Anchor price duhet të jetë **exact** (jo approx.) kur është aktiv.
- Zone_low dhe zone_high duhet të jenë **me saktësi të plotë** sipas qirinjve.
- PD_STATUS: Discount nën 50%, Premium mbi 50%, Equilibrium 50% ± tolerance.
- Nëse ndonjë fushë nuk mund të nxirret → "approx." ose null + arsye.
