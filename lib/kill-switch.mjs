/**
 * kill-switch.mjs — the four v6.0 rules that end a trade before its stop
 * is reached.
 *
 * A stop is one price. These are the four ways the master prompt says a
 * trade can already be dead while price is still nowhere near it:
 *
 *   BREAKER_PRECEDENCE   the Breaker that was holding the trade up has
 *                        been closed through (§06.C / Iron Rule 15)
 *   HTF_CASCADE          the Daily PDA the thesis rests on broke, and
 *                        nothing Weekly was ever confirmed behind it
 *                        (§06.E / Iron Rule 14)
 *   PDA_ARRAYS_BROKEN    three opposing arrays between entry and stop
 *                        have been taken with no reaction (Iron Rule 12)
 *   TIME_STOP            the setup has had its candles and has not gone
 *                        anywhere — Time Distortion
 *
 * Three properties hold for all four, and they are the reason this is a
 * separate module rather than four conditionals inside the tick:
 *
 * **Nothing fires on a level nobody declared.** Each switch is *armed*
 * only by a number the analysis actually sent. An unarmed switch reports
 * itself unarmed and is never counted as passing — inventing a Breaker
 * so the rule has something to check would be the monitor manufacturing
 * the evidence it then acts on.
 *
 * **Everything is measured on closed bodies.** A wick through a Breaker
 * is a raid on the stops resting behind it; a body close through it is
 * the market accepting price on the other side. The whole codebase draws
 * that line and these rules draw it in the same place.
 *
 * **Firing is a recommendation, not an action.** There is no closing
 * order behind a manual position — the operator holds it — so a fired
 * switch produces one loud message and the trade stays tracked, with its
 * stop and targets still reported. Silently resolving the record would
 * take the operator's remaining alerts away at the exact moment he needs
 * them most.
 *
 * Nothing here performs I/O or reads the environment.
 */

import { bodyClosedBeyond, finiteNumber, oppositeBias, periodMs } from "./core.mjs";

export const KILL_SWITCH_CODES = Object.freeze([
  "BREAKER_PRECEDENCE",
  "HTF_CASCADE",
  "PDA_ARRAYS_BROKEN",
  "TIME_STOP",
]);

export const PDA_ARRAYS_LIMIT = 3;

/** Every switch answers in this shape, so an unknown never reads as a pass. */
function verdict(code, { armed = true, fired = false, known = true, reason = null, detail = {} } = {}) {
  return { code, armed, fired, known, reason, detail };
}

const closedAfter = (bar, span, afterMs) =>
  Number.isFinite(bar?.timestampMs) &&
  (!Number.isFinite(afterMs) || bar.timestampMs + span > afterMs);

/**
 * §06.C — the Breaker was the reason this trade could be held. A body
 * close through it against the position removes that reason, and the
 * FVGs and voids beyond it are no longer expected to fill.
 */
export function evaluateBreakerPrecedence(position, bars, { timeframe = "M5", sinceMs = null } = {}) {
  const level = finiteNumber(position?.breaker_level);
  if (level === null) {
    return verdict("BREAKER_PRECEDENCE", { armed: false, reason: "asnjë Breaker Block i deklaruar" });
  }
  if (!Array.isArray(bars) || bars.length === 0) {
    return verdict("BREAKER_PRECEDENCE", { known: false, reason: `${timeframe} candles unavailable` });
  }
  const span = periodMs(timeframe);
  const after = Number.isFinite(sinceMs) ? sinceMs : position?.openedAtMs ?? position?.armedAtMs ?? null;
  const against = oppositeBias(position.direction);
  const broken = bars.find(
    (bar) => closedAfter(bar, span, after) && bodyClosedBeyond(bar, level, against),
  );
  if (!broken) {
    return verdict("BREAKER_PRECEDENCE", { reason: "Breaker Block po mban çmimin" });
  }
  return verdict("BREAKER_PRECEDENCE", {
    fired: true,
    reason: `Breaker Block ${level} u thye me mbyllje trupi (${timeframe})`,
    detail: { level, close: broken.close, at: broken.timestampMs, timeframe },
  });
}

/**
 * §06.E — a broken Daily PDA does not flip the bias, it cascades to the
 * Weekly. So this fires only when there is nothing Weekly behind the
 * thesis: with a confirmed Weekly level the break is reported as a
 * cascade note and the trade is left alone, which is exactly what Iron
 * Rule 14 says to do.
 */
