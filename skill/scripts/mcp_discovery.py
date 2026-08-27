#!/usr/bin/env python3
"""
mcp_discovery.py — Zbulim automatik i mjeteve MCP të disponueshme.

Ekzekuto këtë script për të zbuluar çfarë tools ofron MCP yt.
Pastaj përditëso mcp_config.yaml me emrat e saktë.

Përdorim:
    python3 mcp_discovery.py
    python3 mcp_discovery.py --endpoint ws://localhost:8765
    python3 mcp_discovery.py --config ../mcp_config.yaml
"""

from __future__ import annotations
import json
import sys
import argparse
from pathlib import Path
from typing import Any


# Default tools që duhen skill-it
REQUIRED_TOOLS = {
    "critical": [
        "time.now",
        "market.get_quote",
        "market.get_candles",
    ],
    "important": [
        "market.get_atr",
        "market.get_spread",
        "session.status",
        "session.get_range",
    ],
    "optional": [
        "time.convert",
        "session.list_sessions",
        "calendar.upcoming",
    ],
    "watch_optional": [
        "watch.register",
        "watch.unregister",
        "watch.list",
        "watch.poll",
        "trap.watch.start",
        "trap.watch.stop",
        "trap.watch.status",
    ],
    "register_optional": [
        "register.order",
        "register.position",
        "register.alert",
    ],
    "skill_context_optional": [
        "skill_context.audit",
    ],
}

# Aliases — emra të ndryshëm që mund të përdorë MCP
TOOL_ALIASES = {
    "time.now": ["time.now", "get_time", "now", "time_current", "current_time", "clock.now", "get_server_time", "server_time"],
    "time.convert": ["time.convert", "convert_time", "tz_convert"],
    "market.get_quote": ["market.get_quote", "get_quote", "quote", "price.get", "current_price", "tick", "get_spot_prices", "spot_prices", "get_spot", "spot"],
    "market.get_candles": ["market.get_candles", "get_candles", "candles", "ohlcv", "get_hist", "bars", "history", "klines", "get_trendbars", "trendbars"],
    "market.get_atr": ["market.get_atr", "get_atr", "atr", "atr_calc"],
    "market.get_spread": ["market.get_spread", "get_spread", "spread"],
    "market.get_symbols": ["market.get_symbols", "get_symbols", "list_symbols", "symbols"],
    "session.status": ["session.status", "get_session", "session_state", "killzone.status"],
    "session.get_range": ["session.get_range", "get_range", "session_range", "session.hilo"],
    "session.list_sessions": ["session.list_sessions", "list_sessions", "sessions"],
    "calendar.upcoming": ["calendar.upcoming", "get_news", "upcoming_events", "economic_calendar", "get_news_calendar", "news_calendar"],
    "watch.register": ["watch.register", "subscribe", "watch.create", "event.subscribe", "register_watch"],
    "watch.unregister": ["watch.unregister", "unsubscribe", "watch.delete", "event.unsubscribe", "cancel_watch"],
    "watch.list": ["watch.list", "subscriptions", "list_watches"],
    "watch.poll": ["watch.poll", "events.poll", "get_events"],
    "trap.watch.start": ["trap.watch.start", "start_trap_watch", "trap.subscribe", "register_trap_watch"],
    "trap.watch.stop": ["trap.watch.stop", "stop_trap_watch", "trap.unsubscribe"],
    "trap.watch.status": ["trap.watch.status", "trap_watch_status"],
    "news.lockout.set": ["news.lockout.set", "set_news_lockout", "lockout.set"],
    "news.lockout.clear": ["news.lockout.clear", "clear_news_lockout", "lockout.clear"],
    "auto_trade.status": ["auto_trade.status", "get_auto_trade_status", "auto_trade_status"],
    "auto_trade.pause": ["auto_trade.pause", "pause_auto_trade", "auto_trade.pause"],
    "auto_trade.resume": ["auto_trade.resume", "resume_auto_trade", "auto_trade.resume"],
    "register.order": ["register.order", "place_order", "order.place", "send_order"],
    "register.position": ["register.position", "open_position", "position.open"],
    "register.alert": ["register.alert", "set_alert", "alert.create", "price_alert"],
    "skill_context.audit": ["skill_context.audit", "get_skill_context_audit", "skill_context_audit"],
    "get_version": ["get_version", "version"],
}


