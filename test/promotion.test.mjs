/**
 * Promotion suite — the ported primitives, the hard gates, and the
 * geometry that turns a confirmed trap into a setup.
 *
 * The port is tested against the Python script's own conventions rather
 * than against whatever the JS happens to do, because a port that
 * quietly disagrees with the analysis pipeline produces setups nobody
 * would have taken by hand — and does it silently.
 *
 *   node --test test/promotion.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  displacementBars,
  displacementRatioAt,
  equalLevels,
  fairValueGaps,
  liquiditySweeps,
  minutesUntilWindow,
  orderBlockBefore,
  parseTrapScore,
  premiumDiscount,
  strictSwings,
  structureBreaks,
  workingRange,
} from "../lib/ict.mjs";
import {
  computePromotedSetup,
  confirmingDisplacement,
  evaluatePromotionGates,
  killZoneOutlook,
  validateSetupShape,
} from "../lib/promotion.mjs";

const M15 = 15 * 60_000;

function bar(index, open, high, low, close) {
  return { open, high, low, close, timestampMs: index * M15, volume: 1 };
}

// ---------------------------------------------------------------------------
// The ported primitives

test("P1 — a swing is the strict 3-candle rule, not the extreme of a window", () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 103, 99.5, 102), // swing high 103
    bar(2, 102, 102, 98, 99), // swing low 98
    bar(3, 99, 101, 98.5, 100),
  ];
  const swings = strictSwings(bars);
  assert.deepEqual(
    swings.map((swing) => [swing.kind, swing.price]),
    [
      ["high", 103],
      ["low", 98],
    ],
  );

  // A monotonic drift has no swings at all, however far it travels.
  const drift = Array.from({ length: 20 }, (_, i) => bar(i, 100 - i, 100.5 - i, 99.5 - i, 99.8 - i));
  assert.equal(strictSwings(drift).length, 0);
});

test("P2 — structure breaks are body closes; a wick through a swing is not one", () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 103, 99.5, 102),
    bar(2, 102, 102.5, 98, 99),
    bar(3, 99, 100, 98.5, 99.5),
    bar(4, 99.5, 104, 99, 102.5), // wick through 103, closes below
  ];
  assert.equal(structureBreaks(bars, strictSwings(bars)).length, 0);

  const closingBreak = [...bars, bar(5, 102.5, 104.5, 102, 103.5)];
  const events = structureBreaks(closingBreak, strictSwings(closingBreak));
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, "bullish");
  assert.equal(events[0].level, 103);
});

test("P3 — an FVG carries both boundaries and how deeply price came back", () => {
  const bars = [
    bar(0, 100, 101, 99, 100.5),
    bar(1, 100.5, 106, 100.5, 105.5),
    bar(2, 105.5, 107, 102, 106), // gap 101 → 102
    bar(3, 106, 106.5, 101.5, 102),
  ];
  const gaps = fairValueGaps(bars);
  assert.equal(gaps.length, 1);
  const gap = gaps[0];
  assert.equal(gap.label, "BISI");
  assert.equal(gap.low, 101);
  assert.equal(gap.high, 102);
  assert.equal(gap.ce, 101.5);
  assert.ok(gap.wickPenetration > gap.bodyPenetration, "the wick went deeper than the body");
});

test("P4 — an FVG a body closed through is inverted, not merely filled", () => {
  const bars = [
    bar(0, 100, 101, 99, 100.5),
    bar(1, 100.5, 106, 100.5, 105.5),
    bar(2, 105.5, 107, 102, 106),
    bar(3, 106, 106.5, 99, 99.5), // closes below the gap entirely
  ];
  const gap = fairValueGaps(bars)[0];
  assert.equal(gap.inverted, true);
  assert.match(gap.status, /INVERTED/);
});

test("P5 — the displacement ratio is unmeasurable, not zero, without history", () => {
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 101, 99, 100.5));
  assert.equal(displacementRatioAt(bars, 9, 20), null);
});

test("P6 — a drift through a level does not qualify as displacement", () => {
  // Twenty ~1.0 bodies, then a 0.8 body: exactly the XAUUSD case the
  // whole gate exists for.
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 101));
  bars.push(bar(20, 101, 101.2, 100, 100.2));
  const ratio = confirmingDisplacement(bars, { window: 20 });
  assert.ok(ratio !== null);
  assert.ok(ratio < 1, `expected a sub-1x ratio, got ${ratio}`);

  const found = displacementBars(bars, { multiple: 3, window: 20 });
  assert.equal(found.length, 0, "a near-miss below two thirds of the threshold is not even reported");
});

test("P7 — a real delivery candle qualifies and reports its ratio", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, 100.5, 99.5, 100.2));
  bars.push(bar(20, 100.2, 100.3, 96, 96.2)); // body 4.0 vs average 0.2
  const ratio = confirmingDisplacement(bars, { window: 20 });
  assert.ok(ratio >= 3, `expected ≥3x, got ${ratio}`);
  const found = displacementBars(bars, { multiple: 3, window: 20 });
  assert.equal(found.at(-1).qualifies, true);
  assert.equal(found.at(-1).direction, "bearish");
});

test("P8 — a sweep is a wick beyond a swing that does not hold", () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 103, 99.5, 102),
    bar(2, 102, 102.5, 98, 99),
    bar(3, 99, 104, 98.5, 101), // takes 103, closes back below
  ];
  const sweep = liquiditySweeps(bars, strictSwings(bars));
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].side, "BSL");
  assert.equal(sweep[0].swept, 103);
});

test("P9 — equal highs cluster only within tolerance", () => {
  const swings = [
    { index: 1, kind: "high", price: 100.0, at: 1 },
    { index: 5, kind: "high", price: 100.02, at: 2 },
    { index: 9, kind: "high", price: 110.0, at: 3 },
  ];
  const clusters = equalLevels(swings, "high", 0.03);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].touches, 2);
  assert.equal(clusters[0].kind, "EQH");
});

test("P10 — premium and discount are read from the range, not from a guess", () => {
  const high = premiumDiscount(110, 100, 108);
  assert.equal(high.zone, "PREMIUM");
  assert.equal(high.favours, "sell");
  assert.equal(high.deep, true);
  assert.equal(premiumDiscount(110, 100, 102).zone, "DISCOUNT");
  assert.equal(premiumDiscount(100, 100, 100), null);
});

test("P11 — the order block is the last opposing candle before the leg", () => {
  const bars = [
    bar(0, 100, 101, 99, 100.8),
    bar(1, 100.8, 101.2, 100, 100.2), // bearish
    bar(2, 100.2, 101, 100, 100.9), // bullish — the block for a sell
    bar(3, 100.9, 101, 97, 97.2), // bearish displacement
  ];
  const block = orderBlockBefore(bars, 3, "sell");
  assert.equal(block.index, 2);
  assert.ok(Math.abs(block.meanThreshold - 100.55) < 1e-9);
});

test("P12 — trap scores parse from the shapes the pipeline writes", () => {
  assert.deepEqual(parseTrapScore("7/9"), { value: 7, outOf: 9 });
  assert.deepEqual(parseTrapScore("Grade B (6/9)"), { value: 6, outOf: 9 });
  assert.deepEqual(parseTrapScore("8"), { value: 8, outOf: 9 });
  assert.equal(parseTrapScore("high conviction"), null);
  assert.equal(parseTrapScore(null), null);
});

test("P13 — a window that is open is zero minutes away", () => {
  const window = { start: "07:00", end: "10:00" };
  assert.equal(minutesUntilWindow(8 * 60, window), 0);
  assert.equal(minutesUntilWindow(6 * 60 + 50, window), 10);
  // Wraps midnight rather than reporting a negative wait.
  assert.equal(minutesUntilWindow(11 * 60, window), 20 * 60);
});

// ---------------------------------------------------------------------------
// The gates

function gateInput(overrides = {}) {
  return {
    enabled: true,
    session: { active: true, zone: "NY Open KZ", minutesAway: 0, openingSoon: false },
    requireKillZone: true,
    killZoneLookaheadMinutes: 10,
    news: { blocked: false, source: "scheduled" },
    requireNewsClear: true,
    displacementRatio: 3.4,
    displacementMultiple: 3,
    trapScore: "7/9",
    minTrapScore: 6,
    invalidationTouched: false,
    ...overrides,
  };
}

test("P14 — a clean confirmation passes every gate", () => {
  const result = evaluatePromotionGates(gateInput());
  assert.equal(result.pass, true);
  assert.equal(result.gates.length, 6);
  assert.ok(result.gates.every((gate) => gate.detail));
});

test("P15 — the 0.8x drift is refused by the displacement gate", () => {
  const result = evaluatePromotionGates(gateInput({ displacementRatio: 0.83 }));
  assert.equal(result.pass, false);
  assert.deepEqual(result.failed, ["displacement"]);
  assert.match(result.failedGates[0].detail, /0\.83x vs 3x/);
});

test("P16 — an unmeasurable displacement ratio is a refusal, not a pass", () => {
  const result = evaluatePromotionGates(gateInput({ displacementRatio: null }));
  assert.equal(result.pass, false);
  assert.deepEqual(result.failed, ["displacement"]);
});

test("P17 — a missing trap score blocks promotion", () => {
  const missing = evaluatePromotionGates(gateInput({ trapScore: null }));
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.failed, ["trap_score"]);

  const low = evaluatePromotionGates(gateInput({ trapScore: "4/9" }));
  assert.deepEqual(low.failed, ["trap_score"]);

  // Scores on another scale are normalised rather than misread.
  const other = evaluatePromotionGates(gateInput({ trapScore: "8/10" }));
  assert.equal(other.pass, true);
});

test("P18 — a kill zone opening shortly counts, one hours away does not", () => {
  const soon = evaluatePromotionGates(
    gateInput({ session: { active: false, next: "NY Open KZ", minutesAway: 7, openingSoon: true } }),
  );
  assert.equal(soon.pass, true);

  const later = evaluatePromotionGates(
    gateInput({ session: { active: false, next: "London Open KZ", minutesAway: 240, openingSoon: false } }),
  );
  assert.deepEqual(later.failed, ["kill_zone"]);

  const lunch = evaluatePromotionGates(
    gateInput({ session: { active: false, inLunch: true, next: "London Close", minutesAway: 20 } }),
  );
  assert.deepEqual(lunch.failed, ["kill_zone"]);
});

test("P19 — news blackout and a tagged flip level each block on their own", () => {
  const news = evaluatePromotionGates(
    gateInput({ news: { blocked: true, reason: "FOMC (USD)", source: "scheduled" } }),
  );
  assert.deepEqual(news.failed, ["news"]);

  const tagged = evaluatePromotionGates(
    gateInput({ invalidationTouched: true, invalidationTouchedPrice: 4368.31 }),
  );
  assert.deepEqual(tagged.failed, ["invalidation_untouched"]);
});

test("P20 — every failing gate is reported, not just the first", () => {
  const result = evaluatePromotionGates(
    gateInput({ displacementRatio: 0.7, trapScore: "3/9", invalidationTouched: true }),
  );
  assert.deepEqual(result.failed.sort(), ["displacement", "invalidation_untouched", "trap_score"]);
});

test("P21 — an unarmed promotion reports itself as the reason", () => {
  const result = evaluatePromotionGates(
    gateInput({ enabled: false, enabledReason: "AUTO_PROMOTE_TRAPS is not true" }),
  );
  assert.equal(result.pass, false);
  assert.deepEqual(result.failed, ["auto_promote_enabled"]);
});

test("P22 — the kill-zone outlook never reports a negative wait", () => {
  for (let minute = 0; minute < 1440; minute += 7) {
    const outlook = killZoneOutlook(Date.UTC(2026, 0, 5) + minute * 60_000, 10);
    assert.ok(outlook.minutesAway >= 0, `negative wait at minute ${minute}`);
  }
});

// ---------------------------------------------------------------------------
// The geometry

/**
 * A bearish trap that actually delivered: chop, a swing high to stop
 * behind, an unfilled SIBI to enter from, and a displacement close.
 */
