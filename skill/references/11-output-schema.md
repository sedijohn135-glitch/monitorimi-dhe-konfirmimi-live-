# 11 · OUTPUT SCHEMA — Kontrata e Plotë e Output-it

Çdo përgjigje e skill-it duhet të prodhojë **output sipas këtij skemë**. Asgjë para header-it, asgjë pas footer-it, asnjë koment brenda block-eve.

---

## 1 · JSON OUTPUT COMPLET

```json
{
  "meta": {
    "skill_version": "ict-sniper-liquidity-engine v7.0",
    "timestamp_utc": "2026-08-21T22:39:18Z",
    "user_tz": "Europe/Tirane",
    "user_local_time": "2026-08-22T00:39:18+02:00",
    "ny_et": "18:39",
    "session": "London|NY_AM|NY_PM|Asia|NY_Lunch|Off-Hours",
    "kill_zone": "AKTIVE|INAKTIVE",
    "kill_zone_name": "London Open|NY AM Silver Bullet|PM Silver Bullet|...",
    "macro": "AKTIVE|INAKTIVE",
    "macro_name": "London Open|Pre-NY Open|...",
    "is_time_distortion": false,
    "is_ny_lunch": false,
    "instrument": "XAUUSD",
    "mcp_used": true
  },
  "mcp_status": {
    "tools_available": ["time.now", "market.get_quote", "market.get_candles", "market.get_atr", "market.get_spread", "session.status", "session.get_range"],
    "tools_missing": ["calendar.upcoming"],
    "warnings": ["calendar.upcoming not available — high-impact news check skipped"]
  },
  "instrument": {
    "symbol": "XAUUSD",
    "tick_size": 0.01,
    "price_unit": "pips",
    "spread_points": 1.2,
    "current_price": 4231.50,
    "bid": 4231.45,
    "ask": 4231.57,
    "atr_m5_14": 8.0,
    "atr_m15_14": 25.0,
    "atr_h1_14": 60.0,
    "atr_h4_14": 120.0,
    "atr_d1_14": 250.0
  },
  "ilos_state": {
    "primary_objective": {
      "level": 4260.00,
      "type": "BSL",
      "structural_type": "EQH",
      "htf_confirmation": "D1",
      "lps": 87
    },
    "secondary_objective": {
      "level": 4255.00,
      "type": "BSL",
      "structural_type": "Old High",
      "lps": 65
    },
    "current_dol": 4260.00,
    "objective_locked": true,
    "thesis_integrity": "INTACT",
    "confidence": "HIGH",
    "bias": "buy",
    "institutional_narrative": "...",
    "alternative_thesis_falsified": "..."
  },
  "trap_analysis": {
    "trap_identified": "YES",
    "trap_sub_type": "Type 1",
    "manipulation_phase": "COMPLETE",
    "delivery_phase": "INITIATED",
    "kurthi_status": "INTAKT",
    "trap_direction": "BSL",
    "expected_manipulation_target": 4218.00,
    "retail_positioned": "Shorts at 4240-4250, SL cluster 4252-4260"
  },
  "structure": {
    "d1": {
      "bias": "bullish",
      "swing_high": 4270.00,
      "swing_low": 4180.00,
      "equilibrium": 4225.00,
      "current_premium_discount": "Premium",
      "mss_at": 4220.00,
      "last_bos": 4255.00,
      "active_bullish_pdas": ["H4 OB 4224-4225", "D1 FVG 4200-4210"]
    },
    "h4": {
      "bias": "bullish",
      "swing_high": 4260.00,
      "swing_low": 4220.00,
      "equilibrium": 4240.00,
      "mss_at": 4220.00,
      "last_bos": 4255.00
    },
    "h1": {
      "bias": "bullish",
      "mss_at": 4225.00,
      "last_bos": 4252.00,
      "current_premium_discount": "Discount"
    },
    "m15": {
      "bias": "bullish",
      "mss": true,
      "mss_at": 4225.50,
      "displacement": true
    },
    "m5": {
      "bias": "bullish",
      "mss": true,
      "mss_at": 4225.50,
      "displacement": true,
      "fvg_present": true
    },
    "m1": {
      "bias": "bullish",
      "mss": true,
      "mss_at": 4225.30,
      "displacement": true
    }
  },
  "liquidity_pools": [
    {
      "id": "L1",
      "level": 4260.00,
      "side": "BSL",
      "type": "EQH",
      "tf": "D1",
      "lps": 87,
      "status": "UNTOUCHED",
      "ownership": "retail_breakout",
      "distance_pips": 28.5
    },
    {
      "id": "L2",
      "level": 4255.00,
      "side": "BSL",
      "type": "Old High",
      "tf": "H4",
      "lps": 65,
      "status": "UNTOUCHED",
      "ownership": "late_trend_followers",
      "distance_pips": 23.5
    },
    {
      "id": "L3",
      "level": 4220.00,
      "side": "SSL",
      "type": "EQL",
      "tf": "H4",
      "lps": 75,
      "status": "SWEPT",
      "ownership": "retail_breakdown",
      "distance_pips": 11.5
    }
  ],
  "pda_arrays": [
    {
      "id": "P1",
      "type": "OB",
      "tf": "H4",
      "zone_low": 4224.00,
      "zone_high": 4225.50,
      "anchor_price": 4224.50,
      "anchor_type": "CISD",
      "pd_status": "Discount",
      "status": "ACTIVE",
      "sweep_event_id": "S1",
      "sweep_tf": "M5",
      "sweep_at": "2026-08-21T15:30:00Z"
    },
    {
      "id": "P2",
      "type": "FVG",
      "tf": "H1",
      "zone_low": 4225.00,
      "zone_high": 4227.00,
      "anchor_price": 4226.00,
      "anchor_type": "CE",
      "pd_status": "Discount",
      "fill_pct": 0.0,
      "status": "ACTIVE"
    }
  ],
  "pda_chains": [
    {
      "chain_id": "CHAIN_A",
      "direction": "buy",
      "root_pool_id": "L1",
      "root_pool_level": 4260.00,
      "pda_sequence": [
        {"id": "P1", "type": "OB", "tf": "H4"},
        {"id": "P2", "type": "FVG", "tf": "H1"}
      ],
      "target_pool": "BSL 4260.00",
      "tp1": 4240.00,
      "tp2": 4260.00,
      "chain_lps": 87,
      "status": "ACTIVE"
    }
  ],
  "collection": {
    "status": "CONFIRMED",
    "grade": "A",
    "confirmations": {
      "fvg_50pct": true,
      "wick_3x_body": true,
      "mss_with_displacement": true,
      "volume_absorption": true
    },
    "sweep_event": {
      "sweep_id": "S1",
      "pool_id": "L3",
      "level": 4220.00,
      "side": "SSL",
      "sweep_at": "2026-08-21T15:25:00Z",
      "sweep_wick": 4217.50,
      "body_close": 4222.00
    }
  },
  "lifecycle": {
    "current_stage": "Distribution",
    "stage_number": 3,
    "curve_side": "Buy Side",
    "polarity_flip": false,
    "lrlr_objective": 4260.00,
    "is_unicorn_phase": false,
    "in_target_arrival_window": true,
    "po3_phase": "Distribution"
  },
  "execution": {
    "model": "ICT 2022",
    "direction": "buy",
    "entry": 4225.50,
    "shadow_entry": 4225.20,
    "entry_basis": "FVG CE 4226.00 — entry at 50% of FVG",
    "stop_loss": 4217.00,
    "stop_basis": "ATR M5 8 × 1.5 = 12 pips below entry, plus sweep buffer 1.5 = 13.5, anchored to sweep wick 4217.50 - buffer",
    "tp1": 4240.00,
    "tp1_basis": "Equilibrium 50% of D1 dealing range",
    "tp2": 4260.00,
    "tp2_basis": "DOL final (HTF BSL at 4260.00)",
    "rr_tp1": 2.40,
    "rr_tp2": 5.65,
    "conviction": "A",
    "zero_float_status": "AUTHORIZED"
  },
  "risk": {
    "account_balance_usd": 10000.0,
    "risk_per_trade_pct": 1.0,
    "risk_usd": 100.0,
    "stop_distance_pips": 8.5,
    "pip_value_usd": 1.0,
    "lot_size_micro": 11.76,
    "lot_size_standard": 0.118,
    "spread_pips": 1.2,
    "slippage_buffer_pips": 1.5,
    "commission_round_trip_usd": 7.5,
    "atr_m5_14": 8.0,
    "atr_multiplier_k": 1.5,
    "volatility_regime": "normal"
  },
  "skill_context": {
    "htf_mss_confirmed": true,
    "htf_mss_at": 4220.00,
    "htf_mss_at_ms": 1787352229602,
    "trap_phase": "delivery",
    "trap_sub_type": "Type 1",
    "liquidity_swept": true,
    "liquidity_target": 4255.00,
    "m5_mss_already_observed": true,
    "m5_mss_at_ms": 1787353969602,
    "htf_bias": "bullish",
    "conviction": "HIGH",
    "expected_displacement_tf": "M5",
    "analysis_at_ms": 1787353969602,
    "note": "London sweep i Asia low, delivery drejt NY AM"
  },
  "warnings": [],
  "self_check": {
    "check_1_objective_lock": "PASS",
    "check_2_no_ilos_conflict": "PASS",
    "check_3_thesis_integrity": "PASS",
    "check_4_zero_float_conviction": "PASS",
    "check_5_cross_references": "PASS"
  },
  "verdict": "A+ SETUP",
  "executive_summary": "Bullish bias confirmed on D1/H4. H4 MSS with displacement at 4220 created the structural foundation. SSL sweep at 4220 (EQL) collected retail stops. H1 FVG at 4225-4227 with H4 OB at 4224-4225.5 form confluence zone. DOL: BSL 4260 (D1 EQH 3+ touches, LPS=87). Entry: 4225.50 (FVG CE). Stop: 4217.00 (wick + buffer). TP1: 4240 (Equilibrium). TP2: 4260 (DOL). R:R 1:2.4 (TP1), 1:5.65 (TP2). Conviction A. Zero Float Authorized."
}
```