# Fushat e `skill_context` — konfirmimet që skill-i i ka bërë PARA se çmimi të
# kthehet në zonë, dhe që deri tani mbeteshin brenda skill-it. Monitori i
# përdor për të vendosur *cila provë live* kërkohet dhe *sa gjatë* duhet të
# mbahet — kurrë për të hequr provën fare.
#
#   burimi_ne_output_e_skillit  ->  fusha e skill_context
SKILL_CONTEXT_FIELDS = {
    "htf_mss_confirmed": "structure.h4.mss_at ose structure.h1.mss_at ekziston",
    "htf_mss_at": "structure.h4.mss_at (niveli)",
    "htf_mss_at_ms": "kur printoi ai MSS (epoch ms)",
    "trap_phase": "trap_analysis.manipulation_phase / delivery_phase",
    "trap_sub_type": "trap_analysis.trap_sub_type",
    "liquidity_swept": "liquidity_pools[].status == SWEPT",
    "liquidity_target": "ilos_state.primary_objective (niveli)",
    "m5_mss_already_observed": "structure.m5.mss AND structure.m5.displacement",
    "m5_mss_at_ms": "kur printoi M5 MSS (epoch ms)",
    "htf_bias": "ilos_state.bias",
    "conviction": "ilos_state.confidence (HIGH/MEDIUM/LOW)",
    "expected_displacement_tf": "execution / structure — TF ku pritet displacement",
    "analysis_at_ms": "kur u bë analiza (epoch ms)",
    "note": "shënim i lirë — hyn i plotë në audit",
}


def load_config(config_path: str) -> dict:
    """Load mcp_config.yaml — simple parser (no external deps)."""
    config = {
        "tools": {},
        "server": {"endpoint": ""},
        "discovery": {"enabled": True, "fallback_to_defaults": True},
    }

    if not config_path or not Path(config_path).exists():
        return config

    try:
        import yaml
        with open(config_path) as f:
            config = yaml.safe_load(f) or config
    except ImportError:
        # Fallback: simple line-by-line parser
        with open(config_path) as f:
            for line in f:
                line = line.rstrip()
                if not line or line.strip().startswith("#"):
                    continue
                if ":" in line and not line.startswith(" "):
                    key, _, value = line.partition(":")
                    value = value.strip().strip('"').strip("'")
                    if value:
                        if "tools" not in config:
                            config["tools"] = {}
                        config["tools"][key.strip()] = value

    return config


def resolve_tool_name(canonical: str, config_tools: dict) -> str:
    """Resolve a canonical tool name to the actual MCP tool name."""
    if config_tools.get(canonical):
        return config_tools[canonical]
    return canonical


def discover_tools(endpoint: str, config: dict) -> dict:
    """
    Discover available tools from MCP server.

    Real implementation would call MCP `tools.list` endpoint.
    For demo / offline mode, returns a mock discovery.
    """
    # Try to import MCP client
    try:
        # If MCP SDK is available
        from mcp import ClientSession

        # Real discovery (placeholder — actual implementation depends on MCP setup)
        return {
            "status": "connected",
            "endpoint": endpoint,
            "tools": [],  # Will be populated by actual MCP call
            "message": "Real MCP discovery requires runtime. See MCP SDK docs.",
        }
    except ImportError:
        # Fallback: prompt user to manually list tools
        return {
            "status": "offline",
            "endpoint": endpoint,
            "tools": [],
            "message": "MCP SDK not installed. Run 'pip install mcp' for auto-discovery, or use --manual flag.",
        }


