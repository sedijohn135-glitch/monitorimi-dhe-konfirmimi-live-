/**
 * Execution suite. Same rule as the adversarial suite: each test names
 * the way a real order could go wrong, and passes only if the code makes
 * that outcome unreachable rather than unlikely.
 *
 *   node --test test/execution.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceEntrySequence,
  checkMSS,
  checkZoneRejection,
  computeOrderVolume,
  contractSizeFor,
  emptySequence,
  entryZone,
  evaluatePrerequisite,
  evaluateSafety,
  preflightExecution,
  stageOf,
  validateWatchInput,
  volumeInConnectorUnits,
  zoneTouchLevel,
} from "../lib/core.mjs";
import { Executor, buildOrderArgs, schemaField } from "../lib/execution.mjs";

const M5 = 5 * 60_000;
const M15 = 15 * 60_000;

function bar(t, open, high, low, close) {
  return { open, high, low, close, timestampMs: t, volume: 1 };
}

const SELL = {
  symbol: "XAUUSD",
  direction: "sell",
  entry: 4332,
  sl: 4370,
  invalidation: 4368.31,
  tp1: 4290,
  entry_zone_low: 4330,
  entry_zone_high: 4334,
};

// ---------------------------------------------------------------------------
// Setup prerequisite

test("E1 — a wick through the prerequisite level is not a body close", () => {
  const prerequisite = { level: 4324.71, timeframe: "M15", rule: "body_close", direction: "sell" };
  const wickOnly = [bar(0, 4330, 4335, 4320, 4328)];
  assert.equal(evaluatePrerequisite(prerequisite, wickOnly).satisfied, false);
  const bodyClose = [bar(0, 4330, 4331, 4318, 4322)];
  assert.equal(evaluatePrerequisite(prerequisite, bodyClose).satisfied, true);
});

test("E2 — a missing prerequisite series is unknown, never satisfied", () => {
  const prerequisite = { level: 4324.71, timeframe: "M15", rule: "body_close", direction: "sell" };
  const verdict = evaluatePrerequisite(prerequisite, []);
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.known, false);
});

test("E3 — a declared body-close invalidation is not tripped by a wick", () => {
  const watch = { ...SELL, invalidation_rule: "body_close", entryTouched: true };
  const wick = evaluateSafety(watch, {
    mid: 4369,
    executable: 4369,
    protective: 4369,
    tolerance: 0.1,
    invalidationConfirmed: false,
  });
  assert.notEqual(wick.action, "FAIL");
  const closed = evaluateSafety(watch, {
    mid: 4369,
    executable: 4369,
    protective: 4369,
    tolerance: 0.1,
    invalidationConfirmed: true,
  });
  assert.equal(closed.action, "FAIL");
});

test("E3b — the stop loss stays a hard price line once a trade is actually open", () => {
  // Before entry there is no position, so reaching the stop is an
  // excursion to be classified (§7/§17), not a stop-out. The hard-line
  // guarantee belongs to the regime where the line guards real money.
  const watch = { ...SELL, invalidation_rule: "body_close", entryTouched: true };
  const beforeEntry = evaluateSafety(watch, {
    mid: 4371,
    executable: 4371,
    protective: 4371,
    tolerance: 0.1,
    invalidationConfirmed: false,
  });
  assert.equal(beforeEntry.action, "SL_EXCURSION");

  const inTrade = evaluateSafety(watch, {
    mid: 4371,
    executable: 4371,
    protective: 4371,
    tolerance: 0.1,
    invalidationConfirmed: false,
    regime: "ACTIVE_TRADE",
  });
  assert.equal(inTrade.action, "TRADE_STOPPED");
  assert.match(inTrade.reason, /Stop loss/);

  // And the escape hatch still produces the old hard failure.
  const antiSlOff = evaluateSafety(watch, {
    mid: 4371,
    executable: 4371,
    protective: 4371,
    tolerance: 0.1,
    invalidationConfirmed: false,
    antiSlEnabled: false,
  });
  assert.equal(antiSlOff.action, "FAIL");
  assert.match(antiSlOff.reason, /SL/);
});

// ---------------------------------------------------------------------------
// Entry zone and sequence

test("E4 — a sell zone is touched at its lower edge, not at its midpoint", () => {
  const zone = entryZone(SELL, 0.1);
  assert.deepEqual([zone.low, zone.high], [4330, 4334]);
  assert.equal(zoneTouchLevel(SELL, 0.1), 4330);
  const touched = evaluateSafety(
    { ...SELL, entryTouched: false },
    { mid: 4331, executable: 4331, protective: 4331, tolerance: 0.1, touchLevel: 4330 },
  );
  assert.equal(touched.action, "TOUCH");
});

test("E5 — price action that closed before the touch cannot confirm it", () => {
  const touchedAt = 10 * M5;
  const older = bar(4 * M5, 4333, 4340, 4332, 4333.5);
  const rejection = checkZoneRejection(older, SELL, entryZone(SELL, 0.1), 2, M5, touchedAt);
  assert.equal(rejection.present, false);
  assert.match(rejection.reason, /before the entry touch/);
});

test("E6 — a rejection wick into the zone after the touch counts", () => {
  const touchedAt = 0;
  // Long upper wick into the zone, close pinned to the bar's low.
  const rejectionBar = bar(10 * M5, 4331, 4334.5, 4330.5, 4331.2);
  const verdict = checkZoneRejection(rejectionBar, SELL, entryZone(SELL, 0.1), 1.5, M5, touchedAt);
  assert.equal(verdict.present, true);
  assert.equal(verdict.kind, "rejection_wick_strong");
});

test("E6b — a bar that reaches the zone and closes inside it is not a rejection", () => {
  // Price is in the zone, not being pushed out of it. Under the old
  // reading ("closed below the top of the zone") this counted, which
  // made almost every touch bar a rejection.
  const sittingInside = bar(10 * M5, 4331, 4334, 4330.5, 4333);
  const verdict = checkZoneRejection(sittingInside, SELL, entryZone(SELL, 0.1), 1.5, M5, 0);
  assert.equal(verdict.present, false);
});

test("E6c — a bar that never reaches the zone cannot reject it", () => {
  const below = bar(10 * M5, 4320, 4325, 4318, 4319);
  assert.equal(checkZoneRejection(below, SELL, entryZone(SELL, 0.1), 1.5, M5, 0).present, false);
});

test("E7 — an MSS needs a real pivot, not the lowest print in the window", () => {
  // A steady downward drift has no pivot low to break.
  const drift = Array.from({ length: 12 }, (_, i) => bar(i * M5, 100 - i, 100.5 - i, 99.5 - i, 99.8 - i));
  assert.equal(checkMSS(drift, "sell", M5, 0).present, false);

  // A genuine swing low at index 5, revisited and broken by the close.
  const swing = [
    bar(0, 100, 101, 99.5, 100.5),
    bar(M5, 100.5, 101.5, 100, 101),
    bar(2 * M5, 101, 102, 100.5, 101.5),
    bar(3 * M5, 101.5, 102, 100.8, 101),
    bar(4 * M5, 101, 101.5, 100.2, 100.5),
    bar(5 * M5, 100.5, 100.8, 99.0, 99.5), // pivot low 99.0
    bar(6 * M5, 99.5, 100.5, 99.4, 100.2),
    bar(7 * M5, 100.2, 101, 100, 100.8),
    bar(8 * M5, 100.8, 101.2, 100.5, 101),
    bar(9 * M5, 101, 101.3, 100.6, 100.9),
    bar(10 * M5, 100.9, 101, 98.5, 98.7), // closes through 99.0
  ];
  const mss = checkMSS(swing, "sell", M5, 0);
  assert.equal(mss.present, true);
  assert.equal(mss.level, 99.0);
});

test("E8 — the sequence refuses to skip a step", () => {
  const ctx = { nowIso: "2026-01-01T00:00:00.000Z" };
  let sequence = emptySequence();
  // MSS and displacement arrive first; with no rejection behind them
  // neither may be recorded.
  sequence = advanceEntrySequence(sequence, {
    rejection: { present: false },
    mss: { present: true, level: 4325 },
    displacement: { present: true, body: 5, threshold: 2 },
    barKey: "a",
  }, ctx);
  assert.equal(sequence.mss, null);
  assert.equal(sequence.displacement, null);

  sequence = advanceEntrySequence(sequence, {
    rejection: { present: true, kind: "rejection_wick", tier: "soft", price: 4334 },
    mss: { present: false },
    displacement: { present: true, body: 5, threshold: 2 },
    barKey: "b",
  }, ctx);
  assert.ok(sequence.rejection);
  assert.equal(sequence.displacement, null, "displacement cannot land before the MSS");
  assert.equal(sequence.complete, false);

  sequence = advanceEntrySequence(sequence, {
    rejection: { present: true },
    mss: { present: true, level: 4325 },
    displacement: { present: false },
    barKey: "c",
  }, ctx);
  assert.ok(sequence.mss);
  assert.equal(sequence.complete, false, "an MSS without displacement is not a confirmation");

  sequence = advanceEntrySequence(sequence, {
    rejection: { present: true },
    mss: { present: true },
    displacement: { present: true, body: 5, threshold: 2 },
    barKey: "d",
  }, ctx);
  assert.equal(sequence.complete, true);
});

test("E9 — a sequence whose zone is traded back through is discarded", () => {
  const ctx = { nowIso: "2026-01-01T00:00:00.000Z" };
  let sequence = advanceEntrySequence(emptySequence(), {
    rejection: { present: true, kind: "rejection_wick", tier: "strong" },
    mss: { present: true, level: 4325 },
    displacement: { present: true, body: 5, threshold: 2 },
    barKey: "a",
  }, ctx);
  assert.equal(sequence.complete, true);
  sequence = advanceEntrySequence(sequence, { faded: true, fadedReason: "price above the zone" }, ctx);
  assert.equal(sequence.complete, false);
  assert.equal(sequence.rejection, null);
  assert.equal(sequence.resetCount, 1);
});

test("E10 — the stage names are exactly the execution state machine", () => {
  const base = { ...SELL, lifecycle: "ARMED", lastReason: "armed" };
  assert.equal(stageOf(base), "REGISTERED_WATCH");
  assert.equal(stageOf({ ...base, lastReason: "waiting", prerequisiteSatisfied: false }), "WAITING_FOR_SETUP_CONFIRMATION");
  assert.equal(stageOf({ ...base, lastReason: "armed_waiting_for_touch", prerequisiteSatisfied: true }), "READY_FOR_ENTRY");
  assert.equal(stageOf({ ...base, entryTouched: true, sequence: emptySequence() }), "ENTRY_TOUCHED");
  assert.equal(stageOf({ ...base, entryTouched: true, sequence: { rejection: {} } }), "REJECTION_DETECTED");
  assert.equal(stageOf({ ...base, entryTouched: true, sequence: { rejection: {}, mss: {} } }), "M5_MSS_CONFIRMED");
  assert.equal(
    stageOf({ ...base, entryTouched: true, sequence: { rejection: {}, mss: {}, displacement: {} } }),
    "DISPLACEMENT_CONFIRMED",
  );
  assert.equal(stageOf({ ...base, lifecycle: "ENTRY_CONFIRMED" }), "ENTRY_CONFIRMED");
  assert.equal(stageOf({ ...base, lifecycle: "ORDER_SUBMITTED" }), "ORDER_SUBMITTED");
  assert.equal(stageOf({ ...base, lifecycle: "RESOLVED", status: "EXECUTED" }), "EXECUTED");
  assert.equal(stageOf({ ...base, lifecycle: "RESOLVED", status: "FAILED" }), "INVALIDATED");
});

// ---------------------------------------------------------------------------
// Sizing

test("E11 — risk sizing is refused when the balance is unknown", () => {
  const result = computeOrderVolume({
    mode: "risk",
    balance: null,
    riskPercent: 0.5,
    entry: 4332,
    stop: 4368.31,
    symbol: "XAUUSD",
  });
  assert.equal(result.volume, null);
  assert.match(result.reason, /balance is unknown/);
});

test("E12 — risk sizing is refused when the quote currency is not the account currency", () => {
  const result = computeOrderVolume({
    mode: "risk",
    balance: 10_000,
    riskPercent: 0.5,
    entry: 190,
    stop: 191,
    symbol: "GBPJPY",
    accountCurrency: "USD",
  });
  assert.equal(result.volume, null);
  assert.match(result.reason, /conversion rate/);
});

test("E13 — risk sizing produces the arithmetic it claims", () => {
  const result = computeOrderVolume({
    mode: "risk",
    balance: 10_000,
    riskPercent: 1,
    entry: 4332,
    stop: 4342,
    symbol: "XAUUSD",
    accountCurrency: "USD",
    volumeStep: 0.01,
    minVolume: 0.01,
  });
  // 1% of 10,000 = 100 risked; 10.00 of stop distance x 100oz = 1,000/lot.
  assert.equal(result.riskAmount, 100);
  assert.equal(result.riskPerLot, 1000);
  assert.equal(result.volume, 0.1);
});

test("E14 — a stop too wide for the balance refuses rather than rounding up", () => {
  const result = computeOrderVolume({
    mode: "risk",
    balance: 100,
    riskPercent: 0.5,
    entry: 4332,
    stop: 4432,
    symbol: "XAUUSD",
    minVolume: 0.01,
  });
  assert.equal(result.volume, null);
  assert.match(result.reason, /below the minimum/);
});

test("E15 — an unconfigured fixed volume is not a default of one lot", () => {
  const result = computeOrderVolume({ mode: "fixed", fixedVolume: null, entry: 1, stop: 2, symbol: "XAUUSD" });
  assert.equal(result.volume, null);
});

test("E16 — connector volume units are converted, never assumed", () => {
  assert.equal(contractSizeFor("XAUUSD"), 100);
  assert.equal(volumeInConnectorUnits(0.1, "XAUUSD", "lots"), 0.1);
  assert.equal(volumeInConnectorUnits(0.1, "XAUUSD", "units"), 10);
  assert.equal(volumeInConnectorUnits(0.1, "XAUUSD", "centi_units"), 1000);
  assert.equal(volumeInConnectorUnits(0.1, "XAUUSD", "furlongs"), null);
});

// ---------------------------------------------------------------------------
// Preflight

function preflightInput(overrides = {}) {
  return {
    watch: { ...SELL, lifecycle: "ENTRY_CONFIRMED" },
    symbol: "XAUUSD",
    symbolId: 41,
    direction: "sell",
    price: 4331,
    priceAgeMs: 500,
    sl: 4368.31,
    tp: 4290,
    volume: 0.1,
    connectorVolume: 1000,
    riskAmount: 100,
    balance: 10_000,
    maxRiskPercent: 2,
    positionsKnown: true,
    existingPosition: null,
    openPositionCount: 0,
    maxOpenPositions: 3,
    tradesToday: 0,
    maxTradesPerDay: 5,
    alreadySubmitted: false,
    touchedAtMs: 1000,
    confirmedAtMs: 2000,
    sequenceComplete: true,
    liveData: true,
    ...overrides,
  };
}

test("E17 — a clean confirmation passes every pre-submission check", () => {
  assert.equal(preflightExecution(preflightInput()).ok, true);
});

test("E18 — unreadable positions block the order instead of being read as none", () => {
  const result = preflightExecution(preflightInput({ positionsKnown: false }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.code === "POSITIONS_UNKNOWN"));
});

test("E19 — a confirmation that predates the touch never reaches the broker", () => {
  const result = preflightExecution(preflightInput({ confirmedAtMs: 500 }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.code === "CONFIRMATION_BEFORE_TOUCH"));
});

test("E20 — direction, symbol and stop side are all checked against the watch", () => {
  assert.ok(
    preflightExecution(preflightInput({ direction: "buy" })).failures.some(
      (failure) => failure.code === "DIRECTION_MISMATCH",
    ),
  );
  assert.ok(
    preflightExecution(preflightInput({ symbol: "XAGUSD" })).failures.some(
      (failure) => failure.code === "SYMBOL_MISMATCH",
    ),
  );
  assert.ok(
    preflightExecution(preflightInput({ sl: 4300 })).failures.some(
      (failure) => failure.code === "SL_WRONG_SIDE",
    ),
  );
});

test("E21 — a stale quote is a retryable refusal, not a submission", () => {
  const result = preflightExecution(preflightInput({ priceAgeMs: 60_000 }));
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("E22 — an already-submitted watch cannot submit twice", () => {
  const result = preflightExecution(preflightInput({ alreadySubmitted: true }));
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.ok(result.failures.some((failure) => failure.code === "ALREADY_SUBMITTED"));
});

test("E23 — an incomplete entry sequence is refused at the last gate too", () => {
  const result = preflightExecution(preflightInput({ sequenceComplete: false }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.code === "SEQUENCE_INCOMPLETE"));
});

test("E24 — risk above the configured cap is refused", () => {
  const result = preflightExecution(preflightInput({ riskAmount: 900, maxRiskPercent: 2, balance: 10_000 }));
  assert.ok(result.failures.some((failure) => failure.code === "RISK_EXCEEDS_CAP"));
});

// ---------------------------------------------------------------------------
// Payload construction

test("E25 — the payload uses the field names the connector actually declares", () => {
  const schema = {
    properties: { symbolId: {}, tradeSide: {}, orderType: {}, volume: {}, stopLoss: {}, takeProfit: {}, label: {} },
    required: ["symbolId", "tradeSide", "volume"],
  };
  const { args, missing } = buildOrderArgs(schema, {
    symbolId: 41,
    symbol: "XAUUSD",
    direction: "sell",
    volume: 1000,
    stopLoss: 4368.31,
    takeProfit: 4290,
    label: "wm-123",
  });
  assert.deepEqual(missing, []);
  assert.equal(args.tradeSide, "SELL");
  assert.equal(args.volume, 1000);
  assert.equal(args.stopLoss, 4368.31);
  assert.equal(args.symbol, undefined, "a field the schema does not declare is not invented");
});

test("E26 — a connector with no stop-loss field cannot be sent a naked order", () => {
  const { missing } = buildOrderArgs(
    { properties: { symbolId: {}, tradeSide: {}, volume: {} } },
    { symbolId: 41, direction: "sell", volume: 1000, stopLoss: 4368.31, takeProfit: null },
  );
  assert.ok(missing.includes("stopLoss"));
});

test("E27 — a required schema field the monitor cannot fill blocks the call", () => {
  const { missing } = buildOrderArgs(
    { properties: { symbolId: {}, tradeSide: {}, volume: {}, stopLoss: {}, expiry: {} }, required: ["expiry"] },
    { symbolId: 41, direction: "sell", volume: 1000, stopLoss: 4368.31 },
  );
  assert.ok(missing.includes("expiry"));
});

test("E28 — scaled price format is applied to both protective levels", () => {
  const { args } = buildOrderArgs(
    { properties: { symbolId: {}, tradeSide: {}, volume: {}, stopLoss: {}, takeProfit: {} } },
    { symbolId: 41, direction: "sell", volume: 1000, stopLoss: 4368.31, takeProfit: 4290 },
    { priceFormat: "scaled", priceScale: 100_000 },
  );
  assert.equal(args.stopLoss, 436_831_000);
  assert.equal(args.takeProfit, 429_000_000);
});

test("E29 — schemaField falls back to the canonical name only when no schema is known", () => {
  assert.equal(schemaField(null, "stopLoss"), "stopLoss");
  assert.equal(schemaField({ properties: { sl: {} } }, "stopLoss"), "sl");
  assert.equal(schemaField({ properties: { nothing: {} } }, "stopLoss"), null);
});

// ---------------------------------------------------------------------------
// Executor behaviour against a fake upstream

function fakeClient(handlers) {
  return {
    listTools: async () => handlers.tools,
    callTool: async (name, args) => {
      if (!handlers[name]) throw new Error(`no such tool ${name}`);
      return handlers[name](args);
    },
  };
}

const noop = () => {};

test("E30 — an upstream with no order tool refuses instead of improvising", async () => {
  const executor = new Executor({
    client: fakeClient({ tools: [{ name: "get_spot_prices" }] }),
    config: {},
    log: noop,
  });
  const result = await executor.submit({ symbol: "XAUUSD", symbolId: 41, direction: "sell", volume: 1, stopLoss: 4368 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_ORDER_TOOL");
});

test("E31 — a 200-with-error-body is a rejection, not a fill", async () => {
  const executor = new Executor({
    client: fakeClient({
      tools: [{ name: "create_order", inputSchema: { properties: { symbolId: {}, tradeSide: {}, volume: {}, stopLoss: {} } } }],
      create_order: async () => ({ error: "NOT_ENOUGH_MONEY" }),
    }),
    config: {},
    log: noop,
  });
  const result = await executor.submit({ symbol: "XAUUSD", symbolId: 41, direction: "sell", volume: 1, stopLoss: 4368 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REJECTED");
  assert.match(result.error, /NOT_ENOUGH_MONEY/);
});

test("E32 — a dry run produces the exact payload without calling the connector", async () => {
  let called = false;
  const executor = new Executor({
    client: fakeClient({
      tools: [{ name: "create_order", inputSchema: { properties: { symbolId: {}, tradeSide: {}, volume: {}, stopLoss: {} } } }],
      create_order: async () => {
        called = true;
        return { orderId: "nope" };
      },
    }),
    config: {},
    log: noop,
  });
  const result = await executor.submit({
    symbol: "XAUUSD",
    symbolId: 41,
    direction: "sell",
    volume: 1000,
    stopLoss: 4368.31,
    dryRun: true,
  });
  assert.equal(called, false);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.args.tradeSide, "SELL");
});

test("E33 — an unreadable positions payload is unknown, not empty", async () => {
  const executor = new Executor({
    client: fakeClient({
      tools: [{ name: "get_positions" }],
      get_positions: async () => "the service is warming up",
    }),
    config: {},
    log: noop,
  });
  const result = await executor.openPositions("XAUUSD", 41);
  assert.equal(result.known, false);
});

test("E34 — an explicitly empty positions list is knowledge", async () => {
  const executor = new Executor({
    client: fakeClient({ tools: [{ name: "get_positions" }], get_positions: async () => [] }),
    config: {},
    log: noop,
  });
  const result = await executor.openPositions("XAUUSD", 41);
  assert.equal(result.known, true);
  assert.deepEqual(result.forSymbol, []);
});

test("E35 — an existing position on the symbol is found by name or id", async () => {
  const executor = new Executor({
    client: fakeClient({
      tools: [{ name: "get_positions" }],
      get_positions: async () => [{ positionId: 7, symbolId: 41, tradeSide: "SELL", volume: 1000 }],
    }),
    config: {},
    log: noop,
  });
  const result = await executor.openPositions("XAUUSD", 41);
  assert.equal(result.known, true);
  assert.equal(result.forSymbol.length, 1);
  assert.equal(result.forSymbol[0].id, "7");
});

test("E36 — a balance that cannot be read is not a balance of zero", async () => {
  const executor = new Executor({
    client: fakeClient({ tools: [{ name: "get_balance" }], get_balance: async () => ({ status: "ok" }) }),
    config: {},
    log: noop,
  });
  const result = await executor.balance();
  assert.equal(result.known, false);
});

// ---------------------------------------------------------------------------
// Registration inputs

test("E37 — an entry zone must contain the entry and sit the right side of the stop", () => {
  assert.throws(
    () =>
      validateWatchInput({
        symbol: "XAUUSD",
        direction: "sell",
        entry: 4332,
        sl: 4370,
        tp1: 4290,
        entry_zone_low: 4340,
        entry_zone_high: 4344,
      }),
    /entry must sit inside the entry zone/,
  );
  const ok = validateWatchInput({
    symbol: "XAUUSD",
    direction: "sell",
    entry: 4332,
    sl: 4370,
    tp1: 4290,
    entry_zone_low: 4330,
    entry_zone_high: 4334,
    prerequisite_level: 4324.71,
    prerequisite_timeframe: "M15",
    invalidation_rule: "body_close",
  });
  assert.equal(ok.entry_zone_low, 4330);
  assert.equal(ok.prerequisite.rule, "body_close");
  assert.equal(ok.prerequisite.direction, "sell");
  assert.equal(ok.invalidation_rule, "body_close");
  assert.equal(ok.invalidation_timeframe, "M15");
});

test("E38 — a per-setup risk override cannot exceed a sane ceiling", () => {
  assert.throws(
    () =>
      validateWatchInput({
        symbol: "XAUUSD",
        direction: "sell",
        entry: 4332,
        sl: 4370,
        tp1: 4290,
        risk_percent: 50,
      }),
    /risk_percent/,
  );
});
