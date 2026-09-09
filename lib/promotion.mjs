/**
 * promotion.mjs — turning a confirmed trap read into a live setup.
 *
 * A trap watch answers one falsifiable question and then hands the
 * question back to a human, who re-runs the analysis and registers a
 * setup. This module is that human's arithmetic: the hard gates that
 * decide whether the confirmation deserves a setup at all, and the
 * geometry that produces entry, stop and targets from the same
 * primitives the analysis pipeline uses.
 *
 * Two things it deliberately is not.
 *
 * It is not the 23-item scored checklist. Scoring is judgement, and
 * judgement that nobody reads is not judgement. What runs here is the
 * load-bearing binary subset: is the session right, is the news clear,
 * did the confirming candle actually displace, was the read convicted
 * enough to register, and is the trap's own flip level still intact.
 * Anything softer stays with the human, who still gets the Telegram
 * message either way.
 *
 * And it is not a replacement for the execution pipeline's own gates. A
 * promoted setup goes through exactly the same entry sequence, the same
 * pre-submission checklist and the same position and daily limits as a
 * hand-registered one. This is an extra filter upstream of those, never
 * a shortcut past them — which is why the displacement threshold here is
 * the analysis convention (3.0x) rather than the execution sequence's
 * own 1.8x. The stricter number governs whether an order gets created in
 * the first place; the looser one governs whether the entry, once the
 * setup exists, is timed correctly.
 *
 * Pure: no I/O, no environment reads, no clock of its own.
 */

import { finiteNumber, formatLevel, KILL_ZONES, NY_LUNCH, nyClock, isWindowActive } from "./core.mjs";
import {
  displacementRatioAt,
  equalLevels,
  fairValueGaps,
  minutesUntilWindow,
  orderBlockBefore,
  parseTrapScore,
  premiumDiscount,
  strictSwings,
  workingRange,
} from "./ict.mjs";

// ---------------------------------------------------------------------------
// §1 The hard gates

/**
 * Is a kill zone open, or about to be? A zone starting within the
 * lookahead counts: the promoted setup still has to wait for its entry
 * to be touched and its confirmation sequence to complete, none of which
 * can happen instantly.
 */
export function killZoneOutlook(nowMs, lookaheadMinutes = 10, { ignoreWeekend = false } = {}) {
  const { minutes, weekday } = nyClock(nowMs);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const weekendBlocks = weekend && !ignoreWeekend;
  const inLunch = isWindowActive(minutes, NY_LUNCH);
  let best = null;
  for (const zone of KILL_ZONES) {
    const wait = minutesUntilWindow(minutes, zone);
    if (best === null || wait < best.minutesAway) best = { zone: zone.name, minutesAway: wait };
  }
  const active = best?.minutesAway === 0;
  return {
    weekend,
    weekendBlocks,
    inLunch,
    active: Boolean(active) && !inLunch && !weekendBlocks,
    zone: active ? best.zone : null,
    next: best?.zone ?? null,
    minutesAway: best?.minutesAway ?? null,
    openingSoon: Boolean(best) && best.minutesAway > 0 && best.minutesAway <= lookaheadMinutes,
  };
}

/**
 * Every gate, evaluated and reported — including the ones that passed,
 * because "why did this promote" is as much a question as "why didn't
 * it". A gate whose input is unavailable fails; this decision creates
 * orders, so an unanswerable question is a no.
 */
