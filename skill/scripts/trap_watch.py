#!/usr/bin/env python3
"""
trap_watch.py — Event-driven trap monitoring për CTrader Watch Monitor MCP.

Tools të përdorura (nga screenshots):
  - register_trap_watch      — Regjistron trap watch
  - register_watch            — Regjistron watch për event types
  - list_watches              — Liston watches aktive
  - cancel_watch              — Anulon watch
  - get_spot_prices           — Merr çmim aktual
  - get_trendbars             — Merr qirinj historikë
  - get_news_calendar         — Merr ngjarje makro
  - set_news_lockout          — Aktivizon news block
  - clear_news_lockout        — Heq news block
  - get_auto_trade_status     — Statusi i auto-trade
  - pause_auto_trade          — Ndërpret auto-trade
  - resume_auto_trade         — Rikthen auto-trade

Përdorim:
    from trap_watch import CTraderTrapWatcher, TrapCondition, NewsLockoutManager
    watcher = CTraderTrapWatcher(mcp_client, config)
    await watcher.start_trap_watch("XAUUSD", conditions=[...])
"""

from __future__ import annotations
import json
import time
import asyncio
import logging
from typing import Any, Callable
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime, timezone


logger = logging.getLogger("trap_watch")


# ============================================================
# Enums & Data Classes
# ============================================================

class EventType(str, Enum):
    """Event types që mbështeten nga CTrader MCP."""
    TRAP_DETECTED = "trap.detected"
    TRAP_COMPLETED = "trap.completed"
    LIQUIDITY_SWEPT = "liquidity.swept"
    MSS_CONFIRMED = "mss.confirmed"
    FVG_FORMED = "fvg.formed"
    SESSION_CHANGED = "session.changed"
    KILL_ZONE_ENTERED = "kill_zone.entered"
    KILL_ZONE_EXITED = "kill_zone.exited"
    MACRO_ENTERED = "macro.entered"
    NEWS_UPCOMING = "news.upcoming"
    PRICE_REACHED = "price.reached"
    TIME_DISTORTION_START = "time_distortion.start"
    TIME_DISTORTION_END = "time_distortion.end"


@dataclass
class TrapCondition:
    """Kusht për të aktivizuar trap watch."""
    type: str  # EventType value
    pool_id: str | None = None
    tf: str | None = None
    level: float | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class WatchEvent:
    """Event i marrë nga MCP."""
    type: str
    symbol: str
    timestamp_utc: str
    data: dict
    raw: dict = field(default_factory=dict)

    @property
    def is_trap_event(self) -> bool:
        return self.type in (EventType.TRAP_DETECTED.value, EventType.TRAP_COMPLETED.value)

    @property
    def is_setup_event(self) -> bool:
        return self.type in (
            EventType.LIQUIDITY_SWEPT.value,
            EventType.MSS_CONFIRMED.value,
            EventType.FVG_FORMED.value,
        )


@dataclass
class TrapState:
    """State i një trap detection në progres."""
    symbol: str
    conditions: list[TrapCondition]
    events_received: list[WatchEvent] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    is_trapped: bool = False
    trap_type: str | None = None
    collection_grade: str | None = None


@dataclass
class NewsEvent:
    """Ngjarje makro nga calendar."""
    name: str
    time_utc: str
    impact: str  # "high" | "medium" | "low"
    affected_symbols: list[str]
    minutes_until: float = 0.0


# ============================================================
# CTrader Trap Watcher
# ============================================================

