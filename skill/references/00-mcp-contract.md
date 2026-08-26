# 00 · MCP CONTRACT — Kontrata e Plotë MCP (v7.2 — Skill-Context Aware)

Ky dokument specifikon **saktësisht** çfarë mjete MCP i duhen skill-it, dhe si të integrohet me **tools të çdo forme** (MT5, TradingView, broker proprietary, custom MCP).

---

## 0 · MIKROFILOZOFIA: TOOL DISCOVERY (PARIMI #0)

⛔ **MOS HARTON EMRA FIX.** MCP yt mund të ketë emra të ndryshëm nga default. 

**RREGULLI I ARTË:** Ekzekuto `scripts/mcp_discovery.py` për të zbuluar automatikisht tools e disponueshme. Pastaj përditëso `mcp_config.yaml` me emrat e saktë.

```bash
python3 scripts/mcp_discovery.py --manual
# ose
python3 scripts/mcp_discovery.py --endpoint ws://localhost:8765
```

---

## 1 · TOOL MAPPING & DISCOVERY

### 1.1 · Konfigurimi (mcp_config.yaml)

Shih `mcp_config.yaml` në root të skill-it. Ka 8 seksione:

1. **Tool Mapping** — Emrat e saktë të tools që ofron MCP yt
2. **Server Configuration** — Endpoint, auth, timeout
3. **Tool Discovery** — Aktivizo/çaktivizo zbulimin automatik
4. **Event-Driven Watch** — Subscribe te event types
5. **Registration** — Auto-register setups/alerts
6. **Instrument-Specific Overrides** — tick_size, lot size, etj. për çdo instrument
7. **Cache & Performance** — Koha e cache për çdo TF
8. **Notifications** — Kanalet ku dërgohen alerts

### 1.2 · Mjetet Kritike (pa të cilat skill-i NUK punon)

```
REQUIRED (skill refuzon nëse mungojnë):
  - time.now
  - market.get_quote
  - market.get_candles
```

### 1.3 · Mjetet e Rëndësishme (përdor fallback nëse mungojnë)

```
IMPORTANT (përdor fallback nëse mungojnë):
  - market.get_atr         → fallback: 15 pips XAUUSD M5
  - market.get_spread      → fallback: 0.0 ose vlera vizuale
  - session.status         → fallback: llogarit manualisht nga ora NY ET
  - session.get_range      → fallback: llogarit nga candles
```

### 1.4 · Mjetet Opsionale

```
OPTIONAL (pa to, thjesht humbasim features):
  - time.convert
  - session.list_sessions
  - calendar.upcoming
```

### 1.5 · Watch Tools (Event-Driven)

```
WATCH (nëse MCP ka, aktivizon event-driven mode):
  - watch.register
  - watch.unregister
  - watch.list
  - watch.poll (fallback polling)
  - trap.watch.start
  - trap.watch.stop
  - trap.watch.status
```

### 1.6 · Register Tools (Order/Alert Management)

```
REGISTER (nëse MCP ka, aktivizon position management):
  - register.order
  - register.position
  - register.alert
```

### 1.7 · Skill Context (Dorëzimi i konfirmimeve para touch-it)

```
SKILL CONTEXT (Watch Monitor MCP v7.1+):
  - watch.register pranon argumentin `skill_context`
  - skill_context.audit  (get_skill_context_audit)
```

Ky nuk është mjet më vete por një **argument** te `watch.register`
(`register_watch`). Ai bart konfirmimet që skill-i i ka bërë **para** se çmimi
të kthehet në zonë, në mënyrë që monitori të mos i ri-nxjerrë nga e para.

**Zbulimi është i detyrueshëm, jo opsional.** Fushat lexohen nga `inputSchema`
që MCP-ja kthen te `tools/list` — jo nga supozimi:

```bash
python3 scripts/mcp_discovery.py --endpoint <url>
# → 🧠 SKILL CONTEXT: ✅ register_watch pranon skill_context — 18 fusha
# → ⛔ ...NUK pranon...  (monitor < v7.1 → mos dërgo asgjë)
# → ❔ ...skema nuk u lexua dot (manual mode)
```