export function evaluatePromotionGates(input) {
  const gates = [];
  const add = (name, pass, detail) => gates.push({ name, pass: Boolean(pass), detail });

  add(
    "auto_promote_enabled",
    input.enabled,
    input.enabled ? "promotion is armed for this trap" : input.enabledReason || "promotion is not armed",
  );

  const session = input.session || {};
  const sessionOk = !input.requireKillZone || session.active === true || session.openingSoon === true;
  add(
    "kill_zone",
    sessionOk,
    !input.requireKillZone
      ? "kill-zone gate disabled"
      : session.weekendBlocks
        ? "weekend"
        : session.inLunch
          ? "NY lunch"
          : session.active
            ? `${session.zone} is open`
            : session.openingSoon
              ? `${session.next} opens in ${session.minutesAway} min`
              : `no kill zone within ${input.killZoneLookaheadMinutes} min (next: ${session.next} in ${session.minutesAway} min)`,
  );

  const news = input.news || {};
  const newsOk = !input.requireNewsClear || news.blocked === false;
  add(
    "news",
    newsOk,
    !input.requireNewsClear
      ? "news gate disabled"
      : news.blocked
        ? `blocked: ${news.reason} (${news.source})`
        : `clear (${news.source})`,
  );

  const ratio = finiteNumber(input.displacementRatio);
  const displacementOk = ratio !== null && ratio >= input.displacementMultiple;
  add(
    "displacement",
    displacementOk,
    ratio === null
      ? "the confirming candle's displacement ratio could not be measured"
      : `confirming candle ${ratio.toFixed(2)}x vs ${input.displacementMultiple}x required`,
  );

  const score = parseTrapScore(input.trapScore);
  const normalised = score ? (score.value / score.outOf) * 9 : null;
  const scoreOk = normalised !== null && normalised >= input.minTrapScore;
  add(
    "trap_score",
    scoreOk,
    score === null
      ? `trap_score is missing or unreadable (${input.trapScore ?? "unset"}); register traps with a score like "7/9" to allow promotion`
      : `${score.value}/${score.outOf} → ${normalised.toFixed(1)}/9 vs ${input.minTrapScore}/9 required`,
  );

  add(
    "invalidation_untouched",
    !input.invalidationTouched,
    input.invalidationTouched
      ? `the flip level was already touched at ${formatLevel(input.invalidationTouchedPrice)}`
      : "the flip level has not been touched",
  );

  const failed = gates.filter((gate) => !gate.pass);
  return { pass: failed.length === 0, gates, failed: failed.map((gate) => gate.name), failedGates: failed };
}

// ---------------------------------------------------------------------------
// §2 The geometry
//
// Entry is anchored to a PDA array rather than to the trigger level,
// because entering at the level the market just displaced through is
// entering at the worst price in the leg. The array is chosen in the
// order the methodology prefers: an unfilled gap first, the order block
// that produced the leg second, the level itself only when neither
// exists.

function nearestArray(bars, direction, triggerIndex, { close, tolerance, fvgLookback = 40, obLookback = 12 }) {
  const isBuy = direction === "buy";
  const gaps = fairValueGaps(bars, { lookback: fvgLookback }).filter(
    (gap) =>
      gap.direction === (isBuy ? "bullish" : "bearish") &&
      !gap.inverted &&
      gap.bodyPenetration < 1 &&
      gap.size > tolerance &&
      // The gap has to sit on the retracement side of price: a sell
      // enters on the way back up, a buy on the way back down.
      (isBuy ? gap.high <= close + tolerance : gap.low >= close - tolerance),
  );
  if (gaps.length) {
    // Nearest to price wins — the first array price would reach.
    const chosen = gaps.sort((a, b) =>
      Math.abs(a.ce - close) - Math.abs(b.ce - close),
    )[0];
    return {
      kind: chosen.label,
      low: chosen.low,
      high: chosen.high,
      entry: chosen.ce,
      model: `${chosen.label} retest (CE)`,
      detail: `${chosen.label} ${formatLevel(chosen.low)}–${formatLevel(chosen.high)}, ${chosen.status}`,
    };
  }

  const block = orderBlockBefore(bars, triggerIndex, direction, { lookback: obLookback });
  if (block && (isBuy ? block.high <= close + tolerance : block.low >= close - tolerance)) {
    return {
      kind: "ORDER_BLOCK",
      low: block.low,
      high: block.high,
      entry: block.meanThreshold,
      model: "Order block mean threshold",
      detail: `order block ${formatLevel(block.low)}–${formatLevel(block.high)}`,
    };
  }
  return null;
}

function protectiveSwing(bars, swings, direction, zoneEdge, { lookback = 40 } = {}) {
  const recent = swings.filter((swing) => swing.index >= bars.length - lookback);
  if (direction === "sell") {
    const above = recent.filter((swing) => swing.kind === "high" && swing.price > zoneEdge);
    if (above.length) return Math.min(...above.map((swing) => swing.price));
    const window = bars.slice(-lookback);
    const high = Math.max(...window.map((bar) => bar.high));
    return high > zoneEdge ? high : null;
  }
  const below = recent.filter((swing) => swing.kind === "low" && swing.price < zoneEdge);
  if (below.length) return Math.max(...below.map((swing) => swing.price));
  const window = bars.slice(-lookback);
  const low = Math.min(...window.map((bar) => bar.low));
  return low < zoneEdge ? low : null;
}

