/**
 * Setup-lifecycle suite — the adaptive lifecycle, the anti-SL-Hunter
 * branch, and the separation of setup validity from entry opportunity.
 *
 * The rule the other suites follow holds here too: each test names a way
 * the system could take a wrong entry, miss a right one, or kill a setup
 * that was still alive, and passes only if the code makes that outcome
 * unreachable rather than unlikely.
 *
 *   node --test test/lifecycle.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTI_SL_DEFAULTS,
  PERIOD_MS,
  advanceSlExcursion,
  appendTrail,
  defenceSatisfied,
  emptyExcursion,
  emptySequence,
  evaluateAntiSl,
  evaluateEntryOpportunity,
  evaluateSafety,
  confirmationDeadlineFor,
  evaluateTimeWindow,
  evaluateTradeProgress,
  stageOf,
  trailEvent,
  urgencyHoldMs,
  validateWatchInput,
} from "../lib/core.mjs";
import { WatchStore } from "../lib/store.mjs";

const M1 = PERIOD_MS.M1;
const M5 = PERIOD_MS.M5;

// A gold buy: entry 4330, stop 4310, first target 4390. Risk 20, reward
// 60. No separate thesis line — so the stop is the only number, which is
// exactly the case §7 says must not be read as an invalidation.
const BUY = {
  symbol: "XAUUSD",
  direction: "buy",
  entry: 4330,
  sl: 4310,
  invalidation: 4310,
  tp1: 4390,
  entry_zone_low: 4328,
  entry_zone_high: 4332,
  entryTouched: true,
};

const at = (price) => ({ mid: price, executable: price, protective: price, tolerance: 0.1 });

/** An excursion that went `depth` below the stop, stayed `beyondMs`, and came back. */
function excursion({ depth, beyondMs, reclaimHeldMs = M1, reclaimed = true, startedAtMs = 0 }) {
  return {
    ...emptyExcursion(),
    count: 1,
    active: !reclaimed,
    startedAtMs,
    startPrice: BUY.sl,
    maxDepth: depth,
    maxDepthPrice: BUY.sl - depth,
    beyondMs,
    reclaimedAtMs: reclaimed ? startedAtMs + beyondMs : null,
    reclaimHeldMs: reclaimed ? reclaimHeldMs : 0,
  };
}

/** The evidence of a clean sweep: nothing closed beyond, nothing broke. */
const cleanEvidence = (extra = {}) => ({
  atr: 4,
  nowMs: 60_000,
  closedBodyBeyond: false,
  opposingStructureBreak: false,
  opposingFollowThrough: false,
  withinTimeWindow: true,
  ...extra,
});

// ---------------------------------------------------------------------------
// §9/§11 The normal path — and the guarantee that it does not wait for
// a problem that has not happened.

test("L1 — touch plus the setup's defence is an entry; touch alone is not", () => {
  const noDefence = defenceSatisfied("standard", { sequence: emptySequence() });
  assert.equal(noDefence.satisfied, false);
  assert.equal(noDefence.reason, "awaiting_zone_rejection");

  const halfway = defenceSatisfied("standard", { sequence: { rejection: {}, mss: {} } });
  assert.equal(halfway.satisfied, false);
  assert.equal(halfway.missing, "displacement");

  const complete = defenceSatisfied("standard", {
    sequence: { rejection: {}, mss: {}, displacement: {} },
  });
  assert.equal(complete.satisfied, true);
});

test("L2 — the normal path never routes through the anti-SL branch", () => {
  // Price in the zone, nowhere near the stop: the verdict is the ordinary
  // one, and nothing about a stop excursion is consulted to produce it.
  const verdict = evaluateSafety(BUY, at(4329));
  assert.equal(verdict.action, "CONTINUE");
  // And with no excursion recorded, the setup's stage is the ordinary one.
  assert.equal(stageOf({ ...BUY, lifecycle: "TOUCHED", sequence: { rejection: {} } }), "REJECTION_DETECTED");
});

test("L3 — a fast market with defence enters fast; a fast market without it waits", () => {
  // Urgency buys a shorter hold and nothing else.
  assert.equal(urgencyHoldMs("CRITICAL", 60_000, 15_000), 15_000);
  assert.equal(urgencyHoldMs("HIGH", 60_000, 15_000), 30_000);
  assert.equal(urgencyHoldMs("NORMAL", 60_000, 15_000), 60_000);
  assert.equal(urgencyHoldMs("LOW", 60_000, 15_000), 90_000);
  // It can never take the hold below the floor every path shares...
  assert.equal(urgencyHoldMs("CRITICAL", 20_000, 15_000), 15_000);
  // ...and it cannot satisfy a defence that has not printed.
  assert.equal(
    defenceSatisfied("standard", { sequence: { rejection: {}, mss: {} } }).satisfied,
    false,
  );
});

