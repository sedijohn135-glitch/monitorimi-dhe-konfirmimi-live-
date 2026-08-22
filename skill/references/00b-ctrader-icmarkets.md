# 00b · cTrader + ICMarkets + Railway — Setup Specifik (v7.1 Final)

Ky dokument është për përdoruesit që kanë MCP-në e tyre të deployuar në **Railway** me **CTrader Watch Monitor MCP** (14 tools) që lidhet me llogarinë **ICMarkets** në cTrader.

---

## 1 · 14 TOOLS TË DISPONUESHME (nga screenshots)

CTrader Watch Monitor MCP ofron **14 actions** specifike me naming convention **snake_case**:

### 1.1 · Market Data (4 tools)

| Tool | Qëllimi | Kur përdoret |
|------|---------|--------------|
| `get_symbols` | Merr listën e simboleve të disponueshme | Hapi 1 — Setup |
| `get_spot_prices` | Çmimi aktual bid/ask/last | Çdo analizë |
| `get_trendbars` | Qirinj historikë (cTrader term) | Çdo analizë |
| `get_version` | Versioni i MCP server-it | Diagnostikë |

### 1.2 · Watch / Event-Driven (4 tools)

| Tool | Qëllimi | Kur përdoret |
|------|---------|--------------|
| `register_watch` | Regjistron watch për event types | Kur MCP ka streaming |
| `register_trap_watch` | **Regjistron trap watch specifik** | ⭐ Kursti kryesor |
| `list_watches` | Liston watches aktive | Menaxhim |
| `cancel_watch` | Anulon watch specifik | Cleanup |

### 1.3 · Calendar & News (3 tools)

| Tool | Qëllimi | Kur përdoret |
|------|---------|--------------|
| `get_news_calendar` | Ngjarjet makro të ardhshme | Pre-trade check |
| `set_news_lockout` | **Aktivizon news block** | Para high-impact news |
| `clear_news_lockout` | Heq news block | Pas news-it |

### 1.4 · Auto-Trade Management (3 tools)

| Tool | Qëllimi | Kur përdoret |
|------|---------|--------------|
| `get_auto_trade_status` | Statusi aktual i auto-trade | Monitorim |
| `pause_auto_trade` | **Ndërpret auto-trade** | Kill switch |
| `resume_auto_trade` | Rikthen auto-trade | Pas pause |

---

## 2 · ARKITEKTURA

```
┌──────────────────────────────────────────────────────────────┐
│  Railway (Cloud Deployment)                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │  CTrader Watch Monitor MCP (Python)                │    │
│  │                                                    │    │
│  │  14 tools sipas screenshots:                       │    │
│  │  Market: get_symbols, get_spot_prices,             │    │
│  │          get_trendbars, get_version                │    │
│  │  Watch:  register_watch, register_trap_watch,     │    │
│  │          list_watches, cancel_watch                │    │
│  │  News:   get_news_calendar, set_news_lockout,     │    │
│  │          clear_news_lockout                        │    │
│  │  Auto:   get_auto_trade_status, pause_auto_trade, │    │
│  │          resume_auto_trade                         │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                            ↕
                  cTrader Open API
                  (gRPC + Protobuf)
                            ↕
┌──────────────────────────────────────────────────────────────┐
│  ICMarkets cTrader Server                                    │
│  - Account ID: <your_account_id>                            │
│  - Broker: ICMarkets                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## 3 · TOOL MAPPING (vendosur në mcp_config.yaml)

Ja si i ka vendosur skill-i emrat:

```yaml
tools:
  # Market data
  market_get_quote: "get_spot_prices"        # CTrader: get_spot_prices
  market_get_candles: "get_trendbars"        # CTrader: get_trendbars
  market_get_symbols: "get_symbols"         # CTrader: get_symbols

  # Watch / Event-driven
  watch_register: "register_watch"          # CTrader: register_watch
  watch_unregister: "cancel_watch"          # CTrader: cancel_watch
  watch_list: "list_watches"                # CTrader: list_watches
  trap_watch_register: "register_trap_watch"  # CTrader: register_trap_watch

  # News / Calendar
  calendar_upcoming: "get_news_calendar"    # CTrader: get_news_calendar
  news_lockout_set: "set_news_lockout"      # CTrader: set_news_lockout
  news_lockout_clear: "clear_news_lockout"  # CTrader: clear_news_lockout

  # Auto-trade
  auto_trade_status: "get_auto_trade_status"
  auto_trade_pause: "pause_auto_trade"
  auto_trade_resume: "resume_auto_trade"

  # Utility
  get_version: "get_version"
