/**
 * Skill-context suite. The skill-context fast lane is the only feature
 * in this service that lets an entry happen sooner than the full
 * post-touch M5 sequence would have allowed, so every test here names
 * the way that could go wrong and passes only if the code makes it
 * unreachable — not unlikely.
 *
 * The rule under test throughout: a claim is never evidence. The
 * analyst's context can decide which live proof is required and how long
 * it must hold; it can never stand in for proof, and it can never touch
 * a safety check.
 *
 *   node --test test/skill-context.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_STAGES,
  SKILL_CONTEXT_LIMITS,
  applySkillContext,
  forwardValidationState,
  skillContextAgeMs,
  skillContextAudit,
  stageOf,
  summariseSkillContextAudits,
  validateSkillContext,
  validateWatchInput,
  verifyM1Continuation,
} from "../lib/core.mjs";

const M1 = 60_000;

function bar(t, open, high, low, close) {
  return { open, high, low, close, timestampMs: t, volume: 1 };
}

const BUY = {
  symbol: "XAUUSD",
  direction: "buy",
  entry: 4330,
  sl: 4310,
  invalidation: 4310,
  tp1: 4390,
  entry_zone_low: 4328,
  entry_zone_high: 4332,
};
// 20 points of risk, so 1R = 20: 0.15R = 3 points, 0.5R = 10 points.

const FRESH = () => ({
  htf_mss_confirmed: true,
  trap_phase: "delivery",
  liquidity_swept: true,
  m5_mss_already_observed: true,
  htf_bias: "bullish",
  conviction: "HIGH",
  suggested_min_hold_ms: 15_000,
  suggested_max_age_ms: 180_000,
  skip_m5_sequence_if: "m5_mss_already_observed",
  require_m1_only_if: "m5_mss_already_observed",
});

const CONFIG = {
  enabled: true,
  fastLaneEnabled: true,
  minHoldMs: 60_000,
  holdFloorMs: 15_000,
  sequenceRequired: true,
};

/**
 * M1 that prints a pivot high, then breaks it on the last closed bar
 * with a body many times the recent average — the fast lane's proof
 * obligation, met.
 */
function m1Continuing(touchedAtMs, { displacement = true, breakSwing = true } = {}) {
  const start = touchedAtMs - 5 * M1;
  const bars = [];
  for (let index = 0; index < 6; index += 1) {
    // Rising lows so the only pivot in the window is the high below.
    const base = 4326 + index * 0.2;
    bars.push(bar(start + index * M1, base, base + 0.4, base - 0.2, base + 0.2));
  }
  // The pivot high the structure shift has to break.
  bars.push(bar(start + 6 * M1, 4327.4, 4331.5, 4327.2, 4327.6));
  for (let index = 7; index < 11; index += 1) {
    const base = 4327.8 + (index - 7) * 0.2;
    bars.push(bar(start + index * M1, base, base + 0.3, base - 0.2, base + 0.2));
  }
  // Prior bodies are 0.2 apiece, so the displacement threshold is 0.36:
  // a 0.3 body breaks the pivot without any impulse behind it.
  const close = breakSwing ? 4334 : 4330;
  const open = displacement ? 4328.4 : close - 0.3;
  bars.push(bar(start + 11 * M1, open, close + 0.3, Math.min(open, close) - 0.2, close));
  return bars;
}

// ---------------------------------------------------------------------------
// Registration

test("S1 — a context the skill did not send changes nothing", () => {
  const input = validateWatchInput({ ...BUY });
  assert.equal(input.skill_context, null);
  const decision = applySkillContext(null, { forwardState: "STRONG_MOVE" }, CONFIG);
  assert.equal(decision.lane, "STANDARD");
  assert.equal(decision.holdMs, CONFIG.minHoldMs);
  assert.equal(decision.requireSequence, true);
});

test("S2 — only an explicit true is a claim", () => {
  const context = validateSkillContext({
    htf_mss_confirmed: "false",
    liquidity_swept: 0,
    m5_mss_already_observed: null,
  });
  assert.equal(context.htf_mss_confirmed, false);
  assert.equal(context.liquidity_swept, false);
  assert.equal(context.m5_mss_already_observed, false);
});