def inspect_skill_context(tools: list) -> dict:
    """
    A e pranon monitori `skill_context` te register_watch — dhe cilat fusha?

    Kjo lexohet nga `inputSchema` që MCP-ja kthen te `tools/list`, jo nga
    supozimi ynë: nëse monitori është version i vjetër, fushat thjesht nuk
    janë aty dhe skill-i nuk duhet t'i dërgojë. Kur `tools` janë vetëm emra
    (manual mode), kthehet `status="unknown"` — mungesa e skemës nuk do të
    thotë mungesë mbështetjeje.
    """
    result = {
        "status": "unsupported",
        "accepted_fields": [],
        "missing_fields": [],
        "unknown_fields": [],
        "audit_tool": None,
    }

    schema = None
    saw_any_schema = False
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if tool.get("inputSchema"):
            saw_any_schema = True
        if name in TOOL_ALIASES["watch.register"] or name == "watch.register":
            schema = tool.get("inputSchema") or {}
        if name in TOOL_ALIASES["skill_context.audit"]:
            result["audit_tool"] = name

    if not saw_any_schema:
        result["status"] = "unknown"
        result["missing_fields"] = sorted(SKILL_CONTEXT_FIELDS)
        return result
    if not schema:
        return result

    block = (schema.get("properties") or {}).get("skill_context")
    if not block:
        result["missing_fields"] = sorted(SKILL_CONTEXT_FIELDS)
        return result

    result["status"] = "supported"
    accepted = set((block.get("properties") or {}).keys())
    known = set(SKILL_CONTEXT_FIELDS)
    result["accepted_fields"] = sorted(accepted & known)
    result["missing_fields"] = sorted(known - accepted)
    result["unknown_fields"] = sorted(accepted - known)
    return result


# Fushat e ciklit të jetës (Watch Monitor v7.2+). Mungesa e tyre do të thotë
# monitor i vjetër: dërgimi i tyre do të refuzohej te validimi, sepse skema e
# `register_watch` është `additionalProperties: false`.
LIFECYCLE_FIELDS = {
    "potential_trade_sl": "ku do të ndalej një tregti (alias i `sl`)",
    "thesis_invalidation": "ku analiza është e gabuar (alias i `invalidation`)",
    "defence_profile": "cila provë live kërkohet pas touch-it",
    "urgency": "sa gjatë duhet të mbahet evidenca — asgjë tjetër",
    "max_entry_deviation": "sa larg entry-t ia vlen ende të hyhet",
    "confirmation_deadline_minutes": "sa gjatë mund të zgjasë konfirmimi",
    "entry_monitoring_window_minutes": "sa gjatë ndiqet zona për një touch",
}


def inspect_lifecycle(tools: list) -> dict:
    """
    A i pranon monitori fushat e ciklit të jetës (v7.2+)?

    E njëjta rregull si te `inspect_skill_context`: lexohet nga skema reale,
    dhe mungesa e skemës është `unknown`, jo `unsupported`.
    """
    result = {"status": "unsupported", "accepted_fields": [], "missing_fields": [], "trail_tool": None}

    schema = None
    saw_any_schema = False
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if tool.get("inputSchema"):
            saw_any_schema = True
        if name in TOOL_ALIASES["watch.register"] or name == "watch.register":
            schema = tool.get("inputSchema") or {}
        if name in ("get_setup_trail", "watch.trail", "setup_trail"):
            result["trail_tool"] = name

    if not saw_any_schema:
        result["status"] = "unknown"
        result["missing_fields"] = sorted(LIFECYCLE_FIELDS)
        return result
    if not schema:
        return result

    accepted = set((schema.get("properties") or {}).keys())
    known = set(LIFECYCLE_FIELDS)
    result["accepted_fields"] = sorted(accepted & known)
    result["missing_fields"] = sorted(known - accepted)
    # `defence_profile` është fusha që u shtua me ciklin e jetës; pa të,
    # monitori është < v7.2 sado fusha të tjera të ketë.
    if "defence_profile" in accepted:
        result["status"] = "supported"
    return result