/**
 * Candidate targets, nearest first: the equilibrium of the working
 * range, then pooled liquidity, then the higher timeframe's range edge.
 * Everything is a real level someone's stops are resting at — no round
 * numbers, no fixed R multiples.
 */
function targetCandidates(bars, htfBars, swings, direction, entry, tolerance) {
  const isBuy = direction === "buy";
  const beyond = (price) => (isBuy ? price > entry + tolerance : price < entry - tolerance);
  const candidates = [];

  const range = workingRange(bars, 60);
  if (range && beyond(range.equilibrium)) {
    candidates.push({ price: range.equilibrium, label: "range equilibrium" });
  }

  for (const cluster of equalLevels(swings, isBuy ? "high" : "low")) {
    if (beyond(cluster.price)) {
      candidates.push({ price: cluster.price, label: `${cluster.kind} x${cluster.touches}` });
    }
  }

  for (const swing of swings) {
    if (swing.kind !== (isBuy ? "high" : "low")) continue;
    if (beyond(swing.price)) candidates.push({ price: swing.price, label: "swing liquidity" });
  }

  if (range) {
    const edge = isBuy ? range.high : range.low;
    if (beyond(edge)) candidates.push({ price: edge, label: "range extreme" });
  }

  const htfRange = workingRange(htfBars || [], 40);
  if (htfRange) {
    const edge = isBuy ? htfRange.high : htfRange.low;
    if (beyond(edge)) candidates.push({ price: edge, label: "HTF range extreme" });
    if (beyond(htfRange.equilibrium)) {
      candidates.push({ price: htfRange.equilibrium, label: "HTF equilibrium" });
    }
  }

  const sorted = candidates.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const unique = [];
  for (const candidate of sorted) {
    if (unique.some((item) => Math.abs(item.price - candidate.price) <= tolerance * 2)) continue;
    unique.push(candidate);
  }
  return unique;
}

/**
 * The full setup, or an explicit refusal. Every rejection names what was
 * missing, in the same spirit as a trap's own `what_is_missing`: a
 * promotion that silently produced nothing would be indistinguishable
 * from one that never ran.
 */
