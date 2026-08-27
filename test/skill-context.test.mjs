/**
 * Skill-context suite.
 *
 * The context used to drive a "fast lane": the analyst could claim the M5
 * structure shift had already printed, and the monitor would accept an M1
 * proof in its place. That lane was removed because it could not open —
 * it required the analysis to still be inside its own freshness window
 * when price returned to the entry zone, and an analysis is written,
 * registered, and only then waited on. On the live setup that prompted
 * the removal the context was six minutes past its window before the
 * watch was even registered.
 *
 * What is left is a record: what the analyst believed, carried alongside
 * the setup and scored against the outcome. These tests exist to keep it
 * that way — a record that changes nothing.
 *
 *   node --test test/skill-context.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FORWARD_VALIDATION_STATES,
  PERIOD_MS,
  defenceSatisfied,
  forwardValidationState,
  skillContextAudit,
  stageOf,
  summariseSkillContextAudits,
  validateSkillContext,
  validateWatchInput,
  verifyM1Continuation,
} from "../lib/core.mjs";

const M1 = PERIOD_MS.M1;

const BUY = {
  symbol: "XAUUSD",
  direction: "buy",
  entry: 4330,
  sl: 4310,
  tp1: 4390,
  entry_zone_low: 4328,
  entry_zone_high: 4332,
};

function bar(t, open, high, low, close) {
  return { open, high, low, close, timestampMs: t, volume: 1 };
}

// ---------------------------------------------------------------------------
// The guarantee: a context is a record, not an instruction.

test("S1 — a context the skill did not send changes nothing", () => {
  assert.equal(validateSkillContext(undefined), null);
  assert.equal(validateSkillContext(null), null);
  assert.equal(validateSkillContext(""), null);
});

test("S2 — no field survives that could shorten the confirmation path", () => {
  // These are the fields the fast lane read. Sending them is now a no-op:
  // they are dropped rather than stored, so nothing downstream can act on
  // them and no code can quietly start honouring them again.
  const context = validateSkillContext(
    {
      conviction: "HIGH",
      m5_mss_already_observed: true,
      skip_m5_sequence_if: "m5_mss_already_observed",
      require_m1_only_if: "always",
      suggested_min_hold_ms: 1,
      suggested_max_age_ms: 900000,
    },
    { direction: "buy" },
  );
  for (const field of [
    "skip_m5_sequence_if",
    "require_m1_only_if",
    "suggested_min_hold_ms",
    "suggested_max_age_ms",
  ]) {
    assert.equal(context[field], undefined, `${field} must not survive validation`);
  }
  // What it claimed is still recorded, because that is the whole point.
  assert.equal(context.m5_mss_already_observed, true);
  assert.equal(context.conviction, "HIGH");
});

test("S3 — only an explicit true is a claim", () => {
  const context = validateSkillContext(
    { htf_mss_confirmed: "yes", liquidity_swept: true, m5_mss_already_observed: 0 },
    { direction: "buy" },
  );
  assert.equal(context.htf_mss_confirmed, false, "a non-boolean is not a claim");
  assert.equal(context.liquidity_swept, true);
  assert.equal(context.m5_mss_already_observed, false);
  assert.ok(context.warnings.some((line) => /htf_mss_confirmed/.test(line)));
});

test("S4 — a timestamp from the future is dropped, not trusted", () => {
  // A realistic epoch: numericTimestampMs distinguishes seconds from
  // milliseconds by magnitude, so a 1970 timestamp is not a fair test.
  const nowMs = Date.parse("2026-08-27T12:00:00Z");
  const context = validateSkillContext(
    { m5_mss_at_ms: nowMs + 10 * 60_000, htf_mss_at_ms: nowMs - 60_000 },
    { nowMs, direction: "buy" },
  );
  assert.equal(context.m5_mss_at_ms, null);
  assert.equal(context.htf_mss_at_ms, nowMs - 60_000);
});

test("S5 — structural nonsense throws rather than defaulting", () => {
  assert.throws(() => validateSkillContext("not json", { direction: "buy" }), /must be an object/);
  assert.throws(() => validateSkillContext([1, 2], { direction: "buy" }), /must be an object/);
  assert.throws(
    () => validateSkillContext({ htf_mss_at: "abc" }, { direction: "buy" }),
    /must be numeric/,
  );
});

test("S6 — an unrecognised conviction is MEDIUM, and buys nothing either way", () => {
  const context = validateSkillContext({ conviction: "A+" }, { direction: "buy" });
  assert.equal(context.conviction, "MEDIUM");
  assert.ok(context.warnings.some((line) => /conviction/.test(line)));
});

test("S7 — a context disagreeing with its own setup is recorded, not acted on", () => {
  const context = validateSkillContext({ htf_bias: "bearish" }, { direction: "buy" });
  assert.equal(context.htf_bias, "sell");
  assert.equal(context.direction_conflict, true);
  assert.ok(context.warnings.some((line) => /disagrees/.test(line)));
  // Nothing is withheld, because nothing was ever conferred.
  assert.equal(context.warnings.some((line) => /fast lane/i.test(line)), false);
});

test("S8 — the context reaches the watch intact and normalised", () => {
  const watch = validateWatchInput({
    ...BUY,
    skill_context: { conviction: "high", htf_bias: "bullish", trap_phase: "DELIVERY" },
  });
  assert.equal(watch.skill_context.conviction, "HIGH");
  assert.equal(watch.skill_context.htf_bias, "buy");
  assert.equal(watch.skill_context.trap_phase, "delivery");
  assert.equal(watch.conviction, "HIGH", "it fills the setup's conviction when none was given");
});

test("S9 — no context can register a setup whose own shape is invalid", () => {
  assert.throws(
    () =>
      validateWatchInput({
        ...BUY,
        tp1: 4335,
        skill_context: { conviction: "HIGH", m5_mss_already_observed: true },
      }),
    /at least 1R/,
  );
});

// ---------------------------------------------------------------------------
// Forward validation survives, because the declared M1 defence profile
// reads it before accepting M1 proof. It no longer opens anything.

test("S10 — every forward state is one of the five, on degenerate inputs too", () => {
  const cases = [
    { mid: 4330, nowMs: 0 },
    { mid: null, nowMs: 0 },
    { mid: 4300, nowMs: 0 },
    { mid: 4400, nowMs: 0 },
    { mid: 4330, nowMs: 10 ** 12 },
  ];
  for (const options of cases) {
    const verdict = forwardValidationState(BUY, { ...options, touchedAtMs: 0 });
    assert.ok(FORWARD_VALIDATION_STATES.includes(verdict.state), `${verdict.state} is a known state`);
  }
});

test("S11 — price moving against the setup is FAILED, and withdraws the M1 profile", () => {
  const failed = forwardValidationState(BUY, { mid: 4319, touchedAtMs: 0, nowMs: 1000 });
  assert.equal(failed.state, "FAILED");
  const defence = defenceSatisfied("m1_continuation", {
    sequence: { rejection: {} },
    m1Continuation: { ok: true },
    forwardState: failed.state,
  });
  assert.equal(defence.satisfied, false);
  assert.match(defence.missing, /withdrawn/);
});

test("S12 — M1 continuation is proven on closed bars that closed after the touch", () => {
  const touchedAt = 20 * M1;
  const bars = [];
  for (let index = 0; index < 12; index += 1) {
    bars.push(bar(index * M1, 4330, 4331, 4329, 4330));
  }
  bars.push(bar(12 * M1, 4330, 4331, 4326, 4327));
  for (let index = 13; index < 21; index += 1) {
    bars.push(bar(index * M1, 4327, 4329, 4326.5, 4328));
  }
  bars.push(bar(21 * M1, 4328, 4336, 4327.5, 4335.5));

  const stale = verifyM1Continuation(bars, "buy", touchedAt, { minBarsAfterTouch: 5 });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /closed M1 bar/);
});

test("S13 — a structure shift with no displacement behind it is not continuation", () => {
  const bars = [];
  for (let index = 0; index < 20; index += 1) {
    bars.push(bar(index * M1, 4330, 4331, 4329, 4330));
  }
  const verdict = verifyM1Continuation(bars, "buy", 0, { minBarsAfterTouch: 1 });
  assert.equal(verdict.ok, false);
});

test("S14 — a watch on the declared M1 profile reports what it proved", () => {
  const watch = {
    ...BUY,
    lifecycle: "TOUCHED",
    entryTouched: true,
    defence_profile: "m1_continuation",
    m1ContinuationOk: true,
    sequence: { rejection: {} },
  };
  assert.equal(stageOf(watch), "M1_CONTINUATION_CONFIRMED");
  // Without the proof it reports only what it has.
  assert.equal(stageOf({ ...watch, m1ContinuationOk: false }), "REJECTION_DETECTED");
});

// ---------------------------------------------------------------------------
// The audit is the reason the context is still carried at all.

test("S15 — the audit scores the claim against the outcome, in both directions", () => {
  const context = validateSkillContext({ conviction: "HIGH", liquidity_swept: true }, { direction: "buy" });
  const watch = {
    ...BUY,
    skill_context: context,
    entryTouchedAtMs: 1000,
    confirmedAtMs: 61_000,
    defence_profile: "standard",
    sequence: { complete: true },
  };
  const confirmed = skillContextAudit(watch, "CONFIRMED");
  assert.equal(confirmed.verdict, "skill_said_HIGH_and_confirmed");
  assert.equal(confirmed.observed.touch_to_confirm_ms, 60_000);
  assert.equal(confirmed.observed.sequence_complete, true);

  const failed = skillContextAudit(watch, "FAILED");
  assert.equal(failed.verdict, "skill_said_HIGH_but_failed");

  assert.equal(skillContextAudit({ ...watch, skill_context: null }, "CONFIRMED"), null);
});

test("S16 — the summary separates conviction from declared defence", () => {
  const audits = [
    { conviction: "HIGH", outcome: "CONFIRMED", observed: { defence_profile: "standard" } },
    { conviction: "HIGH", outcome: "FAILED", observed: { defence_profile: "standard" } },
    { conviction: "LOW", outcome: "CONFIRMED", observed: { defence_profile: "m1_continuation" } },
  ];
  const summary = summariseSkillContextAudits(audits);
  assert.equal(summary.total, 3);
  assert.equal(summary.by_conviction.HIGH.confirmed, 1);
  assert.equal(summary.by_conviction.HIGH.failed, 1);
  assert.equal(summary.by_defence_profile.m1_continuation.confirmed, 1);
  assert.equal(summary.by_lane, undefined, "there is no lane to group by any more");
});