function bearishScenario() {
  const bars = [];
  for (let i = 0; i < 22; i += 1) {
    const drift = i * 0.1;
    bars.push(bar(i, 4340 - drift, 4341 - drift, 4339 - drift, 4340.2 - drift));
  }
  bars.push(bar(22, 4338, 4346, 4337.5, 4345)); // swing high 4346
  bars.push(bar(23, 4345, 4345.5, 4338, 4338.5));
  bars.push(bar(24, 4338.5, 4339, 4330, 4330.5)); // leg down
  bars.push(bar(25, 4330.5, 4331, 4326, 4326.5)); // gap: 4339 → 4331 is SIBI
  bars.push(bar(26, 4326.5, 4327, 4322, 4322.5));
  bars.push(bar(27, 4322.5, 4323, 4318, 4318.5));
  bars.push(bar(28, 4318.5, 4319, 4316, 4317));
  bars.push(bar(29, 4317, 4317.5, 4300, 4301)); // displacement close through 4310
  return bars;
}

/**
 * The higher timeframe the leg is delivering into. Without it the only
 * level below entry is the low price just made, which is correctly
 * refused as too close — a trap that has run out of room is not a setup.
 */
function bearishHtf() {
  return Array.from({ length: 30 }, (_, i) =>
    bar(i, 4350 - i * 2, 4360 - i * 2, 4340 - i * 2, 4345 - i * 2),
  );
}

