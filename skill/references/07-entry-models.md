# 07 · ENTRY MODELS — Katalogu i Bashkuar (35 Modele)

Çdo model është valid VETËM kur kushtet e tij specifike plotësohen.

> ## ⚠️ NUMRAT — LEXO KËTË PARA SE TË SHKRUASH NJË SETUP
>
> Ky skedar kishte 19 modele me numërtim të vetin. Katalogu v6.0 ka 22 me
> numërtim tjetër. **Të dy pajtohen vetëm te 1, 2 dhe 3** — nga 4 e tutje,
> i njëjti numër do të thoshte dy modele të ndryshme.
>
> Asnjë model nuk u hoq. Numrat **1–22** i përkasin katalogut v6.0 (ai që
> shkruan Gemini); modelet e kësaj liste që v6.0 nuk i ka mbajtën
> identitetin e tyre dhe morën numrat **23–35**.
>
> | Ky skedar (i vjetër) | Tani |
> |---|---|
> | 1 ICT 2022 · 2 Market Anchor · 3 Model 2 Amplified | **të pandryshuar** |
> | 4 Silver Bullet | **6 / 7 / 8** (London / AM / PM) |
> | 5 Turtle Soup | **4** |
> | 6 OB+FVG · 7 Unicorn · 8 RIFVG · 9 MMXM/MMBM | **23 · 24 · 25 · 26** |
> | 10 BISI/SIBI · 11 Vault Pocket · 12 SDR · 13 DRO | **27 · 28 · 29 · 30** |
> | 14 LSS · 15 OSST · 16 STRC · 17 SRT · 18 FBE | **31 · 32 · 33 · 34 · 35** |
> | 19 Venom | **17** |
>
> **RREGULL PRAKTIK: shkruaj EMRIN, jo numrin.** Boti i njeh të gjithë
> emrat dhe emri nuk ngatërrohet kurrë. Kur një setup dërgon numër dhe
> emër që kundërshtojnë njëri-tjetrin, **emri fiton**.
>
> Për *Silver Bullet* dhe *Opening Range* thuaj gjithmonë cilën dritare —
> "Silver Bullet AM", "Opening Range PM". Pa dritare boti nuk gjen dot
> model dhe e monitoron setup-in pa politikë modeli, se të hamendësonte
> orën do të ishte më keq.
>
> Katalogu i plotë me Trigger / Validation / Invalidation dhe çfarë
> kontrollon makina: [`docs/entry-models.md`](../../docs/entry-models.md).
> Burimi i kodit: [`lib/entry-models.mjs`](../../lib/entry-models.mjs).

---

## 1 · ICT 2022 MODEL (Modeli Bazë)

**Setup:**
```
- SSL ose BSL është marrë
- BOS i konfirmuar në H1/M15
- FVG e krijuar pas BOS
- Entry në CE e FVG
- Stop nën wick + buffer
- TP: Equilibrium pastaj DOL

Kushte shtesë:
  - NY KZ 7:00-9:00 AM
  - HTF bias alignment
  - Collection Grade A ose B
```

**Kur përdoret:** Setup më i zakonshëm. Kurdoherë që bias HTF është i qartë dhe ka pasur sweep + BOS.

---

## 2 · MARKET ANCHOR (ATH-Driven)

**Setup:**
```
- Çmimi në ose mbi ATH (All-Time High)
- SSL sweep (low i ditës ose swing low thyhet)
- Inversion FVG formohet pas sweep
- LONG entry vetëm
- SL nën sweep low
- TP: New highs

RREGULL E HEKURT: Kurrë mos shko SHORT te ATH pa konfirmim bearish.
```

**Kur përdoret:** Kur çmimi ka thyer ATH dhe po tërheq back për të mbledhur SSL.

---

## 3 · MODEL 2 AMPLIFIED

**Setup:**
```
- Dita: E martë, E mërkurë, ose E enjte
- Ora NY ET:
    - LONG: para 6:00 AM (në Asia/London)
    - SHORT: pas 6:00 AM (në NY)
- SL maksimumi 50 pips
- TP: SD projection (2.0σ ose 2.5σ)

Asnjë setup jashtë këtyre kushteve.
```