class CTraderTrapWatcher:
    """
    Trap watcher i optimizuar për CTrader Watch Monitor MCP.

    Pattern:
    1. register_trap_watch() — MCP dërgon events kur kushtet plotësohen
    2. list_watches() — kontrollo watches aktive
    3. cancel_watch() — ndërprit kur mbarojmë
    """

    def __init__(self, mcp_client: Any, config: dict):
        """
        Args:
            mcp_client: MCP client instance (duhet të ketë call_tool method)
            config: Loaded mcp_config.yaml content
        """
        self.mcp = mcp_client
        self.config = config

        # Tool name resolution (nga config)
        tools_map = config.get("tools", {})
        aliases = config.get("aliases", {})

        self.tool_register_trap_watch = self._resolve("trap_watch_register", "register_trap_watch", aliases)
        self.tool_register_watch = self._resolve("watch_register", "register_watch", aliases)
        self.tool_list_watches = self._resolve("watch_list", "list_watches", aliases)
        self.tool_cancel_watch = self._resolve("watch_unregister", "cancel_watch", aliases)
        self.tool_get_spot = self._resolve("market_get_quote", "get_spot_prices", aliases)
        self.tool_get_trendbars = self._resolve("market_get_candles", "get_trendbars", aliases)

        self.active_watches: dict[str, dict] = {}
        self.is_watching = False

    def _resolve(self, config_key: str, default: str, aliases: dict) -> str:
        """Resolve tool name nga config ose aliases."""
        tools_map = self.config.get("tools", {})
        configured = tools_map.get(config_key, "")
        if configured:
            return configured
        return default

    async def register_trap_watch(
        self,
        symbol: str,
        conditions: list[TrapCondition],
        metadata: dict = None,
    ) -> str | None:
        """
        Regjistron trap watch në CTrader MCP.

        Returns:
            watch_id nëse u krijua me sukses, None nëse dështoi
        """
        # Konverto conditions në formatin që pret CTrader MCP
        ctrader_conditions = []
        for cond in conditions:
            c = {"type": cond.type}
            if cond.pool_id:
                c["pool_id"] = cond.pool_id
            if cond.tf:
                c["timeframe"] = cond.tf
            if cond.level is not None:
                c["level"] = cond.level
            if cond.metadata:
                c["metadata"] = cond.metadata
            ctrader_conditions.append(c)

        params = {
            "symbol": symbol,
            "conditions": ctrader_conditions,
        }
        if metadata:
            params["metadata"] = metadata

        try:
            result = await self.mcp.call_tool(
                self.tool_register_trap_watch,
                params,
            )
            if result and "watch_id" in result:
                watch_id = result["watch_id"]
                self.active_watches[watch_id] = {
                    "symbol": symbol,
                    "conditions": conditions,
                    "registered_at": datetime.now(timezone.utc).isoformat(),
                }
                logger.info(f"Trap watch registered: {watch_id} for {symbol}")
                return watch_id
        except Exception as e:
            logger.error(f"register_trap_watch failed: {e}")

        return None

    async def register_event_watch(
        self,
        symbol: str,
        event_types: list[str],
        callback_url: str | None = None,
    ) -> str | None:
        """
        Regjistron watch për event types specifike.
        """
        params = {
            "symbol": symbol,
            "event_types": event_types,
        }
        if callback_url:
            params["callback"] = callback_url

        try:
            result = await self.mcp.call_tool(
                self.tool_register_watch,
                params,
            )
            if result and "watch_id" in result:
                return result["watch_id"]
        except Exception as e:
            logger.error(f"register_watch failed: {e}")

        return None

    async def list_watches(self, symbol: str | None = None) -> list[dict]:
        """
        Liston watches aktive (ose vetëm për një simbol).
        """
        params = {}
        if symbol:
            params["symbol"] = symbol

        try:
            result = await self.mcp.call_tool(self.tool_list_watches, params)
            return result if isinstance(result, list) else result.get("watches", [])
        except Exception as e:
            logger.error(f"list_watches failed: {e}")
            return []

    async def cancel_watch(self, watch_id: str) -> bool:
        """
        Anulon një watch specifik.
        """
        try:
            result = await self.mcp.call_tool(
                self.tool_cancel_watch,
                {"watch_id": watch_id},
            )
            if watch_id in self.active_watches:
                del self.active_watches[watch_id]
            return result.get("success", True) if isinstance(result, dict) else bool(result)
        except Exception as e:
            logger.error(f"cancel_watch failed: {e}")
            return False

    async def cancel_all_watches(self) -> int:
        """
        Anulon të gjitha watches aktive. Kthe numrin e anuluar.
        """
        watches = await self.list_watches()
        cancelled = 0
        for w in watches:
            watch_id = w.get("watch_id") or w.get("id")
            if watch_id and await self.cancel_watch(watch_id):
                cancelled += 1
        return cancelled

    async def get_current_price(self, symbol: str) -> dict | None:
        """
        Merr çmimin aktual përmes get_spot_prices.
        """
        try:
            result = await self.mcp.call_tool(
                self.tool_get_spot,
                {"symbol": symbol},
            )
            if result:
                return result if isinstance(result, dict) else result[0] if result else None
        except Exception as e:
            logger.error(f"get_spot_prices failed: {e}")
        return None

    async def get_trendbars(
        self,
        symbol: str,
        timeframe: str,
        count: int = 100,
        include_live: bool = False,
    ) -> list[dict]:
        """
        Merr trendbars (qirinj) historikë.
        """
        try:
            result = await self.mcp.call_tool(
                self.tool_get_trendbars,
                {
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "count": count,
                    "include_live": include_live,
                },
            )
            if isinstance(result, list):
                return result
            return result.get("trendbars", []) if isinstance(result, dict) else []
        except Exception as e:
            logger.error(f"get_trendbars failed: {e}")
            return []