// ---------------------------------------------------------------------------
// §7/§17 Before entry vs after entry — the distinction the whole
// lifecycle rests on.

test("L4 — reaching the potential stop before entry is an excursion, not an invalidation", () => {
  const verdict = evaluateSafety(BUY, at(4309));
  assert.equal(verdict.action, "SL_EXCURSION");
  assert.match(verdict.reason, /before any entry was taken/);
});

test("L5 — the same price with a position open is a stop-out", () => {
  const verdict = evaluateSafety(BUY, { ...at(4309), regime: "ACTIVE_TRADE" });
  assert.equal(verdict.action, "TRADE_STOPPED");
});

test("L6 — a declared thesis line that price actually breaches still kills the setup", () => {
  // Stop at 4310, thesis at 4315: price at 4314 has not reached the stop
  // but has reached the thesis, and the thesis is what the setup rests on.
  const withThesis = { ...BUY, invalidation: 4315 };
  const verdict = evaluateSafety(withThesis, at(4314));
  assert.equal(verdict.action, "FAIL");
  assert.match(verdict.reason, /Invalidation/);
});

test("L7 — a thesis line beyond the stop does not turn a stop touch back into a failure", () => {
  // The analyst said: stop at 4310, but the thesis only dies at 4300.
  // Price at 4309 is past the stop and nowhere near the thesis, so it is
  // an excursion — the case a naive `invalidation !== sl` test gets wrong.
  const wideThesis = { ...BUY, invalidation: 4300 };
  assert.equal(evaluateSafety(wideThesis, at(4309)).action, "SL_EXCURSION");
  assert.equal(evaluateSafety(wideThesis, at(4299)).action, "FAIL");
});

test("L8 — a closed body beyond the declared rule kills it whatever the level is called", () => {
  const bodyClose = { ...BUY, invalidation_rule: "body_close", invalidation_timeframe: "M15" };
  assert.equal(
    evaluateSafety(bodyClose, { ...at(4309), invalidationConfirmed: false }).action,
    "SL_EXCURSION",
  );
  assert.equal(
    evaluateSafety(bodyClose, { ...at(4309), invalidationConfirmed: true }).action,
    "FAIL",
  );
});

// ---------------------------------------------------------------------------
// §12–§15 The three anti-SL outcomes.

test("L9 — a shallow, brief, reclaimed excursion with no closure survives", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 1.2, beyondMs: 90_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "SURVIVES");
  assert.ok(verdict.measured.depthAtr < ANTI_SL_DEFAULTS.wickDepthAtr);
});

test("L10 — surviving returns to defence evaluation; it is not itself a confirmation", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 1.2, beyondMs: 90_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "SURVIVES");
  // Nothing in the verdict asserts an entry, and the defence a surviving
  // setup goes back to is the same one it always had.
  assert.equal(verdict.measured.reclaimed, true);
  assert.equal(defenceSatisfied("standard", { sequence: emptySequence() }).satisfied, false);
});

test("L11 — a closed body beyond the level is invalidation, however fast the reclaim looked", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 0.5, beyondMs: 20_000 }),
    cleanEvidence({ closedBodyBeyond: true }),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "INVALIDATED");
  assert.match(verdict.reasons[0], /closed body/);
});

test("L12 — structure broken against the setup with displacement behind it is invalidation", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 1, beyondMs: 60_000 }),
    cleanEvidence({ opposingStructureBreak: true, opposingFollowThrough: true }),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "INVALIDATED");
});

test("L13 — a deep excursion is a move, not a sweep, whatever this instrument usually does", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 8, beyondMs: 60_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "INVALIDATED");
  assert.match(verdict.reasons[0], /ATR beyond the stop is a move/);
});

test("L14 — price that settles beyond the level with no reclaim is trading there, not running through it", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 1, beyondMs: 20 * 60_000, reclaimed: false }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "INVALIDATED");
  assert.match(verdict.reasons[0], /no reclaim/);
});