**Kur përdoret:** Setup i përforcuar me kushte specifike. Statistikat tregojnë performancë më të mirë në këto ditë.

---

## 6 / 7 / 8 · SILVER BULLET (London 3-4 AM · AM 10-11 · PM 2-3)

**Setup:**
```
Window (NY ET) — VETËM 3 dritaret:
  1. 3:00 - 4:00 AM (London Open)
  2. 10:00 - 11:00 AM (AM Session)
  3. 2:00 - 3:00 PM (PM Session)

Brenda window-it:
  - FVG e krijuar
  - Entry menjëherë në CE
  - TP: opposing liquidity pool
  - SL: nën wick

KOHËT E TJERA NUK KUALIFIKOJNË.
```

**Kur përdoret:** Setup time-based, brenda Silver Bullet windows.

**Statistika:**
- Mekanike pa filtra: 34-36% win rate
- Me HTF bias filter: 60-66% win rate
- Average RR 2.8R

---

## 4 · TURTLE SOUP

**Setup:**
```
Origjina: Linda Raschke (1995), evoluar nga ICT për intraday.

Fade 20-day high/low breakouts (ose variations):
  - Asian/London session extremes
  - Previous day H/L
  - Internal range liquidity

Kushte:
  1. Sweep i konfirmuar
  2. Rejection via candlestick anatomy (wick)
  3. Reversal me force inside range
  4. Entry menjëherë pas reversal

TP: opposing side e range-it
SL: përtej sweep high/low
```

**Kur përdoret:** Setup mean-reversion. Statistikat: 68% win rate (më e larta), por R:R 1:1.6.

---

## 23 · OB + FVG CONFLUENCE

**Setup:**
```
- OB i identifikuar (CISD anchor)
- FVG që shtrihet nga OB
- Konfluencë = overlap gjeografik
- Entry në CE e FVG (që është edhe brenda OB)
- SL nën OB
- TP: 2.8R target

Statistika: 63% win rate, 1:2.8 R:R, 41% FTMO pass rate
```

**Kur përdoret:** Setup me probabilitetin më të lartë. Kur OB dhe FVG ndodhen në të njëjtin nivel çmimi.

---

## 24 · UNICORN (2nd Stage Redistribution)

**Setup:**
```
MMXM/MMBM 2nd Stage:
  1st Stage: Accumulation/Distribution
  2nd Stage: Redistribution/Reaccumulation (UNICORN = peak speed/magnitude)

Kushte:
  - 1st Stage ka përfunduar (shoqërohet me volume contraction)
  - 2nd Stage fillon me displacement masiv
  - Entry në FVG e 2nd Stage
  - TP: opposing liquidity target

Karakteristikë: Shpejtësi dhe magnitude maksimale.
```

**Kur përdoret:** Kur MMXM/MMBM ka kaluar në 2nd Stage.

---

## 25 · RIFVG (Reaper Inversion FVG)

**Setup:**
```
RIFVG Bullish:
  - FVG në DISCOUNT të Bullish Breaker leg
  - Wick depërton RIFVG
  - Body respekton 50% e previous day range
  - SD projection: Low→High = 1σ target
  - Entry në RIFVG CE

RIFVG Bearish:
  - FVG në PREMIUM të Bearish Breaker
  - Mirror logic
```

**Kur përdoret:** Setup specifik kur inversion FVG ndodhet brenda Breaker leg.

---

## 26 · MMXM / MMBM FULL (Market Maker Models)

```
MMXM (Sell Model) — 4 Stage:
  1. Original Consolidation (1st Stage reference)
  2. Run on Buy Side Liquidity (BSL sweep)
  3. Buy Side Curve → Sell Side Curve (polarity flip)
  4. 2nd Stage Distribution (Unicorn) → target hit

MMBM (Buy Model) — Mirror:
  1. Original Consolidation
  2. Run on Sell Side Liquidity (SSL sweep)
  3. Sell Side Curve → Buy Side Curve (polarity flip)
  4. 2nd Stage Redistribution (Unicorn) → target hit

Entry: në FVG CE të 2nd Stage
TP: opposing liquidity target
SL: përtej 1st Stage extremes
```

