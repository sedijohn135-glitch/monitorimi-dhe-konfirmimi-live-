#!/usr/bin/env python3
"""
mcp_normalize.py — Normalizon përgjigjet MCP në format të brendshëm.

Ky script merr output-in raw nga MCP tools dhe e kthen në format
të standardizuar që përdoret nga skill-i.

Përdorim:
    from mcp_normalize import Normalizer
    n = Normalizer()
    candles = n.normalize_candles(raw_mcp_response, tf="H4")
"""

from __future__ import annotations
from typing import Any
from datetime import datetime, timezone
import json


class MCPNormalizeError(Exception):
    """Gabim gjatë normalizimit të të dhënave MCP."""


class Normalizer:
    """Normalizes MCP responses into a standardized internal format."""

    def __init__(self, default_unit: str = "pips"):
        self.default_unit = default_unit
        self.tick_size = None

    def set_tick_size(self, tick_size: float) -> None:
        """Sets the instrument tick size for price unit determination."""
        self.tick_size = tick_size

    def normalize_quote(self, raw: dict) -> dict:
        """Normalize a market.get_quote response.

        Input format (MCP raw):
            {"symbol": "XAUUSD", "bid": 4231.45, "ask": 4231.57, "spread_points": 12, "last": 4231.50, "timestamp_utc": "..."}

        Output format (internal):
            {"symbol": "XAUUSD", "bid": 4231.45, "ask": 4231.57, "spread_points": 1.2, "last": 4231.50, "mid": 4231.51, "price_unit": "pips", "timestamp_utc": "..."}
        """
        if "bid" not in raw or "ask" not in raw:
            raise MCPNormalizeError("Quote response missing bid/ask fields")

        bid = float(raw["bid"])
        ask = float(raw["ask"])
        last = float(raw.get("last", (bid + ask) / 2))
        mid = (bid + ask) / 2

        # Determine price unit
        price_unit = "pips"
        if self.tick_size is not None and self.tick_size < 0.00010:
            price_unit = "price_points"

        # Spread in pips
        spread_points = ask - bid
        if self.tick_size and self.tick_size > 0:
            spread_pips = spread_points / self.tick_size
        else:
            spread_pips = spread_points

        return {
            "symbol": raw.get("symbol", "UNKNOWN"),
            "bid": bid,
            "ask": ask,
            "last": last,
            "mid": mid,
            "spread_points": spread_points,
            "spread_pips": spread_pips,
            "price_unit": price_unit,
            "timestamp_utc": raw.get("timestamp_utc", datetime.now(timezone.utc).isoformat()),
        }

    def normalize_candles(self, raw: list, tf: str) -> list[dict]:
        """Normalize a market.get_candles response.

        Input format (MCP raw list):
            [{"time_utc": "2026-08-21T18:00:00Z", "open": 4230.00, "high": 4235.00, "low": 4228.50, "close": 4232.75, "volume": 12345}]

        Output format (internal):
            [{"time_utc": "...", "time_et": "...", "datetime_utc": datetime, "open": 4230.00, "high": 4235.00, "low": 4228.50, "close": 4232.75, "volume": 12345, "body": 2.75, "range": 6.50, "is_bullish": True, "tf": "H4"}]
        """
        if not isinstance(raw, list):
            raise MCPNormalizeError(f"Candles response must be a list, got {type(raw)}")

        normalized = []
        for c in raw:
            if not all(k in c for k in ("open", "high", "low", "close")):
                continue  # Skip malformed candles

            o = float(c["open"])
            h = float(c["high"])
            l = float(c["low"])
            cl = float(c["close"])

            body = abs(cl - o)
            candle_range = h - l
            upper_wick = h - max(o, cl)
            lower_wick = min(o, cl) - l

            time_str = c.get("time_utc", c.get("time", ""))
            try:
                dt_utc = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                dt_utc = datetime.now(timezone.utc)

            normalized.append({
                "time_utc": time_str,
                "datetime_utc": dt_utc,
                "open": o,
                "high": h,
                "low": l,
                "close": cl,
                "volume": float(c.get("volume", 0)),
                "body": body,
                "range": candle_range,
                "upper_wick": upper_wick,
                "lower_wick": lower_wick,
                "is_bullish": cl > o,
                "is_bearish": cl < o,
                "tf": tf,
            })

        # Sort by time (oldest first)
        normalized.sort(key=lambda c: c["datetime_utc"])
        return normalized

    def normalize_atr(self, raw: dict | float) -> dict:
        """Normalize a market.get_atr response.

        Input format:
            {"atr": 12.34, "unit": "pips"}  OR  12.34

        Output format:
            {"value": 12.34, "unit": "pips"}
        """
        if isinstance(raw, (int, float)):
            return {"value": float(raw), "unit": self.default_unit}
        if isinstance(raw, dict):
            value = float(raw.get("atr", raw.get("value", 0)))
            unit = raw.get("unit", self.default_unit)
            return {"value": value, "unit": unit}
        raise MCPNormalizeError(f"Invalid ATR response: {raw}")

    def normalize_session_status(self, raw: dict) -> dict:
        """Normalize a session.status response."""
        return {
            "session": raw.get("session", "Off-Hours"),
            "kill_zone": raw.get("kill_zone", "INAKTIVE"),
            "kill_zone_name": raw.get("kill_zone_name", "none"),
            "in_macro_window": raw.get("in_macro_window", False),
            "macro_name": raw.get("macro_name", "none"),
            "is_time_distortion": raw.get("is_time_distortion", False),
            "is_ny_lunch": raw.get("is_ny_lunch", False),
        }

    def normalize_session_range(self, raw: dict) -> dict:
        """Normalize a session.get_range response."""
        return {
            "high": float(raw.get("high", 0)),
            "low": float(raw.get("low", 0)),
            "range": float(raw.get("high", 0)) - float(raw.get("low", 0)),
            "open_time_utc": raw.get("open_time_utc", ""),
            "close_time_utc": raw.get("close_time_utc", ""),
        }

    def compute_equilibrium(self, swing_high: float, swing_low: float) -> float:
        """Compute 50% equilibrium (midpoint) of a range."""
        return (swing_high + swing_low) / 2

    def compute_distance_pips(self, price_a: float, price_b: float) -> float:
        """Compute distance between two prices in pips."""
        distance = abs(price_a - price_b)
        if self.tick_size and self.tick_size > 0:
            return distance / self.tick_size
        return distance


def example_usage():
    """Example of how to use the Normalizer."""
    n = Normalizer()
    n.set_tick_size(0.01)  # XAUUSD

    # Example quote
    raw_quote = {
        "symbol": "XAUUSD",
        "bid": 4231.45,
        "ask": 4231.57,
        "spread_points": 12,
        "last": 4231.50,
        "timestamp_utc": "2026-08-21T22:39:18Z"
    }
    quote = n.normalize_quote(raw_quote)
    print(json.dumps(quote, indent=2, default=str))

    # Example candles
    raw_candles = [
        {"time_utc": "2026-08-21T18:00:00Z", "open": 4230.00, "high": 4235.00, "low": 4228.50, "close": 4232.75, "volume": 12345},
        {"time_utc": "2026-08-21T22:00:00Z", "open": 4232.75, "high": 4240.00, "low": 4231.00, "close": 4238.50, "volume": 15000},
    ]
    candles = n.normalize_candles(raw_candles, "H4")
    print(f"\nNormalized {len(candles)} candles")
    print(f"First candle: {candles[0]}")


if __name__ == "__main__":
    example_usage()