Tre gjendjet dhe çfarë do të thonë:

| Raporti | Kuptimi | Veprimi i skill-it |
|---|---|---|
| `supported` | fushat janë në skemë | dërgo `skill_context` |
| `unsupported` | monitor i vjetër (< v7.1) | **mos e dërgo** — do të refuzohej |
| `unknown` | skema nuk u lexua (manual mode) | mos e dërgo derisa ta verifikosh |

Mungesa e skemës **nuk** do të thotë mungesë mbështetjeje — prandaj `unknown`
është gjendje më vete dhe jo `unsupported`.

Kontrata e plotë e fushave, kufijtë dhe si i përdor monitori →
[SKILL.md §15.5](../SKILL.md) dhe `docs/skill-context.md` te repo-ja e monitorit.

### 1.8 · Setup Lifecycle (v7.2+)

```
SETUP LIFECYCLE (Watch Monitor MCP v7.2+):
  - watch.register pranon: potential_trade_sl / thesis_invalidation,
                           defence_profile, urgency, max_entry_deviation,
                           confirmation_deadline_minutes,
                           entry_monitoring_window_minutes
  - watch.trail  (get_setup_trail)
```

Zbulimi vlen njësoj si te §1.7: fushat lexohen nga `inputSchema`, dhe nëse
`defence_profile` nuk është aty, monitori është < v7.2 — atëherë **mos i
dërgo** fushat e reja dhe sillu si më parë.

Dy gjëra që ndryshojnë sjelljen e monitorit dhe që duhet t'i di përpara se
të regjistroj një setup:

1. **`potential_trade_sl` ≠ `thesis_invalidation`.** Para hyrjes, prekja e
   stop-it **nuk** e vret setup-in — hap degën Anti-SL. Vetëm një
   `thesis_invalidation` i deklaruar dhe i thyer e vret menjëherë. Nëse
   dërgoj vetëm një numër, monitori e lexon si stop.
2. **`ENTRY_MISSED` është gjendje më vete.** Çmimi që shkon në TP1 pa hyrje,
   ose një konfirmim që vjen shumë larg entry-t, e mbyllin mundësinë pa e
   quajtur setup-in të gabuar — dhe pa e ndjekur çmimin.

Kontrata e plotë → [SKILL.md §15.6](../SKILL.md) dhe
`docs/setup-lifecycle.md` te repo-ja e monitorit.

---

## 2 · EVENT-DRIVEN WATCH (Pattern i Ri)

### 2.1 · Koncepti

Në vend që të polling-ojmë MCP çdo 5 sekonda, MCP me watch tools mund të dërgojë **events kur kushtet plotësohen**.

**Event types që dëgjojmë:**

| Event | Kur ndodh |
|-------|-----------|
| `trap.detected` | Kur një trap institucional konfirmohet |
| `trap.completed` | Kur manipulation + collection + MSS përfundojnë |
| `liquidity.swept` | Kur një pool BSL/SSL swept |
| `mss.confirmed` | Kur MSS me displacement konfirmohet |
| `fvg.formed` | Kur FVG krijohet nga displacement |
| `session.changed` | Kur sesioni ndryshon (Asia → London, etj.) |
| `kill_zone.entered` | Kur hyjmë në Kill Zone |
| `kill_zone.exited` | Kur dalim nga Kill Zone |
| `macro.entered` | Kur fillon macro window |
| `news.upcoming` | Kur ka news event në horizon |
| `price.reached` | Kur çmimi arrin nivel specifik |
| `time_distortion.start` | Kur fillon Time Distortion |
| `time_distortion.end` | Kur mbaron Time Distortion |

### 2.2 · Si përdoret