```

---

## 4 · RAILWAY ENVIRONMENT VARIABLES

```bash
# cTrader Authentication
CTRADER_CLIENT_ID=your_ctrader_app_client_id
CTRADER_CLIENT_SECRET=your_ctrader_app_client_secret
CTRADER_ACCESS_TOKEN=your_long_lived_access_token

# cTrader Account
CTRADER_ACCOUNT_ID=12345678
CTRADER_HOST=live.ctraderapi.com:5035
CTRADER_ENV=live

# MCP Transport
MCP_TRANSPORT=sse
MCP_PORT=8080
MCP_HOST=0.0.0.0
```

---

## 5 · TOOL USAGE EXAMPLES (Python)

### 5.1 · Trap Watch (Kryesori)

```python
from trap_watch import CTraderTrapWatcher, TrapCondition

watcher = CTraderTrapWatcher(mcp_client, config)

# Regjistron trap watch që dërgon events kur kushtet plotësohen
watch_id = await watcher.register_trap_watch(
    "XAUUSD",
    conditions=[
        TrapCondition(type="liquidity.swept", pool_id="L1", level=4220.0),
        TrapCondition(type="mss.confirmed", tf="M5"),
        TrapCondition(type="fvg.formed"),
        TrapCondition(type="trap.detected"),
    ],
)
print(f"Trap watch: {watch_id}")

# Liston watches aktive
watches = await watcher.list_watches(symbol="XAUUSD")
for w in watches:
    print(f"  {w['watch_id']}: {w['symbol']}")

# Anulon kur mbarojmë
await watcher.cancel_watch(watch_id)
```

### 5.2 · News Lockout (i ri)

```python
from trap_watch import NewsLockoutManager

news = NewsLockoutManager(mcp_client, config)

# Kontrollon nëse duhet news lockout
should_lock, event, minutes = await news.should_lockout("XAUUSD", lookahead_hours=4)
if should_lock:
    print(f"News lockout needed: {event} in {minutes} min")

# Menaxhim automatik
result = await news.auto_manage_lockout("XAUUSD")
print(f"News lockout: {result['action']}")

# Manual lockout
await news.lockout_news("XAUUSD", reason="NFP upcoming", duration_minutes=30)

# Pastaj clear
await news.clear_lockout("XAUUSD")
```

### 5.3 · Auto-Trade Management (Kill Switch)

```python
from trap_watch import AutoTradeManager

auto = AutoTradeManager(mcp_client, config)

# Merr statusin
status = await auto.get_status()
print(f"Active: {status.get('is_active')}")
print(f"Open positions: {status.get('open_positions')}")

# Vlerëson kill switch
kill_result = await auto.evaluate_kill_switch({
    "daily_loss_pct": 1.5,
    "open_positions": 2,
    "max_positions": 3,
    "news_lockout_active": False,
    "kill_zone_active": True,
})
if kill_result["triggered"]:
    print(f"PAUSED: {kill_result['reasons']}")

# Manual pause / resume
await auto.pause(reason="manual", duration_minutes=60)
# ... pas 60 min
await auto.resume()
```

### 5.4 · Market Data

```python
# Get spot prices
spot = await watcher.get_current_price("XAUUSD")
print(f"Bid: {spot['bid']}, Ask: {spot['ask']}")

# Get trendbars (candles)
candles = await watcher.get_trendbars("XAUUSD", "H4", count=100)
print(f"Got {len(candles)} H4 candles")
```

---

## 6 · NEWS LOCKOUT FLOW (i plotë)

```
┌─────────────────────────────────────────────────────┐
│  1. Pre-trade check                                 │
│     ↓ get_news_calendar("XAUUSD", 4)                │
│     ↓ Kontrollo events brenda 4 orëve               │
│     ↓ Nëse high-impact → set_news_lockout()         │
│                                                     │
│  2. Trade execution                                 │
│     ↓ Kontrollo lockout status                      │
│     ↓ Nëse locked → SKIP TRADE                      │
│     ↓ Nëse clear → proceed                          │
│                                                     │
│  3. Pas news-it                                     │
│     ↓ get_news_calendar() tregon event i kaluar     │
│     ↓ clear_news_lockout()                          │
│     ↓ Resume normal trading                         │
└─────────────────────────────────────────────────────┘
```

**Konfigurimi i rekomanduar:**

```yaml
news_lockout:
  enabled: true
  block_on_impact: ["high"]      # Vetëm high-impact
  pre_news_block_minutes: 5       # 5 min para news
  post_news_block_minutes: 15     # 15 min pas news
  affected_symbols: ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"]
  auto_clear: true                # Auto-clear pas news-it
