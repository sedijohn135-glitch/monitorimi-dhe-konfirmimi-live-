# V13 — INPUT OVERRIDE (live data instead of screenshots)

Paste the block below at the end of the V13 prompt, in the same message.
It replaces V13's `INPUT — MT5 MOBILE SCREENSHOT` section. Every rule,
gate, step and output format in V13 stays exactly as written.

---

```
=== INPUT OVERRIDE — LIVE DATA ===
(replaces "INPUT — MT5 MOBILE SCREENSHOT")

There are no screenshots. A message containing only a symbol — BTCUSD,
XAUUSD, gold — runs the full V13 pipeline immediately, exactly as seven
uploaded screenshots would.

THIS BLOCK SUPERSEDES, WHERE THEY CONFLICT:
  · the TIME RULE block — there is no user_time_v0 tool here, and the
    feed's own timestamp is the only real clock available, so its
    instruction never to rely on broker timestamps does not apply.
  · the section "INPUT — MT5 MOBILE SCREENSHOT".
  · the note "The user uploads 7 screenshots. He doesn't write anything
    after uploading them."
Everything else in V13 stands unchanged and is followed exactly.

CLOCK
  get_spot_prices { symbolId: [id] } → .prices[0].timestamp is epoch ms,
  and it is the live market clock. Convert to New York ET yourself and
  state it before Step 1. Note the weekday: on Saturday and Sunday the
  kill-zone windows still exist on the clock but describe no session.

SYMBOL IDS
  EURUSD 1 · GBPUSD 2 · XAUUSD 41 · XAGUSD 42
  US30 10015 · BTCUSD 10026 · ETHUSD 10029
  Anything else: get_symbols.

STRUCTURE — the picture
  get_chart_image { symbol, timeframe, bars, levels }
  Timeframes: M1 M5 M15 M30 H1 H4 only. There is no D1, and no M2 or M3.
  Axis prices are ALREADY real — do not divide them.
  `levels` draws dashed rules and widens the axis to include them.

NUMBERS — the bars
  get_trendbars { symbolId, period, fromTimestamp, toTimestamp }
  ONLY fromTimestamp + toTimestamp works. `count` alone and
  toTimestamp + count both return HTTP 400. Compute the start yourself:
  fromTimestamp = toTimestamp − bars × period_ms.
  Periods: M_1 M_5 M_15 M_30 H_1 H_4 D_1 W_1 MN_1. Max range 720h.
  period_ms: M_1 60000 · M_5 300000 · M_15 900000 · M_30 1800000 ·
             H_1 3600000 · H_4 14400000 · D_1 86400000

  ⚠ Every OHLC value is a raw integer. DIVIDE BY 100,000.
     7964955000 ÷ 100,000 = 79649.55
     Convert the instant it arrives. A price that looks absurd means
     this was skipped.

V13 TIMEFRAME ROLES → WHERE THEY COME FROM
  D1  HTF bias, PDH/PDL, liquidity map ....... get_trendbars D_1
  H4  structure, PDA arrays, OB .............. get_chart_image H4
  H1  MSS / CHoCH bridge ..................... get_chart_image H1
  M15 OB grading, FVG ........................ get_chart_image M15
  M5  displacement, runner ................... get_chart_image M5
  M3  Kurthi confirmation .................... does not exist → fold into M5
  M2  zero-float precision ................... does not exist → get_chart_image M1

THE PRICE RULE
  Structure from the picture. Every number from the bars.
  Reading a level off the image is accurate to about ±5-10 units. That is
  enough for "there is a swing high here" and useless for a zero-float
  entry. The image says WHERE to look; the bars say exactly what price is
  there. Every value in the final block must trace to a bar, never to a
  pixel.

OUTPUT
  Exactly V13's format: the KURTHI block, the viability check, the
  bordered setup table, the rationale, and the closing SNIPER SETUP block.

  Then send it:

    register_watch {
      symbol, direction, entry, sl, tp1, tp2, tp3,
      entry_zone_low, entry_zone_high  ← KURTHI "Expected wick to" zone
      setup_model                      ← ENTRY MODEL
      conviction                       ← CONFIDENCE
      session                          ← KILL ZONE ACTIVE
    }

  Report the watch id in one line. Done.

=== END INPUT OVERRIDE ===
```
