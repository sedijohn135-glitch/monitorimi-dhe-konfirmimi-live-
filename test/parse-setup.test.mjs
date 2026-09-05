/**
 * parse-setup suite — the paste path must read the trade, not the trap.
 *
 * Every case here is a shape the analysis tools actually emit. The
 * failures they pin down are the ones that made the same setup accepted
 * on one paste and refused on the next:
 *
 *   - the KURTHI block's own "Direction: UP sweep" read as the trade side
 *   - markdown decoration around a label hiding it from the matcher
 *   - "108,450.00" read as 108.45
 *   - the trap's landing zone dropped, leaving no entry zone to watch
 *
 *   node --test test/parse-setup.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseSetupText } from "../lib/parse-setup.mjs";
import { validateWatchInput } from "../lib/core.mjs";

// The V13 output as Gemini produces it: a KURTHI narrative describing an
// UP sweep, followed by the SELL that the sweep sets up.
const GEMINI_SELL = `### ⚡ THE $10 BILLION QUESTION — THE TRAP (KURTHI)

The HTF (D1, H4, H1) is heavily **BEARISH**. On the LTF price is engineering
a V-shaped bullish rally (from 4329.53 up to 4360.34) to hunt the internal
Buy Side Liquidity (BSL) resting above the M5 structural highs.

### ✅ VIABILITY CHECK:
Çmimi aktual : 4360.34
Verdict : ✅ SETUP VALID — VAZHDO

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🪤 KURTHI (TRAP):
Direction: UP sweep
Target liquidity: Internal BSL at 4367.01 and 4375.36
Expected wick to: 4372.50 – 4376.00
After trap → real move: BEARISH

🎯 SNIPER SETUP:
SELL XAUUSD AT THIS PRICE:
SNIPER 0 FLOAT ENTRY PRICE : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00
TP2 : 4333.60
TP3 : 4322.00
CONFIDENCE : 85%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

// ---------------------------------------------------------------------------
// The trap is not the trade.

test("PS1 — a KURTHI 'UP sweep' never becomes a BUY", () => {
  const { parsed, missing, warnings } = parseSetupText(GEMINI_SELL);
  assert.equal(parsed.direction, "sell");
  assert.deepEqual(missing, []);
  assert.ok(
    warnings.some((w) => /trap-move direction/.test(w)),
    "the refusal is reported, not silent",
  );
});

test("PS2 — 'after trap → real move' carries the side on its own", () => {
  // No SELL/BUY verb anywhere, and the only DIRECTION line is the trap's.
  const text = `🪤 KURTHI (TRAP):
Direction: DOWN sweep
Expected wick to: 4423.50 – 4425.00
After trap → real move: BULLISH

INSTRUMENT : XAUUSD
SNIPER 0 FLOAT ENTRY PRICE : 4425.00
STOP LOSS : 4419.00
TP1 : 4435.50`;
  const { parsed, missing } = parseSetupText(text);
  assert.equal(parsed.direction, "buy");
  assert.deepEqual(missing, []);
});

test("PS3 — the trade line wins without the symbol beside the verb", () => {
  // This is the shape that used to produce direction=buy and then a
  // "buy setup requires entry > sl" refusal from register_watch.
  const text = `🪤 KURTHI (TRAP):
Direction: UP sweep

INSTRUMENT : XAUUSD
SELL AT THIS PRICE:
SNIPER 0 FLOAT ENTRY PRICE : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00`;
  const { parsed } = parseSetupText(text);
  assert.equal(parsed.direction, "sell");
});

// ---------------------------------------------------------------------------
// Geometry outranks vocabulary.

test("PS4 — prices that only fit a sell correct a BUY word", () => {
  const text = `INSTRUMENT : XAUUSD
DIRECTION : LONG
ENTRY : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00`;
  const { parsed, warnings } = parseSetupText(text);
  assert.equal(parsed.direction, "sell");
  assert.ok(warnings.some((w) => /geometry/.test(w)), "the correction is announced");
});

test("PS5 — geometry stays silent when it is ambiguous or incomplete", () => {
  // No TP1: two of the three numbers cannot settle a side.
  const partial = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : LONG
ENTRY : 4374.50
STOP LOSS : 4384.50`);
  assert.equal(partial.parsed.direction, "buy", "the word stands when the numbers cannot speak");

  // A consistent buy is left exactly as declared.
  const clean = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : LONG
ENTRY : 4331.00
STOP LOSS : 4325.00
TP1 : 4348.00`);
  assert.equal(clean.parsed.direction, "buy");
  assert.ok(!clean.warnings.some((w) => /corrected/.test(w)));
});

// ---------------------------------------------------------------------------
// Markdown decoration is not a reason to refuse a setup.

test("PS6 — bold labels parse", () => {
  const { parsed, missing } = parseSetupText(`**INSTRUMENT:** XAUUSD
**DIRECTION:** SHORT
**SNIPER 0 FLOAT ENTRY PRICE:** 4374.50
**STOP LOSS:** 4384.50
**TP1:** 4348.00`);
  assert.deepEqual(missing, []);
  assert.equal(parsed.entry, 4374.5);
  assert.equal(parsed.sl, 4384.5);
  assert.equal(parsed.tp1, 4348);
});

test("PS7 — bullet and numbered list markers parse", () => {
  const bullets = parseSetupText(`- INSTRUMENT: XAUUSD
- DIRECTION: SELL
- ENTRY: 4374.50
- STOP LOSS: 4384.50
- TP1: 4348.00`);
  assert.deepEqual(bullets.missing, []);
  assert.equal(bullets.parsed.entry, 4374.5);

  const numbered = parseSetupText(`1. INSTRUMENT: XAUUSD
2. DIRECTION: SELL
3. ENTRY: 4374.50
4. STOP LOSS: 4384.50
5. TP1: 4348.00`);
  assert.deepEqual(numbered.missing, []);
  assert.equal(numbered.parsed.tp1, 4348);
});

// ---------------------------------------------------------------------------
// Numbers.

test("PS8 — comma thousands separators are not decimal points", () => {
  const { parsed } = parseSetupText(`INSTRUMENT : BTCUSD
DIRECTION : SELL
ENTRY : 108,450.00
STOP LOSS : 109,200.00
TP1 : 106,000.00`);
  assert.equal(parsed.entry, 108450);
  assert.equal(parsed.sl, 109200);
  assert.equal(parsed.tp1, 106000);
});

test("PS9 — a comma decimal is still a decimal", () => {
  const { parsed } = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
ENTRY : 4374,50
STOP LOSS : 4384,50
TP1 : 4348,00`);
  assert.equal(parsed.entry, 4374.5);
  assert.equal(parsed.sl, 4384.5);
});

test("PS10 — a trailing rationale after the price is ignored", () => {
  const { parsed } = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
ENTRY : 4374.50 — M15 FVG CE / Premium array
STOP LOSS : 4384.50 (above the M5 swing high)
TP1 : 4348.00`);
  assert.equal(parsed.entry, 4374.5);
  assert.equal(parsed.sl, 4384.5);
});

// ---------------------------------------------------------------------------
// §trap-zone — the KURTHI landing zone is the zone Active validation
// waits at, so it has to survive the paste.

test("PS11 — the KURTHI landing zone becomes the entry zone", () => {
  const { parsed, warnings } = parseSetupText(GEMINI_SELL);
  assert.equal(parsed.entry_zone_low, 4372.5);
  assert.equal(parsed.entry_zone_high, 4376);
  assert.ok(warnings.some((w) => /KURTHI landing zone/.test(w)));
});

test("PS12 — the trap zone alone supplies the entry", () => {
  const { parsed, missing } = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
Expected wick to: 4372.50 – 4376.00
STOP LOSS : 4384.50
TP1 : 4348.00`);
  assert.deepEqual(missing, []);
  assert.equal(parsed.entry, 4374.25, "midpoint of the trap zone");
});

test("PS13 — an inconsistent trap zone is refused, not forced", () => {
  // The quoted zone belongs to a different leg: the entry sits outside
  // it. Adopting it would make register_watch reject the whole paste.
  const { parsed, warnings } = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
Expected wick to: 4390.00 – 4395.00
SNIPER 0 FLOAT ENTRY PRICE : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00`);
  assert.equal(parsed.entry_zone_low, null);
  assert.equal(parsed.entry, 4374.5);
  assert.ok(warnings.some((w) => /KURTHI zone .* ignored/.test(w)));
});

test("PS14 — an explicit ENTRY ZONE outranks the trap zone", () => {
  const { parsed } = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
ENTRY ZONE : 4373.00 – 4375.00
Expected wick to: 4372.50 – 4376.00
SNIPER 0 FLOAT ENTRY PRICE : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00`);
  assert.equal(parsed.entry_zone_low, 4373);
  assert.equal(parsed.entry_zone_high, 4375);
});

// ---------------------------------------------------------------------------
// The defence profile is the operator's to name; the parser never picks.

test("PS15 — a named validation mode is carried, an unknown one is not", () => {
  const named = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
VALIDATION MODE : m1_continuation
ENTRY : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00`);
  assert.equal(named.parsed.defence_profile, "m1_continuation");

  const unknown = parseSetupText(`INSTRUMENT : XAUUSD
DIRECTION : SELL
VALIDATION MODE : aggressive
ENTRY : 4374.50
STOP LOSS : 4384.50
TP1 : 4348.00`);
  assert.equal(unknown.parsed.defence_profile, null, "the monitor keeps its own default");
  assert.ok(unknown.warnings.some((w) => /not one of/.test(w)));
});

// ---------------------------------------------------------------------------
// The whole point: what the parser emits has to survive register_watch.

test("PS16 — the parsed Gemini setup passes validateWatchInput", () => {
  const { parsed } = parseSetupText(GEMINI_SELL);
  const validated = validateWatchInput(parsed);
  assert.equal(validated.direction, "sell");
  assert.equal(validated.entry, 4374.5);
  assert.equal(validated.entry_zone_low, 4372.5);
  assert.equal(validated.entry_zone_high, 4376);
  assert.equal(validated.defence_profile, "standard", "Active validation is the default profile");
});

test("PS17 — the bullish V13 table still reads as a buy", () => {
  // The regression guard for the original sample: a DOWN sweep trap
  // ahead of a long, in the bordered STEP 9 table.
  const text = `🪤 KURTHI IDENTIFIED:
Direction of trap: DOWN sweep (SSL Raid)
Kurthi landing zone: 4423.50 – 4425.00
After trap → REAL direction: BULLISH
╔══════════════════════════════════════════════════════════╗
║ INSTRUMENT : XAUUSD                                      ║
║ DIRECTION : 📈 LONG                                      ║
║ 🟢 ENTRY ZONE : 4424.50 – 4426.00                        ║
║ 🔴 SL ZONE : 4419.00                                     ║
║ 🎯 TARGET 1 : 4435.50                                    ║
║ 🎯 TARGET 2 : 4440.00                                    ║
╚══════════════════════════════════════════════════════════╝
BUY XAUUSD AT THIS PRICE:
SNIPER 0 FLOAT ENTRY PRICE : 4425.00
STOP LOSS : 4419.00
TP1 : 4435.50`;
  const { parsed, missing } = parseSetupText(text);
  assert.equal(parsed.direction, "buy");
  assert.equal(parsed.entry, 4425);
  assert.equal(parsed.entry_zone_low, 4424.5);
  assert.deepEqual(missing, []);
  assert.doesNotThrow(() => validateWatchInput(parsed));
});

// ---------------------------------------------------------------------------
// Nothing in, nothing out.

test("PS18 — empty and narrative-only text report what is missing", () => {
  assert.deepEqual(parseSetupText("").missing, ["symbol", "direction", "entry", "sl", "tp1"]);
  const narrative = parseSetupText(
    "The market will sweep sell side liquidity before the real move develops.",
  );
  assert.ok(narrative.missing.includes("entry"));
  assert.ok(narrative.missing.includes("sl"));
});
