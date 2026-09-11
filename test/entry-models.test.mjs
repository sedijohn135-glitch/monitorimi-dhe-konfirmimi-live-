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

const bar = (timestampMs, open, high, low, close) => ({ open, high, low, close, timestampMs });
const BASE = Date.parse("2026-09-09T13:00:00Z"); // a Wednesday, 09:00 NY
const setup = (over = {}) => ({ symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450, ...over });

// --- the catalogue ----------------------------------------------------------

test("EM1 — all 22 models are present, numbered 1..22, with unique keys", () => {
  assert.equal(ENTRY_MODELS.length, 22);
  assert.deepEqual(ENTRY_MODELS.map((m) => m.number), Array.from({ length: 22 }, (_, i) => i + 1));
  assert.equal(new Set(ENTRY_MODELS.map((m) => m.key)).size, 22);
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