---

## 2 · VERDIKTET E LEJUARA

```
A+ SETUP        — Të gjitha kushtet A. Zero Float authorized.
SETUP           — Setup valid por jo A+. Zero Float suspended.
RESET           — LTF reset, HTF thesis preserved. Prit konfirmim.
NO-SETUP        — Asnjë setup valid. Prit ose dil.
NO-TRADE        — NY Lunch, Time Distortion, ose kushte absolute.
POLICY_FAIL     — MCP tools missing ose ILOS violation.
```

---

## 3 · VERDIKT-BLOCK RULES

### 3.1 · Kur është `A+ SETUP`?

```
- ILOS_STATE.confidence = HIGH
- TRAP_IDENTIFIED = YES
- COLLECTION_GRADE = A
- CONVICTION = A
- ZERO_FLOAT_STATUS = AUTHORIZED ose CONFIRMED
- R:R TP1 ≥ 1:2
- Self-check TË GJITHA PASS
```

### 3.2 · Kur është `SETUP`?

```
- ILOS_STATE.confidence = MEDIUM ose HIGH
- TRAP_IDENTIFIED = YES
- COLLECTION_GRADE = B
- CONVICTION = B
- ZERO_FLOAT_STATUS = SUSPENDED
- R:R TP1 ≥ 1:1.5
- Self-check PASS
```