# ============================================================
# News Lockout Manager
# ============================================================

class NewsLockoutManager:
    """
    Menaxhon news lockout përmes set_news_lockout / clear_news_lockout.

    Pattern:
    1. set_news_lockout() — bllokon tregtinë gjatë lajmeve
    2. clear_news_lockout() — heq bllokun
    3. get_news_calendar() — kontrollon ngjarjet e ardhshme
    """

    def __init__(self, mcp_client: Any, config: dict):
        self.mcp = mcp_client
        self.config = config

        tools_map = config.get("tools", {})
        aliases = config.get("aliases", {})
        self.tool_set = tools_map.get("news_lockout_set", "set_news_lockout")
        self.tool_clear = tools_map.get("news_lockout_clear", "clear_news_lockout")
        self.tool_calendar = tools_map.get("calendar_upcoming", "get_news_calendar")

        self.lockout_config = config.get("news_lockout", {})
        self.is_locked = False

    async def get_upcoming_news(
        self,
        symbol: str,
        lookahead_hours: int = 4,
    ) -> list[NewsEvent]:
        """
        Merr ngjarjet e ardhshme nga news calendar.
        """
        try:
            result = await self.mcp.call_tool(
                self.tool_calendar,
                {"symbol": symbol, "lookahead_hours": lookahead_hours},
            )
            events = result if isinstance(result, list) else result.get("events", [])
            news_events = []
            for e in events:
                time_utc = e.get("time_utc", "")
                try:
                    dt = datetime.fromisoformat(time_utc.replace("Z", "+00:00"))
                    minutes_until = (dt - datetime.now(timezone.utc)).total_seconds() / 60
                except (ValueError, AttributeError):
                    minutes_until = 0

                news_events.append(NewsEvent(
                    name=e.get("name", "Unknown"),
                    time_utc=time_utc,
                    impact=e.get("impact", "low"),
                    affected_symbols=e.get("affected_symbols", [symbol]),
                    minutes_until=minutes_until,
                ))
            return news_events
        except Exception as e:
            logger.error(f"get_news_calendar failed: {e}")
            return []

    async def should_lockout(
        self,
        symbol: str,
        lookahead_hours: int = 4,
    ) -> tuple[bool, str | None, float]:
        """
        Kontrollon nëse duhet aktivizuar news lockout.

        Returns:
            (should_lock, event_name, minutes_until)
        """
        if not self.lockout_config.get("enabled", True):
            return (False, None, 0)

        events = await self.get_upcoming_news(symbol, lookahead_hours)
        block_impacts = self.lockout_config.get("block_on_impact", ["high"])
        pre_minutes = self.lockout_config.get("pre_news_block_minutes", 5)
        post_minutes = self.lockout_config.get("post_news_block_minutes", 15)

        for event in events:
            if event.impact not in block_impacts:
                continue
            if symbol not in event.affected_symbols and event.affected_symbols != [symbol]:
                continue
            # Kontrollo nëse jemi brenda window-it (pre ose post)
            if -post_minutes <= event.minutes_until <= pre_minutes:
                return (True, event.name, event.minutes_until)

        return (False, None, 0)

    async def lockout_news(
        self,
        symbol: str,
        reason: str = "news_lockout",
        duration_minutes: int = 30,
    ) -> bool:
        """
        Aktivizon news lockout.
        """
        if self.is_locked:
            return True

        try:
            result = await self.mcp.call_tool(
                self.tool_set,
                {
                    "symbol": symbol,
                    "reason": reason,
                    "duration_minutes": duration_minutes,
                },
            )
            self.is_locked = True
            logger.info(f"News lockout activated for {symbol}: {reason}")
            return bool(result)
        except Exception as e:
            logger.error(f"set_news_lockout failed: {e}")
            return False

    async def clear_lockout(self, symbol: str) -> bool:
        """
        Heq news lockout.
        """
        if not self.is_locked:
            return True

        try:
            result = await self.mcp.call_tool(
                self.tool_clear,
                {"symbol": symbol},
            )
            self.is_locked = False
            logger.info(f"News lockout cleared for {symbol}")
            return bool(result)
        except Exception as e:
            logger.error(f"clear_news_lockout failed: {e}")
            return False

    async def auto_manage_lockout(
        self,
        symbol: str,
        lookahead_hours: int = 4,
    ) -> dict:
        """
        Menaxhon automatikisht news lockout bazuar në calendar.

        Returns:
            Dict me statusin e lockout-it
        """
        should, event_name, minutes = await self.should_lockout(symbol, lookahead_hours)

        if should and not self.is_locked:
            duration = self.lockout_config.get("post_news_block_minutes", 15) + \
                      self.lockout_config.get("pre_news_block_minutes", 5)
            await self.lockout_news(symbol, f"auto: {event_name}", duration)
            return {
                "action": "lockout_activated",
                "event": event_name,
                "minutes_until": minutes,
            }
        elif not should and self.is_locked and self.lockout_config.get("auto_clear", True):
            await self.clear_lockout(symbol)
            return {
                "action": "lockout_cleared",
                "event": None,
                "minutes_until": None,
            }
        else:
            return {
                "action": "no_change",
                "is_locked": self.is_locked,
                "event": event_name if should else None,
                "minutes_until": minutes if should else None,
            }