```python
from trap_watch import TrapWatcher, TrapCondition
import asyncio

# Load config
import yaml
with open("mcp_config.yaml") as f:
    config = yaml.safe_load(f)

# Create watcher
watcher = TrapWatcher(config, mcp_client=mcp_client)

# Define conditions
conditions = [
    TrapCondition(type="liquidity.swept", pool_id="L1", level=4220.0),
    TrapCondition(type="mss.confirmed", tf="M5"),
    TrapCondition(type="fvg.formed"),
    TrapCondition(type="trap.detected"),
]

# Start watching
watch_id = await watcher.start_watching("XAUUSD", conditions, timeout_sec=3600)

# Stream events
async for event in watcher.stream_events():
    if event.is_trap_event:
        print(f"🚨 TRAP: {event.type} → {event.data}")
        # Trigger analysis
        ...
    elif event.is_setup_event:
        print(f"📊 SETUP: {event.type} → {event.data}")
```

### 2.3 · Fallback Polling

Nëse MCP nuk ka watch tools → `trap_watch.py` kalon automatikisht në polling mode çdo 5 sekonda. Polling përdor `market.get_quote` për të kontrolluar nëse kushtet e `price.reached` janë plotësuar.

---

## 3 · REGISTER TOOLS (Position/Alert Management)

### 3.1 · Alert Registration

Nëse MCP ka `register.alert`, skill-i mund të regjistrojë alerts automatikisht:

```python
# Auto-register alert për çdo BSL/SSL me LPS >= 65
alerts = []
for pool in liquidity_registry:
    if pool.lps >= 65 and pool.status == "UNTOUCHED":
        result = await mcp_client.call_tool(
            "register.alert",
            {
                "symbol": "XAUUSD",
                "level": pool.level,
                "side": pool.side,
                "condition": "price_reaches",
                "metadata": {"pool_id": pool.id, "lps": pool.lps}
            }
        )
        alerts.append(result["alert_id"])
```

### 3.2 · Order Registration (Opsionale, OFF by Default)

⛔ **Default i sigurt: OFF.** Aktivizo vetëm nëse përdoruesi e konfirmon.

```yaml
# mcp_config.yaml
registration:
  auto_register_setups: false   # ⛔ MBANI OFF
  auto_register_alerts: true    # ✅ alerts janë të sigurt
  register_on_conviction:
    - "A"                        # vetëm A+ setups
  risk_per_trade_pct: 1.0
  max_positions: 3
  max_daily_loss_pct: 5.0
```

**Arsyeja OFF:** Analiza ICT/SMC ka risk të lartë gabimi. Auto-register pa konfirmim njeriu = rrezik humbjeje kapitali.

---

## 4 · KONTRATA E TOOLS (Skenarët e Përdorimit)

### 4.1 · Time Tools

#### `time.now(tz: str) -> dict`
Kthen orën aktuale në timezone-n e dhënë.

**Input:** `{"tz": "America/New_York"}`

**Output:** `{"utc": "...", "local": "...", "tz": "..."}`

#### `time.convert(time_iso: str, from_tz: str, to_tz: str) -> dict`
Konverton kohë.

### 4.2 · Market Data Tools

#### `market.get_quote(symbol: str) -> dict`
Kthen çmimin aktual (bid/ask/last).

#### `market.get_candles(symbol: str, tf: str, count: int, include_live: bool = false) -> list[dict]`
Kthen qirinjt historikë OHLCV.

**Timeframe values:** `"M1" | "M5" | "M15" | "H1" | "H4" | "D1" | "W1" | "MN"`

#### `market.get_atr(symbol: str, tf: str, period: int = 14) -> dict`
Kthen ATR aktual.

#### `market.get_spread(symbol: str) -> float`
Kthen spread-in aktual.

### 4.3 · Session Tools

#### `session.status(symbol: str, now_et: str) -> dict`
Kthen statusin e sesionit aktiv.

**Output:** `{"session": "...", "kill_zone": "AKTIVE|INAKTIVE", "kill_zone_name": "...", "in_macro_window": true, "macro_name": "...", "is_time_distortion": true, "is_ny_lunch": false}`

#### `session.get_range(symbol: str, session_name: str, date: str) -> dict`
Kthen High/Low të sesionit.

#### `session.list_sessions() -> list[str]`
Kthen listën e sesioneve.

### 4.4 · Calendar Tools

#### `calendar.upcoming(symbol: str, lookahead_h: int) -> list[dict]`
Kthen ngjarjet makro të ardhshme.

