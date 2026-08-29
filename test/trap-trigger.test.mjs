/**
 * Trap-trigger suite — taking a level is a crossing, not a state.
 *
 * The failure this exists to make unreachable: a trap watch armed on the
 * already-broken side of its own trigger reporting "TRIGGER LEVEL TAKEN"
 * on its first post-arm candle, naming a break that never happened.
 *
 *   node --test test/trap-trigger.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { bodyClosedBeyond, triggerTaken, validateTrapWatchInput } from "../lib/core.mjs";

const M15 = 15 * 60_000;

function bar(index, open, high, low, close) {
  return { open, high, low, close, timestampMs: index * M15, volume: 1 };
}

// ---------------------------------------------------------------------------
// The reported case, with its real numbers.

test("TT1 — the live BTCUSD trap: price never crossed 77158, so nothing was taken", () => {
  // Registered: bias buy, trigger 77158, invalidation 76878.
  // Market: every M15 close far ABOVE the trigger, none below it.
  const bars = [
    bar(0, 77980, 78060, 77950, 78047),
    bar(1, 78047, 78090, 77960, 77976),
    bar(2, 77976, 78030, 77940, 77995.67),
  ];
  const take = triggerTaken(bars, 77158, "buy");

  assert.equal(take.taken, false, "no candle crossed the trigger, so it was never taken");
  // The state read on its own is what produced the false notification.
  assert.equal(take.comparison.beyond, true, "the raw state test is still true — that was the trap");
  assert.equal(take.comparison.previousClose, 77976);
  assert.match(take.reason, /already beyond/);
});

test("TT2 — the comparison is reported exactly, for the log", () => {
  const bars = [bar(0, 77980, 78060, 77950, 78047), bar(1, 78047, 78090, 77960, 77995.67)];
  const { comparison } = triggerTaken(bars, 77158, "buy");
  assert.deepEqual(comparison, {
    close: 77995.67,
    level: 77158,
    bias: "buy",
    operator: ">",
    beyond: true,
    previousClose: 78047,
  });
});

// ---------------------------------------------------------------------------
// A real crossing still works, both ways.

test("TT3 — a buy trap is taken by closing UP through its trigger", () => {
  const bars = [
    bar(0, 77100, 77140, 77050, 77090), // below the trigger
    bar(1, 77090, 77300, 77080, 77250), // closes up through it
  ];
  const take = triggerTaken(bars, 77158, "buy");
  assert.equal(take.taken, true);
  assert.equal(take.comparison.previousClose, 77090);
});

test("TT4 — a sell trap is taken by closing DOWN through its trigger", () => {
  const bars = [
    bar(0, 77200, 77260, 77180, 77250), // above the trigger
    bar(1, 77250, 77260, 77000, 77050), // closes down through it
  ];
  const take = triggerTaken(bars, 77158, "sell");
  assert.equal(take.taken, true);
  assert.equal(take.comparison.operator, "<");
});

test("TT5 — a sell trap sitting already below its trigger takes nothing", () => {
  const bars = [bar(0, 77000, 77040, 76900, 76950), bar(1, 76950, 77000, 76800, 76880)];
  assert.equal(triggerTaken(bars, 77158, "sell").taken, false);
});

// ---------------------------------------------------------------------------
// Direction is not negotiable: the convention the rest of the system
// enforces is buy = close above, sell = close below.

test("TT6 — a buy read is never taken by closing DOWN through its trigger", () => {
  const bars = [
    bar(0, 77200, 77260, 77180, 77250),
    bar(1, 77250, 77260, 77000, 77050), // a fall through the level
  ];
  assert.equal(triggerTaken(bars, 77158, "buy").taken, false, "a buy is taken upward, never downward");
  assert.equal(bodyClosedBeyond(bars.at(-1), 77158, "buy"), false);
});

test("TT7 — validation agrees: a buy's invalidation sits BELOW its trigger", () => {
  // This is what fixes the direction convention in place: if a buy were
  // taken by closing down through its trigger, the confirm and the flip
  // would overlap and a single close could be both.
  const ok = validateTrapWatchInput({
    symbol: "BTCUSD",
    bias: "buy",
    timeframe: "M15",
    trigger_level: 77158,
    invalidation_level: 76878,
  });
  assert.equal(ok.trigger_level, 77158);
  assert.ok(ok.invalidation_level < ok.trigger_level);
  assert.throws(
    () =>
      validateTrapWatchInput({
        symbol: "BTCUSD",
        bias: "buy",
        trigger_level: 77158,
        invalidation_level: 77500,
      }),
    /below trigger_level/,
  );
});

// ---------------------------------------------------------------------------
// Degenerate inputs report unavailability rather than a take.

test("TT8 — no candle, no prior candle, and a missing level all take nothing", () => {
  assert.equal(triggerTaken([], 77158, "buy").taken, false);
  assert.equal(triggerTaken(null, 77158, "buy").taken, false);
  assert.equal(triggerTaken([bar(0, 1, 2, 0.5, 1.5)], null, "buy").taken, false);
  // A single bar beyond the level cannot prove a crossing.
  const lone = triggerTaken([bar(0, 77200, 77300, 77180, 77250)], 77158, "buy");
  assert.equal(lone.taken, false);
  assert.match(lone.reason, /no prior closed candle/);
});

test("TT9 — price that leaves and genuinely returns through the trigger is taken", () => {
  // The watch is not killed when it arms on the wrong side: it self-heals
  // the moment a real crossing happens.
  const bars = [
    bar(0, 78000, 78100, 77900, 77990), // above (armed on the wrong side)
    bar(1, 77990, 78000, 77000, 77100), // falls back below
    bar(2, 77100, 77400, 77080, 77300), // closes back up through
  ];
  assert.equal(triggerTaken(bars.slice(0, 2), 77158, "buy").taken, false);
  assert.equal(triggerTaken(bars, 77158, "buy").taken, true);
});