def print_lifecycle_report(lifecycle: dict) -> None:
    """Çfarë pranon monitori për ciklin e jetës së setup-it."""
    print("\n🔄 SETUP LIFECYCLE (SL vs invalidim teze, Anti-SL, entry missed):")
    status = lifecycle["status"]
    if status == "unknown":
        print("  ❔ Skema e tools nuk u lexua dot (manual mode).")
        print("     Verifiko me tools/list përpara se t'i dërgosh këto fusha.")
        return
    if status == "unsupported":
        print("  ⛔ Ky monitor është < v7.2: nuk i pranon fushat e ciklit të jetës.")
        print("     Prekja e stop-it para hyrjes do ta vrasë setup-in menjëherë,")
        print("     dhe TP1 pa hyrje do të raportohet si EXPIRED, jo ENTRY_MISSED.")
        print("     MOS i dërgo fushat e reja — skema i refuzon.")
        return

    print(f"  ✅ register_watch pranon {len(lifecycle['accepted_fields'])} fusha të ciklit të jetës")
    for field in lifecycle["accepted_fields"]:
        print(f"     · {field}  ←  {LIFECYCLE_FIELDS[field]}")
    if lifecycle["missing_fields"]:
        print("\n  ⚠️  Fusha që ky MCP nuk i pranon (mos i dërgo):")
        for field in lifecycle["missing_fields"]:
            print(f"     · {field}")
    if lifecycle["trail_tool"]:
        print(f"\n  🧾 Gjurma: `{lifecycle['trail_tool']}` — pse hyri kur hyri, ose pse jo.")
    else:
        print("\n  ⚠️  Nuk u gjet mjet gjurme; vendimet nuk mund të rindërtohen pas faktit.")


def inspect_promotion(tools: list) -> dict:
    """
    A e promovon monitori vetë një trap të konfirmuar në setup (v7.3+)?

    Kjo nuk është thjesht një fushë — ndryshon se çfarë do të thotë të
    regjistrosh një trap, prandaj skill-i duhet ta dijë përpara se ta bëjë.
    """
    result = {"status": "unsupported", "opt_out_field": False}
    saw_any_schema = False
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if tool.get("inputSchema"):
            saw_any_schema = True
        if tool.get("name") in TOOL_ALIASES.get("trap_watch.register", ["register_trap_watch"]):
            properties = (tool.get("inputSchema") or {}).get("properties") or {}
            if "auto_promote" in properties:
                result["status"] = "supported"
                result["opt_out_field"] = True
    if not saw_any_schema:
        result["status"] = "unknown"
    return result


def print_promotion_report(promotion: dict) -> None:
    """A mund të kthehet një trap i regjistruar në një tregti pa më pyetur."""
    print("\n🪤 TRAP PROMOTION (trapi i konfirmuar → setup i gatshëm):")
    status = promotion["status"]
    if status == "unknown":
        print("  ❔ Skema e tools nuk u lexua dot (manual mode).")
        return
    if status == "unsupported":
        print("  ⛔ Monitor < v7.3: një trap i regjistruar mbetet vetëm informativ.")
        print("     Pas konfirmimit duhet ta rianalizoj dhe ta regjistroj setup-in vetë.")
        return
    print("  ✅ Një trap i konfirmuar mund të kthehet VETË në setup dhe të japë ENTER NOW.")
    print("     · dërgo `trap_score` të lexueshëm (\"7/9\") ose porta e rezultatit refuzon")
    print("     · `invalidation_level` bëhet vija e tezës së setup-it — mendoje mirë")
    print("     · `auto_promote: false` e mban trapin thjesht informativ")


def check_coverage(discovered_tools: list, config: dict) -> dict:
    """Check which required tools are covered."""
    discovered_set = set(discovered_tools)
    coverage = {
        "critical_missing": [],
        "important_missing": [],
        "optional_missing": [],
        "watch_available": [],
        "register_available": [],
        "skill_context_available": [],
        "alias_suggestions": {},
    }

    for tool in REQUIRED_TOOLS["critical"]:
        if not _is_tool_available(tool, discovered_set):
            coverage["critical_missing"].append(tool)

    for tool in REQUIRED_TOOLS["important"]:
        if not _is_tool_available(tool, discovered_set):
            coverage["important_missing"].append(tool)

    for tool in REQUIRED_TOOLS["optional"]:
        if not _is_tool_available(tool, discovered_set):
            coverage["optional_missing"].append(tool)

    for tool in REQUIRED_TOOLS["watch_optional"]:
        if _is_tool_available(tool, discovered_set):
            coverage["watch_available"].append(tool)

    for tool in REQUIRED_TOOLS["register_optional"]:
        if _is_tool_available(tool, discovered_set):
            coverage["register_available"].append(tool)

    for tool in REQUIRED_TOOLS["skill_context_optional"]:
        if _is_tool_available(tool, discovered_set):
            coverage["skill_context_available"].append(tool)

    # Suggest aliases for missing tools
    for canonical, aliases in TOOL_ALIASES.items():
        for alias in aliases:
            if alias in discovered_set and canonical not in discovered_set:
                coverage["alias_suggestions"][canonical] = alias
                break

    return coverage