**Kur përdoret:** Setup i plotë ciklik. Më i përshtatshëm për HTF analizë.

---

## 27 · BISI / SIBI (Volume Imbalance Entry)

```
BISI = Buy Side Imbalance, Sell Side Inefficiency:
  - Qiri bullish pa sell-side delivery
  - Body lart, wick i shkurtër poshtë
  - Çmimi do të kthehet të mbushë inefficacy
  - Entry: kur çmimi depërton BISI
  - TP: liquidity pool mbi BISI

SIBI = Mirror logic
```

**Kur përdoret:** Setup për mean-reversion brenda range.

---

## 28 · VAULT POCKET (Inner OB)

```
OB që ndodhet brenda range (jo në boundary):
  - OB i brendshëm
  - Kur çmimi rikthehet në OB
  - Entry: në OB CE
  - TP: range boundary (BSL/SSL)
  - SL: përtej OB

Karakteristikë: Precision entry brenda dealing range.
```

**Kur përdoret:** Kur dealing range është i qartë dhe çmimi po rikthehet në OB të brendshëm.

---

## 29 · SDR (Standard Deviation Rejection)

```
- Asian Range i identifikuar
- SD projections llogaritur
- Çmimi arrin 1.0σ ose 1.5σ
- Rejection (wick ≥ 3× body)
- Entry: pas rejection
- TP: 0.5σ ose Equilibrium
- SL: përtej SD projection
```

**Kur përdoret:** Setup i hershëm i ditës (Asia → London).

---

## 30 · DRO (Daily Range Open)

```
- Open e ditës si anchor
- Çmimi kthehet në open pas gap
- Entry: në open ose 50% e gap
- TP: range H ose L
- SL: përtev open + buffer

Përdoret veçanërisht për indices (gap fill behavior).
```

**Kur përdoret:** Kur ka gap të dukshëm në open.

---

## 31 · LSS (Liquidity Sweep Setup)

```
Pure sweep + MSS:
  1. Liquidity pool i identifikuar (BSL/SSL)
  2. Sweep i konfirmuar
  3. MSS me displacement
  4. Entry në FVG e MSS
  5. TP: opposing liquidity

Karakteristikë: Më i thjeshtë se Unicorn, përdoret kur cikli MMXM/MMBM nuk është i qartë.
```

**Kur përdoret:** Setup themelor pa komplikime.

---

## 32 · OSST (One-Shot Setup)

```
Single-attempt setup:
  - Kushtet perfekte janë të pranishme
  - Vetëm 1 hyrje — pa retries
  - Setup i rrallë, conviction A
  - TP: target i plotë pa R1/R2 splits

Kushte specifike:
  - HTF alignment i fortë
  - Collection Grade A
  - Displacement masiv
  - 3+ PDA confluence
```

**Kur përdoret:** Vetëm kur të gjitha kushtet janë A+.

---

## 33 · STRC (Structure + CSD)

```
Structure + Change in State of Delivery:
  - CSD (G104) = momenti algoritmik bullish→bearish ose anasjelltas
  - CSD trigger EXACT: çmimi tregton nën Opening-in e qirit të fundit up-close (Bear Shoulder Block)
  - Propulsion Block = qiri tjetër up-close që ha Bear Shoulder Block
  - Entry: në Propulsion Block
  - TP: opposing liquidity

CSD 2 (sekondare) kur Propulsion Block aktivizohet.
```

**Kur përdoret:** Kur CSD ka ndodhur dhe Propulsion Block është aktiv.

---

## 34 · SRT (Sweep-Retest-Trap)

```
- Sweep i konfirmuar
- Çmimi kthehet në nivelin e sweep-uar (retest)
- Trap pattern formohet (e.g., lower high pastaj break)
- Entry: në retest + trap pattern
- TP: opposing liquidity
- SL: përtej sweep high/low

Karakteristikë: Më i ngadalshëm se LSS, por më i sigurt.
```