export function evaluateHtfCascade(position, dailyBars, { timeframe = "D1", sinceMs = null } = {}) {
  const level = finiteNumber(position?.htf_pda_level);
  if (level === null) {
    return verdict("HTF_CASCADE", { armed: false, reason: "asnjë Daily PDA i deklaruar" });
  }
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return verdict("HTF_CASCADE", { known: false, reason: `${timeframe} candles unavailable` });
  }
  const span = periodMs(timeframe);
  const after = Number.isFinite(sinceMs) ? sinceMs : null;
  const against = oppositeBias(position.direction);
  const broken = dailyBars.find(
    (bar) => closedAfter(bar, span, after) && bodyClosedBeyond(bar, level, against),
  );
  if (!broken) {
    return verdict("HTF_CASCADE", { reason: "Daily PDA i paprekur" });
  }
  if (position.htf_weekly_confirmed === true) {
    return verdict("HTF_CASCADE", {
      reason: `Daily PDA ${level} u thye — cascade te Weekly e konfirmuar, bias-i nuk ndryshon`,
      detail: { level, cascade: "WEEKLY_CONFIRMED", at: broken.timestampMs },
    });
  }
  return verdict("HTF_CASCADE", {
    fired: true,
    reason: `Daily PDA ${level} u thye plotësisht dhe nuk ka konfirmim Weekly`,
    detail: { level, close: broken.close, at: broken.timestampMs, timeframe },
  });
}

/**
 * Iron Rule 12 — three opposing arrays taken between entry and stop with
 * no reaction. Each declared array counts once, by its own level, so
 * re-reading the same closed bar on a later tick cannot inflate the
 * count; arrays outside the entry-to-stop corridor are ignored, because
 * the rule is about the ground the trade has already given up.
 */
export function advancePdaArraysBroken(state, position, bars, { timeframe = "M5", limit = PDA_ARRAYS_LIMIT, sinceMs = null } = {}) {
  const previous = state && Array.isArray(state.brokenLevels)
    ? state
    : { count: 0, brokenLevels: [], armed: false };
  const declared = Array.isArray(position?.pda_arrays) ? position.pda_arrays : [];
  const entry = finiteNumber(position?.entry);
  const stop = finiteNumber(position?.sl);
  const corridor = declared
    .map((value) => finiteNumber(value))
    .filter((level) => level !== null && entry !== null && stop !== null &&
      level > Math.min(entry, stop) && level < Math.max(entry, stop));

  if (corridor.length === 0) {
    return { ...previous, armed: false, fired: false, reason: "asnjë PDA array i deklaruar mes entry dhe SL" };
  }
  if (!Array.isArray(bars) || bars.length === 0) {
    return { ...previous, armed: true, fired: false, known: false, reason: `${timeframe} candles unavailable` };
  }

  const span = periodMs(timeframe);
  const after = Number.isFinite(sinceMs) ? sinceMs : position?.openedAtMs ?? null;
  const against = oppositeBias(position.direction);
  const broken = new Set(previous.brokenLevels);
  for (const level of corridor) {
    if (broken.has(level)) continue;
    const hit = bars.some((bar) => closedAfter(bar, span, after) && bodyClosedBeyond(bar, level, against));
    if (hit) broken.add(level);
  }
  const count = broken.size;
  const wasFired = previous.count >= limit;
  return {
    armed: true,
    known: true,
    count,
    limit,
    declared: corridor.length,
    brokenLevels: [...broken],
    fired: count >= limit,
    newlyFired: count >= limit && !wasFired,
    reason:
      count >= limit
        ? `${count} PDA arrays të thyera mes entry dhe SL pa reagim`
        : `${count}/${limit} PDA arrays të thyera`,
  };
}

/**
 * Time Stop — the setup has had its candles and has not gone anywhere.
 *
 * Progress is measured as the best the trade has actually been offered
 * since entry, not where price happens to sit on this tick: a trade that
 * ran 70% of the way to TP1 and came back has been delivered and is a
 * different problem from one that never moved. Bars are counted, never
 * wall-clock minutes, because a monitoring gap is not the market
 * standing still.
 */
export function evaluateTimeStop(position, bars, { timeframe = "M5", barsAllowed = 12, minProgress = 0.5, nowMs = Date.now() } = {}) {
  const entry = finiteNumber(position?.entry);
  const target = finiteNumber(position?.tp1);
  const openedAt = Number.isFinite(position?.openedAtMs) ? position.openedAtMs : null;
  if (entry === null || target === null || openedAt === null) {
    return verdict("TIME_STOP", { armed: false, reason: "trade pa entry/TP1/kohë hapjeje" });
  }
  if (!Array.isArray(bars) || bars.length === 0) {
    return verdict("TIME_STOP", { known: false, reason: `${timeframe} candles unavailable` });
  }
  const span = periodMs(timeframe);
  const since = bars.filter((bar) => Number.isFinite(bar?.timestampMs) && bar.timestampMs >= openedAt);
  const elapsed = since.length;
  const distance = Math.abs(target - entry);
  const best = since.length
    ? position.direction === "buy"
      ? Math.max(...since.map((bar) => bar.high))
      : Math.min(...since.map((bar) => bar.low))
    : entry;
  const progress = distance > 0
    ? Math.max(0, (position.direction === "buy" ? best - entry : entry - best) / distance)
    : 0;
  const detail = {
    bars_elapsed: elapsed,
    bars_allowed: barsAllowed,
    progress_to_tp1: Number(progress.toFixed(3)),
    min_progress: minProgress,
    timeframe,
    measured_at: nowMs,
    span_ms: span,
  };
  if (elapsed < barsAllowed) {
    return verdict("TIME_STOP", { reason: `${elapsed}/${barsAllowed} qirinj që nga hyrja`, detail });
  }
  if (progress >= minProgress) {
    return verdict("TIME_STOP", {
      reason: `lëvizi ${Math.round(progress * 100)}% drejt TP1 — po dorëzohet`,
      detail,
    });
  }
  return verdict("TIME_STOP", {
    fired: true,
    reason: `${elapsed} qirinj pas hyrjes dhe vetëm ${Math.round(progress * 100)}% drejt TP1 — Time Distortion`,
    detail,
  });
}

