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
  assert.ok(warnings.some((w) => /KURTHI zone.*ignored/.test(w)));
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

// ---------------------------------------------------------------------------
// §single-level — the V13 table writes "ENTRY ZONE : [Level]", one number
// under a zone label. Recorded as low === high it failed validation, and
// that refused every setup drawn from the template's own layout.

test("PS19 — a single-number ENTRY ZONE is a level, not a zero-width zone", () => {
  const text = `INSTRUMENT      : BTCUSD
DIRECTION       : SHORT
ENTRY ZONE      : 79935.00 (M1 Bearish FVG / OTE)
SL ZONE         : 80012.00
TARGET 1        : 79631.00`;
  const { parsed, missing } = parseSetupText(text);
  assert.deepEqual(missing, []);
  assert.equal(parsed.entry, 79935);
  assert.equal(parsed.entry_zone_low, null, "no zone is invented around the level");
  assert.equal(parsed.entry_zone_high, null);
  assert.doesNotThrow(() => validateWatchInput(parsed), "this used to throw on low >= high");
});

test("PS20 — an explicit entry price outranks the single-level zone", () => {
  const { parsed } = parseSetupText(`INSTRUMENT : BTCUSD
DIRECTION : SHORT
ENTRY ZONE : 79950.00
SNIPER 0 FLOAT ENTRY PRICE : 79935.00
STOP LOSS : 80012.00
TP1 : 79631.00`);
  assert.equal(parsed.entry, 79935);
});

// ---------------------------------------------------------------------------
// §label-qualifier and §zone-choice.

test("PS21 — a parenthetical qualifier does not hide the label", () => {
  const { parsed } = parseSetupText(`INSTRUMENT : BTCUSD
DIRECTION : SHORT
Fibo Master Sniper Zone (5.0-16.8): 79,935.00 - 80,011.00
SNIPER 0 FLOAT ENTRY PRICE : 79935.00
STOP LOSS : 80012.00
TARGET 1 (M15 Swing Low) : 79631.00`);
  assert.equal(parsed.tp1, 79631, "the TP label survives its qualifier");
  assert.equal(parsed.entry_zone_low, 79935);
  assert.equal(parsed.entry_zone_high, 80011);
});

test("PS22 — among several named zones the consistent one is chosen", () => {
  // The landing zone belongs to the sweep above the stop; the Fibo zone
  // is the one the entry actually sits in.
  const { parsed, warnings } = parseSetupText(`INSTRUMENT : BTCUSD
DIRECTION : SHORT
Kurthi landing zone: 80,000.00 - 80,134.53
Fibo Master Sniper Zone (5.0-16.8): 79,935.00 - 80,011.00
SNIPER 0 FLOAT ENTRY PRICE : 79935.00
STOP LOSS : 80012.00
TP1 : 79631.00`);
  assert.equal(parsed.entry_zone_low, 79935);
  assert.equal(parsed.entry_zone_high, 80011);
  // And the warning names the block it was actually taken from. This used
  // to read "KURTHI landing zone" for every source, which on this very
  // paste named the one zone that was rejected.
  assert.ok(
    warnings.some((w) => /sniper zone/i.test(w) && /79935/.test(w)),
    `expected the Fibo sniper zone to be named, got: ${warnings.join(" | ")}`,
  );
  assert.doesNotThrow(() => validateWatchInput(parsed));
});

test("PS23 — when no named zone fits, none is forced and all are reported", () => {
  const { parsed, warnings } = parseSetupText(`INSTRUMENT : BTCUSD
DIRECTION : SHORT
Kurthi landing zone: 80,000.00 - 80,134.53
Expected wick to: 80,011.00 - 80,134.00
SNIPER 0 FLOAT ENTRY PRICE : 79935.00
STOP LOSS : 80012.00
TP1 : 79631.00`);
  assert.equal(parsed.entry_zone_low, null);
  const note = warnings.find((w) => /ignored/.test(w));
  assert.ok(note, "the refusal is reported");
  assert.ok(/80000/.test(note) && /80011/.test(note), "both candidates are named");
  assert.doesNotThrow(() => validateWatchInput(parsed));
});

// ---------------------------------------------------------------------------
// The v6 output block, verbatim from the paste that produced the live
// refusal. It declares its objective twice — once as a DOL level in the
// trap block, once as the label on TP2 — and declares the PDA band the
// trigger fires inside. The monitor read neither.

const V6_PASTE = `
🪤 TRAP INTELLIGENCE
Kurthi: Type 1 (EQH/Swing High Breakout Trap) BEARISH
Trap Score: 9/9 | Manipulation: COMPLETE
DOL: 4354.10 (H1 EQL) | Lock: LOCKED

🎯 ZERO FLOAT ENTRY
INSTRUMENT: XAUUSD
DREJTIMI: 📉 SHORT
PDA: Bearish FVG / OB (M1/M5) [4404.00 - 4408.00] · Rank 1st

🟢 ENTRY: 4404.50 — M1/M5 Bearish FVG CE
🔴 SL: 4415.50 — [Anchor i swing high + spread buffer]
🎯 TP1: 4384.66 — [Low Hanging Fruit / M5 SSL]
🎯 TP2: 4354.10 — [DOL Final / H1 EQL Strong Magnet]
🎯 TP3: 4314.12 — [HTF H4 Swing Low]
`;