export function computePromotedSetup(input) {
  const {
    bars,
    htfBars = [],
    direction,
    triggerLevel,
    tolerance,
    atr = 0,
    minRR = 1,
    slBufferAtrFraction = 0.15,
    timeframe = "M15",
  } = input;

  if (!Array.isArray(bars) || bars.length < 25) {
    return { ok: false, reason: `only ${bars?.length ?? 0} closed ${timeframe} bars; not enough to derive a setup` };
  }
  if (!["buy", "sell"].includes(direction)) {
    return { ok: false, reason: `unusable direction "${direction}"` };
  }

  const isBuy = direction === "buy";
  const triggerIndex = bars.length - 1;
  const close = bars[triggerIndex].close;
  const swings = strictSwings(bars);
  const range = workingRange(bars, 60);

  const array =
    nearestArray(bars, direction, triggerIndex, { close, tolerance }) ||
    // Nothing to retrace into: the level that was just broken becomes the
    // breaker, and its retest is the entry.
    (finiteNumber(triggerLevel) !== null
      ? {
          kind: "BREAKER",
          low: triggerLevel - tolerance,
          high: triggerLevel + tolerance,
          entry: triggerLevel,
          model: "Breaker retest of the trigger level",
          detail: `trigger level ${formatLevel(triggerLevel)}`,
        }
      : null);
  if (!array) return { ok: false, reason: "no PDA array and no trigger level to anchor an entry to" };

  const entry = array.entry;
  const zoneLow = Math.min(array.low, array.high);
  const zoneHigh = Math.max(array.low, array.high);
  if (entry < zoneLow || entry > zoneHigh) {
    return { ok: false, reason: "the computed entry does not sit inside its own array" };
  }

  const buffer = Math.max(tolerance, atr * slBufferAtrFraction);
  const swingLevel = protectiveSwing(bars, swings, direction, isBuy ? zoneLow : zoneHigh);
  if (swingLevel === null) {
    return { ok: false, reason: "no structural swing beyond the entry zone to place a stop behind" };
  }
  const sl = isBuy ? swingLevel - buffer : swingLevel + buffer;
  if (isBuy ? !(sl < zoneLow) : !(sl > zoneHigh)) {
    return { ok: false, reason: "the stop would sit inside the entry zone" };
  }

  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return { ok: false, reason: "entry and stop are the same price" };

  const candidates = targetCandidates(bars, htfBars, swings, direction, entry, tolerance);
  const firstIndex = candidates.findIndex(
    (candidate) => Math.abs(candidate.price - entry) >= risk * minRR,
  );
  if (firstIndex < 0) {
    const nearest = candidates[0];
    return {
      ok: false,
      reason: nearest
        ? `nearest target ${formatLevel(nearest.price)} (${nearest.label}) is only ${(Math.abs(nearest.price - entry) / risk).toFixed(2)}R from entry; ${minRR}R required`
        : `no liquidity beyond the entry to target`,
    };
  }

  const picked = [candidates[firstIndex]];
  for (const candidate of candidates.slice(firstIndex + 1)) {
    if (picked.length >= 3) break;
    const previous = picked[picked.length - 1];
    // Targets that sit on top of each other are one target written three
    // times; require half an R of separation to count as another.
    if (Math.abs(candidate.price - previous.price) >= risk * 0.5) picked.push(candidate);
  }

  // Levels are rounded to the connector's own precision before they
  // leave here. A stop of 4346.776785714285 is not a more accurate stop,
  // it is the same stop with the arithmetic showing.
  const level = (value) => (value === null || value === undefined ? null : Number(value.toFixed(5)));

  const setup = {
    direction,
    entry: level(entry),
    entry_zone_low: level(zoneLow),
    entry_zone_high: level(zoneHigh),
    sl: level(sl),
    tp1: level(picked[0].price),
    tp2: level(picked[1]?.price ?? null),
    tp3: level(picked[2]?.price ?? null),
    risk,
    rr: Math.abs(picked[0].price - entry) / risk,
    array: array.kind,
    setup_model: `Trap promotion — ${array.model} after ${timeframe} displacement close`,
    rationale: [
      `${timeframe} body close beyond ${formatLevel(triggerLevel)} with qualifying displacement`,
      array.detail,
      `stop beyond the ${isBuy ? "swing low" : "swing high"} at ${formatLevel(swingLevel)} + ${formatLevel(buffer)} buffer`,
      `targets: ${picked.map((item) => `${formatLevel(item.price)} (${item.label})`).join(" → ")}`,
    ].join(" | "),
    targets: picked,
    context: range ? premiumDiscount(range.high, range.low, close) : null,
  };

  // The same shape rules register_watch enforces, checked here so a
  // promotion refuses with a readable reason instead of throwing inside
  // registration.
  const shapeError = validateSetupShape(setup);
  if (shapeError) return { ok: false, reason: shapeError, setup };

  return { ok: true, setup };
}

export function validateSetupShape(setup) {
  const isBuy = setup.direction === "buy";
  if (isBuy && !(setup.entry > setup.sl)) return "buy entry must sit above its stop";
  if (!isBuy && !(setup.entry < setup.sl)) return "sell entry must sit below its stop";
  if (isBuy && !(setup.tp1 > setup.entry)) return "buy tp1 must sit above entry";
  if (!isBuy && !(setup.tp1 < setup.entry)) return "sell tp1 must sit below entry";
  for (const field of ["tp2", "tp3"]) {
    const value = setup[field];
    if (value === null || value === undefined) continue;
    if (isBuy && !(value > setup.entry)) return `buy ${field} must sit above entry`;
    if (!isBuy && !(value < setup.entry)) return `sell ${field} must sit below entry`;
  }
  const reward = Math.abs(setup.tp1 - setup.entry);
  const risk = Math.abs(setup.entry - setup.sl);
  if (!(risk > 0)) return "risk is zero";
  if (reward / risk < 1) return `tp1 is only ${(reward / risk).toFixed(2)}R from entry`;
  return null;
}

/** The confirming candle's own displacement ratio, measured the analysis way. */
export function confirmingDisplacement(bars, { window = 20 } = {}) {
  if (!Array.isArray(bars) || !bars.length) return null;
  return displacementRatioAt(bars, bars.length - 1, window);
}