### 3.3 · Kur është `RESET`?

```
- HTF thesis INTACT
- LTF reset event (noise condition N1, N2, N3)
- Zero Float nuk lëshohet, por setup mund të rikthehet
```

### 3.4 · Kur është `NO-SETUP`?

```
- COLLECTION_GRADE = C ose D
- CONVICTION = C
- ZERO_FLOAT_STATUS = DENIED
- Asnjë trap i konfirmuar
- Self-check PASS
```

### 3.5 · Kur është `NO-TRADE`?

```
- is_ny_lunch = true
- is_time_distortion = true
- Pa setup aktiv
```

### 3.6 · Kur është `POLICY_FAIL`?

```
- Ndonjë mjet MCP kritik mungon
- ILOS conflict i pazgjidhur
- Self-check FAIL
- Tregu jashtë orarit aktiv
```

---

## 4 · EXECUTIVE SUMMARY FORMAT

```
{verdict}: {bias} bias on D1/H4 alignment. {structure summary}.
Trap {trap_status} ({trap_sub_type}). Collection Grade {grade}.
DOL: {dol_description}.
Entry: {entry} ({entry_basis}). Stop: {stop} ({stop_basis}).
TP1: {tp1} ({tp1_basis}). TP2: {tp2} ({tp2_basis}).
R:R 1:{rr_tp1} (TP1), 1:{rr_tp2} (TP2).
Conviction {conviction}. Zero Float {zero_float_status}.
```