def _is_tool_available(canonical: str, discovered_set: set) -> bool:
    """Check if a canonical tool is available (by name or alias)."""
    if canonical in discovered_set:
        return True
    for alias in TOOL_ALIASES.get(canonical, []):
        if alias in discovered_set:
            return True
    return False


def manual_discovery() -> list[str]:
    """Prompt user to manually enter available tool names."""
    print("\n📋 MANUAL TOOL DISCOVERY")
    print("Shkruaj emrat e tools që ka MCP yt (një për rresht, Ctrl+D ose 'done' për të përfunduar):")
    print("Shembuj: time.now, market.get_quote, watch.register, etj.\n")

    tools = []
    try:
        while True:
            line = input("> ").strip()
            if not line or line.lower() == "done":
                break
            tools.append(line)
    except (EOFError, KeyboardInterrupt):
        pass

    return tools


def print_skill_context_report(skill_context: dict) -> None:
    """Çfarë pranon monitori nga konfirmimet që skill-i ka bërë tashmë."""
    print(f"\n🧠 SKILL CONTEXT (konfirmimet para touch-it):")
    status = skill_context["status"]
    if status == "unknown":
        print("  ❔ Skema e tools nuk u lexua dot (manual mode).")
        print("     Dërgo skill_context vetëm nëse register_watch e pranon —")
        print("     verifiko me tools/list te MCP yt.")
        return
    if status == "unsupported":
        print("  ⛔ register_watch NUK pranon skill_context në këtë MCP.")
        print("     Monitori do të presë sekuencën e plotë M5 pas touch-it.")
        print("     Përditëso monitorin në v7.1+ për ta aktivizuar.")
        return

    print(f"  ✅ register_watch pranon skill_context — {len(skill_context['accepted_fields'])} fusha")
    print("     ⓘ  Konteksti REGJISTROHET dhe auditohet; nuk ndryshon asnjë vendim konfirmimi.")
    for field in skill_context["accepted_fields"]:
        print(f"     · {field}  ←  {SKILL_CONTEXT_FIELDS[field]}")
    if skill_context["missing_fields"]:
        print(f"\n  ⚠️  Fusha që ky MCP nuk i pranon (mos i dërgo):")
        for field in skill_context["missing_fields"]:
            print(f"     · {field}")
    if skill_context["unknown_fields"]:
        print(f"\n  🆕 Fusha që MCP pranon por skill-i nuk i njeh:")
        for field in skill_context["unknown_fields"]:
            print(f"     · {field}")
    if skill_context["audit_tool"]:
        print(f"\n  📊 Audit: `{skill_context['audit_tool']}` — krahaso conviction me rezultatin real.")
    else:
        print(f"\n  ⚠️  Pa mjet auditi: conviction-i yt nuk mund të kalibrohet.")