test("PS24 — the declared DOL becomes the target the R:R is judged on", () => {
  // The whole trade is a delivery to 4354.10. TP1 is the partial taken on
  // the way, and judging the setup on it is what refused a live winner.
  const { parsed } = parseSetupText(V6_PASTE);
  assert.equal(parsed.tp2, 4354.1);
  assert.equal(parsed.rr_target, "tp2", "DOL 4354.10 is TP2, so TP2 is the objective");
});

test("PS25 — a DOL that matches no declared target leaves the default alone", () => {
  // Guessing which target a stray level meant would be worse than
  // measuring TP1, which is at least what the operator already expects.
  const { parsed } = parseSetupText(V6_PASTE.replace("DOL: 4354.10", "DOL: 4200.00"));
  assert.equal(parsed.rr_target, null);
});

test("PS26 — the PDA band is the entry zone the trigger fires inside", () => {
  // Without it the zone collapses to entry ± tolerance — 0.20 wide on gold
  // — which no live tick sits inside for long, so every in-zone rule the
  // monitor has is unreachable and confirmation can only arrive late.
  const { parsed } = parseSetupText(V6_PASTE);
  assert.equal(parsed.entry_zone_low, 4404.0);
  assert.equal(parsed.entry_zone_high, 4408.0);
});

test("PS27 — a PDA band that disagrees with the entry or the stop is ignored", () => {
  // Same consistency rule the KURTHI zone already answers to: a band
  // quoted from another leg must not be able to move the entry.
  const { parsed, warnings } = parseSetupText(V6_PASTE.replace("[4404.00 - 4408.00]", "[4420.00 - 4430.00]"));
  assert.equal(parsed.entry_zone_low, null, "the stop sits inside that band");
  assert.ok(warnings.some((w) => /PDA|zone/i.test(w)));
});

test("PS28 — the v6 block still parses into a registrable watch", () => {
  const { parsed } = parseSetupText(V6_PASTE);
  const watch = validateWatchInput({ ...parsed, symbol: "XAUUSD" });
  assert.equal(watch.direction, "sell");
  assert.equal(watch.entry, 4404.5);
  assert.equal(watch.sl, 4415.5);
  assert.equal(watch.rr_target, "tp2");
  assert.equal(watch.entry_zone_low, 4404.0);
});

test("PS29 — the declared invalidation is read, not inferred past the stop", () => {
  // v6 writes "INVALID:", not "INVALIDATION:". Missing the label meant the
  // monitor invented a level 1.6 beyond the one the analysis declared dead,
  // and would have kept a broken setup alive across it.
  const { parsed } = parseSetupText(V6_PASTE + "\nINVALID: Body close mbi ekstremitetin e kurthit 4415.00\n");
  assert.equal(parsed.invalidation, 4415.0);
});

test("PS30 — the warning names the block the zone actually came from", () => {
  // The operator reads these in Telegram. "taken from the KURTHI landing
  // zone" for a band that came from the PDA line is a wrong answer to
  // "where did this zone come from".
  const { warnings } = parseSetupText(V6_PASTE);
  assert.ok(
    warnings.some((w) => /PDA/i.test(w) && /4404/.test(w)),
    `expected a PDA-sourced zone warning, got: ${warnings.join(" | ")}`,
  );
});

// The analysis's own ratio names its objective when no DOL line does.
//
// A real Silver Bullet paste: TP1 is 1.06R and TP3 is 2.88R, and the
// analysis declares 1:2.8. Judged against TP1, the engine's acceptance
// requirement leaves 0.53R at the fill against a 0.5R floor — a setup
// rated CONVICTION A, refused for decaying against a target its own
// author labelled "Low Hanging Fruit".
test("PS-RR1 — a declared ratio picks the target it actually matches", () => {
  const { parsed, warnings } = parseSetupText(`INSTRUMENT: XAUUSD
DREJTIMI: SHORT
MODEL: 7 — Silver Bullet (10-11 AM)
ENTRY: 4361.50
SL: 4378.00
TP1: 4344.00 — Low Hanging Fruit
TP2: 4330.00
TP3: 4314.00 — DOL Final
RR: 1:2.8 | CONVICTION: A`);
  assert.equal(parsed.rr_target, "tp3");
  assert.match(warnings.join(" "), /measured to TP3/);
});

test("PS-RR2 — a ratio that already matches TP1 changes nothing", () => {
  const { parsed } = parseSetupText(`INSTRUMENT: BTCUSD
DREJTIMI: SHORT
ENTRY: 77408
SL: 77550
TP1: 77065
TP2: 76814
TP3: 76642
RR: 1:2.4`);
  assert.equal(parsed.rr_target, "tp1", "TP1 is 2.42R — the declared 2.4 means TP1");
});

test("PS-RR3 — the DOL line still wins, and a ratio matching nothing is ignored", () => {
  const withDol = parseSetupText(`INSTRUMENT: XAUUSD
DREJTIMI: SHORT
DOL: 4330.00
ENTRY: 4361.50
SL: 4378.00
TP1: 4344.00
TP2: 4330.00
TP3: 4314.00
RR: 1:2.8`);
  assert.equal(withDol.parsed.rr_target, "tp2", "the declared DOL is TP2, whatever the ratio says");

  const nonsense = parseSetupText(`INSTRUMENT: XAUUSD
DREJTIMI: SHORT
ENTRY: 4361.50
SL: 4378.00
TP1: 4344.00
RR: 1:9`);
  assert.equal(nonsense.parsed.rr_target, null, "9R matches no target; TP1 stays the default");
});
