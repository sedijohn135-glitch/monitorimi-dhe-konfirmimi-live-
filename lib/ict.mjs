/**
 * ict.mjs — the deterministic ICT primitives, ported from the analysis
 * pipeline's `scripts/ict_levels.py`.
 *
 * This is a port, not a second opinion. The trap-promotion path has to
 * compute the same geometry the human pipeline computes, or a promoted
 * setup is not the setup the analysis would have produced — and the
 * whole point of promoting automatically is that nobody is there to
 * notice the difference. So the conventions are carried across exactly:
 *
 *   - swings are the STRICT 3-candle rule, not "the extreme of a window";
 *   - structure breaks are BODY closes; a wick through a swing is a raid
 *     on the stops resting there, not a change in structure;
 *   - displacement is the body against the trailing average body over a
 *     20-bar window, reported as a ratio so near-misses stay visible;
 *   - an FVG carries both wick and body boundaries, because the wick gap
 *     is the unfilled delivery range while the body gap is what the 2022
 *     model measures from.
 *
 * Bars are the monitor's normalised shape — {open, high, low, close,
 * timestampMs} in real prices — rather than the script's {o,h,l,c}. That
 * is the only intentional difference.
 *
 * Nothing here performs I/O or reads the environment.
 */

import { finiteNumber, nyClock } from "./core.mjs";

export const bodyTop = (bar) => Math.max(bar.open, bar.close);
export const bodyBottom = (bar) => Math.min(bar.open, bar.close);
export const bodySize = (bar) => Math.abs(bar.close - bar.open);
export const isBullish = (bar) => bar.close > bar.open;

/**
 * Strict 3-candle swing points: a high with a lower high immediately on
 * each side, a low with a higher low immediately on each side. Anything
 * looser is not a swing and must not be used as structure.
 */
export function strictSwings(bars) {
  const out = [];
  if (!Array.isArray(bars)) return out;
  for (let index = 1; index < bars.length - 1; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    const next = bars[index + 1];
    if (current.high > previous.high && current.high > next.high) {
      out.push({ index, kind: "high", price: current.high, at: current.timestampMs });
    }
    if (current.low < previous.low && current.low < next.low) {
      out.push({ index, kind: "low", price: current.low, at: current.timestampMs });
    }
  }
  return out;
}

/**
 * Swings of one kind clustered within `tolerancePercent` of each other —
 * equal highs and lows, where retail stops pool and the algorithm is
 * most likely drawing toward.
 */
export function equalLevels(swings, kind, tolerancePercent = 0.03) {
  const points = swings.filter((swing) => swing.kind === kind).sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [];
  for (const point of points) {
    if (!current.length) {
      current = [point];
      continue;
    }
    const last = current[current.length - 1];
    if ((Math.abs(point.price - last.price) / last.price) * 100 <= tolerancePercent) {
      current.push(point);
    } else {
      if (current.length >= 2) clusters.push(current);
      current = [point];
    }
  }
  if (current.length >= 2) clusters.push(current);
  return clusters.map((cluster) => ({
    kind: kind === "high" ? "EQH" : "EQL",
    price: cluster.reduce((sum, item) => sum + item.price, 0) / cluster.length,
    low: Math.min(...cluster.map((item) => item.price)),
    high: Math.max(...cluster.map((item) => item.price)),
    touches: cluster.length,
    lastAt: Math.max(...cluster.map((item) => item.at ?? 0)),
  }));
}

/**
 * Three-candle fair value gaps with both boundaries, plus how deeply
 * price later returned into each — separately for wicks and bodies,
 * because the wick/body distinction is the whole basis of the rejection,
 * inversion and 90% rules.
 */