test("S3 — a shorter hold than the floor is raised to the floor, never honoured as sent", () => {
  const context = validateSkillContext({ ...FRESH(), suggested_min_hold_ms: 10 });
  const decision = applySkillContext(
    context,
    { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.holdMs, CONFIG.holdFloorMs);
  assert.ok(decision.holdMs >= SKILL_CONTEXT_LIMITS.holdFloorMs);
});

test("S4 — a freshness window longer than the cap is clamped and the clamp is reported", () => {
  const context = validateSkillContext({ suggested_max_age_ms: 24 * 60 * 60_000 });
  assert.equal(context.suggested_max_age_ms, SKILL_CONTEXT_LIMITS.maxAgeCapMs);
  assert.ok(context.warnings.some((warning) => /clamped/.test(warning)));
});

test("S5 — a timestamp from the future is dropped, not trusted", () => {
  const nowMs = Date.now();
  const context = validateSkillContext(
    { m5_mss_at_ms: nowMs + 60 * 60_000, htf_mss_at_ms: nowMs - 1000 },
    { nowMs },
  );
  assert.equal(context.m5_mss_at_ms, null);
  assert.ok(context.warnings.some((warning) => /future/.test(warning)));
  // The age falls back to a claim that is real, so a bad clock cannot
  // manufacture a fresh context.
  assert.ok(skillContextAgeMs(context, nowMs) >= 1000);
});

test("S6 — structural nonsense throws rather than being read as a default", () => {
  assert.throws(() => validateSkillContext([1, 2, 3]), /must be an object/);
  assert.throws(() => validateSkillContext({ htf_mss_at: "not a price" }), /must be numeric/);
  assert.throws(() => validateSkillContext({ suggested_min_hold_ms: "soon" }), /must be numeric/);
});

test("S7 — an unrecognised conviction is MEDIUM, which buys nothing", () => {
  const context = validateSkillContext({ ...FRESH(), conviction: "VERY HIGH" });
  assert.equal(context.conviction, "MEDIUM");
  const decision = applySkillContext(
    context,
    { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.holdMs, CONFIG.minHoldMs, "MEDIUM cannot shorten the hold");
  assert.equal(decision.lane, "M1_FAST", "but it can still take the verified M1 lane");
});

// ---------------------------------------------------------------------------
// Forward validation — the five states

test("S8 — WITHIN_ZONE: price sitting in the zone confers no fast lane", () => {
  const forward = forwardValidationState(BUY, {
    mid: 4330.5,
    zone: { low: 4328, high: 4332 },
    touchedAtMs: Date.now() - 30_000,
    contextAgeMs: 30_000,
    maxAgeMs: 180_000,
  });
  assert.equal(forward.state, "WITHIN_ZONE");
  const decision = applySkillContext(
    validateSkillContext(FRESH(), { direction: "buy" }),
    { forwardState: forward.state, m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "STANDARD");
  assert.equal(decision.requireSequence, true);
  assert.ok(decision.blocked.some((reason) => /has not moved out of the zone/.test(reason)));
});

test("S9 — FAVORABLE_EARLY: a first step in the right direction opens the M1 lane", () => {
  const forward = forwardValidationState(BUY, {
    mid: 4334,
    touchedAtMs: Date.now() - 60_000,
    contextAgeMs: 60_000,
    maxAgeMs: 180_000,
  });
  assert.equal(forward.state, "FAVORABLE_EARLY");
  const decision = applySkillContext(
    validateSkillContext(FRESH(), { direction: "buy" }),
    { forwardState: forward.state, m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "M1_FAST");
  assert.equal(decision.requireSequence, false);
});

test("S10 — STRONG_MOVE with HIGH conviction is the fastest lane there is, and it is still gated on M1 proof", () => {
  const forward = forwardValidationState(BUY, {
    mid: 4342,
    touchedAtMs: Date.now() - 45_000,
    contextAgeMs: 45_000,
    maxAgeMs: 180_000,
  });
  assert.equal(forward.state, "STRONG_MOVE");
  const context = validateSkillContext(FRESH(), { direction: "buy" });

  const unproven = applySkillContext(
    context,
    { forwardState: forward.state, m1Continuation: { ok: false, reason: "no M1 structure shift since the touch" } },
    CONFIG,
  );
  assert.equal(unproven.lane, "STANDARD", "a strong move on its own is not a confirmation");
  assert.equal(unproven.requireSequence, true);
  assert.ok(unproven.eligible, "the context qualified; only the live proof is missing");

  const proven = applySkillContext(
    context,
    { forwardState: forward.state, m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(proven.lane, "SKILL_VALIDATED");
  assert.equal(proven.holdMs, CONFIG.holdFloorMs);
});

test("S11 — STALE: the window closes and the context stops conferring anything", () => {
  const forward = forwardValidationState(BUY, {
    mid: 4330.5,
    zone: { low: 4328, high: 4332 },
    touchedAtMs: Date.now() - 400_000,
    contextAgeMs: 400_000,
    maxAgeMs: 180_000,
  });
  assert.equal(forward.state, "STALE");
  const decision = applySkillContext(
    validateSkillContext(FRESH(), { direction: "buy" }),
    { forwardState: forward.state, m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "STANDARD");
  assert.equal(decision.requireSequence, true);
  assert.equal(decision.holdMs, CONFIG.minHoldMs, "an expired context cannot shorten the hold either");
});

test("S12 — FAILED: price moving against the setup revokes the fast lane", () => {
  const forward = forwardValidationState(BUY, {
    mid: 4319,
    touchedAtMs: Date.now() - 60_000,
    contextAgeMs: 60_000,
    maxAgeMs: 180_000,
  });
  assert.equal(forward.state, "FAILED");
  const decision = applySkillContext(
    validateSkillContext(FRESH(), { direction: "buy" }),
    { forwardState: forward.state, m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "STANDARD");
  assert.equal(decision.holdMs, CONFIG.minHoldMs);
  assert.ok(decision.blocked.some((reason) => /moved against/.test(reason)));
});

test("S13 — every forward state is one of the five, on degenerate inputs too", () => {
  const states = new Set();
  for (const mid of [NaN, 0, 4330, 4300, 4400]) {
    states.add(
      forwardValidationState(BUY, { mid, touchedAtMs: Date.now(), contextAgeMs: 0 }).state,
    );
  }
  for (const state of states) {
    assert.ok(
      ["WITHIN_ZONE", "FAVORABLE_EARLY", "STRONG_MOVE", "STALE", "FAILED"].includes(state),
      `${state} is not a forward-validation state`,
    );
  }
});

// ---------------------------------------------------------------------------
// The fast lane's own proof obligation

test("S14 — M1 continuation is proven on closed bars that closed after the touch", () => {
  const touchedAtMs = Date.now() - 12 * M1;
  const bars = m1Continuing(touchedAtMs);
  const proven = verifyM1Continuation(bars, "buy", touchedAtMs, { minBarsAfterTouch: 2 });
  assert.equal(proven.ok, true);
  assert.equal(proven.mss.present, true);
  assert.equal(proven.displacement.present, true);

  // The same bars, against a touch that happened after all of them, are
  // history the analyst already saw.
  const late = verifyM1Continuation(bars, "buy", Date.now() + 10 * M1, { minBarsAfterTouch: 2 });
  assert.equal(late.ok, false);
  assert.match(late.reason, /closed M1 bar/);
});

test("S15 — a structure shift with no displacement behind it is not continuation", () => {
  const touchedAtMs = Date.now() - 12 * M1;
  const bars = m1Continuing(touchedAtMs, { displacement: false });
  const result = verifyM1Continuation(bars, "buy", touchedAtMs, { minBarsAfterTouch: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.mss.present, true);
  assert.equal(result.displacement.present, false);
  assert.match(result.reason, /displacement/);
});

test("S16 — a displacement that breaks no structure is not continuation either", () => {
  const touchedAtMs = Date.now() - 12 * M1;
  const bars = m1Continuing(touchedAtMs, { breakSwing: false });
  const result = verifyM1Continuation(bars, "buy", touchedAtMs, { minBarsAfterTouch: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.mss.present, false);
});

test("S17 — too little M1 history is unknown, never continuation", () => {
  const result = verifyM1Continuation([bar(0, 1, 2, 0.5, 1.5)], "buy", 0);
  assert.equal(result.ok, false);
  assert.match(result.reason, /insufficient/);
});

// ---------------------------------------------------------------------------
// Guardrails

test("S18 — a context that disagrees with its own setup earns nothing", () => {
  const context = validateSkillContext({ ...FRESH(), htf_bias: "bearish" }, { direction: "buy" });
  assert.equal(context.direction_conflict, true);
  const decision = applySkillContext(
    context,
    { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "STANDARD");
  assert.equal(decision.holdMs, CONFIG.minHoldMs);
  assert.ok(decision.blocked.some((reason) => /htf_bias disagrees/.test(reason)));
});

test("S19 — the operator's switch beats every claim the skill can make", () => {
  const context = validateSkillContext(FRESH(), { direction: "buy" });
  const observations = { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } };

  const laneOff = applySkillContext(context, observations, { ...CONFIG, fastLaneEnabled: false });
  assert.equal(laneOff.lane, "STANDARD");
  assert.equal(laneOff.requireSequence, true);

  const allOff = applySkillContext(context, observations, { ...CONFIG, enabled: false });
  assert.equal(allOff.lane, "STANDARD");
  assert.equal(allOff.holdMs, CONFIG.minHoldMs);
});

test("S20 — a context that asks for nothing gets the standard path even at HIGH conviction", () => {
  const context = validateSkillContext({ conviction: "HIGH", htf_mss_confirmed: true }, { direction: "buy" });
  assert.equal(context.skip_m5_sequence_if, "never");
  const decision = applySkillContext(
    context,
    { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "STANDARD");
  assert.equal(decision.requireSequence, true);
});

test("S21 — a condition whose claim was never made does not fire", () => {
  const context = validateSkillContext(
    { ...FRESH(), m5_mss_already_observed: false },
    { direction: "buy" },
  );
  const decision = applySkillContext(
    context,
    { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "STANDARD");
  assert.ok(context.warnings.some((warning) => /is declared but its claim is not set/.test(warning)));
});

test("S22 — a longer hold is always honoured, including against the fastest lane", () => {
  const context = validateSkillContext(
    { ...FRESH(), suggested_min_hold_ms: 5 * 60_000 },
    { direction: "buy" },
  );
  const decision = applySkillContext(
    context,
    { forwardState: "STRONG_MOVE", m1Continuation: { ok: true } },
    CONFIG,
  );
  assert.equal(decision.lane, "SKILL_VALIDATED");
  assert.equal(decision.holdMs, 5 * 60_000, "two instructions that disagree resolve toward more proof");
});

// ---------------------------------------------------------------------------
// What a human and the skill get to see afterwards

test("S23 — a watch on the fast lane does not report itself as merely touched", () => {
  const watch = {
    ...BUY,
    kind: "SETUP",
    lifecycle: "TOUCHED",
    entryTouched: true,
    sequence: { rejection: null, mss: null, displacement: null, complete: false },
    skillContextState: { lane: "M1_FAST" },
  };
  assert.equal(stageOf(watch), "M1_CONTINUATION_CONFIRMED");
  assert.ok(EXECUTION_STAGES.includes("M1_CONTINUATION_CONFIRMED"));
  assert.equal(stageOf({ ...watch, skillContextState: null }), "ENTRY_TOUCHED");
});

test("S24 — the audit scores the claim against the outcome, in both directions", () => {
  const watch = {
    ...BUY,
    skill_context: validateSkillContext(FRESH(), { direction: "buy" }),
    skillContextState: {
      lane: "SKILL_VALIDATED",
      forwardState: "STRONG_MOVE",
      holdMs: 15_000,
      baseHoldMs: 60_000,
      forward: { progressR: 0.62 },
      m1Continuation: { ok: true, barsAfterTouch: 3, mss: { present: true }, displacement: { present: true } },
    },
    entryTouchedAtMs: 1_000_000,
    confirmedAtMs: 1_090_000,
    sequence: { complete: false },
  };
  const failed = skillContextAudit(watch, "FAILED");
  assert.equal(failed.verdict, "skill_said_HIGH_but_failed");
  assert.equal(failed.observed.touch_to_confirm_ms, 90_000);
  assert.equal(failed.observed.m5_sequence_complete, false);
  assert.equal(failed.observed.m1_continuation.ok, true);

  const executed = skillContextAudit(watch, "EXECUTED");
  assert.equal(executed.verdict, "skill_said_HIGH_and_executed");

  assert.equal(skillContextAudit({ ...watch, skill_context: null }, "FAILED"), null);
});

test("S25 — the summary separates conviction from lane so both can be calibrated", () => {
  const audits = [
    { conviction: "HIGH", lane: "SKILL_VALIDATED", forward_state: "STRONG_MOVE", outcome: "EXECUTED", observed: { hold_ms_used: 15_000, touch_to_confirm_ms: 60_000 } },
    { conviction: "HIGH", lane: "SKILL_VALIDATED", forward_state: "STRONG_MOVE", outcome: "FAILED", observed: { hold_ms_used: 15_000, touch_to_confirm_ms: 90_000 } },
    { conviction: "LOW", lane: "STANDARD", forward_state: "WITHIN_ZONE", outcome: "CONFIRMED", observed: { hold_ms_used: 60_000, touch_to_confirm_ms: 300_000 } },
  ];
  const summary = summariseSkillContextAudits(audits);
  assert.equal(summary.total, 3);
  assert.equal(summary.by_conviction.HIGH.total, 2);
  assert.equal(summary.by_conviction.HIGH.failed, 1);
  assert.equal(summary.by_conviction.LOW.confirmed, 1);
  assert.equal(summary.by_lane.SKILL_VALIDATED.total, 2);
  assert.equal(summary.by_lane.STANDARD.total, 1);
  assert.equal(summary.mean_hold_ms, 30_000);
  assert.equal(summariseSkillContextAudits([]).total, 0);
});

// ---------------------------------------------------------------------------
// The line the fast lane must never cross

test("S26 — no context can register a setup whose own shape is invalid", () => {
  assert.throws(
    () =>
      validateWatchInput({
        ...BUY,
        sl: 4340, // above the entry on a buy
        skill_context: FRESH(),
      }),
    /entry > sl/,
  );
});

test("S27 — the context reaches the watch intact and normalised", () => {
  const input = validateWatchInput({ ...BUY, skill_context: FRESH() });
  assert.equal(input.skill_context.htf_bias, "buy", "bullish is normalised to the order side");
  assert.equal(input.skill_context.conviction, "HIGH");
  assert.equal(input.conviction, "HIGH", "and backfills the watch's own conviction field");
  assert.equal(input.skill_context.direction_conflict, false);
});
