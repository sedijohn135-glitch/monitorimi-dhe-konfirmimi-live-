/**
 * The catalogue and the four kill switches.
 *
 * Both modules exist to refuse things, so most of what is worth testing
 * is the refusal: a model that is a filter, a direction the model does
 * not allow, a level on the wrong side of the entry, a switch nobody
 * armed. An over-permissive answer here is a trade nobody should be in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTRY_MODELS,
  applyEntryModel,
  entryModelByNumber,
  evaluateModelGate,
  resolveEntryModel,
  timeStopBarsFor,
} from "../lib/entry-models.mjs";
import {
  advancePdaArraysBroken,
  evaluateBreakerPrecedence,
  evaluateHtfCascade,
  evaluateTimeStop,
  validateKillSwitchInput,
} from "../lib/kill-switch.mjs";
import { validateWatchInput } from "../lib/core.mjs";
import { parseSetupText } from "../lib/parse-setup.mjs";

const bar = (timestampMs, open, high, low, close) => ({ open, high, low, close, timestampMs });
const BASE = Date.parse("2026-09-09T13:00:00Z"); // a Wednesday, 09:00 NY
const setup = (over = {}) => ({ symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450, ...over });

// --- the catalogue ----------------------------------------------------------

test("EM1 — all 35 models are present, numbered 1..35, with unique keys", () => {
  // 1-22 are the v6.0 prompt's catalogue; 23-35 are the repo's older
  // 19-model list, carried across rather than renumbered or dropped.
  assert.equal(ENTRY_MODELS.length, 35);
  assert.deepEqual(ENTRY_MODELS.map((m) => m.number), Array.from({ length: 35 }, (_, i) => i + 1));
  assert.equal(new Set(ENTRY_MODELS.map((m) => m.key)).size, 35);
  assert.equal(ENTRY_MODELS.filter((m) => m.catalogue === "v6.0").length, 22);
  assert.equal(ENTRY_MODELS.filter((m) => m.catalogue === "hybrid-v7.2").length, 13);
  for (const model of ENTRY_MODELS) {
    for (const field of ["trigger", "validation", "invalidation"]) {
      assert.ok(model[field]?.length > 10, `model ${model.number} has a ${field}`);
    }
  }
});

test("EM2 — a model is found by number, by key and by name", () => {
  assert.equal(resolveEntryModel("Modeli 7").model.number, 7);
  assert.equal(resolveEntryModel("SILVER_BULLET_AM").model.number, 7);
  assert.equal(resolveEntryModel("ICT 2022 Model").model.number, 1);
  assert.equal(resolveEntryModel("Power of 3 (PO3) Distribution Entry").model.number, 22);
});

test("EM3 — the longest matching name wins, so the window is not lost", () => {
  // "Silver Bullet (2-3 PM)" contains "silver bullet"; taking that would
  // silently monitor the PM setup against the London window.
  assert.equal(resolveEntryModel("Silver Bullet (2-3 PM)").model.number, 8);
  assert.equal(resolveEntryModel("silver bullet london").model.number, 6);
});

test("EM4 — an unrecognised name resolves to nothing and is not an error", () => {
  assert.equal(resolveEntryModel("një model që nuk ekziston"), null);
  assert.equal(resolveEntryModel(""), null);
  assert.equal(resolveEntryModel(null), null);
  const applied = applyEntryModel(validateWatchInput(setup({ setup_model: "diçka tjetër" })), {});
  assert.equal(applied.entry_model, null);
  assert.equal(applied.defence_profile, "standard", "an unknown model changes no default");
});

test("EM3b — every model the older list had is still reachable by name", () => {
  const legacy = {
    "OB + FVG Confluence": 23,
    Unicorn: 24,
    RIFVG: 25,
    "MMXM / MMBM": 26,
    "BISI / SIBI": 27,
    "Vault Pocket": 28,
    SDR: 29,
    DRO: 30,
    LSS: 31,
    OSST: 32,
    STRC: 33,
    SRT: 34,
    FBE: 35,
  };
  for (const [name, number] of Object.entries(legacy)) {
    assert.equal(resolveEntryModel(name)?.model.number, number, `${name} resolves`);
  }
});

test("EM3c — when a number and a name disagree, the name wins", () => {
  // The two catalogues agree on 1-3 and diverge after: "Model 5" is
  // Turtle Soup Deferred in v6.0 and plain Turtle Soup in the old list.
  // A name never collides that way, so it decides.
  const resolved = resolveEntryModel("Model 5 — Turtle Soup");
  assert.equal(resolved.model.number, 4);
  assert.match(resolved.matchedBy, /number 5 disagreed/);

  // A bare number still resolves, against the v6.0 numbering the
  // analysis prompt actually writes to.
  assert.equal(resolveEntryModel("Model 5").model.number, 5);
});

test("EM3d — a family name with no window resolves to nothing, never to a guess", () => {
  // Three Silver Bullets, three different hours. Picking one would
  // monitor the setup against an hour the analyst never named.
  assert.equal(resolveEntryModel("Silver Bullet"), null);
  assert.equal(resolveEntryModel("Modeli 4 — Silver Bullet"), null, "the number does not break the tie either");
  assert.equal(resolveEntryModel("Opening Range"), null);
  // Say which, and it resolves.
  assert.equal(resolveEntryModel("Silver Bullet AM").model.number, 7);
  assert.equal(resolveEntryModel("Opening Range PM").model.number, 13);
});

test("EM5 — Model 16 is a filter: registering it is refused outright", () => {
  assert.throws(
    () => applyEntryModel(validateWatchInput(setup({ setup_model: "High Resistance Conditions" })), {}),
    /PASS/,
  );
});

test("EM6 — Model 2 is LONG only and refuses a short", () => {
  const short = setup({ direction: "sell", entry: 4414, sl: 4430, tp1: 4380, setup_model: "Market Anchor" });
  assert.throws(() => applyEntryModel(validateWatchInput(short), {}), /lejon vetëm BUY/);
  assert.doesNotThrow(() => applyEntryModel(validateWatchInput(setup({ setup_model: "Market Anchor" })), {}));
});

test("EM7 — the model fills a blank default but never overrules a declared one", () => {
  const args = { setup_model: "Turtle Soup" };
  const filled = applyEntryModel(validateWatchInput(setup(args)), args);
  assert.equal(filled.defence_profile, "rejection_displacement");

  const declared = { setup_model: "Turtle Soup", defence_profile: "standard" };
  const kept = applyEntryModel(validateWatchInput(setup(declared)), declared);
  assert.equal(kept.defence_profile, "standard", "§22 — the analyst's declaration wins");
});

test("EM8 — a session window withholds before it opens and invalidates after it closes", () => {
  const sb = entryModelByNumber(7); // 10:00–11:00 NY
  const before = evaluateModelGate(sb, { nowMs: Date.parse("2026-09-09T13:00:00Z") }); // 09:00 NY
  assert.equal(before.pass, false);
  assert.equal(before.blockers[0].code, "MODEL_WINDOW_PENDING");
  assert.equal(before.expired, false, "before the window the setup is waiting, not dead");

  const during = evaluateModelGate(sb, { nowMs: Date.parse("2026-09-09T14:30:00Z") }); // 10:30 NY
  assert.equal(during.pass, true);

  const after = evaluateModelGate(sb, { nowMs: Date.parse("2026-09-09T16:00:00Z") }); // 12:00 NY
  assert.equal(after.pass, false);
  assert.equal(after.expired, true, "the Silver Bullet declares its own window close an invalidation");
});

// A real MULTISNIPER07 v6.0 output, pasted verbatim. The operator does
// not write these — Gemini does, and he pastes them whole — so the exact
// shape it emits is the contract, not a shape anyone can be asked to
// adjust. This test is the one that would have caught the window gate
// refusing it.
const REAL_PASTE = `🎯 ZERO FLOAT ENTRY
INSTRUMENT: BTCUSD
DREJTIMI: 📉 SHORT
MODEL: 13 (Opening Range PM — First Presented FVG)
HTF BIAS: BEARISH · Premium
PDA: Bearish FVG (77366 - 77450) · Rank 1st

🟢 ENTRY: 77408.00 — FVG CE (Consequent Encroachment)
🔴 SL: 77550.00 — Anchor 77538 + buffer
🎯 TP1: 77065.00 — Low Hanging Fruit (M1 SSL)
🎯 TP2: 76814.00 — M5 SSL Target
🎯 TP3: 76642.00 — HTF ERL (H1 Low)

RR: 1:2.4 | CONVICTION: A
INVALID: Body close mbi ekstremitetin e sipërm të FVG (77450)`;

test("EM8b — a real pasted v6.0 setup registers whole, model and all", () => {
  const { parsed } = parseSetupText(REAL_PASTE);
  const watch = applyEntryModel(validateWatchInput(parsed), parsed);

  assert.equal(watch.symbol, "BTCUSD");
  assert.equal(watch.direction, "sell");
  assert.equal(watch.entry, 77408);
  assert.equal(watch.entry_zone_low, 77366);
  assert.equal(watch.entry_zone_high, 77450);
  assert.equal(watch.sl, 77550);
  assert.equal(watch.invalidation, 77450);
  assert.deepEqual([watch.tp1, watch.tp2, watch.tp3], [77065, 76814, 76642]);

  // "13 (Opening Range PM — First Presented FVG)" — number and name agree.
  assert.equal(watch.entry_model.number, 13);
  assert.equal(watch.defence_profile, "rejection_displacement", "the model filled the blank");
  assert.equal(watch.invalidation_rule, "body_close");
});

test("EM8c — an Opening Range setup is not withheld for being early", () => {
  // This setup was issued at 13:41 NY, inside the PM Opening Range and
  // before the 14:00 a strict reading of Model 13 wants. Its own declared
  // invalidation is a price event — "thyerja e kufirit të kundërt të
  // Opening Range" — so the clock is context, not a gate. Withholding it
  // here would have cost nineteen minutes and probably the entry.
  const model = entryModelByNumber(13);
  const gate = evaluateModelGate(model, { nowMs: Date.parse("2026-09-10T17:41:00Z"), direction: "sell" });
  assert.equal(gate.pass, true);
  assert.equal(gate.expired, false);
  assert.equal(gate.blockers.length, 0);
  assert.match(gate.notes.join(" "), /nuk ka hapur ende/, "still reported, just not as a refusal");
});

test("EM8d — only the Silver Bullets hold a hard clock", () => {
  // The rule: a window blocks exactly where the model's own Invalidation
  // line names the window. That is §5.1's three windows and nothing else.
  const hard = ENTRY_MODELS.filter((m) => m.policy.window && m.policy.windowMode === "HARD");
  assert.deepEqual(hard.map((m) => m.number), [6, 7, 8]);
  for (const model of hard) assert.match(model.invalidation, /dritares kohore/);
  for (const model of ENTRY_MODELS.filter((m) => m.policy.window && m.policy.windowMode !== "HARD")) {
    assert.doesNotMatch(model.invalidation, /dritares kohore/, `model ${model.number}`);
  }
});

test("EM9 — a model with no window never blocks and never expires", () => {
  const gate = evaluateModelGate(entryModelByNumber(19), { nowMs: BASE, direction: "buy" });
  assert.equal(gate.pass, true);
  assert.equal(gate.expired, false);
  assert.equal(gate.window.state, "NONE");
});

test("EM10 — the Time Stop allowance halves outside a kill zone, with a floor", () => {
  const sb = entryModelByNumber(6); // 6 bars
  assert.equal(timeStopBarsFor(sb, { killZoneActive: true }), 6);
  assert.equal(timeStopBarsFor(sb, { killZoneActive: false }), 4, "floored at 4, never below");
  assert.equal(timeStopBarsFor(sb, { killZoneActive: true, override: 20 }), 20);
});

// --- kill-switch inputs -----------------------------------------------------

test("KS1 — a Breaker on the wrong side of the entry is refused, not dropped", () => {
  const bounds = { direction: "buy", entry: 4414, sl: 4400 };
  assert.throws(() => validateKillSwitchInput({ breaker_level: 4420 }, bounds), /below entry/);
  assert.equal(validateKillSwitchInput({ breaker_level: 4405 }, bounds).breaker_level, 4405);
});

test("KS2 — a PDA array outside the entry-to-stop corridor is refused", () => {
  const bounds = { direction: "buy", entry: 4414, sl: 4400 };
  assert.throws(() => validateKillSwitchInput({ pda_arrays: [4390] }, bounds), /between entry and sl/);
  assert.deepEqual(validateKillSwitchInput({ pda_arrays: [4410, 4410, 4406] }, bounds).pda_arrays, [4410, 4406]);
});

test("KS3 — nothing declared arms nothing", () => {
  const armed = validateKillSwitchInput({}, { direction: "buy", entry: 4414, sl: 4400 });
  assert.deepEqual(armed, {
    breaker_level: null,
    htf_pda_level: null,
    htf_weekly_confirmed: false,
    pda_arrays: null,
    time_stop_bars: null,
  });
});

// --- the switches themselves ------------------------------------------------

const trade = (over = {}) => ({
  direction: "buy",
  entry: 100,
  sl: 99,
  tp1: 102,
  openedAtMs: BASE,
  ...over,
});

const flat = Array.from({ length: 20 }, (_, i) => bar(BASE + i * 300_000, 100, 100.3, 99.7, 100.05));

test("KS4 — the Breaker switch fires on a body close through it, not on a wick", () => {
  const wicked = [...flat, bar(BASE + 20 * 300_000, 100, 100.1, 99.2, 99.9)];
  const held = evaluateBreakerPrecedence(trade({ breaker_level: 99.5 }), wicked);
  assert.equal(held.fired, false, "a wick through the Breaker is a raid on the stops behind it");

  const closed = [...flat, bar(BASE + 20 * 300_000, 99.8, 99.85, 99.2, 99.3)];
  const broken = evaluateBreakerPrecedence(trade({ breaker_level: 99.5 }), closed);
  assert.equal(broken.fired, true);
  assert.match(broken.reason, /Breaker Block 99.5/);
});

test("KS5 — an unarmed switch reports unarmed and never fires", () => {
  const result = evaluateBreakerPrecedence(trade(), flat);
  assert.equal(result.armed, false);
  assert.equal(result.fired, false);
});

test("KS6 — candles that cannot be read are unknown, never a pass", () => {
  const result = evaluateBreakerPrecedence(trade({ breaker_level: 99.5 }), []);
  assert.equal(result.known, false);
  assert.equal(result.fired, false);
});

test("KS7 — a broken Daily PDA cascades with a Weekly behind it and kills without one", () => {
  const daily = [bar(BASE - 86_400_000, 99.5, 99.6, 98.4, 98.5)];
  const killed = evaluateHtfCascade(trade({ htf_pda_level: 98.8 }), daily);
  assert.equal(killed.fired, true);

  const cascaded = evaluateHtfCascade(trade({ htf_pda_level: 98.8, htf_weekly_confirmed: true }), daily);
  assert.equal(cascaded.fired, false, "Iron Rule 14 — follow the cascade, do not flip the bias");
  assert.match(cascaded.reason, /cascade/);
});

test("KS8 — three arrays broken is the exit, and each level counts once", () => {
  const position = trade({ pda_arrays: [99.8, 99.6, 99.4] });
  const bars = [
    bar(BASE, 100, 100.1, 99.7, 99.75),
    bar(BASE + 300_000, 99.75, 99.8, 99.5, 99.55),
    bar(BASE + 600_000, 99.55, 99.6, 99.3, 99.35),
  ];
  const first = advancePdaArraysBroken(null, position, bars.slice(0, 2));
  assert.equal(first.count, 2);
  assert.equal(first.fired, false);

  const second = advancePdaArraysBroken(first, position, bars);
  assert.equal(second.count, 3);
  assert.equal(second.fired, true);
  assert.equal(second.newlyFired, true);

  // Re-reading the same bars must not push the count past what happened.
  const third = advancePdaArraysBroken(second, position, bars);
  assert.equal(third.count, 3);
  assert.equal(third.newlyFired, false, "already fired — it does not re-announce itself");
});

test("KS9 — the Time Stop waits for its candles, then judges the best excursion", () => {
  const early = evaluateTimeStop(trade(), flat.slice(0, 5), { barsAllowed: 12 });
  assert.equal(early.fired, false);
  assert.match(early.reason, /5\/12/);

  const stalled = evaluateTimeStop(trade(), flat, { barsAllowed: 12, minProgress: 0.5 });
  assert.equal(stalled.fired, true, "20 bars and nowhere near TP1 is Time Distortion");

  // The same 20 bars, but price was offered 60% of the way to TP1 and
  // came back: delivered, so not a Time Distortion.
  const delivered = [...flat.slice(0, 19), bar(BASE + 19 * 300_000, 100, 101.3, 99.9, 100.1)];
  const moved = evaluateTimeStop(trade(), delivered, { barsAllowed: 12, minProgress: 0.5 });
  assert.equal(moved.fired, false);
  assert.match(moved.reason, /dorëzohet/);
});
