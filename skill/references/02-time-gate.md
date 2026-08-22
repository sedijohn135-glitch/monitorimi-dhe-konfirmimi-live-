# 02 · TIME GATE — Moduli 00 (Hapi Zero Absolut)

Para çdo analize — thirr **MENJËHERË** `time.now("America/New_York")`. Ky hap është **DETYRIM ABSOLUT**.

---

## 1 · TIMEZONE RULES

| Rregull | Vlera |
|---------|-------|
| Timezone Durrësi (verë mars-tetor) | **UTC+2 (CET)** |
| Timezone Durrësi (dimër tetor-mars) | **UTC+1 (CET)** |
| NY ET verë | **UTC-4** |
| NY ET dimër | **UTC-5** |
| Diferenca CET → NY ET | **-6 orë** (e njëjta kur të dyja kanë DST) |

**⛔ KURRË** mos u mbështet në timestamp-et e broker-it si referencë kohore reale. Broker-at shpesh japin orë server (GMT, GMT+2, GMT+3) që NUK është Durrësi dhe NUK është NY ET.

**⛔ KURRË** mos vazhdo analizën pa konfirmuar orën NY ET. Nëse ora nuk është e qartë → thirr `time.now` PARA çdo gjëje tjetër.

---

## 2 · FORMULA E SHPEJTË

| CET (Durrës) | NY ET | Sesioni | Status |
|---------------|-------|---------|--------|
| 00:00–08:00 | 18:00–02:00 | Asia / Pre-London | NEUTRAL |
| 08:00 | 02:00 | ⭐ **London KZ Start** | **PRIME** |
| 08:00–11:00 | 02:00–05:00 | ⭐ London Open KZ | **PRIME** |
| 09:00–10:00 | 03:00–04:00 | ⭐ **London Silver Bullet** | **PRIME** |
| 11:00 | 05:00 | London Close | — |
| 13:00 | 07:00 | NY Pre-Market | PRIME |
| 14:00–15:30 | 08:00–09:30 | ⭐ NY Pre-Open | **PRIME** |
| 15:30 | 09:30 | ⭐ **RTH Open (Judas Swing)** | **PRIME** |
| 16:00 | 10:00 | ⭐ AM Silver Bullet + Lunch Macro | **PRIME** |
| 16:00–17:00 | 10:00–11:00 | ⭐ **AM Silver Bullet** | **PRIME** |
| 17:00 | 11:00 | NY AM Close | — |
| **18:00–19:00** | **12:00–13:00** | ⛔ **NY LUNCH — ZERO TRADE** | ⛔ **NO-TRADE** |
| 19:30 | 13:30 | ⭐ PM Session Start | **PRIME** |
| 20:00–21:00 | 14:00–15:00 | ⭐ **PM Silver Bullet** | **PRIME** |
| 21:00–22:00 | 15:00–16:00 | PM Peak / Last Hour | **PRIME** |
| 22:00 | 16:00 | NY Close | — |

---

## 3 · NY LUNCH BINARY GATE (12:00–13:00 NY ET = 18:00–19:00 CET)

⛔ **NËSE ora aktuale bie brenda NY Lunch → MODULE 00 GATE = NO-TRADE absolute.**

Asnjë modul tjetër. Identifiko vetëm Lunch Macro Target (first swing H/L pas 10:00 AM) për t'u përdorur në PM Session. Prit deri 13:00 NY ET.

---

## 4 · KILL ZONES (Lista e Plotë)

| Kill Zone | Time (NY ET) | Notes |
|-----------|--------------|-------|
| **Asian Range** | 7:00 PM – Midnight (natën e kaluar) | Consolidation |
| **London Opening Range** | 1:30 – 2:00 AM | 30-min OR |
| **London Open KZ** | 2:00 – 5:00 AM | Potential false breakout |
| **London False Breakout** | 2:00 AM | Drop below Asian Range Low → reversal |
| **London Silver Bullet** | 3:00 – 4:00 AM | **PRIME** |
| **NY Opening Range** | 7:00 – 7:30 AM | 30-min OR — të gjitha instrumentet |
| **6:30 AM Reference** | 6:30 AM | Pre-NY OR context — BSL/SSL taken? |
| **NY Open KZ** | 7:00 – 10:00 AM | High energy; Judas Swing 9:30–10:00 |
| **Equities Opening Range** | 9:30 – 10:00 AM | 30-min — indices only |
| **London Close** | 10:00 – 12:00 PM | Macro 10:50–11:10 |
| **Silver Bullet AM** | 10:00 – 11:00 AM | **PRIME** |
| **NY Lunch** | 12:00 – 1:00 PM | ⛔ **DO NOT TRADE** |
| **PM Opening Range** | 1:30 – 2:00 PM | 30-min PM OR |
| **Silver Bullet PM** | 2:00 – 3:00 PM | **PRIME** |
| **PM Session** | 1:30 – 4:00 PM | Inversion AM arrays |
| **Last Hour Macros** | 3:00 – 4:00 PM | 3:15 / 3:40 / 3:50 / 4:00 PM |

