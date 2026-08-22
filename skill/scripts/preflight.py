#!/usr/bin/env python3
"""
preflight.py — Kontrollet para-çdo-analize (Pre-Analysis Checks).

Ekzekuto PARA çdo analize. Nëse ndonjë CHECK dështon, refuzo analizën
ose raporto kushte të veçanta.

9 Kontrollet (A-I) sipas SNIPER MACHINE spec:
  A — Instrument identifikueshëm
  B — Timeframe completeness
  C — Screenshot/Input clarity
  D — Live candle exclusion
  E — PDA staleness
  F — Time Distortion
  G — Gap Risk
  H — ATH Context
  I — Large Range Day
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
from datetime import datetime, timezone, timedelta


@dataclass
class PreflightResult:
    """Rezultati i preflight checks."""
    passed: bool
    verdict: str  # "PROCEED" | "NO-TRADE" | "STOP"
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "verdict": self.verdict,
            "failures": self.failures,
            "warnings": self.warnings,
            "notes": self.notes,
        }


class PreflightChecker:
    """Kontrollet para-çdo-analize për skill-in."""

    # Timeframe requirements
    REQUIRED_TFS = ["D1", "H4", "H1", "M15", "M5", "M1"]

    # PDA staleness (days)
    PDA_STALENESS_DAYS = 60

    def __init__(self, market_state: dict):
        """
        Args:
            market_state: {
                "instrument": "XAUUSD",
                "available_tfs": ["D1", "H4", "H1", "M15", "M5", "M1"],
                "current_session": "London",
                "now_et": "10:30",
                "current_price": 4231.50,
                "pd_arrays": [...],
                "candles_by_tf": {"D1": [...], "H4": [...], ...},
                "is_large_range_day_prior": false,
                "ath_level": 4270.00,
            }
        """
        self.state = market_state
        self.failures: list[str] = []
        self.warnings: list[str] = []
        self.notes: dict[str, Any] = {}

    def run_all(self) -> PreflightResult:
        """Run all preflight checks in order."""
        self.check_a_instrument()
        self.check_b_timeframes()
        self.check_c_clarity()
        self.check_d_live_candle()
        self.check_e_pda_staleness()
        self.check_f_time_distortion()
        self.check_g_gap_risk()
        self.check_h_ath_context()
        self.check_i_large_range_day()

        # Determine verdict
        if self.failures:
            # Check if it's a hard stop or just no-trade
            hard_failures = [f for f in self.failures if "missing" in f.lower() or "stop" in f.lower()]
            if hard_failures:
                verdict = "STOP"
            else:
                verdict = "NO-TRADE"
        else:
            verdict = "PROCEED"

        return PreflightResult(
            passed=not self.failures,
            verdict=verdict,
            failures=self.failures,
            warnings=self.warnings,
            notes=self.notes,
        )

    def check_a_instrument(self) -> None:
        """CHECK A — Instrument identifikueshëm."""
        instrument = self.state.get("instrument")
        if not instrument or instrument == "UNKNOWN":
            self.failures.append("CHECK A: Instrument not identifiable")

    def check_b_timeframes(self) -> None:
        """CHECK B — Timeframe completeness."""
        available = self.state.get("available_tfs", [])
        missing = [tf for tf in self.REQUIRED_TFS if tf not in available]
        if missing:
            self.failures.append(f"CHECK B: Missing required timeframes: {missing}")

    def check_c_clarity(self) -> None:
        """CHECK C — Input clarity (candles have valid OHLC)."""
        candles_by_tf = self.state.get("candles_by_tf", {})
        for tf in self.REQUIRED_TFS:
            candles = candles_by_tf.get(tf, [])
            if candles and not self._is_candle_data_valid(candles):
                self.failures.append(f"CHECK C: {tf} candle data invalid or unclear")

    def check_d_live_candle(self) -> None:
        """CHECK D — Live candle (most recent may be incomplete)."""
        # This is informational; the engine should exclude live candles
        now_et = self.state.get("now_et", "00:00")
        self.notes["live_candle_excluded"] = True
        self.notes["note_d"] = f"Most recent candle on each TF excluded (now {now_et} ET)"

    def check_e_pda_staleness(self) -> None:
        """CHECK E — PDA staleness (>60 days = EXPIRED)."""
        pd_arrays = self.state.get("pd_arrays", [])
        today = datetime.now(timezone.utc)
        for pda in pd_arrays:
            age_days = pda.get("age_days", 0)
            if age_days > self.PDA_STALENESS_DAYS:
                pda["status"] = "EXPIRED"
                self.warnings.append(f"CHECK E: PDA at {pda.get('level')} is {age_days} days old — EXPIRED")

    def check_f_time_distortion(self) -> None:
        """CHECK F — Time Distortion = NO TRADE."""
        session = self.state.get("current_session", "")
        now_et = self.state.get("now_et", "00:00")

        # NY Lunch check (12:00-13:00 ET)
        if self._is_in_ny_lunch(now_et):
            self.failures.append("CHECK F: NY Lunch (12:00-13:00 ET) — NO TRADE absolute")

        # Between sessions
        if session == "Off-Hours":
            self.failures.append("CHECK F: Off-Hours session — Time Distortion active")

        # Between macros
        if self._is_between_macros(now_et):
            self.failures.append("CHECK F: Time between macros — Time Distortion active")

    def check_g_gap_risk(self) -> None:
        """CHECK G — Gap Risk (large opening gap)."""
        gap_size = self.state.get("opening_gap_size", 0)
        if gap_size > 50:  # > 50 pips
            self.warnings.append(f"CHECK G: Large opening gap ({gap_size} pips) — require discount retracement")
            self.notes["gap_risk"] = True

    def check_h_ath_context(self) -> None:
        """CHECK H — ATH Context (BULLISH only at ATH)."""
        current = self.state.get("current_price", 0)
        ath = self.state.get("ath_level", 0)
        if ath and current >= ath:
            self.warnings.append("CHECK H: Price at/above ATH — BULLISH bias only, no shorts")

    def check_i_large_range_day(self) -> None:
        """CHECK I — Large Range Day (BTCUSD-specific 9:30-10:30 AM)."""
        instrument = self.state.get("instrument", "")
        is_lrd = self.state.get("is_large_range_day_prior", False)
        now_et = self.state.get("now_et", "00:00")

        if "BTC" in instrument and is_lrd:
            if self._is_in_window(now_et, "09:30", "10:30"):
                self.failures.append("CHECK I: BTCUSD + Large Range Day + 9:30-10:30 AM — NO TRADE")

    # Helpers

    def _is_candle_data_valid(self, candles: list) -> bool:
        """Check if candle data is valid."""
        if not candles:
            return False
        for c in candles:
            if not all(k in c for k in ("open", "high", "low", "close")):
                return False
        return True

    def _is_in_ny_lunch(self, now_et: str) -> bool:
        return self._is_in_window(now_et, "12:00", "13:00")

    def _is_between_macros(self, now_et: str) -> bool:
        """Check if time is between ICT macros (low probability)."""
        # Simplified: between 5:00-7:00 AM (London close to NY pre-market) is Time Distortion
        return self._is_in_window(now_et, "05:30", "07:00") or \
               self._is_in_window(now_et, "11:30", "12:00") or \
               self._is_in_window(now_et, "16:00", "17:00")

    def _is_in_window(self, time_str: str, start: str, end: str) -> bool:
        """Check if HH:MM is in [start, end] window."""
        try:
            t = datetime.strptime(time_str, "%H:%M").time()
            s = datetime.strptime(start, "%H:%M").time()
            e = datetime.strptime(end, "%H:%M").time()
            return s <= t <= e
        except ValueError:
            return False


def example_usage():
    """Example of how to use the PreflightChecker."""
    market_state = {
        "instrument": "XAUUSD",
        "available_tfs": ["D1", "H4", "H1", "M15", "M5", "M1"],
        "current_session": "NY_AM",
        "now_et": "10:30",
        "current_price": 4231.50,
        "pd_arrays": [
            {"level": 4225.00, "age_days": 5, "status": "ACTIVE"},
            {"level": 4200.00, "age_days": 70, "status": "EXPIRED"},
        ],
        "candles_by_tf": {
            "D1": [{"open": 4230, "high": 4235, "low": 4228, "close": 4232}],
            "H4": [{"open": 4230, "high": 4235, "low": 4228, "close": 4232}],
            "H1": [{"open": 4230, "high": 4235, "low": 4228, "close": 4232}],
            "M15": [{"open": 4230, "high": 4235, "low": 4228, "close": 4232}],
            "M5": [{"open": 4230, "high": 4235, "low": 4228, "close": 4232}],
            "M1": [{"open": 4230, "high": 4235, "low": 4228, "close": 4232}],
        },
        "is_large_range_day_prior": False,
        "ath_level": 4270.00,
    }

    checker = PreflightChecker(market_state)
    result = checker.run_all()
    print(f"Verdict: {result.verdict}")
    print(f"Failures: {result.failures}")
    print(f"Warnings: {result.warnings}")


if __name__ == "__main__":
    example_usage()