# ============================================================
# Auto-Trade Manager
# ============================================================

class AutoTradeManager:
    """
    Menaxhon auto-trade status përmes CTrader MCP tools.

    Tools:
    - get_auto_trade_status
    - pause_auto_trade
    - resume_auto_trade
    """

    def __init__(self, mcp_client: Any, config: dict):
        self.mcp = mcp_client
        self.config = config

        tools_map = config.get("tools", {})
        self.tool_status = tools_map.get("auto_trade_status", "get_auto_trade_status")
        self.tool_pause = tools_map.get("auto_trade_pause", "pause_auto_trade")
        self.tool_resume = tools_map.get("auto_trade_resume", "resume_auto_trade")

        self.kill_switch_config = config.get("kill_switch", {})

    async def get_status(self) -> dict | None:
        """Merr statusin aktual të auto-trade."""
        try:
            result = await self.mcp.call_tool(self.tool_status, {})
            return result
        except Exception as e:
            logger.error(f"get_auto_trade_status failed: {e}")
            return None

    async def pause(
        self,
        reason: str = "manual",
        duration_minutes: int | None = None,
    ) -> bool:
        """Ndërpret auto-trade."""
        try:
            params = {"reason": reason}
            if duration_minutes:
                params["duration_minutes"] = duration_minutes
            result = await self.mcp.call_tool(self.tool_pause, params)
            logger.info(f"Auto-trade paused: {reason}")
            return bool(result)
        except Exception as e:
            logger.error(f"pause_auto_trade failed: {e}")
            return False

    async def resume(self) -> bool:
        """Rikthen auto-trade."""
        try:
            result = await self.mcp.call_tool(self.tool_resume, {})
            logger.info("Auto-trade resumed")
            return bool(result)
        except Exception as e:
            logger.error(f"resume_auto_trade failed: {e}")
            return False

    async def evaluate_kill_switch(
        self,
        context: dict,
    ) -> dict:
        """
        Vlerëson kill switch triggers dhe vepron automatikisht.

        Args:
            context: {
                "daily_loss_pct": float,
                "open_positions": int,
                "max_positions": int,
                "news_lockout_active": bool,
                "kill_zone_active": bool,
            }
        """
        if not self.kill_switch_config.get("enabled", True):
            return {"triggered": False, "action": "none"}

        triggers = self.kill_switch_config.get("triggers", {})
        auto_pause = self.kill_switch_config.get("auto_pause", True)

        triggered_reasons = []

        # Daily loss check
        daily_loss_limit = triggers.get("daily_loss_exceeded", 5.0)
        if context.get("daily_loss_pct", 0) >= daily_loss_limit:
            triggered_reasons.append(f"daily_loss={context['daily_loss_pct']}% >= {daily_loss_limit}%")

        # Max positions check
        if triggers.get("max_positions_reached", True):
            if context.get("open_positions", 0) >= context.get("max_positions", 3):
                triggered_reasons.append(f"max_positions={context['open_positions']}")

        # News lockout
        if triggers.get("news_lockout_active", True) and context.get("news_lockout_active", False):
            triggered_reasons.append("news_lockout_active")

        # Kill Zone check
        if triggers.get("kill_zone_inactive", True) and not context.get("kill_zone_active", True):
            triggered_reasons.append("kill_zone_inactive")

        if triggered_reasons and auto_pause:
            reason = "kill_switch: " + "; ".join(triggered_reasons)
            success = await self.pause(reason=reason)
            return {
                "triggered": True,
                "reasons": triggered_reasons,
                "action": "paused" if success else "pause_failed",
            }

        return {
            "triggered": bool(triggered_reasons),
            "reasons": triggered_reasons,
            "action": "none" if not triggered_reasons else "manual_required",
        }