test("L15 — mixed evidence is UNCERTAIN, never a guess in either direction", () => {
  // Reclaimed and shallow, but the reclaim has not held for a bar yet.
  const early = evaluateAntiSl(
    BUY,
    excursion({ depth: 1, beyondMs: 60_000, reclaimHeldMs: 5_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(early.outcome, "UNCERTAIN");
  assert.match(early.reasons.join(" "), /reclaim has held/);
});

test("L16 — an unknown is never read as the permissive answer", () => {
  // No bar has closed since the excursion began, so "nothing closed
  // beyond the level" is not yet a fact. It must not be treated as one.
  const unknownClosure = evaluateAntiSl(
    BUY,
    excursion({ depth: 0.5, beyondMs: 30_000 }),
    cleanEvidence({ closedBodyBeyond: null }),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(unknownClosure.outcome, "UNCERTAIN");

  // And an excursion that can be measured against neither volatility nor
  // risk cannot be called a sweep.
  const unmeasurable = evaluateAntiSl(
    { ...BUY, entry: 4330, sl: 4330 },
    excursion({ depth: 1, beyondMs: 30_000 }),
    cleanEvidence({ atr: null }),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(unmeasurable.outcome, "UNCERTAIN");
  assert.match(unmeasurable.reasons.join(" "), /cannot be measured/);
});

test("L17 — speed widens the depth a sweep may have, and only for a reversed excursion", () => {
  // 3 ATR/min: violent in and violent out. Depth 2.8 (0.7 ATR) is beyond
  // the 0.5 ATR a slow excursion is allowed, and inside what a fast one is.
  const fast = evaluateAntiSl(
    BUY,
    excursion({ depth: 2.8, beyondMs: 14_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(fast.outcome, "SURVIVES");
  assert.ok(fast.measured.speedAtrPerMinute > ANTI_SL_DEFAULTS.fastAtrPerMinute);

  // The same depth taken slowly is not the same event.
  const slow = evaluateAntiSl(
    BUY,
    excursion({ depth: 2.8, beyondMs: 4 * 60_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(slow.outcome, "UNCERTAIN");
});

test("L18 — supporting context is reported and never decides", () => {
  const base = excursion({ depth: 6, beyondMs: 60_000 });
  const withLiquidity = evaluateAntiSl(
    BUY,
    base,
    cleanEvidence({ liquiditySwept: true, liquidityTarget: 4400 }),
    ANTI_SL_DEFAULTS,
  );
  // A swept pool is exactly the story that makes a stop run feel
  // explainable. It does not save a 1.5 ATR excursion.
  assert.equal(withLiquidity.outcome, "INVALIDATED");
  assert.ok(withLiquidity.supporting.some((line) => /swept/.test(line)));
});

test("L19 — an excursion nobody can classify is bounded, not parked forever", () => {
  const stale = evaluateAntiSl(
    BUY,
    excursion({ depth: 1, beyondMs: 60_000, reclaimHeldMs: 1_000, startedAtMs: 0 }),
    cleanEvidence({ nowMs: 3 * ANTI_SL_DEFAULTS.maxEvaluationMs }),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(stale.outcome, "UNCERTAIN");
  assert.equal(stale.exhausted, true);
});

// ---------------------------------------------------------------------------
// The excursion record itself.

test("L20 — duration is accumulated from observation, never from wall clock", () => {
  let state = emptyExcursion();
  state = advanceSlExcursion(state, { beyond: true, price: 4309, depth: 1, nowMs: 0 });
  state = advanceSlExcursion(state, { beyond: true, price: 4308, depth: 2, nowMs: 10_000 });
  assert.equal(state.beyondMs, 10_000);
  assert.equal(state.maxDepth, 2);

  // A monitoring gap — a restart, a degraded feed — is not evidence that
  // price sat beyond the level for an hour.
  const resumed = advanceSlExcursion(state, { beyond: true, price: 4309, depth: 1, nowMs: 3_610_000 });
  assert.equal(resumed.beyondMs, 10_000 + (3_610_000 - 10_000));
  // ...which is why the store drops a mid-flight excursion on restart
  // rather than resuming one (asserted in L46).
  assert.equal(resumed.maxDepth, 2, "a shallower sample never lowers the recorded depth");
});

test("L21 — a reclaim is recorded once and its hold accumulates", () => {
  let state = advanceSlExcursion(emptyExcursion(), { beyond: true, price: 4309, depth: 1, nowMs: 0 });
  state = advanceSlExcursion(state, { beyond: false, price: 4312, depth: 0, nowMs: 30_000 });
  assert.equal(state.active, false);
  assert.equal(state.reclaimedAtMs, 30_000);
  state = advanceSlExcursion(state, { beyond: false, price: 4315, depth: 0, nowMs: 95_000 });
  assert.equal(state.reclaimHeldMs, 65_000);
  assert.equal(state.reclaimedAtMs, 30_000, "the reclaim time is the first one, not the latest");
});

test("L22 — a second excursion is a second event, not a continuation of the first", () => {
  // The first visit is deep and slow — the shape of a breakdown.
  let state = advanceSlExcursion(emptyExcursion(), { beyond: true, price: 4302, depth: 8, nowMs: 0 });
  state = advanceSlExcursion(state, { beyond: true, price: 4302, depth: 8, nowMs: 240_000 });
  state = advanceSlExcursion(state, { beyond: false, price: 4315, depth: 0, nowMs: 300_000 });
  assert.equal(state.maxDepth, 8);
  assert.equal(state.beyondMs, 240_000);

  // The second is a shallow flick. It must be classified on its own
  // numbers, or the first visit's depth would condemn it.
  state = advanceSlExcursion(state, { beyond: true, price: 4309.5, depth: 0.5, nowMs: 600_000 });
  assert.equal(state.count, 2);
  assert.equal(state.startedAtMs, 600_000, "the clock restarts with the new event");
  assert.equal(state.maxDepth, 0.5, "and so does the measurement");
  assert.equal(state.beyondMs, 0);
  assert.equal(state.reclaimedAtMs, null, "the new excursion has not been reclaimed");
});

// ---------------------------------------------------------------------------
// §18/§19 Entry opportunity — separate from setup validity.

test("L23 — price reaching TP1 without an entry is ENTRY_MISSED, not an expiry and not a failure", () => {
  const verdict = evaluateSafety(BUY, at(4391));
  assert.equal(verdict.action, "ENTRY_MISSED");
  assert.match(verdict.reason, /TP1/);
  assert.equal(stageOf({ ...BUY, lifecycle: "RESOLVED", status: "ENTRY_MISSED" }), "ENTRY_MISSED");
});

test("L24 — a confirmation far from the planned entry is refused rather than chased", () => {
  // ATR 4 → the volatility cap is 3; the risk cap is 20 × 0.3 = 6. The
  // tighter of the two decides.
  const escaped = evaluateEntryOpportunity(BUY, { mid: 4335, atr: 4, tolerance: 0.1 });
  assert.equal(escaped.actionable, false);
  assert.equal(escaped.reason, "ENTRY_ESCAPED");
  assert.equal(escaped.cap, 3);

  const fine = evaluateEntryOpportunity(BUY, { mid: 4332, atr: 4, tolerance: 0.1 });
  assert.equal(fine.actionable, true);
});

test("L24b — the deployed monitor does not enforce the cap by default", () => {
  // §19's cap exists as a mechanism, but the service turns it off by
  // default (ENTRY_DEVIATION_CHECK_ENABLED=false): the evidence engine's
  // own hold-and-fade check already discards a move that reverses, so a
  // signal that graduates has already proven itself by not reversing —
  // often well beyond the zone by the time it does. Capping distance on
  // top of that stands an entry down for the reason it was safe. This is
  // the exact case a real XAUUSD momentum trade produced: a late entry,
  // deep into a move with no room left to turn back, that the cap alone
  // would have refused as ENTRY_ESCAPED.
  const farButSafe = evaluateEntryOpportunity(BUY, {
    mid: 4360,
    atr: 4,
    tolerance: 0.1,
    enforceCap: false,
  });
  assert.equal(farButSafe.actionable, true, "distance alone no longer refuses the entry");
  assert.equal(farButSafe.chase, 30, "the drift is still measured and reported");

  // The two safety checks that are not about distance stay on regardless.
  const throughTheStop = evaluateEntryOpportunity(
    { ...BUY, sl: 4325 },
    { mid: 4320, atr: 4, tolerance: 0.1, enforceCap: false },
  );
  assert.equal(throughTheStop.actionable, false);
  assert.equal(throughTheStop.reason, "RISK_INVERTED");

  const thin = { ...BUY, tp1: 4350 };
  const noRewardLeft = evaluateEntryOpportunity(thin, {
    mid: 4345,
    atr: 4,
    tolerance: 0.1,
    enforceCap: false,
  });
  assert.equal(noRewardLeft.actionable, false);
  assert.equal(noRewardLeft.reason, "RR_COLLAPSED");
});

test("L25 — a better fill than planned is never a missed entry", () => {
  // A buy filling below its entry is a better trade, not a late one.
  const better = evaluateEntryOpportunity(BUY, { mid: 4320, atr: 4, tolerance: 0.1 });
  assert.equal(better.actionable, true);
  assert.ok(better.chase < 0);
});

test("L26 — the cap is context-aware, and a declared cap cannot break the setup's shape", () => {
  // A quiet market tightens the cap; a violent one widens it, up to the
  // ceiling the setup's own risk imposes.
  assert.equal(evaluateEntryOpportunity(BUY, { mid: 4330, atr: 1, tolerance: 0.1 }).cap, 0.75);
  assert.equal(evaluateEntryOpportunity(BUY, { mid: 4330, atr: 40, tolerance: 0.1 }).cap, 6);
  // An analyst asking for 50 points of deviation on a 20-point risk is
  // asking for a different trade; half the risk is the hard ceiling.
  assert.equal(
    evaluateEntryOpportunity(BUY, { mid: 4330, atr: 4, tolerance: 0.1, maxEntryDeviation: 50 }).cap,
    10,
  );
});

test("L27 — a collapsed reward-to-risk is refused even inside a cap the analyst widened", () => {
  // The derived cap is tight enough that a 1R setup cannot fall under
  // half an R inside it. The R:R floor exists for the case where the
  // analyst widened the cap themselves: risk 20, reward 20, and a
  // declared 20-point deviation that the ceiling trims to 10.
  const thin = { ...BUY, tp1: 4350 };
  const verdict = evaluateEntryOpportunity(thin, {
    mid: 4339,
    atr: 40,
    tolerance: 0.1,
    maxEntryDeviation: 20,
    minRemainingRR: 0.5,
  });
  assert.equal(verdict.cap, 10, "the declared cap is trimmed to half the risk distance");
  assert.ok(verdict.chase < verdict.cap, "and the drift is inside it");
  assert.equal(verdict.actionable, false);
  assert.equal(verdict.reason, "RR_COLLAPSED");
});

// ---------------------------------------------------------------------------
// §16 No resurrection, and §20 the clock.

test("L28 — a resolved setup is gone from the registry and cannot be re-armed by later price", () => {
  const store = new WatchStore({ path: null, log: () => {} });
  const watch = store.add({
    id: "w1",
    kind: "SETUP",
    symbol: "XAUUSD",
    direction: "buy",
    lifecycle: "TOUCHED",
    ...BUY,
  });
  assert.equal(store.beginResolution("w1"), true);
  store.finalize(watch, "FAILED", { reason: "thesis invalidated" });
  assert.equal(store.get("w1"), null);
  assert.equal(store.active().length, 0);
  // Price returning to the original target changes nothing: there is no
  // record left that any code path could re-arm.
  assert.equal(store.beginResolution("w1"), false);
  assert.equal(store.resolved.get("w1").status, "FAILED");
});

test("L29 — a fresh setup after an invalidation is a different setup", () => {
  const first = validateWatchInput({
    setup_id: "gold-1",
    symbol: "XAUUSD",
    direction: "buy",
    entry: 4330,
    sl: 4310,
    tp1: 4390,
  });
  const second = validateWatchInput({
    setup_id: "gold-2",
    symbol: "XAUUSD",
    direction: "buy",
    entry: 4330,
    sl: 4310,
    tp1: 4390,
  });
  assert.notEqual(first.setup_id, second.setup_id);
});

test("L30 — the confirmation clock runs from the touch, not from registration", () => {
  // This is the bug that killed a live setup: price never reached the
  // zone, so nothing was confirming, and a *confirmation* deadline
  // measured from registration ended a setup whose thesis was intact and
  // whose own entry window had two more hours to run.
  const armed = {
    armedAtMs: 0,
    entryMonitoringUntil: 120 * 60_000,
    confirmation_deadline_minutes: 25,
    expiresAt: 150 * 60_000,
    entry: 4599.1,
    sl: 4587.5,
    direction: "buy",
  };
  assert.equal(
    evaluateTimeWindow(armed, { nowMs: 26 * 60_000, entryTouched: false }).state,
    "OPEN",
    "an untouched setup is not killed by a clock that has not started",
  );
  assert.equal(
    evaluateTimeWindow(armed, { nowMs: 121 * 60_000, entryTouched: false }).state,
    "ENTRY_WINDOW_CLOSED",
    "its own entry window is what bounds the wait",
  );

  // Once touched, the deadline is measured from the touch.
  const touched = { ...armed, entryTouched: true, entryTouchedAtMs: 60 * 60_000 };
  assert.equal(evaluateTimeWindow(touched, { nowMs: 80 * 60_000 }).state, "OPEN");
  assert.equal(evaluateTimeWindow(touched, { nowMs: 86 * 60_000 }).state, "DEADLINE_PASSED");
  assert.equal(confirmationDeadlineFor(touched), 85 * 60_000);
  assert.equal(confirmationDeadlineFor(armed), null, "no touch, no clock");

  // Expiry still outranks everything.
  assert.equal(evaluateTimeWindow(touched, { nowMs: 151 * 60_000 }).state, "EXPIRED");
  // Inside the window nothing is pending, and outside the session it is a
  // boundary rather than a delay.
  assert.equal(
    evaluateTimeWindow(touched, { nowMs: 80 * 60_000, killZoneActive: true }).state,
    "OPEN",
  );
  assert.equal(
    evaluateTimeWindow(touched, { nowMs: 80 * 60_000, killZoneActive: false }).state,
    "OUTSIDE_WINDOW",
  );
});

test("L30b — a declared entry window is actually enforced", () => {
  // It was stored at registration and read by nothing, so an analyst
  // declaring one got no behaviour from it at all.
  const watch = { armedAtMs: 0, entryMonitoringUntil: 60_000, expiresAt: 9e15 };
  assert.equal(evaluateTimeWindow(watch, { nowMs: 30_000, entryTouched: false }).state, "OPEN");
  assert.equal(
    evaluateTimeWindow(watch, { nowMs: 61_000, entryTouched: false }).state,
    "ENTRY_WINDOW_CLOSED",
  );
  // And a setup that declared no window is bounded only by its expiry.
  assert.equal(
    evaluateTimeWindow({ armedAtMs: 0, expiresAt: 9e15 }, { nowMs: 9e14, entryTouched: false }).state,
    "OPEN",
  );
});

test("L31 — a deadline that outlives the setup's own expiry is rejected at registration", () => {
  assert.throws(
    () =>
      validateWatchInput({
        symbol: "XAUUSD",
        direction: "buy",
        entry: 4330,
        sl: 4310,
        tp1: 4390,
        expiration_minutes: 30,
        confirmation_deadline_minutes: 60,
      }),
    /cannot outlive/,
  );
});

// ---------------------------------------------------------------------------
// §22/§26 Setup-specific defence.

test("L32 — the M5 structure shift is required where it is declared and not where it is not", () => {
  const rejectionOnly = { rejection: {}, displacement: {} };
  assert.equal(defenceSatisfied("standard", { sequence: rejectionOnly }).satisfied, false);
  assert.equal(defenceSatisfied("rejection_displacement", { sequence: rejectionOnly }).satisfied, true);
});

test("L33 — the M1 profile is a faster clock, not a weaker one", () => {
  const sequence = { rejection: {} };
  assert.equal(
    defenceSatisfied("m1_continuation", { sequence, m1Continuation: { ok: false, reason: "no M1 shift" } })
      .satisfied,
    false,
  );
  assert.equal(
    defenceSatisfied("m1_continuation", { sequence, m1Continuation: { ok: true } }).satisfied,
    true,
  );
  // It still needs the rejection that every profile needs.
  assert.equal(
    defenceSatisfied("m1_continuation", {
      sequence: emptySequence(),
      m1Continuation: { ok: true },
    }).satisfied,
    false,
  );
});

test("L34 — the M1 profile is withdrawn once price moves against the setup", () => {
  const verdict = defenceSatisfied("m1_continuation", {
    sequence: { rejection: {} },
    m1Continuation: { ok: true },
    forwardState: "FAILED",
  });
  assert.equal(verdict.satisfied, false);
  assert.match(verdict.missing, /withdrawn/);
});

test("L35 — an unknown profile falls back to the strictest one, never to none", () => {
  const verdict = defenceSatisfied("something_new", { sequence: { rejection: {}, displacement: {} } });
  assert.equal(verdict.profile, "standard");
  assert.equal(verdict.satisfied, false);
});

// ---------------------------------------------------------------------------
// §33 Post-entry.

test("L36 — targets are reported once each and the stop ends the trade", () => {
  const trade = { direction: "buy", entry: 4330, sl: 4310, tp1: 4350, tp2: 4370, tp3: 4390, targetsHit: [] };
  const first = evaluateTradeProgress(trade, { mid: 4355, protective: 4355 });
  assert.equal(first.action, "TARGET");
  assert.deepEqual(first.reached.map((target) => target.name), ["TP1"]);

  const already = evaluateTradeProgress({ ...trade, targetsHit: ["TP1"] }, { mid: 4355, protective: 4355 });
  assert.equal(already.action, "WAIT", "a target already reported is not reported again");

  const final = evaluateTradeProgress({ ...trade, targetsHit: ["TP1", "TP2"] }, { mid: 4395, protective: 4395 });
  assert.equal(final.action, "TARGET_FINAL");

  const stopped = evaluateTradeProgress(trade, { mid: 4309, protective: 4309 });
  assert.equal(stopped.action, "STOPPED");
});

test("L37 — the stop beats a target reached on the same tick", () => {
  // A bar that spanned both is not a win; the protective side is checked
  // first and resolves the trade.
  const trade = { direction: "buy", entry: 4330, sl: 4310, tp1: 4350, targetsHit: [] };
  const both = evaluateTradeProgress(trade, { mid: 4355, protective: 4305 });
  assert.equal(both.action, "STOPPED");
});

// ---------------------------------------------------------------------------
// §35 The event trail.

test("L38 — every event carries its own id and the setup's correlation id, and the trail is bounded", () => {
  const watch = { id: "w1", setup_id: "gold-1", lifecycle: "ARMED", trail: [] };
  const first = trailEvent(watch, "setup_created", { entry: 4330 }, 1_000);
  assert.equal(first.event_id, "w1:1");
  assert.equal(first.correlation_id, "gold-1");
  assert.equal(first.at, new Date(1_000).toISOString());

  let trail = [];
  for (let index = 0; index < 250; index += 1) {
    trail = appendTrail(trail, { event_id: `w1:${index}` }, 200);
  }
  assert.equal(trail.length, 200);
  assert.equal(trail.at(-1).event_id, "w1:249", "the newest events are the ones kept");
});

// ---------------------------------------------------------------------------
// §38 The adversarial XAUUSD sequences, each resolved to one state.

test("L39 — reaction, sudden excursion, reclaim, defence → the setup enters", () => {
  assert.equal(evaluateSafety(BUY, at(4309)).action, "SL_EXCURSION");
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 1.5, beyondMs: 45_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "SURVIVES");
  // Back to defence, which then completes on post-reclaim price action.
  assert.equal(
    defenceSatisfied("standard", { sequence: { rejection: {}, mss: {}, displacement: {} } }).satisfied,
    true,
  );
  assert.equal(evaluateEntryOpportunity(BUY, { mid: 4331, atr: 4, tolerance: 0.1 }).actionable, true);
});

test("L40 — excursion then continued opposing displacement → the setup is dead", () => {
  const verdict = evaluateAntiSl(
    BUY,
    excursion({ depth: 2, beyondMs: 120_000, reclaimed: false }),
    cleanEvidence({ opposingStructureBreak: true, opposingFollowThrough: true }),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(verdict.outcome, "INVALIDATED");
});

test("L41 — no confirmation and price runs to TP1 → ENTRY_MISSED, never a chase", () => {
  assert.equal(evaluateSafety(BUY, at(4390)).action, "ENTRY_MISSED");
  // And the entry that would have been taken at that price is refused on
  // its own terms too, so neither path can produce an entry there.
  assert.equal(evaluateEntryOpportunity(BUY, { mid: 4390, atr: 4, tolerance: 0.1 }).actionable, false);
});

test("L42 — apparent reclaim, then a bar closes beyond the level → the later truth wins", () => {
  const record = excursion({ depth: 1, beyondMs: 45_000 });
  const early = evaluateAntiSl(BUY, record, cleanEvidence(), ANTI_SL_DEFAULTS);
  assert.equal(early.outcome, "SURVIVES");
  const later = evaluateAntiSl(BUY, record, cleanEvidence({ closedBodyBeyond: true }), ANTI_SL_DEFAULTS);
  assert.equal(later.outcome, "INVALIDATED");
});

test("L43 — excursion, reclaim, confirmation, and then price escapes → ENTRY_MISSED", () => {
  const survived = evaluateAntiSl(
    BUY,
    excursion({ depth: 1, beyondMs: 45_000 }),
    cleanEvidence(),
    ANTI_SL_DEFAULTS,
  );
  assert.equal(survived.outcome, "SURVIVES");
  // The setup is alive and the defence prints — but by then price is gone.
  const opportunity = evaluateEntryOpportunity(BUY, { mid: 4340, atr: 4, tolerance: 0.1 });
  assert.equal(opportunity.actionable, false);
  assert.equal(opportunity.reason, "ENTRY_ESCAPED");
});

test("L44 — an invalidation and a touch on the same tick resolve the same way every time", () => {
  // §30: ordering is fixed. The thesis test runs before the touch branch,
  // so a tick that carries both never produces a touch.
  const withThesis = { ...BUY, invalidation: 4315, entryTouched: false };
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const verdict = evaluateSafety(withThesis, { ...at(4314), touchLevel: 4332 });
    assert.equal(verdict.action, "FAIL");
  }
});

test("L45 — an excursion and a target on the same tick resolve to the excursion, not the target", () => {
  // Protective side at the stop, mid at the target: the risk question is
  // answered first, so a bar that spanned the whole setup cannot report
  // itself as a missed winner.
  const verdict = evaluateSafety(BUY, { mid: 4391, executable: 4391, protective: 4309, tolerance: 0.1 });
  assert.equal(verdict.action, "SL_EXCURSION");
});

test("L46 — a restart drops a mid-flight excursion rather than resuming one it did not watch", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const path = join(dir, "state.json");
  try {
    const first = new WatchStore({ path, log: () => {} });
    first.add({
      id: "w1",
      kind: "SETUP",
      lifecycle: "ANTI_SL_EVALUATION",
      ...BUY,
      slExcursion: excursion({ depth: 1, beyondMs: 60_000 }),
      antiSl: { outcome: "UNCERTAIN" },
      sequenceAnchorMs: 123,
      technicalConfirmationAtMs: 456,
      trail: [{ event_id: "w1:1", type: "sl_excursion_started" }],
    });
    first.save();

    const second = new WatchStore({ path, log: () => {} });
    second.load();
    const recovered = second.get("w1");
    assert.ok(recovered, "the setup itself survives");
    assert.equal(recovered.slExcursion, undefined, "the excursion does not");
    assert.equal(recovered.antiSl, undefined);
    assert.equal(recovered.sequenceAnchorMs, undefined);
    assert.equal(recovered.technicalConfirmationAtMs, undefined);
    // The trail is the record of what happened and is not observation, so
    // it survives — that is the whole point of keeping it.
    assert.equal(recovered.trail.length, 1);
    // The entry touch is a market fact and survives too.
    assert.equal(recovered.entryTouched, true);
    assert.equal(recovered.lifecycle, "TOUCHED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L47 — a tracked trade survives a restart with its reported targets intact", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-trade-"));
  const path = join(dir, "state.json");
  try {
    const first = new WatchStore({ path, log: () => {} });
    first.add({
      id: "trade:w1",
      kind: "TRADE",
      parentWatchId: "w1",
      symbol: "XAUUSD",
      direction: "buy",
      entry: 4330,
      sl: 4310,
      tp1: 4350,
      tp2: 4370,
      targetsHit: ["TP1"],
      lifecycle: "ACTIVE_TRADE",
      trail: [],
    });
    first.save();

    const second = new WatchStore({ path, log: () => {} });
    const summary = second.load();
    assert.equal(summary.trades, 1);
    const trade = second.get("trade:w1");
    assert.equal(trade.lifecycle, "ACTIVE_TRADE");
    // Re-announcing TP1 after a redeploy would be a false signal.
    assert.deepEqual(trade.targetsHit, ["TP1"]);
    assert.equal(
      evaluateTradeProgress(trade, { mid: 4355, protective: 4355 }).action,
      "WAIT",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The trade's risk is entry-to-stop. The thesis line says when the
// analysis is wrong; it never says how much the trade costs when it
// fails — a trade can only lose as far as the price it is stopped at.
// Conflating the two rejects well-shaped setups for declaring a wide
// thesis, which is how a promoted trap was refused registration.

test("L48 — a thesis line beyond the stop does not shrink the setup's measured R:R", () => {
  // entry→stop is 29, entry→tp1 is 35.75 — a 1.23R setup by the only
  // measure that describes the trade. The thesis line sits 42 away.
  const shape = {
    symbol: "XAUUSD",
    direction: "sell",
    entry: 4317.75,
    sl: 4346.78,
    thesis_invalidation: 4360,
    tp1: 4282,
  };
  const registered = validateWatchInput(shape);
  assert.equal(registered.sl, 4346.78);
  assert.equal(registered.invalidation, 4360);
  assert.equal(registered.thesis_invalidation_declared, true);

  // Measured against the thesis line it would read 0.85R and be refused.
  const againstThesis = Math.abs(shape.tp1 - shape.entry) / Math.abs(shape.entry - 4360);
  assert.ok(againstThesis < 1, "the wrong measure would have rejected this setup");
});

test("L49 — and a thesis line nearer than the stop cannot flatter a bad one", () => {
  // entry→stop is 20, entry→tp1 is 15: a 0.75R setup however it is
  // dressed. A thesis line at 10 away would make it read 1.5R.
  assert.throws(
    () =>
      validateWatchInput({
        symbol: "XAUUSD",
        direction: "buy",
        entry: 4330,
        sl: 4310,
        thesis_invalidation: 4320,
        tp1: 4345,
      }),
    /at least 1R/,
  );
});

test("L50 — progress and acceptance are measured in the same R", () => {
  const wideThesis = { ...BUY, invalidation: 4290 };
  // 4340 is half of the 20-point entry-to-stop distance in favour. It is
  // only a quarter of the distance to the thesis line, so a thesis-based
  // R would report this as WITHIN_ZONE and withhold the fast lane.
  const forward = evaluateEntryOpportunity(wideThesis, { mid: 4340, atr: 40, tolerance: 0.1 });
  assert.equal(forward.remainingRisk, 30);
  assert.equal(forward.cap, 6, "the deviation cap is a fraction of entry-to-stop, not of the thesis distance");
});