/**
 * All four in one pass, in the order the master prompt ranks them. The
 * caller supplies whichever candle series it managed to read; a series
 * it could not read produces an explicit unknown rather than a pass.
 */
export function evaluateKillSwitches(position, {
  bars = null,
  dailyBars = null,
  arraysState = null,
  timeframe = "M5",
  htfTimeframe = "D1",
  barsAllowed = 12,
  minProgress = 0.5,
  arraysLimit = PDA_ARRAYS_LIMIT,
  timeStopEnabled = true,
  nowMs = Date.now(),
} = {}) {
  const arrays = advancePdaArraysBroken(arraysState, position, bars, {
    timeframe,
    limit: arraysLimit,
    sinceMs: position?.openedAtMs ?? null,
  });
  const results = [
    evaluateBreakerPrecedence(position, bars, { timeframe }),
    evaluateHtfCascade(position, dailyBars, { timeframe: htfTimeframe }),
    verdict("PDA_ARRAYS_BROKEN", {
      armed: arrays.armed === true,
      fired: arrays.fired === true,
      known: arrays.known !== false,
      reason: arrays.reason,
      detail: { count: arrays.count ?? 0, limit: arrays.limit ?? arraysLimit, levels: arrays.brokenLevels ?? [] },
    }),
  ];
  if (timeStopEnabled) {
    results.push(evaluateTimeStop(position, bars, { timeframe, barsAllowed, minProgress, nowMs }));
  }
  return {
    arraysState: arrays,
    results,
    fired: results.filter((result) => result.fired),
    armed: results.filter((result) => result.armed),
  };
}

/**
 * The levels that arm the switches, validated the same way the setup's
 * own levels are: numeric, on the side of the trade that makes the rule
 * mean what it says, and refused rather than silently dropped when they
 * are not.
 *
 * A Breaker above a long's entry is not the Breaker holding that long
 * up, and a "PDA array" outside the entry-to-stop corridor is not one of
 * the three Iron Rule 12 counts. Accepting either would arm a switch
 * that then measures something else.
 */
export function validateKillSwitchInput(args = {}, { direction, entry, sl }) {
  const isBuy = direction === "buy";
  const protectiveSide = (value, field) => {
    if (isBuy && !(value < entry)) throw new Error(`${field} must be below entry for a buy`);
    if (!isBuy && !(value > entry)) throw new Error(`${field} must be above entry for a sell`);
    return value;
  };
  const optionalLevel = (field) => {
    const raw = args[field];
    if (raw === undefined || raw === null || raw === "") return null;
    const value = finiteNumber(raw);
    if (value === null || !(value > 0)) throw new Error(`${field} must be a positive number`);
    return protectiveSide(value, field);
  };

  const breaker = optionalLevel("breaker_level");
  const htf = optionalLevel("htf_pda_level");

  let arrays = null;
  if (args.pda_arrays !== undefined && args.pda_arrays !== null && args.pda_arrays !== "") {
    if (!Array.isArray(args.pda_arrays)) throw new Error("pda_arrays must be an array of price levels");
    if (args.pda_arrays.length > 8) throw new Error("pda_arrays accepts at most 8 levels");
    const low = Math.min(entry, sl);
    const high = Math.max(entry, sl);
    arrays = args.pda_arrays.map((raw) => {
      const value = finiteNumber(raw);
      if (value === null || !(value > 0)) throw new Error("pda_arrays entries must be positive numbers");
      if (!(value > low && value < high)) {
        throw new Error(`pda_arrays entry ${value} is not between entry and sl`);
      }
      return value;
    });
    arrays = [...new Set(arrays)];
  }

  let timeStopBars = null;
  if (args.time_stop_bars !== undefined && args.time_stop_bars !== null && args.time_stop_bars !== "") {
    const value = finiteNumber(args.time_stop_bars);
    if (value === null || !(value >= 1 && value <= 288)) {
      throw new Error("time_stop_bars must be between 1 and 288 M5 candles");
    }
    timeStopBars = Math.floor(value);
  }

  return {
    breaker_level: breaker,
    htf_pda_level: htf,
    htf_weekly_confirmed: args.htf_weekly_confirmed === true,
    pda_arrays: arrays,
    time_stop_bars: timeStopBars,
  };
}
