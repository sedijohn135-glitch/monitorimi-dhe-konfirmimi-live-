#!/usr/bin/env python3
"""
time_zone.py — Konvertim timezone për analiza ICT.

User timezone: Europe/Tirane (Durrës, Shqipëri)
NY ET timezone: America/New_York

Përdorim:
    from time_zone import now_ny_et, is_in_ny_lunch, cet_to_ny_et
    print(now_ny_et())  # "10:30"
"""

from __future__ import annotations
from datetime import datetime, timezone
try:
    from zoneinfo import ZoneInfo
except ImportError:
    # Python < 3.9 fallback
    from backports.zoneinfo import ZoneInfo


# Timezones
TZ_TIRANE = ZoneInfo("Europe/Tirane")
TZ_NY = ZoneInfo("America/New_York")
TZ_UTC = timezone.utc


def now_utc() -> datetime:
    """Current UTC time."""
    return datetime.now(TZ_UTC)


def now_tirane() -> datetime:
    """Current Tirana (user) time."""
    return datetime.now(TZ_TIRANE)


def now_ny_et() -> datetime:
    """Current New York ET time."""
    return datetime.now(TZ_NY)


def now_ny_et_str() -> str:
    """Current NY ET time as HH:MM string."""
    return now_ny_et().strftime("%H:%M")


def cet_to_ny_et(cet_time: str) -> str:
    """Convert HH:MM CET (Durrës) to HH:MM NY ET.

    CET - 6 hours = NY ET (during overlapping DST).
    """
    try:
        cet_h, cet_m = map(int, cet_time.split(":"))
        # CET → NY ET = -6 hours
        ny_total = cet_h * 60 + cet_m - 360
        ny_total = ny_total % (24 * 60)  # wrap to 24h
        return f"{ny_total // 60:02d}:{ny_total % 60:02d}"
    except (ValueError, AttributeError):
        return "00:00"


def is_in_ny_lunch(time_et: str = None) -> bool:
    """Check if given or current NY ET time is in NY Lunch (12:00-13:00)."""
    if time_et is None:
        time_et = now_ny_et_str()
    return "12:00" <= time_et <= "13:00"


def is_in_kill_zone(time_et: str = None) -> bool:
    """Check if given or current NY ET time is in a kill zone."""
    if time_et is None:
        time_et = now_ny_et_str()
    t = datetime.strptime(time_et, "%H:%M").time()

    kill_zones = [
        ("02:00", "05:00"),  # London Open KZ
        ("03:00", "04:00"),  # London Silver Bullet
        ("07:00", "10:00"),  # NY Open KZ
        ("09:30", "10:00"),  # Equities OR
        ("10:00", "11:00"),  # AM Silver Bullet
        ("13:30", "16:00"),  # PM Session
        ("14:00", "15:00"),  # PM Silver Bullet
    ]
    for start, end in kill_zones:
        s = datetime.strptime(start, "%H:%M").time()
        e = datetime.strptime(end, "%H:%M").time()
        if s <= t <= e:
            return True
    return False


def get_current_session(time_et: str = None) -> str:
    """Determine current trading session."""
    if time_et is None:
        time_et = now_ny_et_str()
    t = datetime.strptime(time_et, "%H:%M").time()

    sessions = [
        ("19:00", "23:59", "Asia"),
        ("00:00", "01:59", "Pre-London"),
        ("02:00", "05:00", "London"),
        ("05:01", "06:59", "Pre-NY"),
        ("07:00", "11:59", "NY_AM"),
        ("12:00", "13:00", "NY_Lunch"),
        ("13:01", "16:00", "NY_PM"),
    ]
    for start, end, name in sessions:
        s = datetime.strptime(start, "%H:%M").time()
        e = datetime.strptime(end, "%H:%M").time()
        if s <= t <= e:
            return name
    return "Off-Hours"


def is_in_macro_window(time_et: str = None) -> tuple[bool, str]:
    """Check if time is in an ICT macro window (±10 min).

    Returns: (is_in_macro, macro_name)
    """
    if time_et is None:
        time_et = now_ny_et_str()

    # Macros with windows (±10 min)
    macros = [
        ("02:33", "London Open"),
        ("04:03", "London Continuation"),
        ("08:00", "Pre-NY Open"),
        ("09:00", "Pre-Open"),
        ("10:00", "NY Open"),
        ("11:00", "London Close"),
        ("12:00", "NY Lunch"),
        ("13:20", "PM Session Start"),
        ("15:00", "PM Macro"),
        ("15:15", "Last Hour 1"),
        ("15:40", "Last Hour 2"),
        ("15:50", "Last Hour 3"),
        ("16:00", "NY Close"),
    ]

    for macro_time, macro_name in macros:
        mh, mm = map(int, macro_time.split(":"))
        t = datetime.strptime(time_et, "%H:%M").time()
        # ±10 min window
        delta = abs((t.hour * 60 + t.minute) - (mh * 60 + mm))
        if delta <= 10:
            return True, macro_name
    return False, "none"


def format_time_for_output() -> str:
    """Format current time for module 00 output."""
    tirane = now_tirane()
    ny = now_ny_et()
    return (
        f"⏰ time.now: {tirane.strftime('%H:%M CET Durrës')} = "
        f"{ny.strftime('%H:%M NY ET')} | "
        f"Sesioni: {get_current_session()} | "
        f"Kill Zone: {'AKTIVE' if is_in_kill_zone() else 'INAKTIVE'} | "
        f"Macro: {is_in_macro_window()[1] if is_in_macro_window()[0] else 'INAKTIVE'}"
    )


# Kill Zone windows for reference
KILL_ZONES = {
    "London Open KZ": ("02:00", "05:00"),
    "London Silver Bullet": ("03:00", "04:00"),
    "NY Pre-Market": ("07:00", "09:30"),
    "NY Open KZ": ("07:00", "10:00"),
    "Equities OR": ("09:30", "10:00"),
    "AM Silver Bullet": ("10:00", "11:00"),
    "NY Lunch": ("12:00", "13:00"),
    "PM Session": ("13:30", "16:00"),
    "PM Silver Bullet": ("14:00", "15:00"),
    "Last Hour": ("15:00", "16:00"),
}


def example_usage():
    """Example of how to use the time_zone module."""
    print(f"Now (UTC):       {now_utc().isoformat()}")
    print(f"Now (Tirana):    {now_tirane().strftime('%H:%M CET Durrës')}")
    print(f"Now (NY ET):     {now_ny_et_str()}")
    print(f"Current session: {get_current_session()}")
    print(f"In kill zone:    {is_in_kill_zone()}")
    print(f"In macro:        {is_in_macro_window()}")
    print(f"In NY lunch:     {is_in_ny_lunch()}")
    print()
    print(format_time_for_output())
    print()
    print(f"08:00 CET = {cet_to_ny_et('08:00')} NY ET")
    print(f"15:30 CET = {cet_to_ny_et('15:30')} NY ET")
    print(f"18:00 CET = {cet_to_ny_et('18:00')} NY ET (NY Lunch)")
    print(f"20:00 CET = {cet_to_ny_et('20:00')} NY ET (PM Silver Bullet)")


if __name__ == "__main__":
    example_usage()