def print_report(discovered: list, config: dict, coverage: dict) -> None:
    """Print a discovery report."""
    print("\n" + "=" * 60)
    print("📊 MCP TOOL DISCOVERY REPORT")
    print("=" * 60)

    print(f"\n✅ Tools discovered: {len(discovered)}")
    for tool in sorted(discovered):
        # Find canonical name
        canonical = tool
        for c, aliases in TOOL_ALIASES.items():
            if tool in aliases:
                canonical = c
                break
        is_canonical = tool in REQUIRED_TOOLS["critical"] + REQUIRED_TOOLS["important"]
        marker = "🔴" if canonical in REQUIRED_TOOLS["critical"] else \
                 "🟡" if canonical in REQUIRED_TOOLS["important"] else \
                 "🟢" if canonical in REQUIRED_TOOLS["optional"] else \
                 "🔵"
        print(f"  {marker} {tool}" + (f"  →  {canonical}" if tool != canonical else ""))

    print(f"\n❌ Critical missing ({len(coverage['critical_missing'])}):")
    if coverage["critical_missing"]:
        for t in coverage["critical_missing"]:
            print(f"  - {t}  (REFUZO analizën nëse mungon)")
    else:
        print("  (asnjë — mbulim i plotë)")

    print(f"\n⚠️  Important missing ({len(coverage['important_missing'])}):")
    if coverage["important_missing"]:
        for t in coverage["important_missing"]:
            print(f"  - {t}")
    else:
        print("  (asnjë)")

    print(f"\n📡 Watch tools available ({len(coverage['watch_available'])}):")
    for t in coverage["watch_available"]:
        print(f"  - {t}  (event-driven watch aktiv)")

    print(f"\n🧠 Skill-context tools available ({len(coverage['skill_context_available'])}):")
    for t in coverage["skill_context_available"]:
        print(f"  - {t}  (audit i conviction-it aktiv)")

    print(f"\n📝 Register tools available ({len(coverage['register_available'])}):")
    for t in coverage["register_available"]:
        print(f"  - {t}  (order/alert management aktiv)")

    if coverage["alias_suggestions"]:
        print(f"\n💡 Alias suggestions (për mcp_config.yaml):")
        for canonical, alias in coverage["alias_suggestions"].items():
            print(f"  {canonical}: \"{alias}\"")

    # Print suggested config snippet
    print(f"\n📝 SUGGESTED mcp_config.yaml SNIPPET:")
    print("```yaml")
    print("tools:")
    for tool in discovered:
        canonical = tool
        for c, aliases in TOOL_ALIASES.items():
            if tool in aliases:
                canonical = c
                break
        if tool != canonical:
            print(f"  {canonical}: \"{tool}\"")
    print("```")

    # Verdict
    if coverage["critical_missing"]:
        print(f"\n⛔ VERDIKT: MCP yt NUK mbulon critical tools. Refuzo analizën.")
    elif coverage["important_missing"]:
        print(f"\n⚠️ VERDIKT: MCP yt mbulon critical, por disa important mungojnë. Përdor fallback-at.")
    else:
        print(f"\n✅ VERDIKT: MCP yt mbulon TË GJITHA required tools.")


def main():
    parser = argparse.ArgumentParser(description="MCP Tool Discovery for ict-sniper-liquidity-engine")
    parser.add_argument("--endpoint", default="", help="MCP server endpoint")
    parser.add_argument("--config", default="", help="Path to mcp_config.yaml")
    parser.add_argument("--manual", action="store_true", help="Manual tool entry mode")
    args = parser.parse_args()

    # Load config
    config = load_config(args.config) if args.config else {"tools": {}, "server": {}}
    endpoint = args.endpoint or config.get("server", {}).get("endpoint", "ws://localhost:8765")

    print(f"🔌 MCP Discovery — endpoint: {endpoint}")

    # Auto discovery
    if not args.manual:
        result = discover_tools(endpoint, config)
        if result["status"] == "offline":
            print(f"\n⚠️ {result['message']}")
            print("Duke kaluar në manual discovery...")
            args.manual = True

    # Manual discovery
    if args.manual:
        discovered = manual_discovery()
        raw_tools = [{"name": name} for name in discovered]
    else:
        raw_tools = result.get("tools", [])
        discovered = [
            tool.get("name") if isinstance(tool, dict) else tool for tool in raw_tools
        ]

    # Check coverage
    coverage = check_coverage(discovered, config)

    # Print report
    print_report(discovered, config, coverage)

    # A i pranon monitori konfirmimet që skill-i i ka bërë tashmë?
    print_skill_context_report(inspect_skill_context(raw_tools))
    print_lifecycle_report(inspect_lifecycle(raw_tools))
    print_promotion_report(inspect_promotion(raw_tools))


if __name__ == "__main__":
    main()
