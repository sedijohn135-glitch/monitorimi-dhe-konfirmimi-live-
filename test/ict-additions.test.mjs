/**
 * ICT-additions suite — four signals added from a direct reading of
 * ICT's own material (raw lecture transcripts, not the abandoned
 * screenshot-workflow prompt pile): the NY midnight open and the Judas
 * Swing read from it, PDA confluence as its own graduated technical
 * signal, the macro timing windows, and post-entry structural failure.
 * None of them replace or gate anything that already existed — each one
 * is either an additional way to graduate (alongside CISD/SMT/pattern,
 * under the same hold-and-fade rule) or purely advisory.
 *
 *   node --test test/ict-additions.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkMidnightJudas, nyMidnightOpen, pdaConfluence } from "../lib/ict.mjs";
import { advanceStructureFailure, evaluateConfirmation, macroStatus } from "../lib/core.mjs";

const M5 = 5 * 60_000;

function bar(t, open, high, low, close) {
  return { open, high, low, close, timestampMs: t, volume: 1 };
}

// 00:00 New York (EST, UTC-5) on Thursday 8 January 2026.
const MIDNIGHT = Date.parse("2026-01-08T05:00:00Z");

const CTX = (over = {}) => ({
  nowMs: 1_000_000,
  generation: 1,
  hasBarTime: true,
  minHoldMs: 60_000,
  requireNewBar: true,
  mid: 100,
  tolerance: 0.01,
  ...over,
});

// ---------------------------------------------------------------------------
// §18 NY midnight open

test("MIDNIGHT — the open is read from the bar landing in the midnight slot", () => {
  const bars = [
    bar(MIDNIGHT - 2 * M5, 4318, 4322, 4300, 4315),
    bar(MIDNIGHT - M5, 4315, 4321, 4300, 4312),
    bar(MIDNIGHT, 4310, 4313, 4308, 4311),
    bar(MIDNIGHT + M5, 4311, 4312, 4295, 4305),
  ];
  const midnight = nyMidnightOpen(bars);
  assert.equal(midnight.price, 4310);
  assert.equal(midnight.at, MIDNIGHT);
});

test("MIDNIGHT — unavailable, not absent, when the window does not reach back that far", () => {
  const bars = [bar(MIDNIGHT + M5, 4311, 4312, 4295, 4305), bar(MIDNIGHT + 2 * M5, 4305, 4310, 4304, 4308)];
  assert.equal(nyMidnightOpen(bars), null);
});

// ---------------------------------------------------------------------------
// §19 Midnight Judas Swing

function judasBars() {
  return [
    bar(MIDNIGHT - 3 * M5, 4320, 4322, 4318, 4320),
    bar(MIDNIGHT - 2 * M5, 4320, 4321, 4300, 4315), // strict low swing at 4300
    bar(MIDNIGHT - M5, 4315, 4318, 4310, 4312),
    bar(MIDNIGHT, 4310, 4313, 4308, 4311), // midnight open = 4310
    bar(MIDNIGHT + M5, 4311, 4312, 4295, 4305), // sweeps 4300, closes back above it, still below 4310
    bar(MIDNIGHT + 2 * M5, 4305, 4318, 4304, 4315), // closes back above the midnight open
  ];
}

test("JUDAS — present is null before the midnight open is even in view", () => {
  const bars = judasBars().slice(0, 2);
  assert.equal(checkMidnightJudas(bars, "buy").present, null);
});

test("JUDAS — swept but not yet reclaimed is false, not present", () => {
  const bars = judasBars().slice(0, 5);
  const result = checkMidnightJudas(bars, "buy");
  assert.equal(result.present, false);
  assert.equal(result.midnightOpen, 4310);
});

test("JUDAS — sweep of the near swing plus a reclaim through the midnight open is present", () => {
  const bars = judasBars();
  const result = checkMidnightJudas(bars, "buy");
  assert.equal(result.present, true);
  assert.equal(result.midnightOpen, 4310);
});

test("JUDAS — direction is read from which side got swept, not asserted", () => {
  // The same bullish sweep-and-reclaim proves nothing for a sell read.
  const bars = judasBars();
  assert.equal(checkMidnightJudas(bars, "sell").present, false);
});

// ---------------------------------------------------------------------------
// §18b PDA confluence

test("CONFLUENCE — an FVG and an order block agreeing on one level count as two hits", () => {
  const bars = [
    bar(0, 4315, 4316, 4304, 4305), // bearish candle: OB meanThreshold = 4310
    bar(M5, 4305, 4309, 4304, 4308), // FVG leg a: high 4309
    bar(2 * M5, 4308, 4320, 4307, 4318),
    bar(3 * M5, 4318, 4322, 4312, 4320), // FVG leg c: low 4312 > 4309 -> bullish gap, ce 4310.5
  ];
  const result = pdaConfluence(bars, 4310, "buy", { tolerancePercent: 0.1 });
  assert.ok(result.count >= 2, `expected at least 2 hits, got ${result.count}`);
  const types = result.hits.map((hit) => hit.type);
  assert.ok(types.includes("OB"));
  assert.ok(types.includes("BISI"));
});

test("CONFLUENCE — a level with nothing near it scores zero", () => {
  const bars = [
    bar(0, 4315, 4316, 4304, 4305),
    bar(M5, 4305, 4309, 4304, 4308),
    bar(2 * M5, 4308, 4320, 4307, 4318),
    bar(3 * M5, 4318, 4322, 4312, 4320),
  ];
  const result = pdaConfluence(bars, 4000, "buy", { tolerancePercent: 0.1 });
  assert.equal(result.count, 0);
});

// ---------------------------------------------------------------------------
// §6 Macro windows — informational, never a gate

test("MACRO — active inside a published window, inactive just outside it, off on weekends", () => {
  assert.equal(macroStatus(Date.parse("2026-01-07T15:55:00Z")).active, true); // 10:55 NY, Wed
  assert.equal(macroStatus(Date.parse("2026-01-07T15:55:00Z")).window, "10:50-11:10 Macro");
  assert.equal(macroStatus(Date.parse("2026-01-07T15:20:00Z")).active, false); // 10:20 NY, Wed
  assert.equal(macroStatus(Date.parse("2026-01-10T15:55:00Z")).active, false); // 10:55 NY, Saturday
});

// ---------------------------------------------------------------------------
// §20 Post-entry structural failure — advisory, never self-resolving

function structureBars() {
  return {
    b0: bar(0, 102, 105, 100, 103),
    b1: bar(M5, 92, 95, 90, 93), // strict low swing at 90
    b2: bar(2 * M5, 96, 99, 95, 98),
    b3: bar(3 * M5, 94, 97, 93, 96),
    b4: bar(4 * M5, 92, 93, 85, 82), // closes through the 90 swing: break #1
    b5: bar(5 * M5, 81, 83, 78, 80), // a second close against the position: break #2
  };
}

test("STRUCTURE — insufficient history reports unavailable, not a break", () => {
  const s = structureBars();
  const state = advanceStructureFailure(null, [s.b0, s.b1, s.b2], "buy", { strength: 1, limit: 2 });
  assert.equal(state.count, 0);
  assert.equal(state.defensiveExit, false);
});

test("STRUCTURE — each fresh close against the position counts once, defensiveExit only at the limit", () => {
  const s = structureBars();
  let state = advanceStructureFailure(null, [s.b0, s.b1, s.b2, s.b3, s.b4], "buy", { strength: 1, limit: 2 });
  assert.equal(state.count, 1);
  assert.equal(state.defensiveExit, false);

  state = advanceStructureFailure(state, [s.b0, s.b1, s.b2, s.b3, s.b4, s.b5], "buy", { strength: 1, limit: 2 });
  assert.equal(state.count, 2);
  assert.equal(state.defensiveExit, true);

  // Re-evaluating the same closed bar again must not double-count it.
  const repeated = advanceStructureFailure(state, [s.b0, s.b1, s.b2, s.b3, s.b4, s.b5], "buy", {
    strength: 1,
    limit: 2,
  });
  assert.equal(repeated.count, 2);
});

// ---------------------------------------------------------------------------
// Wired into confirmation as additional graduated technical signals

test("CONFIRMATION — a midnight Judas Swing graduates like any other technical signal", () => {
  const watch = { direction: "buy", entry: 100, sl: 99, tp1: 104, evidence: {} };
  const signals = {
    cisd: false,
    smt: null,
    engulfM5: "none",
    engulfM1: "none",
    wick: "none",
    acceptance: true,
    midnightJudas: true,
    confluence: false,
  };
  let state = { ...watch };
  let result;
  for (const nowMs of [0, 70_000, 140_000]) {
    result = evaluateConfirmation(state, signals, CTX({ nowMs, generation: nowMs / 70_000 + 1 }));
    state = { ...state, evidence: result.evidence };
  }
  assert.equal(result.enter, true);
  assert.ok(result.signals.includes("Midnight Open Judas Swing"));
  assert.equal(result.strength, "STRONG");
});

test("CONFIRMATION — PDA confluence graduates like any other technical signal", () => {
  const watch = { direction: "buy", entry: 100, sl: 99, tp1: 104, evidence: {} };
  const signals = {
    cisd: false,
    smt: null,
    engulfM5: "none",
    engulfM1: "none",
    wick: "none",
    acceptance: true,
    midnightJudas: false,
    confluence: true,
  };
  let state = { ...watch };
  let result;
  for (const nowMs of [0, 70_000, 140_000]) {
    result = evaluateConfirmation(state, signals, CTX({ nowMs, generation: nowMs / 70_000 + 1 }));
    state = { ...state, evidence: result.evidence };
  }
  assert.equal(result.enter, true);
  assert.ok(result.signals.includes("PDA Confluence"));
});
