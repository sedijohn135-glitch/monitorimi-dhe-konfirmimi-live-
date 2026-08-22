# 🎯 ICT Sniper Liquidity Engine v7.2

> **Liquidity Intelligence Engine për analizë ICT/SMC në tregje live — XAUUSD, BTCUSD, FX, indekse.**
> **MCP-Native. Event-Driven. Configurable. Zero-Float Architecture.**

---

## ⚡ Quick Start (5 minuta)

```bash
# 1. Zbulo tools të MCP yt
python3 scripts/mcp_discovery.py --manual

# 2. Përditëso mcp_config.yaml me emrat e saktë

# 3. Fillo analizën
# Thuaj AI: "Përdor skill-in ict-sniper-liquidity-engine për XAUUSD"
```

---

## 📦 Çfarë ka brenda

```
ict-sniper-liquidity-engine/
├── SKILL.md                       # Orchestrator (649 rreshta)
├── mcp_config.yaml                # Konfigurim i personalizueshëm MCP
├── README.md                      # Ky file
├── references/                    # 13 module të detajuara
│   ├── 00-mcp-contract.md         # Kontrata MCP + watch pattern
│   ├── 01-ilos-foundation.md      # 10 ILOS Laws + 9 Supremacy Rules
│   ├── 02-time-gate.md            # Time, Kill Zones, Macros
│   ├── 03-htf-mapper.md           # HTF Structure, Liquidity Discovery
│   ├── 04-trap-engine.md          # Kurthi, $10B Pyetja, 8 TIP
│   ├── 05-pda-arrays.md           # OB, FVG, BB, RB, BPR, RIFVG
│   ├── 06-zero-float.md           # Zero Float Engine
│   ├── 07-entry-models.md         # 18 modelet e hyrjes
│   ├── 08-risk-management.md      # ATR Stop, Position Sizing
│   ├── 09-london-ny-am-pm.md      # Judas Swing, Macro specifics
│   ├── 10-lifecycle-stages.md     # MMXM/MMBM Full Doctrine
│   ├── 11-output-schema.md        # JSON Output Contract
│   └── 12-enum-registry.md        # Enum values (master list)
└── scripts/                       # 5 scripts të gatshme
    ├── mcp_discovery.py           # Zbulim i tools + fushave të skill_context
    ├── mcp_normalize.py           # Normalizim të dhënash MCP
    ├── preflight.py               # 9 kontrollet para-analizës
    ├── time_zone.py               # Konvertim timezone
    └── trap_watch.py              # Event-driven watch + polling fallback
```

**Total:** 20 fajlle, 6500+ rreshta kodit.

---

## 🧠 Skill context — konfirmimet nuk humbasin më (v7.2)

Deri në v7.1, konfirmimet që bënte skill-i (MSS-i HTF, faza e kurthit,
likuiditeti i marrë, MSS-i M5 i vërejtur **para** touch-it) mbeteshin brenda
skill-it. Monitori i ri-nxirrte nga e para pas touch-it dhe konfirmonte 5–15
minuta pas lëvizjes.

Tani `register_watch` merr bllokun `skill_context`. Monitori e përdor për të
vendosur **cila provë live kërkohet** dhe **sa gjatë duhet mbajtur** — kurrë që
s'duhet provë fare: korsia e shpejtë kërkon MSS + displacement në **M1**, të
dyja në bare të mbyllura pas touch-it.

```bash
# Verifiko para se ta dërgosh — fushat lexohen nga inputSchema, jo nga supozimi
python3 scripts/mcp_discovery.py --endpoint <url>
```

Nëse raporti thotë `unsupported`, monitori është < v7.1 dhe blloku nuk dërgohet.
Rregullat e plota → [SKILL.md §15.5](SKILL.md).

---

## 🔌 Lidhja me MCP

### Skenari 1: MT5

```yaml
# mcp_config.yaml
tools:
  time_now: "mt5_time_now"
  market_get_quote: "mt5_get_quote"
  market_get_candles: "mt5_get_candles"
  market_get_atr: "mt5_get_atr"
  market_get_spread: "mt5_get_spread"
  session_status: "mt5_session_status"
  register_alert: "mt5_alert_create"
server:
  endpoint: "stdio"
```

### Skenari 2: TradingView

```yaml
tools:
  market_get_candles: "tv.get_hist"
  market_get_quote: "tv.get_quote"
  market_get_atr: "tv.atr"
server:
  endpoint: "ws://localhost:8080"
  auth_token: "your_token"
```

### Skenari 3: Custom Broker

```yaml
tools:
  market_get_quote: "broker_api_quote"
  market_get_candles: "broker_api_candles"
  # ... sipas API broker-it
server:
  endpoint: "https://api.broker.com/mcp"
  auth_token: "your_api_key"
```

---

## 📡 Event-Driven Watch (Opsionale)

Nëse MCP yt ofron watch tools, aktivizon event-driven mode:

```python
# Subscribe te events — jo polling
conditions = [
    {"type": "liquidity.swept", "pool_id": "L1", "level": 4220.0},
    {"type": "mss.confirmed", "tf": "M5"},
    {"type": "trap.detected"},
]

# MCP dërgon event kur kushtet plotësohen
# 13 event types mbështetura (shih mcp_config.yaml)
```

Nëse MCP nuk ka watch → polling fallback automatik çdo 5 sekonda.

---

## 🛡️ Siguria

⛔ **Auto-register orders: OFF by default.**
- `auto_register_setups: false` — përdoruesi vendos manualisht
- `auto_register_alerts: true` — alerts janë të sigurt
- `max_daily_loss_pct: 5.0` — mbrojtje

⛔ **Disclaimer brenda SKILL.md:** Mjet analize, jo këshillë investimi. Risk-u mbetet i përdoruesit.

---

## 🎯 Output Shembull

```json
{
  "verdict": "A+ SETUP",
  "meta": {"session": "London", "kill_zone": "AKTIVE", "ny_et": "03:15"},
  "ilos_state": {"bias": "buy", "confidence": "HIGH", "thesis_integrity": "INTACT"},
  "trap_analysis": {"trap_identified": "YES", "trap_sub_type": "Type 1", "collection_grade": "A"},
  "execution": {
    "model": "ICT 2022",
    "entry": 4225.50,
    "stop_loss": 4217.00,
    "tp1": 4240.00,
    "tp2": 4260.00,
    "rr_tp1": 2.40,
    "rr_tp2": 5.65,
    "conviction": "A"
  }
}
```

---

## 📊 Burimi (28 fajlle të hybridizuara)

- MULTISNIPER07 v6.0
- LIQUIDITY INTELLIGENCE ENGINE v4.0
- ICT SNIPER v8 / v11 / v13 / v17
- V-TRAP1 (Trap-Centric)
- GEM 1 (HTF Mapper) + GEM 2 (LTF Execution Engine)
- BANK SETUP SNIPER v3.13
- Quantitative XAUUSD (microstructure research)
- + shumë të tjera

---

## 📞 Support

- **Issues:** Kontrollo që MCP yt ekspozon të paktën 3 tools kritike (`time.now`, `market.get_quote`, `market.get_candles`)
- **Test pa MCP real:** `python3 scripts/mcp_discovery.py --manual` pastaj përdor mock data
- **Verifikim:** `python3 scripts/mcp_normalize.py` teston normalizimin

---

**Version:** 7.1 (MCP-Aware)  
**Last update:** 2026-08-21  
**Gjuha:** Shqip (termat ICT në anglisht)  
**Licenca:** MIT