---

## 5 · ICT MACROS (Saktësisht ±10 min)

**RREGULL:** Macro = 10 min PARA + 10 min PAS orarit. Asnjë orar tjetër nuk kualifikon.

| Macro | Window (NY ET) |
|-------|----------------|
| London Open | 2:33 AM |
| London Continuation | 4:03 AM |
| Pre-NY Open | 7:50 – 8:10 AM |
| Pre-Open | 8:50 – 9:10 AM |
| NY Open | 9:50 – 10:10 AM |
| London Close | 10:50 – 11:10 AM |
| NY Lunch | 11:50 AM – 12:10 PM |
| PM Session Start | 1:10 – 1:30 PM |
| PM Macro | 2:50 – 3:10 PM |
| Last Hour | 3:15 / 3:40 / 3:50 / 4:00 PM |

---

## 6 · SILVER BULLET WINDOWS (3 dritare, jo 4)

| # | Window (NY ET) | Emri |
|---|----------------|------|
| 1 | 3:00 – 4:00 AM | **London Open Silver Bullet** |
| 2 | 10:00 – 11:00 AM | **AM Session Silver Bullet** |
| 3 | 2:00 – 3:00 PM | **PM Session Silver Bullet** |

⛔ **3:00–4:00 PM NUK është Silver Bullet.**

---

## 7 · OPENING RANGE WINDOWS (Saktësisht 30 min)

| OR | Window (NY ET) | Instrumente |
|----|----------------|-------------|
| London OR | 1:30 – 2:00 AM | Forex/Metals |
| NY KZ OR | 7:00 – 7:30 AM | Të gjitha |
| Equities OR | 9:30 – 10:00 AM | Indices vetëm |
| PM OR | 1:30 – 2:00 PM | PM Session |

---

## 8 · TIME-OF-DAY CONFIDENCE PENALTY

| Sesioni | Status | Penaliteti |
|---------|--------|------------|
| PRIME (London KZ / NY Pre / RTH / AM SB / PM / PM SB) | ✅ Konfirmim | 0% |
| NY Lunch (12:00–13:00 NY) | ⛔ NO TRADE absolute | −100% (gate mbyllet) |
| Neutrale (11:00–13:00 NY, 17:00–19:00 CET) | ⚠️ Kujdes | −10% confidence |
| Late NY (15:30–16:00 NY) | ⚠️ Setup i vonuar | −15% confidence |

---

## 9 · TIME DISTORTION

⛔ **TIME DISTORTION** aktiv nëse:
- Jemi midis dy sesioneve (e.g., midis London Close dhe NY Pre-Market)
- Jemi midis dy macros
- Jemi në NY Lunch (12:00–13:00 NY ET)
- Jemi jashtë orarit aktiv tregtar

Nëse Time Distortion aktiv → **NO TRADE absolute.**

---

## 10 · LONDON OPEN ROLE (G100 — Round 16 Integration)

Roli i London-it ndryshon sipas Asian session output:

- **Asian krijon LOD (low of day)** → London = Retracement leg → OTE LONG
- **Asian krijon HOD (high of day)** → London = Retracement leg → OTE SHORT
- **Asian neutral** → London krijon vetë HOD/LOD

---

## 11 · MODULE 00 OUTPUT FORMAT

```
⏰ time.now: [HH:MM CET Durrës] = [HH:MM NY ET] | Sesioni: [...] | Kill Zone: [AKTIVE: lloji / INAKTIVE / NY LUNCH NO-TRADE] | Macro: [AKTIVE: time / INAKTIVE]
```

**Nëse modul-i dështon → e gjithë analiza është e pasaktë sepse timing-u i çdo modeli, macros, dhe Kill Zone varet nga kjo orë.**