test("P23 — a delivered bearish trap produces a coherent setup", () => {
  const bars = bearishScenario();
  const result = computePromotedSetup({
    bars,
    htfBars: bearishHtf(),
    direction: "sell",
    triggerLevel: 4310,
    tolerance: 0.1,
    atr: 4,
    minRR: 1,
    timeframe: "M15",
  });
  assert.equal(result.ok, true, result.reason);
  const setup = result.setup;
  assert.ok(setup.entry > setup.entry_zone_low && setup.entry < setup.entry_zone_high);
  assert.ok(setup.sl > setup.entry_zone_high, "the stop sits beyond the entry zone");
  assert.ok(setup.tp1 < setup.entry, "the target is below entry for a sell");
  assert.ok(setup.rr >= 1, `tp1 is ${setup.rr}R`);
  assert.equal(validateSetupShape(setup), null);
  assert.match(setup.setup_model, /Trap promotion/);
  assert.ok(setup.rationale.includes("stop beyond"));
});

test("P24 — the entry is an array, never the level price just displaced through", () => {
  const bars = bearishScenario();
  const setup = computePromotedSetup({
    bars,
    htfBars: bearishHtf(),
    direction: "sell",
    triggerLevel: 4310,
    tolerance: 0.1,
    atr: 4,
    minRR: 1,
  }).setup;
  assert.ok(setup.entry > bars.at(-1).close, "a sell entry sits above the displaced close");
  assert.ok(["SIBI", "ORDER_BLOCK", "BREAKER"].includes(setup.array));
});