export function fairValueGaps(bars, { lookback = null } = {}) {
  const out = [];
  if (!Array.isArray(bars) || bars.length < 3) return out;
  const from = lookback ? Math.max(1, bars.length - lookback) : 1;
  for (let index = from; index < bars.length - 1; index += 1) {
    const a = bars[index - 1];
    const b = bars[index];
    const c = bars[index + 1];

    let direction = null;
    let low = null;
    let high = null;
    let bodyLow = null;
    let bodyHigh = null;
    if (c.low > a.high) {
      direction = "bullish";
      low = a.high;
      high = c.low;
      bodyLow = bodyTop(a);
      bodyHigh = bodyBottom(c);
    } else if (c.high < a.low) {
      direction = "bearish";
      low = c.high;
      high = a.low;
      bodyLow = bodyTop(c);
      bodyHigh = bodyBottom(a);
    }
    if (!direction) continue;
    if (bodyLow > bodyHigh) [bodyLow, bodyHigh] = [bodyHigh, bodyLow];

    const after = bars.slice(index + 2);
    let wickPenetration = 0;
    let bodyPenetration = 0;
    let inverted = false;
    if (after.length) {
      if (direction === "bullish") {
        const wickLow = Math.min(...after.map((bar) => bar.low));
        const bodyLowAfter = Math.min(...after.map(bodyBottom));
        wickPenetration = clamp01((high - wickLow) / (high - low));
        bodyPenetration = clamp01((high - bodyLowAfter) / (high - low));
        inverted = after.some((bar) => bar.close < low);
      } else {
        const wickHigh = Math.max(...after.map((bar) => bar.high));
        const bodyHighAfter = Math.max(...after.map(bodyTop));
        wickPenetration = clamp01((wickHigh - low) / (high - low));
        bodyPenetration = clamp01((bodyHighAfter - low) / (high - low));
        inverted = after.some((bar) => bar.close > high);
      }
    }

    out.push({
      index,
      at: b.timestampMs,
      direction,
      label: direction === "bullish" ? "BISI" : "SIBI",
      low,
      high,
      ce: (low + high) / 2,
      bodyLow,
      bodyHigh,
      size: high - low,
      wickPenetration,
      bodyPenetration,
      inverted,
      status: gapStatus({ inverted, wickPenetration, bodyPenetration }),
    });
  }
  return out;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function gapStatus({ inverted, wickPenetration, bodyPenetration }) {
  if (inverted) return "INVERTED (body closed through — treat as opposing array)";
  if (bodyPenetration >= 1) return "fully filled";
  if (bodyPenetration > 0.5) return "body beyond CE — heavy";
  if (wickPenetration > 0 && bodyPenetration === 0) {
    return "wick only, body never entered (90% rule: revisit likely)";
  }
  if (wickPenetration === 0) return "untouched";
  return "partially filled";
}

/**
 * The displacement ratio of one bar: its body against the average body
 * of the `window` bars before it. Returns null — never zero, never a
 * default — when there is not enough history to compute it, because a
 * ratio that could not be measured is not a ratio of zero and must not
 * read as "no displacement" to the caller deciding whether to trade.
 */
export function displacementRatioAt(bars, index, window = 20) {
  if (!Array.isArray(bars) || index < window || index >= bars.length) return null;
  const previous = bars.slice(index - window, index);
  if (previous.length < window) return null;
  const average = previous.reduce((sum, bar) => sum + bodySize(bar), 0) / window;
  if (!(average > 0)) return null;
  return bodySize(bars[index]) / average;
}

/**
 * Bars whose body is `multiple`x the trailing average. Near-misses down
 * to two thirds of the threshold are kept, with `qualifies` marking the
 * ones that actually clear it — a 0.8x drift through a level looks the
 * same as a 3.2x delivery in a boolean, and only one of them is a trade.
 */
export function displacementBars(bars, { multiple = 3, window = 20 } = {}) {
  const out = [];
  if (!Array.isArray(bars)) return out;
  for (let index = window; index < bars.length; index += 1) {
    const ratio = displacementRatioAt(bars, index, window);
    if (ratio === null) continue;
    if (ratio >= multiple * 0.66) {
      out.push({
        index,
        at: bars[index].timestampMs,
        direction: isBullish(bars[index]) ? "bullish" : "bearish",
        ratio,
        qualifies: ratio >= multiple,
        open: bars[index].open,
        close: bars[index].close,
      });
    }
  }
  return out;
}

/**
 * Closing breaks of the most recent strict swing, in sequence. BOS when
 * the break continues the prevailing direction, MSS when it reverses it.
 */
export function structureBreaks(bars, swings) {
  const events = [];
  if (!Array.isArray(bars)) return events;
  let lastHigh = null;
  let lastLow = null;
  let trend = null;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    for (const swing of swings) {
      if (swing.index === index - 1) {
        if (swing.kind === "high") lastHigh = swing;
        else lastLow = swing;
      }
    }
    if (lastHigh && bar.close > lastHigh.price) {
      events.push({
        index,
        at: bar.timestampMs,
        type: trend === "up" ? "BOS" : "MSS",
        direction: "bullish",
        level: lastHigh.price,
        close: bar.close,
      });
      trend = "up";
      lastHigh = null;
    }
    if (lastLow && bar.close < lastLow.price) {
      events.push({
        index,
        at: bar.timestampMs,
        type: trend === "down" ? "BOS" : "MSS",
        direction: "bearish",
        level: lastLow.price,
        close: bar.close,
      });
      trend = "down";
      lastLow = null;
    }
  }
  return events;
}