```

---

## 7 · AUTO-TRADE KILL SWITCH

```yaml
kill_switch:
  enabled: true
  triggers:
    daily_loss_exceeded: 5.0      # 5% e account
    max_positions_reached: true
    news_lockout_active: true     # Ndërprit gjatë news
    kill_zone_inactive: true      # Ndërprit jashtë Kill Zone
  auto_pause: true                # Auto-pause kur trigger aktivizohet
  auto_resume: false              # Manual resume (për siguri)
```

**Kur trigger aktivizohet:**
1. `pause_auto_trade` thirret automatikisht
2. Arsyeja regjistrohet në logs
3. Notification dërgohet
4. Manual resume nevojitet nga përdoruesi

---

## 8 · RAILWAY DEPLOYMENT

### 8.1 · Files të gatshme

- `railway.json` — deployment config
- `Dockerfile` — container image
- `requirements.txt` — Python deps

### 8.2 · Deploy

```bash
railway login
railway init
railway variables set CTRADER_CLIENT_ID=xxx ...
railway up
```

### 8.3 · Verify

```bash
# Test discovery
python3 scripts/mcp_discovery.py --endpoint https://your-app.up.railway.app

# Test trap watch
python3 scripts/trap_watch.py

# Test discovery with all 14 tools
python3 scripts/mcp_discovery.py --manual <<EOF
get_symbols
get_spot_prices
get_trendbars
get_version
register_watch
register_trap_watch
list_watches
cancel_watch
get_news_calendar
set_news_lockout
clear_news_lockout
get_auto_trade_status
pause_auto_trade
resume_auto_trade
done
EOF
```

---

## 9 · TEST I INTEGRIMIT (Offline)

```bash
# Teston të gjitha 14 tools pa MCP real
python3 scripts/trap_watch.py
```

Output-i i pritur:
```
1️⃣  Trap Watch
  → watch_id: watch-1234.56
2️⃣  List Watches
  → 1 active watches
3️⃣  News Lockout
  → should_lock: False
  → {'action': 'no_change', 'is_locked': False}
4️⃣  Auto-Trade
  → status: {'is_active': True, 'open_positions': 0}
5️⃣  Trap Evaluation
  → trapped: True, grade: A
```

---

## 10 · TROUBLESHOOTING

| Problem | Zgjidhja |
|---------|----------|
| `PERMISSION_DENIED` | Kontrollo që access_token ka leje për account_id |
| `SYMBOL_NOT_FOUND` | Thirr `get_symbols` për të parë simbolet e disponueshme |
| `WATCH_NOT_FOUND` | `list_watches` për të parë watches aktive |
| `NEWS_LOCKOUT_FAILED` | Provo manual `clear_news_lockout` pastaj `set_news_lockout` |
| `AUTO_TRADE_ALREADY_PAUSED` | Kontrollo `get_auto_trade_status` para `resume_auto_trade` |
| Railway deploy failure | `railway logs --tail` |

---

## 11 · PËRFUNDIM

Me këtë setup, MCP yt ofron **14 tools** të dedikuara:
- 📊 **4 Market Data** — quote, candles, symbols
- 📡 **4 Watch/Event** — register/list/cancel watches
- 📰 **3 News** — calendar, lockout set/clear
- 🤖 **3 Auto-Trade** — status, pause, resume

Skill-i tani është **plotësisht i lidhur** me infrastrukturën tënde Railway + CTrader + ICMarkets. Përditëso `mcp_config.yaml` me `ctrader_id`-të e sakta, vendos env variables në Railway, dhe fillo:

> **"Përdor skill-in ict-sniper-liquidity-engine për XAUUSD"**