test("P25 — targets are real levels, ordered, and separated", () => {
  const bars = bearishScenario();
  const setup = computePromotedSetup({
    bars,
    htfBars: bearishHtf(),
    direction: "sell",
    triggerLevel: 4310,
    tolerance: 0.1,
    atr: 4,
    minRR: 1,
  }).setup;
  const targets = [setup.tp1, setup.tp2, setup.tp3].filter((value) => value !== null);
  for (let i = 1; i < targets.length; i += 1) {
    assert.ok(targets[i] < targets[i - 1], "sell targets descend");
    assert.ok(
      Math.abs(targets[i] - targets[i - 1]) >= setup.risk * 0.5,
      "targets are separated by at least half an R",
    );
  }
  assert.ok(setup.targets.every((target) => target.label));
});

test("P26 — a setup with no target at least 1R away refuses instead of shrinking the stop", () => {
  const bars = bearishScenario();
  const result = computePromotedSetup({
    bars,
    htfBars: bearishHtf(),
    direction: "sell",
    triggerLevel: 4310,
    tolerance: 0.1,
    atr: 4,
    minRR: 25, // nothing on this chart is 25R away
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /R from entry|no liquidity/);
});

test("P27 — too little history refuses rather than inventing structure", () => {
  const result = computePromotedSetup({
    bars: [bar(0, 100, 101, 99, 100)],
    direction: "sell",
    triggerLevel: 99,
    tolerance: 0.1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not enough/);
});

test("P28 — the shape validator enforces exactly what register_watch enforces", () => {
  assert.match(
    validateSetupShape({ direction: "sell", entry: 100, sl: 99, tp1: 90 }),
    /sell entry must sit below its stop/,
  );
  assert.match(
    validateSetupShape({ direction: "buy", entry: 100, sl: 99, tp1: 100.5 }),
    /0\.50R/,
  );
  assert.equal(validateSetupShape({ direction: "buy", entry: 100, sl: 99, tp1: 102 }), null);
});

test("P29 — a bullish trap mirrors, it does not fall through to the sell branch", () => {
  const bars = bearishScenario().map((item, index) =>
    bar(index, 8700 - item.open, 8700 - item.low, 8700 - item.high, 8700 - item.close),
  );
  const result = computePromotedSetup({
    bars,
    htfBars: bearishHtf().map((item, index) =>
      bar(index, 8700 - item.open, 8700 - item.low, 8700 - item.high, 8700 - item.close),
    ),
    direction: "buy",
    triggerLevel: 8700 - 4310,
    tolerance: 0.1,
    atr: 4,
    minRR: 1,
  });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.setup.sl < result.setup.entry_zone_low);
  assert.ok(result.setup.tp1 > result.setup.entry);
});

test("P30 — the working range is the basis for the equilibrium target", () => {
  const range = workingRange(bearishScenario(), 60);
  assert.ok(range.high > range.low);
  assert.equal(range.equilibrium, (range.high + range.low) / 2);
});