# ============================================================
# Trap Evaluation
# ============================================================

def evaluate_trap_state(state: TrapState) -> dict:
    """
    Vlerëson nëse një trap është konfirmuar bazuar në events të marra.

    Returns:
        {
            "trapped": bool,
            "trap_type": str | None,
            "collection_grade": "A" | "B" | "C" | "D" | None,
            "missing_conditions": list[str],
            "ready_for_analysis": bool,
            "confirmations": dict
        }
    """
    received_types = {e.type for e in state.events_received}

    confirmations = {
        "liquidity_swept": EventType.LIQUIDITY_SWEPT.value in received_types,
        "mss_confirmed": EventType.MSS_CONFIRMED.value in received_types,
        "fvg_formed": EventType.FVG_FORMED.value in received_types,
        "trap_detected": EventType.TRAP_DETECTED.value in received_types,
    }

    confirmed_count = sum(confirmations.values())

    if confirmed_count >= 4:
        grade = "A"
    elif confirmed_count == 3:
        grade = "B"
    elif confirmed_count == 2:
        grade = "C"
    else:
        grade = "D"

    trap_type = None
    if EventType.TRAP_DETECTED.value in received_types:
        for event in state.events_received:
            if event.type == EventType.TRAP_DETECTED.value:
                trap_type = event.data.get("trap_type", "TYPE 0 — UNCLASSIFIED")
                break

    missing = [c.type for c in state.conditions if c.type not in received_types]

    return {
        "trapped": confirmed_count >= 3,
        "trap_type": trap_type,
        "collection_grade": grade if confirmed_count >= 3 else None,
        "missing_conditions": missing,
        "ready_for_analysis": confirmed_count >= 3,
        "confirmations": confirmations,
    }


# ============================================================
# Example usage
# ============================================================