**Kur përdoret:** Kur tregu po tregon retest behavior pas sweep.

---

## 35 · FBE (Fibo-Body-Entry)

```
- Fibo retracement (OTE zone 0.618-0.79)
- Çmimi arrin në Fibo zone
- Body close (jo wick) brenda zone
- Entry: menjëherë pas body close
- TP: -0.5 deri -1.0 extension
- SL: përtej Fibo zone

Karakteristikë: Precision entry bazuar në Fibo overlap me PDA.
```

**Kur përdoret:** Kur Fibo zone dhe PDA array ndodhen në të njëjtin nivel.

---

## 17 · VENOM (Deferred Turtle Soup)

**Setup:**
```
Origjina: ICT — variant "deferred entry" i Turtle Soup (#5).
Turtle Soup klasik hyn MENJËHERË pas reversal, te vetë sweep-i.
Venom hyn MË VONË, pasi struktura ka dhënë firmën — jo te sweep-i vetë.

Struktura (dy "fangs"):
  1. Sweep nën/mbi një liquidity pool (SSL për long, BSL për short)
     — minimumi 1 candle mbyllet përtej pool-it, jo thjesht wick
  2. CIBI (sell-side imbalance) e ndjekur nga BISI (buy-side imbalance)
     që e lë atë pas — duhet SEKUENCA e të dyjave, njëra vetëm s'mjafton

Entry: në ose përtej closing price të candle-it të 2-të (candle-i i reclaim/BISI)
SL: përtej low/high e candle-it që bëri sweep-in (jo e candle-it të reclaim)
TP: opposing liquidity pool / FVG kundërshtare

Karakteristikë: DEFERRED. Nuk kërkon të kapësh vetë momentin e sweep-it
(rrezik i lartë, kohë vendimi shumë e shkurtër). Prit sekuencën CIBI→BISI,
pastaj hyr — edhe nëse çmimi ka konsoliduar/lëvizur gjatë ("time distortion"),
edhe nëse dukesh sikur po "ndjek" çmimin. Brenda konsolidimit mund të ketë
disa mundësi hyrjeje të njëpasnjëshme, të gjitha valide përderisa janë
në ose përtej closing price të candle-it të 2-të.
```

**Kur përdoret:** Kur Turtle Soup klasik do të kërkonte hyrje te vetë sweep-i (shumë të rrezikshme/të vështira për t'u kapur në kohë). Zgjidhet siguria mbi precizitetin — parim i njëjtë me atë që "s'na intereson sniper, na intereson safe."

---

## MODEL SELECTION LOGIC

```
┌─────────────────────────────────────────────────────┐
│  IF bias HTF është i qartë AND ka SSL/BSL sweep:    │
│    → ICT 2022 (default)                              │
│  IF ka HTF alignment me sweep në ATH:               │
│    → Market Anchor                                   │
│  IF dita është Tue/Wed/Thu:                         │
│    → Model 2 Amplified                               │
│  IF brenda Silver Bullet window:                    │
│    → Silver Bullet                                   │
│  IF OB dhe FVG ndodhen në të njëjtin nivel:         │
│    → OB + FVG Confluence                             │
│  IF MMXM/MMBM në 2nd Stage:                         │
│    → Unicorn                                         │
│  IF Inversion FVG brenda Breaker leg:               │
│    → RIFVG                                           │
│  ELIF Sweep + MSS:                                  │
│    → LSS                                             │
│  ELIF Çmimi në Fibo zone + PDA overlap:             │
│    → FBE                                             │
│  ELIF Sweep + CIBI→BISI reclaim (sweep-i vetë       │
│  tashmë ka kaluar, s'kapet dot me hyrje të menjëhershme): │
│    → Venom (deferred)                                │
│  ELSE:                                               │
│    → Prit ose refuzo                                 │
└─────────────────────────────────────────────────────┘
```