/**
 * A wick beyond a swing that does not hold on a closing basis: the stop
 * run that fuels the move the other way. Telling this apart from a
 * genuine break is the single most consequential read in the method.
 */
export function liquiditySweeps(bars, swings, { lookahead = 6 } = {}) {
  const out = [];
  for (const swing of swings) {
    const start = swing.index + 1;
    const end = Math.min(start + lookahead, bars.length);
    for (let index = start; index < end; index += 1) {
      const bar = bars[index];
      if (swing.kind === "high" && bar.high > swing.price && bar.close < swing.price) {
        out.push({
          index,
          at: bar.timestampMs,
          side: "BSL",
          swept: swing.price,
          wickTo: bar.high,
          closedBack: bar.close,
        });
        break;
      }
      if (swing.kind === "low" && bar.low < swing.price && bar.close > swing.price) {
        out.push({
          index,
          at: bar.timestampMs,
          side: "SSL",
          swept: swing.price,
          wickTo: bar.low,
          closedBack: bar.close,
        });
        break;
      }
    }
  }
  return out;
}

export function premiumDiscount(high, low, price) {
  if (!(high > low)) return null;
  const equilibrium = (high + low) / 2;
  const percent = ((price - low) / (high - low)) * 100;
  return {
    rangeHigh: high,
    rangeLow: low,
    equilibrium,
    price,
    percentOfRange: percent,
    zone: price > equilibrium ? "PREMIUM" : price < equilibrium ? "DISCOUNT" : "EQUILIBRIUM",
    favours: price > equilibrium ? "sell" : price < equilibrium ? "buy" : "neither",
    deep: percent >= 75 || percent <= 25,
  };
}

/**
 * The last opposing candle before a directional leg — the order block.
 * Its mean threshold (the midpoint of its body) is the classic entry
 * anchor when no unfilled gap is available to retrace into.
 */
export function orderBlockBefore(bars, index, direction, { lookback = 12 } = {}) {
  const from = Math.max(0, index - lookback);
  for (let cursor = index - 1; cursor >= from; cursor -= 1) {
    const bar = bars[cursor];
    if (bodySize(bar) <= 0) continue;
    const opposing = direction === "buy" ? !isBullish(bar) : isBullish(bar);
    if (opposing) {
      return {
        index: cursor,
        at: bar.timestampMs,
        low: bodyBottom(bar),
        high: bodyTop(bar),
        wickLow: bar.low,
        wickHigh: bar.high,
        meanThreshold: (bar.open + bar.close) / 2,
      };
    }
  }
  return null;
}

/** The working range of the last `count` bars, for equilibrium targets. */
export function workingRange(bars, count = 60) {
  const window = bars.slice(-count);
  if (!window.length) return null;
  const high = Math.max(...window.map((bar) => bar.high));
  const low = Math.min(...window.map((bar) => bar.low));
  if (!(high > low)) return null;
  return { high, low, equilibrium: (high + low) / 2, bars: window.length };
}

/**
 * Minutes until a window opens, or 0 while it is open. Used by the
 * promotion gate, which accepts a kill zone that is about to start —
 * the promoted setup still has to wait for its own entry.
 */
export function minutesUntilWindow(nowMinutes, window) {
  const start = toMinutesLocal(window.start);
  const endValue = toMinutesLocal(window.end);
  const end = endValue === 0 ? 1440 : endValue;
  const active = start <= end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
  if (active) return 0;
  const delta = start - nowMinutes;
  return delta >= 0 ? delta : delta + 1440;
}