def example_usage():
    """Example of how to use CTrader trap watcher + news lockout + auto-trade."""
    # Mock MCP client
    class MockMCP:
        async def call_tool(self, name, params):
            print(f"  [MCP] {name}({json.dumps(params, default=str)})")
            # Mock responses
            if "register" in name:
                return {"watch_id": f"watch-{datetime.now().timestamp()}", "success": True}
            if "list" in name:
                return {"watches": []}
            if "spot" in name or "get_spot" in name:
                return {"symbol": "XAUUSD", "bid": 4231.45, "ask": 4231.57, "last": 4231.50}
            if "trendbars" in name:
                return []
            if "calendar" in name or "news" in name:
                return {"events": []}
            if "lockout" in name:
                return {"success": True}
            if "auto_trade" in name:
                return {"is_active": True, "open_positions": 0}
            return {"success": True}

    # Config
    config = {
        "tools": {
            "trap_watch_register": "register_trap_watch",
            "watch_register": "register_watch",
            "watch_unregister": "cancel_watch",
            "watch_list": "list_watches",
            "market_get_quote": "get_spot_prices",
            "market_get_candles": "get_trendbars",
            "calendar_upcoming": "get_news_calendar",
            "news_lockout_set": "set_news_lockout",
            "news_lockout_clear": "clear_news_lockout",
            "auto_trade_status": "get_auto_trade_status",
            "auto_trade_pause": "pause_auto_trade",
            "auto_trade_resume": "resume_auto_trade",
        },
        "news_lockout": {
            "enabled": True,
            "block_on_impact": ["high"],
            "pre_news_block_minutes": 5,
            "post_news_block_minutes": 15,
            "auto_clear": True,
        },
        "kill_switch": {
            "enabled": True,
            "auto_pause": True,
            "triggers": {
                "daily_loss_exceeded": 5.0,
                "max_positions_reached": True,
                "news_lockout_active": True,
                "kill_zone_inactive": True,
            },
        },
    }

    print("=" * 60)
    print("CTrader Watch Monitor MCP — Integration Test")
    print("=" * 60)

    async def run():
        mcp = MockMCP()

        # 1. Trap Watch
        print("\n1️⃣  Trap Watch")
        watcher = CTraderTrapWatcher(mcp, config)
        watch_id = await watcher.register_trap_watch(
            "XAUUSD",
            conditions=[
                TrapCondition(type=EventType.LIQUIDITY_SWEPT.value, pool_id="L1", level=4220.0),
                TrapCondition(type=EventType.MSS_CONFIRMED.value, tf="M5"),
                TrapCondition(type=EventType.FVG_FORMED.value),
                TrapCondition(type=EventType.TRAP_DETECTED.value),
            ],
        )
        print(f"  → watch_id: {watch_id}")

        # 2. List watches
        print("\n2️⃣  List Watches")
        watches = await watcher.list_watches()
        print(f"  → {len(watches)} active watches")

        # 3. News lockout
        print("\n3️⃣  News Lockout")
        news_mgr = NewsLockoutManager(mcp, config)
        should_lock, event, minutes = await news_mgr.should_lockout("XAUUSD")
        print(f"  → should_lock: {should_lock}, event: {event}")

        result = await news_mgr.auto_manage_lockout("XAUUSD")
        print(f"  → {result}")

        # 4. Auto-trade
        print("\n4️⃣  Auto-Trade")
        auto_mgr = AutoTradeManager(mcp, config)
        status = await auto_mgr.get_status()
        print(f"  → status: {status}")

        kill_result = await auto_mgr.evaluate_kill_switch({
            "daily_loss_pct": 1.5,
            "open_positions": 0,
            "max_positions": 3,
            "news_lockout_active": False,
            "kill_zone_active": True,
        })
        print(f"  → kill_switch: {kill_result}")

        # 5. Trap evaluation
        print("\n5️⃣  Trap Evaluation")
        state = TrapState(
            symbol="XAUUSD",
            conditions=[TrapCondition(type=EventType.TRAP_DETECTED.value)],
            events_received=[
                WatchEvent(type=EventType.LIQUIDITY_SWEPT.value, symbol="XAUUSD", timestamp_utc="...", data={}),
                WatchEvent(type=EventType.MSS_CONFIRMED.value, symbol="XAUUSD", timestamp_utc="...", data={}),
                WatchEvent(type=EventType.FVG_FORMED.value, symbol="XAUUSD", timestamp_utc="...", data={}),
                WatchEvent(type=EventType.TRAP_DETECTED.value, symbol="XAUUSD", timestamp_utc="...", data={"trap_type": "Type 1"}),
            ],
        )
        evaluation = evaluate_trap_state(state)
        print(f"  → {json.dumps(evaluation, indent=2)}")

    asyncio.run(run())


if __name__ == "__main__":
    example_usage()