---

## 5 · OUTPUT DISCIPLINE

1. ⛔ **ASNJË** koment para header-it
2. ⛔ **ASNJË** koment pas footer-it
3. ⛔ **ASNJË** koment brenda block-eve JSON
4. ⛔ **ASNJË** "common sense" adjustments
5. ✅ Çdo fushë e detyrueshme duhet të shfaqet
6. ✅ Vlera të munguara ose të papërshtatshme → "null" ose "NOT APPLICABLE" + arsye
7. ✅ Zero Float Entry section OMISSO nëse ZERO_FLOAT_STATUS ≠ CONFIRMED ose CONVICTION ∉ {A, B}

---

## 6 · HUMAN-READABLE PRESENTATION

Pas JSON, shto një prezantim njeri-qartë në shqip:

```
🎯 VERDIKTI: {verdict}

📊 KONTEKSTI:
  Instrumenti: {symbol}
  Çmimi aktual: {current_price}
  Sesioni: {session}
  Kill Zone: {kill_zone} ({kill_zone_name})
  Macro: {macro} ({macro_name})

📐 STRUKTURA:
  D1: {d1.bias} (MSS @ {d1.mss_at}, BOS @ {d1.last_bos})
  H4: {h4.bias} (MSS @ {h4.mss_at})
  H1: {h1.bias} (MSS @ {h1.mss_at})
  M5: {m5.bias} (MSS={m5.mss}, Displacement={m5.displacement})

🪤 KURTHI:
  Status: {trap_status}
  Tipi: {trap_sub_type}
  Collection Grade: {collection.grade}
  Konfirmime: {collection.confirmations}

🎯 ENTRY (nëse ka):
  Modeli: {execution.model}
  Drejtimi: {execution.direction}
  Entry: {execution.entry} ({execution.entry_basis})
  Stop: {execution.stop_loss} ({execution.stop_basis})
  TP1: {execution.tp1} ({execution.tp1_basis})
  TP2: {execution.tp2} ({execution.tp2_basis})
  R:R: 1:{execution.rr_tp1} / 1:{execution.rr_tp2}
  Conviction: {execution.conviction}

⚠️ PARALAJMËRIME: {warnings}
✅ SELF-CHECK: Të gjitha PASS (ose specifiko failure)
```

---

## 7 · DISCLAIMER (Detyrim në çdo output)

```
⚠️ KY OUTPUT ËSHTË ANALIZË, JO KËSHILLË INVESTIMI.
Tregu përmban rrezik humbjeje kapitali. Verifiko me burimin tënd
para çdo ekzekutimi. Përdoruesi mban përgjegjësi të plotë.
```


---

## SKILL_CONTEXT — bllok i veçantë për `register_watch`

`skill_context` nuk është vetëm output; ai **dërgohet** te monitori bashkë me
`register_watch`. Rregullat e plota → [SKILL.md §15.5](../SKILL.md).

Dy gjëra që gabohen më shpesh:

1. **`conviction` këtu është `HIGH|MEDIUM|LOW`** (nga `ilos_state.confidence`),
   jo `A|B|C` (nga `execution.conviction`). Çdo vlerë e panjohur lexohet `MEDIUM`.
2. **Vetëm `true` i shprehur është pretendim.** `"false"`, `0`, `null` dhe mungesa
   do të thonë "nuk e pretendova" — dhe monitori nuk e lexon kurrë si pretendim.

Boolean-at duhet të pasqyrojnë vëzhgim real. Auditi
(`get_skill_context_audit`) i krahason me rezultatin: një `HIGH` i rremë del
`skill_said_HIGH_but_failed`.