function toMinutesLocal(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * A trap's score as the analysis recorded it — "7/9", "7", "B (6/9)".
 * Returns null when it cannot be read, which the gate treats as a
 * failure rather than as a pass: an unrecorded conviction is not a high
 * one.
 */
export function parseTrapScore(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  const fraction = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (fraction) {
    const value = finiteNumber(fraction[1]);
    const outOf = finiteNumber(fraction[2]);
    if (value !== null && outOf !== null && outOf > 0) return { value, outOf };
  }
  const bare = text.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?:$|[^\d.%])/);
  if (bare) {
    const value = finiteNumber(bare[1]);
    if (value !== null) return { value, outOf: 9 };
  }
  return null;
}

/**
 * The open of the first bar landing in New York's midnight five-minute
 * slot — the single most repeated reference level across ICT's own
 * material, and one the monitor did not track before. Only computable
 * when the bar window reaches back that far: a watch ticking mid
 * afternoon in New York cannot see the bar that opened at midnight, and
 * this returns null exactly like the rest of the evidence machine does
 * when a signal is unavailable rather than pretending it is absent.
 */
export function nyMidnightOpen(bars) {
  if (!Array.isArray(bars)) return null;
  for (const bar of bars) {
    if (nyClock(bar.timestampMs).minutes < 5) {
      return { price: bar.open, at: bar.timestampMs };
    }
  }
  return null;
}

/**
 * A Judas Swing at the midnight open: the swing nearest the open gets
 * swept, then price closes back through the open itself, against the
 * swept side. Direction is read from which side got swept — a bullish
 * read comes only from a swept low, never asserted the other way round.
 * The formal Asian-range high/low ICT frames this from is not carried
 * here; the nearest strict swing stands in for it, so this only needs
 * the bar window the confirmation loop already fetches, not a second,
 * wider one reaching back to the prior session.
 */
export function checkMidnightJudas(bars, direction, { strength = 2 } = {}) {
  const midnight = nyMidnightOpen(bars);
  if (!midnight) return { present: null, reason: "midnight open not in the current bar window" };
  const swings = strictSwings(bars);
  const sweeps = liquiditySweeps(bars, swings);
  const wantedSide = direction === "buy" ? "SSL" : "BSL";
  const sweep = sweeps.filter((item) => item.side === wantedSide).at(-1);
  if (!sweep) {
    return { present: false, reason: "no matching sweep since the midnight open", midnightOpen: midnight.price };
  }
  const current = bars.at(-1);
  const reclaimed = direction === "buy" ? current.close > midnight.price : current.close < midnight.price;
  return {
    present: reclaimed,
    reason: reclaimed
      ? "swept and reclaimed through the midnight open"
      : "swept, but has not reclaimed the midnight open",
    midnightOpen: midnight.price,
    sweptAt: sweep.at,
  };
}

/**
 * How many independently-computed PDA array types cluster within
 * `tolerancePercent` of one price level — an FVG's CE, an order block's
 * mean threshold, an equal-highs/lows cluster. Confluence means several
 * unrelated reads agreeing on the same level, not one read counted
 * several ways, so each array type contributes at most once.
 */
export function pdaConfluence(bars, level, direction, { tolerancePercent = 0.1 } = {}) {
  if (!Array.isArray(bars) || bars.length < 3 || !Number.isFinite(level) || level <= 0) {
    return { count: 0, hits: [] };
  }
  const near = (price) => Number.isFinite(price) && (Math.abs(price - level) / level) * 100 <= tolerancePercent;
  const hits = [];

  const swings = strictSwings(bars);
  const supportingSwingKind = direction === "buy" ? "low" : "high";
  for (const cluster of equalLevels(swings, supportingSwingKind)) {
    if (near(cluster.price)) hits.push({ type: cluster.kind, price: cluster.price });
  }

  const wantedGapDirection = direction === "buy" ? "bullish" : "bearish";
  for (const gap of fairValueGaps(bars, { lookback: 40 })) {
    if (gap.direction === wantedGapDirection && near(gap.ce)) {
      hits.push({ type: gap.label, price: gap.ce });
    }
  }

  const ob = orderBlockBefore(bars, bars.length - 1, direction);
  if (ob && near(ob.meanThreshold)) hits.push({ type: "OB", price: ob.meanThreshold });

  return { count: hits.length, hits };
}