### 4.5 · Watch Tools (Opsionale)

#### `watch.register(symbol: str, event_types: list[str], callback: str) -> dict`
Regjistron watch për event types të caktuara.

**Output:** `{"watch_id": "watch-12345", "status": "active"}`

#### `watch.unregister(watch_id: str) -> dict`
Ndërpret watch-in.

#### `watch.list() -> list[dict]`
Kthen watches aktive.

#### `watch.poll(watch_id: str, max_events: int) -> list[dict]`
Merr events të rejat (fallback kur s'punon streaming).

#### `trap.watch.start(symbol: str, conditions: list[dict]) -> dict`
Specifik për trap detection.

#### `trap.watch.stop(watch_id: str) -> dict`

#### `trap.watch.status(watch_id: str) -> dict`

### 4.6 · Register Tools (Opsionale)

#### `register.alert(symbol: str, level: float, condition: str, metadata: dict) -> dict`
Regjistron price alert.

**Output:** `{"alert_id": "alert-12345"}`

#### `register.order(symbol: str, side: str, qty: float, sl: float, tp: float) -> dict`
Vendos order.

**Output:** `{"order_id": "order-12345", "status": "pending"}`

#### `register.position(symbol: str, side: str, qty: float, entry: float) -> dict`
Hap pozicion.

---

## 5 · FALLBACK & DEGRADATION

Nëse ndonjë mjet MCP nuk disponohet:

| Mungon | Veprim | Risk |
|--------|--------|------|
| `time.now` | Ndalo — ky mjet është kritik | ⛔ KRITIK |
| `market.get_quote` | Ndalo — pa çmim nuk ka analizë | ⛔ KRITIK |
| `market.get_candles` | Ndalo — pa të dhëna nuk ka strukturë | ⛔ KRITIK |
| `market.get_atr` | Përdor fixed fallback: 15 pips XAUUSD M5 | ⚠️ Mesatar |
| `market.get_spread` | Përdor visual nga MT5 ose 0.0 | ⚠️ Mesatar |
| `session.status` | Llogarit manualisht nga ora NY ET | ⚠️ Mesatar |
| `session.get_range` | Llogarit manualisht nga candles | ⚠️ Mesatar |
| `calendar.upcoming` | Hiq nga output, shëno në warnings | 🟢 I ulët |
| `watch.*` | Kalo në polling fallback | 🟢 I ulët |
| `trap.watch.*` | Kalo në polling fallback | 🟢 I ulët |
| `register.alert` | Hiq alerts, përdor vetëm console | 🟢 I ulët |
| `register.order` | ⛔ Mos aktivizo auto-register | ⛔ Siguri |

---

## 6 · TOOL NAME RESOLUTION (Mënyra e Zgjidhjes)

Kur skill-i thërret një tool, e kalon nëpër këtë pipeline:

```
1. Lexo mcp_config.yaml
2. Kontrollo a ka "tools.<canonical_name>" të vendosur
3. Nëse PO → përdor atë emër
4. Nëse JO (bosh) → përdor emrin canonical default
5. Nëse asnjëra nuk punon → fallback sipas seksionit 5
```

Shembull:
```python
def resolve_tool_name(canonical: str) -> str:
    config = load_config("mcp_config.yaml")
    configured = config.get("tools", {}).get(canonical, "")
    if configured:
        return configured
    return canonical

# Përdorim
tool_name = resolve_tool_name("market.get_quote")
result = await mcp_client.call_tool(tool_name, {"symbol": "XAUUSD"})
```

---

## 7 · MCP SERVER IMPLEMENTATION EXAMPLES

### 7.1 · MT5 (Python)

```python
from mcp.server import Server
import MetaTrader5 as mt5
from datetime import datetime, timezone

server = Server("mt5-trading")

@server.tool()
def time_now(tz: str = "America/New_York") -> dict:
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo(tz))
    return {"utc": datetime.now(timezone.utc).isoformat(), "local": now.isoformat(), "tz": tz}

@server.tool()
def market_get_quote(symbol: str) -> dict:
    tick = mt5.symbol_info_tick(symbol)
    return {"symbol": symbol, "bid": tick.bid, "ask": tick.ask, "spread_points": tick.ask - tick.bid, "last": tick.last, "timestamp_utc": datetime.now(timezone.utc).isoformat()}

@server.tool()
def market_get_candles(symbol: str, tf: str, count: int, include_live: bool = False) -> list:
    tf_map = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4, "D1": mt5.TIMEFRAME_D1}
    rates = mt5.copy_rates_from_pos(symbol, tf_map[tf], 0, count)
    return [{"time_utc": datetime.fromtimestamp(r[0], timezone.utc).isoformat(), "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]} for r in rates]

@server.tool()
def register_alert(symbol: str, level: float, condition: str, metadata: dict = None) -> dict:
    """Regjistron price alert në MT5."""
    # Implementimi me MT5 orders
    return {"alert_id": f"alert-{datetime.now().timestamp()}", "status": "active"}

@server.tool()
async def watch_register(symbol: str, event_types: list, callback: str) -> dict:
    """Regjistron watch (event-driven) për event types."""
    # Implementimi me asyncio + MT5 streaming
    watch_id = f"watch-{datetime.now().timestamp()}"
    # ... start streaming task
    return {"watch_id": watch_id, "status": "active"}
```

### 7.2 · TradingView (via tvdatafeed)

```python
@server.tool()
def market_get_candles(symbol: str, tf: str, count: int, include_live: bool = False) -> list:
    from tvdatafeed import TvDatafeed, Interval
    tv = TvDatafeed()
    tf_map = {"M1": Interval.in_1_minute, "M5": Interval.in_5_minute, "H1": Interval.in_1_hour, "H4": Interval.in_4_hour, "D1": Interval.in_daily}
    df = tv.get_hist(symbol, "OANDA", tf_map[tf], bars=count)
    return df.reset_index().to_dict('records')
```

### 7.3 · Custom Broker

```python
# Përputhshmëri me broker proprietary
@server.tool()
def market_get_quote(symbol: str) -> dict:
    # Thirrja REST API e broker-it
    response = requests.get(f"{BROKER_URL}/quote/{symbol}", headers={"Authorization": f"Bearer {BROKER_TOKEN}"})
    return response.json()
```

---

## 8 · CACHING & PERFORMANCE

- **Candles cache:** Ruaj sipas TF (paracaktime në `mcp_config.yaml`).
- **Quote cache:** Maksimum 1 sekondë.
- **ATR cache:** Ri-llogarit çdo 5 minuta për M5.

---

## 9 · TESTING PA MCP REAL (Mock Mode)

Për të testuar skill-in pa MCP real, përdor `mcp_discovery.py --manual` dhe listo tools të rreme. Pastaj përdor `mcp_normalize.py` me të dhëna të paracaktuara.

```python
# mock_mcp.py
MOCK_CANDLES = {
    "XAUUSD_H4": [...100 qirinj të paracaktuar...]
}
```

---

## 10 · WIZARD I SHPEJTË

```bash
# 1. Zbulo tools të MCP yt
python3 scripts/mcp_discovery.py --manual

# 2. Përditëso mcp_config.yaml me emrat e saktë

# 3. Test discovery
python3 scripts/mcp_discovery.py --config mcp_config.yaml

# 4. Test trap watch (offline)
python3 scripts/trap_watch.py

# 5. Fillo analizën
# "Përdor skill-in ict-sniper-liquidity-engine për XAUUSD"
```

---

## 11 · SESSION NAMING CONVENTIONS

Për të mos pasur konflikte me emra të tjerë MCP, sugjerojmë prefix:

| Server | Prefix | Shembull |
|--------|--------|----------|
| MT5 | `mt5_` ose `mt5.` | `mt5_get_quote` |
| TradingView | `tv_` ose `tv.` | `tv.get_candles` |
| Broker proprietary | sipas dëshirës | `bcr_get_quote` |
| Mock/test | `mock_` | `mock_get_quote` |

**Rekomandim:** Përdor prefix të qartë për të shmangur konflikte kur ke shumë MCP servers njëkohësisht.
