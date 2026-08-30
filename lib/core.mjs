/**
 * core.mjs — pure logic for the Watch Monitor.
 *
 * Nothing in this file performs I/O, reads process.env at call time, or
 * schedules a timer. Every function is a total function of its inputs so
 * the adversarial suite in test/ can drive it directly. All impure
 * orchestration lives in index.js.
 *
 * Design rule that drives the whole file: an absent or unverifiable
 * observation is never silently coerced into a permissive one. Missing
 * timestamp does not mean "closed". Missing partner data does not mean
 * "no divergence". Unverifiable price scale does not mean "scale is
 * fine". Each of those returns an explicit UNKNOWN that the caller must
 * handle, because the alternative is infrastructure failure wearing the
 * costume of market evidence.
 */

// ---------------------------------------------------------------------------
// §1 Timeframes
//
// The upstream cTrader MCP rejects bare period names on get_trendbars:
// verified in mcp_contract.md §4, only the underscored form (M_5, H_1)
// is accepted, and a bare "M5" returns HTTP 400. The monitor's public
// surface (register_trap_watch.timeframe) uses the bare form, so the
// translation has to happen at exactly one place — here.

export const PERIOD_MS = Object.freeze({
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
});

export const TRAP_TIMEFRAMES = Object.freeze([
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
]);

const PERIOD_API = Object.freeze({
  M1: "M_1",
  M5: "M_5",
  M15: "M_15",
  M30: "M_30",
  H1: "H_1",
  H4: "H_4",
  D1: "D_1",
});

/** Canonical upstream period token for a bare timeframe name. */
export function apiPeriod(timeframe, dialect = "underscored") {
  const key = String(timeframe || "").toUpperCase().replace(/_/g, "");
  if (!PERIOD_MS[key]) return null;
  return dialect === "bare" ? key : PERIOD_API[key];
}

export function periodMs(timeframe) {
  const key = String(timeframe || "").toUpperCase().replace(/_/g, "");
  return PERIOD_MS[key] ?? null;
}

/**
 * Trendbar request window. The upstream requires an explicit
 * from/to pair (count alone is a 400) and caps the span at 30 days.
 * Bars are padded because a naive calendar subtraction under-fetches
 * across weekends and holidays.
 */
export function trendbarWindow(count, tf, nowMs = Date.now()) {
  const span = periodMs(tf);
  if (!span) return null;
  const padded = Math.ceil((count + 5) * span * (span < PERIOD_MS.H1 ? 2.2 : 1.6));
  const capped = Math.min(padded, 29 * PERIOD_MS.D1);
  return {
    fromTimestamp: new Date(nowMs - capped).toISOString(),
    toTimestamp: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// §2 Numbers, timestamps, price scaling
//
// mcp_contract.md §2 states the connector returns raw integers scaled by
// a uniform 100,000 across every asset class, with a verified table. The
// divisor is therefore treated as correct — but never as self-evidently
// correct. A wrong divisor is the single most destructive silent failure
// available to this service: every level comparison inverts or degenerates,
// entry "never touches", SL "never breaches", and the monitor reports a
// healthy watch forever. So the scale is applied and then falsified
// against an independent observation before any price is allowed to
// drive a decision.

export function finiteNumber(value) {
  // Number(null) is 0 and Number("") is 0. Both are the coercion this
  // file exists to prevent: an absent price, an absent timestamp and an
  // absent size would each arrive downstream as a perfectly plausible
  // zero. Absence returns null, and every caller already handles null.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numericTimestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^[0-9]+(?:\.[0-9]+)?$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    // Below 1e12 the value cannot be epoch-ms for any date after 2001,
    // so it is epoch-seconds.
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function scaledPrice(value, scale) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return number / scale;
}

/**
 * Falsify the price scale against a reference the caller already trusts.
 *
 * `reference` is a human-readable price the system asserted independently
 * of the feed — the entry level the pipeline computed, or a previously
 * validated mid. `observed` is what the feed produced after scaling.
 *
 * Returns OK when the two agree within an order of magnitude, and
 * MISMATCH with the implied corrective factor when they don't. The
 * caller's obligation on MISMATCH is to stop evaluating, not to guess a
 * new divisor: a divisor guessed from one sample is how you turn a
 * data bug into a wrong trade.
 */
export function validateScale(observed, reference, { tolerance = 0.25 } = {}) {
  if (!Number.isFinite(observed) || !Number.isFinite(reference)) {
    return { ok: false, status: "UNKNOWN", ratio: null, impliedFactor: null };
  }
  if (observed === 0 || reference === 0) {
    return { ok: false, status: "MISMATCH", ratio: null, impliedFactor: null };
  }
  const ratio = observed / reference;
  if (ratio > 1 - tolerance && ratio < 1 + tolerance) {
    return { ok: true, status: "OK", ratio, impliedFactor: 1 };
  }
  // Round the implied correction to the nearest power of ten; a genuine
  // scale error is always a power of ten on this connector.
  const exponent = Math.round(Math.log10(1 / ratio));
  return {
    ok: false,
    status: "MISMATCH",
    ratio,
    impliedFactor: Number.isFinite(exponent) ? 10 ** exponent : null,
  };
}

export function normalizeCandle(candle, scale) {
  if (!candle || typeof candle !== "object") return null;
  const open = scaledPrice(candle.open ?? candle.o, scale);
  const high = scaledPrice(candle.high ?? candle.h, scale);
  const low = scaledPrice(candle.low ?? candle.l, scale);
  const close = scaledPrice(candle.close ?? candle.c, scale);
  if ([open, high, low, close].some((value) => value === null)) return null;
  // A bar whose high is below its low, or whose body escapes its range,
  // is corrupt. Dropping it is safer than normalising it into something
  // plausible-looking.
  if (high < low) return null;
  if (open > high || open < low || close > high || close < low) return null;
  const timestampMs = numericTimestampMs(
    candle.timestamp ?? candle.time ?? candle.openTime ?? candle.utcTimestamp ?? candle.date,
  );
  return { open, high, low, close, timestampMs, volume: finiteNumber(candle.volume) };
}

export function normalizeCandles(list, scale) {
  const bars = (Array.isArray(list) ? list : [])
    .map((candle) => normalizeCandle(candle, scale))
    .filter(Boolean);
  // Feeds are not contractually ordered. Sort ascending by open time so
  // at(-1) means "most recent" rather than "however the JSON arrived",
  // and drop duplicate bar times (a repeated bar from a retried page
  // must not become a second data point).
  const timed = bars.filter((bar) => bar.timestampMs !== null);
  if (timed.length !== bars.length) return bars;
  const byTime = new Map();
  for (const bar of timed) byTime.set(bar.timestampMs, bar);
  return [...byTime.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function normalizeSpot(spot, scale, symbolById = new Map()) {
  if (!spot || typeof spot !== "object") return null;
  const symbol = String(
    spot.symbol ??
      spot.symbolName ??
      spot.instrument ??
      symbolById.get(Number(spot.symbolId)) ??
      "",
  ).toUpperCase();
  const bid = scaledPrice(spot.bid ?? spot.bidPrice ?? spot.buy, scale);
  const ask = scaledPrice(spot.ask ?? spot.askPrice ?? spot.sell, scale);
  if (!symbol || bid === null || ask === null) return null;
  if (ask < bid) return null;
  if (bid <= 0) return null;
  const timestampMs = numericTimestampMs(spot.timestamp ?? spot.time ?? spot.utcTimestamp);
  return { symbol, symbolId: Number(spot.symbolId), bid, ask, timestampMs };
}

// ---------------------------------------------------------------------------
// §3 Candle-close discipline
//
// The distinction between "a bar exists in the array" and "that bar has
// closed" is the load-bearing distinction in this entire service. The
// previous build treated a bar with no timestamp as closed, which made
// every wick on a forming bar eligible to trigger a trap. Unknown now
// means not closed.

export function barIsClosed(bar, span, nowMs = Date.now()) {
  if (!bar) return false;
  if (bar.timestampMs === null || bar.timestampMs === undefined) return false;
  return nowMs >= bar.timestampMs + span;
}

/**
 * The closed prefix of a bar series, plus an explicit quality verdict.
 *
 * `status`:
 *   OK          — at least one closed bar, freshly delivered
 *   NO_TIMESTAMP— feed omitted bar times; closure is unverifiable
 *   STALE       — newest closed bar is older than the staleness budget
 *   EMPTY       — nothing usable
 */
export function closedSeries(bars, tf, { nowMs = Date.now(), staleBars = 3 } = {}) {
  const span = periodMs(tf);
  if (!span || !Array.isArray(bars) || bars.length === 0) {
    return { bars: [], status: "EMPTY", latestCloseMs: null };
  }
  if (bars.some((bar) => bar.timestampMs === null || bar.timestampMs === undefined)) {
    return { bars: [], status: "NO_TIMESTAMP", latestCloseMs: null };
  }
  const closed = bars.filter((bar) => barIsClosed(bar, span, nowMs));
  if (closed.length === 0) return { bars: [], status: "EMPTY", latestCloseMs: null };
  const latest = closed.at(-1);
  const latestCloseMs = latest.timestampMs + span;
  // Weekend gaps are legitimate; the caller decides whether a stale
  // series is fatal. The monitor treats STALE as degraded-data, not as
  // evidence of anything.
  if (nowMs - latestCloseMs > staleBars * span) {
    return { bars: closed, status: "STALE", latestCloseMs };
  }
  return { bars: closed, status: "OK", latestCloseMs };
}

/**
 * Stable identity for a closed bar. The previous implementation folded
 * the array index into the fallback fingerprint, so the same bar
 * produced a different key on every poll as the window advanced, which
 * defeated the once-only guarantee it was written to provide.
 */
export function barKey(bar) {
  if (!bar) return null;
  if (bar.timestampMs !== null && bar.timestampMs !== undefined) {
    return `t:${bar.timestampMs}`;
  }
  return null;
}

/**
 * Align two bar series on shared open times. Cross-market divergence
 * compared by array position is meaningless the moment one feed returns
 * a different bar count or a different last bar — which happens on every
 * illiquid partner instrument. Returns null when the overlap is too thin
 * to make a claim.
 */
export function alignSeries(a, b, minBars = 20) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const bByTime = new Map(b.map((bar) => [bar.timestampMs, bar]));
  const left = [];
  const right = [];
  for (const bar of a) {
    const match = bByTime.get(bar.timestampMs);
    if (match) {
      left.push(bar);
      right.push(match);
    }
  }
  if (left.length < minBars) return null;
  return { left, right };
}

// ---------------------------------------------------------------------------
// §4 Market analytics
//
// Every function here takes CLOSED bars. None of them may be handed a
// forming bar; the caller is responsible for that and the test suite
// asserts it.

export function calcATR(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return 0;
  const window = bars.slice(-(period + 1));
  const ranges = [];
  for (let index = 1; index < window.length; index += 1) {
    const bar = window[index];
    const previous = window[index - 1];
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      ),
    );
  }
  if (!ranges.length) return 0;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifyWick(bar, atr, direction) {
  if (!bar || !atr || atr <= 0) return "none";
  const range = Math.max(0, bar.high - bar.low);
  if (range <= 0) return "none";
  const body = Math.abs(bar.close - bar.open);
  const lower = Math.min(bar.open, bar.close) - bar.low;
  const upper = bar.high - Math.max(bar.open, bar.close);
  const wick = Math.max(0, direction === "buy" ? lower : upper);
  const opposing = Math.max(0, direction === "buy" ? upper : lower);
  // Ratio against range, not against body: a doji has a body near zero,
  // and dividing by it produced an unbounded ratio that classified every
  // indecision bar as a strong rejection.
  const ratio = wick / range;
  // A rejection is one-sided. A bar with comparable wicks on both ends is
  // indecision — the market went both ways and committed to neither — and
  // it must not count as evidence for either direction.
  const oneSided = wick >= 2 * opposing;
  const closesStrong =
    direction === "buy"
      ? bar.close >= bar.high - 0.25 * range
      : bar.close <= bar.low + 0.25 * range;
  if (!oneSided) return "none";
  if (ratio >= 0.66 && closesStrong && range >= 1.5 * atr && body > 0) return "strong";
  if (ratio >= 0.5) return "soft";
  return "none";
}

export function classifyEngulfing(bars, direction, timeframe) {
  if (!Array.isArray(bars) || bars.length < 2) return "none";
  const current = bars.at(-1);
  const previous = bars.at(-2);
  const currentBody = Math.abs(current.close - current.open);
  const previousBody = Math.abs(previous.close - previous.open);
  if (currentBody <= 0) return "none";
  const directional =
    direction === "buy" ? current.close > current.open : current.close < current.open;
  if (!directional) return "none";
  const engulfed =
    direction === "buy"
      ? current.close > previous.open && current.open < previous.close
      : current.close < previous.open && current.open > previous.close;
  if (!engulfed) return "none";
  return timeframe === "M5" && previousBody > 0 && currentBody >= 1.5 * previousBody
    ? "strong"
    : "soft";
}

/**
 * CISD — a sweep of a prior swing that is reclaimed by the close.
 * Returns null (not false) when there is insufficient history, so the
 * caller can distinguish "no divergence" from "cannot tell".
 */
export function checkCISD(bars, direction, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < lookback) return null;
  const window = bars.slice(-lookback, -2);
  if (window.length < 5) return null;
  const current = bars.at(-1);
  const previous = bars.at(-2);
  if (direction === "buy") {
    const swingLow = Math.min(...window.map((bar) => bar.low));
    return previous.low < swingLow && current.close > swingLow;
  }
  const swingHigh = Math.max(...window.map((bar) => bar.high));
  return previous.high > swingHigh && current.close < swingHigh;
}

/**
 * SMT — one market takes the liquidity, the correlated one refuses.
 *
 * Both legs are timestamp-aligned first. Returns null when no partner
 * series overlaps enough to make the comparison, which the evidence
 * layer treats as "unavailable" rather than "absent". The previous build
 * collapsed both into `false`, so a missing partner feed and a genuine
 * lack of divergence were indistinguishable in the audit trail.
 */
export function checkSMT(main, partners, direction, lookback = 20) {
  if (!Array.isArray(main) || main.length < lookback) return null;
  const usable = (partners || []).filter(
    (partner) => Array.isArray(partner.bars) && partner.bars.length >= lookback,
  );
  if (!usable.length) return null;

  let compared = 0;
  for (const partner of usable) {
    const aligned = alignSeries(main, partner.bars, lookback);
    if (!aligned) continue;
    compared += 1;
    const { left, right } = aligned;
    const mainWindow = left.slice(-lookback, -2);
    const partnerWindow = right.slice(-lookback, -2);
    if (mainWindow.length < 5) continue;

    const inverse = partner.inverse === true;
    if (direction === "buy") {
      const mainSwingLow = Math.min(...mainWindow.map((bar) => bar.low));
      const mainTook = Math.min(left.at(-1).low, left.at(-2).low) < mainSwingLow;
      if (!mainTook) return false;
      if (inverse) {
        const swingHigh = Math.max(...partnerWindow.map((bar) => bar.high));
        if (Math.max(right.at(-1).high, right.at(-2).high) <= swingHigh) return true;
      } else {
        const swingLow = Math.min(...partnerWindow.map((bar) => bar.low));
        if (Math.min(right.at(-1).low, right.at(-2).low) >= swingLow) return true;
      }
    } else {
      const mainSwingHigh = Math.max(...mainWindow.map((bar) => bar.high));
      const mainTook = Math.max(left.at(-1).high, left.at(-2).high) > mainSwingHigh;
      if (!mainTook) return false;
      if (inverse) {
        const swingLow = Math.min(...partnerWindow.map((bar) => bar.low));
        if (Math.min(right.at(-1).low, right.at(-2).low) >= swingLow) return true;
      } else {
        const swingHigh = Math.max(...partnerWindow.map((bar) => bar.high));
        if (Math.max(right.at(-1).high, right.at(-2).high) <= swingHigh) return true;
      }
    }
  }
  return compared === 0 ? null : false;
}

export function classifyPricePattern(signals) {
  const strong = signals.engulfM5 === "strong" || signals.wick === "strong";
  const soft =
    signals.engulfM5 === "soft" ||
    (signals.engulfM1 && signals.engulfM1 !== "none") ||
    signals.wick === "soft";
  if (strong) return { present: true, tier: "strong" };
  if (soft) return { present: true, tier: "soft" };
  return { present: false, tier: "none" };
}

export function bodyClosedBeyond(bar, level, direction) {
  if (!bar || level === null || level === undefined) return false;
  return direction === "buy" ? bar.close > level : bar.close < level;
}

/**
 * Whether a trigger level was *taken* by the closing bar.
 *
 * Taking a level is a transition, not a state. A body close beyond a
 * level that price was already beyond is not a break of that level — it
 * is simply where the market already was. Reading the state alone is how
 * a trap armed on the already-broken side of its own trigger reports
 * "TRIGGER LEVEL TAKEN" on its first post-arm candle, for a level
 * nothing ever crossed.
 *
 * So the take requires the previous closed body to have been on the
 * un-taken side. Direction is the bias: a buy read is taken by closing
 * ABOVE its trigger, a sell read by closing BELOW it — the same
 * convention `bodyClosedBeyond` uses, the one the arming message states,
 * and the one `validateTrapWatchInput` enforces by requiring a buy's
 * invalidation to sit below its trigger.
 *
 * The comparison it actually made is returned either way, so the caller
 * can log precisely what was compared rather than inferring it.
 */
export function triggerTaken(bars, level, bias) {
  const current = Array.isArray(bars) ? bars.at(-1) : null;
  if (!current || level === null || level === undefined) {
    return { taken: false, reason: "no closed candle", comparison: null };
  }
  const beyond = bodyClosedBeyond(current, level, bias);
  const comparison = {
    close: current.close,
    level,
    bias,
    operator: bias === "buy" ? ">" : "<",
    beyond,
    previousClose: null,
  };
  if (!beyond) {
    return { taken: false, reason: "close is on the un-taken side of the trigger", comparison };
  }
  const previous = bars.at(-2);
  if (!previous) {
    return { taken: false, reason: "no prior closed candle to prove a crossing", comparison };
  }
  comparison.previousClose = previous.close;
  if (bodyClosedBeyond(previous, level, bias)) {
    return {
      taken: false,
      reason: "price was already beyond the trigger before this candle — nothing crossed it",
      comparison,
    };
  }
  return { taken: true, reason: "closed through the trigger from the un-taken side", comparison };
}

export function oppositeBias(bias) {
  return bias === "buy" ? "sell" : "buy";
}

export function displacementCheck(bars, direction, multiple, lookback) {
  const trigger = bars.at(-1);
  const prior = bars.slice(-(lookback + 1), -1);
  if (!trigger || prior.length < 5) {
    return { present: false, body: null, threshold: null, average: null, samples: prior.length };
  }
  const bodies = prior.map((bar) => Math.abs(bar.close - bar.open));
  const average = bodies.reduce((sum, value) => sum + value, 0) / bodies.length;
  const body = Math.abs(trigger.close - trigger.open);
  const threshold = average * multiple;
  const directional =
    direction === "buy" ? trigger.close > trigger.open : trigger.close < trigger.open;
  return {
    present: directional && average > 0 && body >= threshold,
    body,
    threshold,
    average,
    samples: prior.length,
  };
}

export function fvgCheck(bars, direction) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return { present: false, from: null, to: null };
  }
  const first = bars.at(-3);
  const third = bars.at(-1);
  if (direction === "buy" && third.low > first.high) {
    return { present: true, from: first.high, to: third.low };
  }
  if (direction === "sell" && third.high < first.low) {
    return { present: true, from: third.high, to: first.low };
  }
  return { present: false, from: null, to: null };
}

// ---------------------------------------------------------------------------
// §5 Instrument conventions
//
// Tolerance and spread caps used to be a hardcoded symbol table with a
// 0.0001 default, which is roughly right for a 5-digit FX major and
// wrong by two orders of magnitude for USDJPY, an index, or any symbol
// not in the table. Both are now derived from the price itself, with the
// table kept only as an override for instruments where the derived value
// is known to be too loose.

const TOLERANCE_OVERRIDES = { XAUUSD: 0.1, XAGUSD: 0.02 };
const SPREAD_CAP_OVERRIDES = { XAUUSD: 0.6, XAGUSD: 0.05 };
export const INDEX_SYMBOLS = new Set([
  "NAS100",
  "US30",
  "SPX500",
  "US500",
  "USTEC",
  "UK100",
  "GER40",
  "JP225",
]);

export function priceTolerance(symbol, price) {
  if (TOLERANCE_OVERRIDES[symbol]) return TOLERANCE_OVERRIDES[symbol];
  if (!Number.isFinite(price) || price <= 0) return 0.0001;
  // 1 basis point of price, floored at a tick-ish value. Scales
  // correctly from EURUSD at 1.08 to BTCUSD at 90,000 without a table.
  return Math.max(price * 0.0001, 1e-5);
}

export function spreadHardCap(symbol, mid, override = null) {
  if (override !== null && override > 0) return override;
  if (SPREAD_CAP_OVERRIDES[symbol]) return SPREAD_CAP_OVERRIDES[symbol];
  if (!Number.isFinite(mid) || mid <= 0) return Infinity;
  if (INDEX_SYMBOLS.has(symbol)) return mid * 0.001;
  return mid * 0.0004;
}

const CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "SEK", "NOK",
  "DKK", "PLN", "HUF", "CZK", "TRY", "ZAR", "MXN", "SGD", "HKD", "CNH",
]);

/**
 * Currencies whose scheduled news should gate a symbol. Derived from the
 * symbol name so an unlisted cross (EURGBP, AUDNZD) gates on the right
 * two economies instead of defaulting to USD and missing both.
 */
export function symbolCurrencies(symbol) {
  const name = String(symbol || "").toUpperCase();
  if (INDEX_SYMBOLS.has(name)) return ["USD"];
  if (/^(XAU|XAG|XPT|XPD)/.test(name)) return ["USD"];
  if (/^(BTC|ETH|SOL|XRP|LTC|ADA|DOGE)/.test(name)) return ["USD"];
  if (name.length === 6) {
    const base = name.slice(0, 3);
    const quote = name.slice(3);
    if (CURRENCY_CODES.has(base) && CURRENCY_CODES.has(quote)) return [base, quote];
  }
  return ["USD"];
}

export function formatLevel(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 2 : magnitude >= 10 ? 3 : 5;
  return value.toFixed(digits);
}

export function quantizePrice(value) {
  if (!Number.isFinite(value)) return "NaN";
  return value.toFixed(8);
}

// ---------------------------------------------------------------------------
// §6 Session and news time math

export const KILL_ZONES = Object.freeze([
  { name: "Asian Range", start: "19:00", end: "24:00" },
  { name: "London Opening Range", start: "01:30", end: "02:00" },
  { name: "London Open KZ", start: "02:00", end: "05:00" },
  { name: "NY Opening Range", start: "07:00", end: "07:30" },
  { name: "NY Open KZ", start: "07:00", end: "10:00" },
  { name: "Equities Opening Range", start: "09:30", end: "10:00" },
  { name: "London Close", start: "10:00", end: "12:00" },
  { name: "PM Opening Range", start: "13:30", end: "14:00" },
  { name: "PM Session", start: "13:30", end: "16:00" },
  { name: "Last Hour Macros", start: "15:00", end: "16:00" },
]);
export const NY_LUNCH = Object.freeze({ name: "NY Lunch", start: "12:00", end: "13:00" });

// The top-of/around-the-hour "macro" windows, narrower than the kill
// zones above and centred on the institutional hours rather than on a
// session open. Informational only — recorded on a confirmed entry, and
// never a gate: nothing here decides whether a setup enters, which is
// what §11b's fast lane got wrong and this does not repeat.
export const MACRO_WINDOWS = Object.freeze([
  { name: "7:50-8:10 Macro", start: "07:50", end: "08:10" },
  { name: "9:50-10:10 Macro", start: "09:50", end: "10:10" },
  { name: "10:50-11:10 Macro", start: "10:50", end: "11:10" },
  { name: "11:50-12:10 Macro", start: "11:50", end: "12:10" },
  { name: "13:10-13:40 Macro", start: "13:10", end: "13:40" },
  { name: "15:15-15:45 Macro", start: "15:15", end: "15:45" },
]);

export function toMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

export function isWindowActive(nowMinutes, window) {
  const start = toMinutes(window.start);
  const endValue = toMinutes(window.end);
  const end = endValue === 0 ? 1440 : endValue;
  if (start <= end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

/**
 * Minutes past midnight in New York, and the weekday there. Intl handles
 * DST, which is why the session gate is computed from an IANA zone
 * rather than a fixed UTC offset — a fixed offset silently shifts every
 * kill zone by an hour twice a year.
 */
export function nyClock(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    minutes: Number(values.hour) * 60 + Number(values.minute),
    weekday: values.weekday,
  };
}

export function killZoneStatus(nowMs = Date.now(), { ignoreWeekend = false } = {}) {
  const { minutes, weekday } = nyClock(nowMs);
  // `weekend` is still reported honestly either way — it is what the
  // calendar actually says. `ignoreWeekend` only controls whether it is
  // allowed to gate `active`, for a symbol (crypto) whose venue does not
  // close on Sat/Sun even though the FX week does.
  const weekend = weekday === "Sat" || weekday === "Sun";
  const lunch = isWindowActive(minutes, NY_LUNCH);
  const zone = KILL_ZONES.find((item) => isWindowActive(minutes, item));
  const weekendBlocks = weekend && !ignoreWeekend;
  return {
    active: Boolean(zone) && !lunch && !weekendBlocks,
    zone: zone?.name || null,
    inLunch: lunch,
    weekend,
    weekendBlocks,
  };
}

export function macroStatus(nowMs = Date.now()) {
  const { minutes, weekday } = nyClock(nowMs);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const window = MACRO_WINDOWS.find((item) => isWindowActive(minutes, item));
  return { active: Boolean(window) && !weekend, window: window?.name || null };
}

export function newsBlackout(events, currencies, nowMs, { before, after, impacts }) {
  const wanted = new Set(currencies);
  for (const event of events || []) {
    if (!wanted.has(event.country)) continue;
    if (!impacts.has(event.impact)) continue;
    if (nowMs >= event.timestamp - before && nowMs <= event.timestamp + after) {
      return event;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// §7 Evidence machine
//
// Evidence graduates only after it has survived both wall-clock time and
// a market-time boundary (a new M1 bar). Poll frequency is never a
// substitute for market time: without the bar-generation requirement, a
// faster polling interval would manufacture confirmations that a slower
// one would not, which makes the confirmation a property of the
// infrastructure rather than of the market.

export function emptyDiscrete() {
  return {
    pending: false,
    graduated: false,
    tier: null,
    sourceMid: null,
    firstSeenAt: null,
    firstSeenGeneration: null,
  };
}

export function emptyContinuous() {
  return { pending: false, graduated: false, firstSeenAt: null, firstSeenGeneration: null };
}

/**
 * The evidence object's rest state — the same shape evaluateConfirmation
 * builds every tick, with every stream un-graduated. Used to force a
 * fresh hold rather than resuming a pre-existing one: notably after an
 * SL excursion survives (§15A), where a stream that graduated before
 * price ran to the stop must not carry that graduation straight through
 * the excursion and into the reclaim.
 */
export function emptyEvidence() {
  return {
    structure: emptyDiscrete(),
    crossMarket: emptyDiscrete(),
    pricePattern: emptyDiscrete(),
    midnightJudas: emptyDiscrete(),
    confluence: emptyDiscrete(),
    acceptance: emptyContinuous(),
  };
}

export function evidenceHeld(slot, generation, hasBarTime, opts) {
  if (!slot || slot.firstSeenAt === null || slot.firstSeenAt === undefined) return false;
  if (opts.nowMs - slot.firstSeenAt < opts.minHoldMs) return false;
  if (!opts.requireNewBar) return true;
  if (!hasBarTime) {
    // The feed gave no bar time, so a market-time boundary cannot be
    // proven. Fall back to a strictly longer wall-clock hold rather than
    // pretending the boundary was crossed.
    return opts.nowMs - slot.firstSeenAt >= opts.minHoldMs * 2;
  }
  if (slot.firstSeenGeneration === null || slot.firstSeenGeneration === undefined) {
    return false;
  }
  return generation > slot.firstSeenGeneration;
}

export function advanceDiscrete(slot, present, tier, mid, direction, tolerance, ctx) {
  const current = slot || emptyDiscrete();
  if (present === null) return current; // unavailable: hold, don't decay
  const faded =
    current.sourceMid !== null &&
    (direction === "buy"
      ? mid < current.sourceMid - tolerance
      : mid > current.sourceMid + tolerance);
  if (faded) return emptyDiscrete();
  if (current.graduated) {
    return { ...current, tier: tier === "none" || tier === null ? current.tier : tier };
  }
  if (present && !current.pending) {
    return {
      pending: true,
      graduated: false,
      tier,
      sourceMid: mid,
      firstSeenAt: ctx.nowMs,
      firstSeenGeneration: ctx.generation,
    };
  }
  if (current.pending) {
    const next = { ...current };
    if (present && tier === "strong" && next.tier !== "strong") next.tier = "strong";
    if (evidenceHeld(next, ctx.generation, ctx.hasBarTime, ctx)) {
      return { ...next, pending: false, graduated: true };
    }
    return next;
  }
  return current;
}

export function advanceContinuous(slot, present, ctx) {
  const current = slot || emptyContinuous();
  if (!present) return emptyContinuous();
  if (current.graduated) return current;
  if (!current.pending) {
    return {
      pending: true,
      graduated: false,
      firstSeenAt: ctx.nowMs,
      firstSeenGeneration: ctx.generation,
    };
  }
  return evidenceHeld(current, ctx.generation, ctx.hasBarTime, ctx)
    ? { ...current, pending: false, graduated: true }
    : current;
}

/**
 * Acceptance — price has travelled far enough beyond entry, and still
 * sits far enough from the risk line, to call the level accepted rather
 * than merely touched.
 *
 * The buffer is capped as a fraction of the entry-to-risk distance. The
 * previous unbounded 0.5×ATR requirement meant that on a high-ATR
 * instrument the monitor would only accept after price had already
 * travelled most of the way to the stop's mirror image, which is a
 * structurally late entry: the trade was chased, not sniped.
 */
export function checkAcceptance(watch, mid, protective, atr, tolerance, opts = {}) {
  if (!atr || atr <= 0) return false;
  // The trade's risk, and therefore the stop — see validateWatchInput.
  // The safety margin below is a distance from the line price would
  // actually be stopped at, so it is the stop that defines it.
  const riskLine = watch.sl;
  const risk = Math.abs(watch.entry - riskLine);
  if (!(risk > 0)) return false;
  const atrFraction = opts.atrFraction ?? 0.5;
  const riskFraction = opts.riskFraction ?? 0.35;
  const buffer = Math.min(Math.max(tolerance, atr * atrFraction), risk * riskFraction);
  const safetyMargin = Math.max(tolerance, Math.min(atr * 0.25, risk * 0.2));
  if (watch.direction === "buy") {
    return mid - watch.entry >= buffer && protective - riskLine >= safetyMargin;
  }
  return watch.entry - mid >= buffer && riskLine - protective >= safetyMargin;
}

/**
 * Fold this tick's signals into the watch's evidence and report whether
 * the technical read is complete. Mutates nothing: returns the next
 * evidence object alongside the verdict, so the caller decides whether
 * to commit it.
 */
export function evaluateConfirmation(watch, signals, ctx) {
  const pattern = classifyPricePattern(signals);
  const previous = watch.evidence || {};
  const evidence = {
    structure: advanceDiscrete(
      previous.structure,
      signals.cisd,
      "strong",
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    crossMarket: advanceDiscrete(
      previous.crossMarket,
      signals.smt,
      "strong",
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    pricePattern: advanceDiscrete(
      previous.pricePattern,
      pattern.present,
      pattern.tier,
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    // Two more graduated technical streams, alongside CISD/SMT/pattern
    // rather than in place of any of them — the same hold-and-fade rule
    // applies, so a fake midnight reclaim or a confluence that price
    // trades back through fades and resets exactly like the others do.
    midnightJudas: advanceDiscrete(
      previous.midnightJudas,
      signals.midnightJudas,
      "strong",
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    confluence: advanceDiscrete(
      previous.confluence,
      signals.confluence,
      "strong",
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    acceptance: advanceContinuous(previous.acceptance, signals.acceptance, ctx),
  };

  const technical = [];
  if (evidence.structure.graduated) technical.push({ label: "CISD", strong: true });
  if (evidence.crossMarket.graduated) {
    technical.push({ label: "SMT Divergence", strong: true });
  }
  if (evidence.pricePattern.graduated) {
    technical.push({
      label:
        evidence.pricePattern.tier === "strong"
          ? "Price Pattern (Strong)"
          : "Price Pattern",
      strong: evidence.pricePattern.tier === "strong",
    });
  }
  if (evidence.midnightJudas.graduated) {
    technical.push({ label: "Midnight Open Judas Swing", strong: true });
  }
  if (evidence.confluence.graduated) {
    technical.push({ label: "PDA Confluence", strong: true });
  }

  const acceptance = evidence.acceptance.graduated;
  const labels = technical.map((item) => item.label).concat(acceptance ? ["Live Acceptance"] : []);
  if (!acceptance || technical.length === 0) {
    return {
      evidence,
      enter: false,
      signals: labels,
      strength: !acceptance ? "PENDING_ACCEPTANCE" : "PENDING_REASON",
    };
  }
  return {
    evidence,
    enter: true,
    signals: labels,
    strength:
      technical.some((item) => item.strong) || technical.length > 1 ? "STRONG" : "CONFIRMED",
  };
}

/**
 * Bar-generation counter. Confirmation requires this to advance, which
 * is what ties the hold requirement to market time rather than to the
 * poll loop.
 */
export function advanceGeneration(state, latestBarTimeMs) {
  if (latestBarTimeMs === null || latestBarTimeMs === undefined) {
    return { ...state, hasBarTime: false };
  }
  if (state.lastBarTimeMs === null || state.lastBarTimeMs === undefined) {
    return { lastBarTimeMs: latestBarTimeMs, generation: state.generation || 0, hasBarTime: true };
  }
  if (latestBarTimeMs > state.lastBarTimeMs) {
    return {
      lastBarTimeMs: latestBarTimeMs,
      generation: (state.generation || 0) + 1,
      hasBarTime: true,
    };
  }
  return { ...state, hasBarTime: true };
}

// ---------------------------------------------------------------------------
// §8 Registration validation

export const NUMERIC_FIELDS = ["entry", "sl", "invalidation", "tp1", "tp2", "tp3"];

export function validateWatchInput(args) {
  // §8 of the lifecycle spec names these two separately, and the
  // separation is the point: `potential_trade_sl` is where a trade would
  // be stopped, `thesis_invalidation` is where the analysis is wrong.
  // The schema's own names for them are `sl` and `invalidation`; both
  // vocabularies are accepted so the analyst can write either.
  if (args.potential_trade_sl !== undefined && args.sl === undefined) {
    args = { ...args, sl: args.potential_trade_sl };
  }
  if (args.thesis_invalidation !== undefined && args.invalidation === undefined) {
    args = { ...args, invalidation: args.thesis_invalidation };
  }
  const symbol = String(args.symbol || "").trim().toUpperCase();
  const direction = String(args.direction || "").trim().toLowerCase();
  if (!symbol) throw new Error("symbol is required");
  if (!/^[A-Z0-9._]{3,20}$/.test(symbol)) throw new Error("symbol is malformed");
  if (!["buy", "sell"].includes(direction)) throw new Error("direction must be buy or sell");

  const numeric = {};
  for (const field of NUMERIC_FIELDS) {
    if (args[field] !== undefined && args[field] !== null && args[field] !== "") {
      const value = finiteNumber(args[field]);
      if (value === null) throw new Error(`${field} must be numeric`);
      if (value <= 0) throw new Error(`${field} must be greater than zero`);
      numeric[field] = value;
    }
  }
  for (const field of ["entry", "sl", "tp1"]) {
    if (numeric[field] === undefined) throw new Error(`${field} is required`);
  }

  const isBuy = direction === "buy";
  if (isBuy && !(numeric.entry > numeric.sl && numeric.tp1 > numeric.entry)) {
    throw new Error("buy setup requires entry > sl and tp1 > entry");
  }
  if (!isBuy && !(numeric.entry < numeric.sl && numeric.tp1 < numeric.entry)) {
    throw new Error("sell setup requires entry < sl and tp1 < entry");
  }
  if (numeric.invalidation !== undefined) {
    if (isBuy && numeric.invalidation >= numeric.entry) {
      throw new Error("buy invalidation must be below entry");
    }
    if (!isBuy && numeric.invalidation <= numeric.entry) {
      throw new Error("sell invalidation must be above entry");
    }
  }
  for (const field of ["tp2", "tp3"]) {
    if (numeric[field] !== undefined) {
      if (isBuy && numeric[field] <= numeric.entry) {
        throw new Error(`${field} must be above entry for a buy`);
      }
      if (!isBuy && numeric[field] >= numeric.entry) {
        throw new Error(`${field} must be below entry for a sell`);
      }
    }
  }

  // A setup whose reward is smaller than its risk is not a sniper setup;
  // registering it wastes a monitoring slot and invites a low-quality
  // notification. This is the one quality assertion the monitor makes
  // about a setup's shape, and it is deliberately minimal.
  //
  // Risk is measured entry-to-STOP, never entry-to-thesis-line. A trade
  // can only lose as far as the price it is stopped at; a thesis line
  // that sits beyond the stop describes when the analysis is wrong, not
  // how much the trade costs when it fails. Measuring against the thesis
  // line would reject a perfectly shaped setup for declaring a wide one.
  const risk = Math.abs(numeric.entry - numeric.sl);
  const reward = Math.abs(numeric.tp1 - numeric.entry);
  if (risk > 0 && reward / risk < 1) {
    throw new Error(
      `tp1 must be at least 1R from entry (got ${(reward / risk).toFixed(2)}R)`,
    );
  }

  const expirationMinutes =
    args.expiration_minutes === undefined || args.expiration_minutes === null
      ? null
      : finiteNumber(args.expiration_minutes);
  if (args.expiration_minutes !== undefined && args.expiration_minutes !== null && expirationMinutes === null) {
    throw new Error("expiration_minutes must be numeric");
  }
  if (expirationMinutes !== null && expirationMinutes <= 0) {
    throw new Error("expiration_minutes must be greater than zero");
  }

  const zone = validateEntryZone(args, numeric.entry, direction);
  const prerequisite = validatePrerequisite(args, direction);
  const invalidationRule = String(args.invalidation_rule || "touch").toLowerCase();
  if (!["touch", "body_close"].includes(invalidationRule)) {
    throw new Error("invalidation_rule must be touch or body_close");
  }
  const invalidationTimeframe = normalizeTimeframe(args.invalidation_timeframe || "M15");
  if (!invalidationTimeframe) throw new Error("invalidation_timeframe is not a known timeframe");

  const riskPercent =
    args.risk_percent === undefined || args.risk_percent === null || args.risk_percent === ""
      ? null
      : finiteNumber(args.risk_percent);
  if (riskPercent !== null && !(riskPercent > 0 && riskPercent <= 10)) {
    throw new Error("risk_percent must be greater than zero and at most 10");
  }
  const volume =
    args.volume === undefined || args.volume === null || args.volume === ""
      ? null
      : finiteNumber(args.volume);
  if (volume !== null && !(volume > 0)) throw new Error("volume must be greater than zero");

  // The analysis skill's own conclusions, if it sent any. They are
  // advisory: they can shorten the confirmation path within bounds, and
  // they can never place a trade on their own. See §11b.
  const skillContext = validateSkillContext(args.skill_context, { direction });

  // -- Lifecycle inputs ----------------------------------------------------
  const defenceProfile = String(args.defence_profile || "standard").toLowerCase();
  if (!DEFENCE_PROFILES.includes(defenceProfile)) {
    throw new Error(`defence_profile must be one of ${DEFENCE_PROFILES.join(", ")}`);
  }
  const urgency = String(args.urgency || "NORMAL").toUpperCase();
  if (!URGENCIES.includes(urgency)) {
    throw new Error(`urgency must be one of ${URGENCIES.join(", ")}`);
  }
  const positiveMinutes = (key) => {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === "") return null;
    const value = finiteNumber(raw);
    if (value === null) throw new Error(`${key} must be numeric`);
    if (!(value > 0)) throw new Error(`${key} must be greater than zero`);
    return value;
  };
  const confirmationDeadlineMinutes = positiveMinutes("confirmation_deadline_minutes");
  const entryMonitoringWindowMinutes = positiveMinutes("entry_monitoring_window_minutes");
  if (
    confirmationDeadlineMinutes !== null &&
    expirationMinutes !== null &&
    confirmationDeadlineMinutes > expirationMinutes
  ) {
    throw new Error("confirmation_deadline_minutes cannot outlive expiration_minutes");
  }
  const maxEntryDeviation =
    args.max_entry_deviation === undefined || args.max_entry_deviation === null || args.max_entry_deviation === ""
      ? null
      : finiteNumber(args.max_entry_deviation);
  if (args.max_entry_deviation !== undefined && args.max_entry_deviation !== null && args.max_entry_deviation !== "" && !(maxEntryDeviation > 0)) {
    throw new Error("max_entry_deviation must be greater than zero");
  }

  // Per-setup override of which target the remaining-R:R floor (§19) is
  // measured against. Absent, the server-wide ENTRY_RR_TARGET env default
  // applies. "tp2" only takes effect if the watch actually has a tp2.
  let entryRRTarget = null;
  if (args.entry_rr_target !== undefined && args.entry_rr_target !== null && args.entry_rr_target !== "") {
    const normalized = String(args.entry_rr_target).toLowerCase();
    if (normalized !== "tp1" && normalized !== "tp2") {
      throw new Error("entry_rr_target must be 'tp1' or 'tp2'");
    }
    entryRRTarget = normalized;
  }

  const text = (value) => (value ? String(value).slice(0, 500) : null);
  return {
    ...numeric,
    defence_profile: defenceProfile,
    urgency,
    confirmation_deadline_minutes: confirmationDeadlineMinutes,
    entry_monitoring_window_minutes: entryMonitoringWindowMinutes,
    max_entry_deviation: maxEntryDeviation,
    entry_rr_target: entryRRTarget,
    // Whether the analyst declared a thesis line in its own right, or the
    // stop is standing in for one. Everything in §15 turns on this: a
    // number that is only a stop cannot invalidate a thesis by itself.
    thesis_invalidation_declared:
      numeric.invalidation !== undefined && numeric.invalidation !== numeric.sl,
    symbol,
    direction,
    entry_zone_low: zone.low,
    entry_zone_high: zone.high,
    prerequisite,
    invalidation_rule: invalidationRule,
    invalidation_timeframe: invalidationTimeframe,
    risk_percent: riskPercent,
    volume,
    auto_trade: args.auto_trade === undefined ? null : args.auto_trade === true,
    invalidation: numeric.invalidation ?? numeric.sl,
    tp2: numeric.tp2 ?? null,
    tp3: numeric.tp3 ?? null,
    setup_id: text(args.setup_id),
    state: String(args.state || "WAIT").toUpperCase(),
    setup_model: text(args.setup_model) || "Unknown",
    conviction: text(args.conviction) || skillContext?.conviction || "N/A",
    session: text(args.session) || text(args.season) || "N/A",
    liquidity:
      args.liquidity && typeof args.liquidity === "object"
        ? JSON.stringify(args.liquidity).slice(0, 500)
        : text(args.liquidity) || "N/A",
    expiration_minutes: expirationMinutes,
    skill_context: skillContext,
  };
}

export function validateTrapWatchInput(args, defaults = {}) {
  const symbol = String(args.symbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("symbol is required");
  if (!/^[A-Z0-9._]{3,20}$/.test(symbol)) throw new Error("symbol is malformed");

  const bias = String(args.bias || args.direction || "").trim().toLowerCase();
  if (!["buy", "sell"].includes(bias)) throw new Error("bias must be buy or sell");

  const timeframe = String(args.timeframe || "M15").trim().toUpperCase().replace(/_/g, "");
  if (!TRAP_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`timeframe must be one of ${TRAP_TIMEFRAMES.join(", ")}`);
  }

  const triggerLevel = finiteNumber(args.trigger_level);
  if (triggerLevel === null) throw new Error("trigger_level must be numeric");
  if (triggerLevel <= 0) throw new Error("trigger_level must be greater than zero");

  const hasInvalidation =
    args.invalidation_level !== undefined &&
    args.invalidation_level !== null &&
    args.invalidation_level !== "";
  const invalidationLevel = hasInvalidation ? finiteNumber(args.invalidation_level) : null;
  if (hasInvalidation && invalidationLevel === null) {
    throw new Error("invalidation_level must be numeric");
  }
  if (invalidationLevel !== null) {
    if (bias === "buy" && invalidationLevel >= triggerLevel) {
      throw new Error("buy trap watch requires invalidation_level below trigger_level");
    }
    if (bias === "sell" && invalidationLevel <= triggerLevel) {
      throw new Error("sell trap watch requires invalidation_level above trigger_level");
    }
  }

  const hasExpiration =
    args.expiration_minutes !== undefined && args.expiration_minutes !== null;
  const expirationMinutes = hasExpiration
    ? finiteNumber(args.expiration_minutes)
    : defaults.trapExpiryMinutes ?? 720;
  if (hasExpiration && expirationMinutes === null) {
    throw new Error("expiration_minutes must be numeric");
  }
  if (expirationMinutes !== null && expirationMinutes < 0) {
    throw new Error("expiration_minutes must not be negative");
  }

  const text = (value) => (value ? String(value).slice(0, 500) : null);
  return {
    symbol,
    bias,
    timeframe,
    trigger_level: triggerLevel,
    invalidation_level: invalidationLevel,
    require_displacement: args.require_displacement !== false,
    require_fvg: args.require_fvg === true,
    auto_promote: args.auto_promote === undefined ? null : args.auto_promote === true,
    setup_id: text(args.setup_id),
    trap_sub_type: text(args.trap_sub_type),
    trap_active: text(args.trap_active),
    trap_score: text(args.trap_score),
    collection_grade: text(args.collection_grade),
    what_is_missing: text(args.what_is_missing),
    dol: text(args.dol),
    trigger_note: text(args.trigger_note),
    flip_note: text(args.flip_note),
    session: text(args.session),
    expiration_minutes: expirationMinutes === 0 ? null : expirationMinutes,
  };
}

export function watchKey(input) {
  return input.setup_id
    ? `setup:${input.setup_id}`
    : [
        input.symbol,
        input.direction,
        quantizePrice(input.entry),
        quantizePrice(input.sl),
        quantizePrice(input.tp1),
      ].join(":");
}

export function trapWatchKey(input) {
  if (input.setup_id) return `trap:setup:${input.setup_id}`;
  return ["trap", input.symbol, input.bias, input.timeframe, quantizePrice(input.trigger_level)].join(
    ":",
  );
}

// ---------------------------------------------------------------------------
// §9 Safety evaluation
//
// Extracted from the monitor loop so it can be tested in isolation and,
// critically, so it can be proven to run in every lifecycle state. The
// original implementation guarded the whole tick on lifecycle ∈ {ARMED,
// TOUCHED}, so a watch that reached CONFIRMING stopped checking its own
// stop loss.

export const SAFETY_REGIMES = Object.freeze(["PRE_ENTRY", "ACTIVE_TRADE"]);

/**
 * The two regimes are not two settings of one rule; they are two
 * different questions, and mixing them is the bug this function exists
 * to prevent.
 *
 * BEFORE the entry is confirmed there is no position. Price reaching the
 * level where a trade *would have been* stopped costs nothing, because
 * no trade was entered. That is an excursion to be classified (§15), not
 * an invalidation to be assumed — so it returns `SL_EXCURSION` and the
 * anti-SL branch decides what it meant.
 *
 * AFTER the entry is confirmed the same number is a real risk boundary
 * on a real position, and touching it is simply the trade being stopped.
 *
 * The one thing that kills a setup before entry regardless is the
 * *thesis* being invalidated: a level the analyst declared separately
 * from the stop, or a closed body beyond the declared rule. A stop and a
 * thesis that happen to share a number are still a stop, not a thesis.
 */
export function evaluateSafety(
  watch,
  {
    mid,
    executable,
    protective,
    tolerance,
    touchLevel = null,
    invalidationConfirmed = null,
    regime = "PRE_ENTRY",
    antiSlEnabled = true,
  },
) {
  const riskLine = watch.invalidation ?? watch.sl;
  const isBuy = watch.direction === "buy";
  const slBreached = isBuy ? protective <= watch.sl : protective >= watch.sl;
  // A setup that declares invalidation as a body close is not invalidated
  // by a wick through the level — that is the entire point of the rule.
  // The stop loss above stays a hard price line either way, so declaring
  // the rule can never leave the position unprotected.
  const riskBreached =
    watch.invalidation_rule === "body_close"
      ? invalidationConfirmed === true
      : isBuy
        ? protective <= riskLine
        : protective >= riskLine;
  const tp1Reached = isBuy ? mid >= watch.tp1 : mid <= watch.tp1;

  // Did the analyst actually declare a thesis line, or is `invalidation`
  // just the stop loss wearing a second name? `validateWatchInput`
  // defaults one to the other, so equality here means "only one number
  // was given" — and one number is a stop, which before entry invalidates
  // nothing by itself.
  const thesisIsDistinct = riskLine !== watch.sl;

  if (regime === "ACTIVE_TRADE") {
    if (slBreached) {
      return { action: "TRADE_STOPPED", reason: "Stop loss hit", price: protective };
    }
    return { action: "CONTINUE" };
  }

  // A declared body-close rule that has actually printed is the strongest
  // statement the market can make about a level: it did not visit the
  // level, it accepted price beyond it. That kills the thesis whether or
  // not the level doubles as the stop.
  if (watch.invalidation_rule === "body_close" && invalidationConfirmed === true) {
    return {
      action: "FAIL",
      reason: watch.entryTouched
        ? "Invalidation confirmed by a closed body after entry touch"
        : "Invalidation confirmed by a closed body before entry touch",
      price: protective,
    };
  }
  if (riskBreached && thesisIsDistinct) {
    return {
      action: "FAIL",
      reason: watch.entryTouched
        ? "Invalidation reached after entry touch"
        : "Invalidation reached before entry touch",
      price: protective,
    };
  }
  if (slBreached) {
    // No trade was entered, so nothing has been stopped out. Reaching
    // this line means the thesis test above did *not* fire, so the thesis
    // is — on its own declared terms — still standing. Hand the excursion
    // to the anti-SL branch rather than declaring it dead.
    if (antiSlEnabled) {
      return {
        action: "SL_EXCURSION",
        reason: "Price reached the potential trade stop before any entry was taken",
        price: protective,
      };
    }
    return {
      action: "FAIL",
      reason: watch.entryTouched ? "SL reached" : "SL reached before entry touch",
      price: protective,
    };
  }
  if (tp1Reached) {
    // The thesis was right and the entry never happened. Those are two
    // different facts (§5): the setup is not "expired", the *opportunity*
    // is gone. Chasing it here is exactly what §18 forbids.
    return {
      action: "ENTRY_MISSED",
      reason: watch.entryTouched
        ? "TP1 reached before confirmation"
        : "TP1 reached before entry touch",
      price: mid,
    };
  }
  if (!watch.entryTouched) {
    const level = finiteNumber(touchLevel) ?? watch.entry;
    const touched = isBuy ? executable <= level + tolerance : executable >= level - tolerance;
    if (touched) return { action: "TOUCH", price: executable };
    return { action: "WAIT" };
  }
  return { action: "CONTINUE" };
}

export function updateSpreadHealth(watch, spread, tolerance, mid, config) {
  const history = watch.spreadSamples || [];
  const cap = spreadHardCap(watch.symbol, mid, config.capOverride);
  let abnormal = false;
  let baseline = null;
  if (config.enabled) {
    if (history.length >= config.baselineSamples) {
      baseline = median(history);
      abnormal =
        spread > cap ||
        (spread > baseline * config.anomalyMultiplier && spread - baseline > tolerance);
    } else {
      abnormal = spread > cap;
    }
  }
  const next = [...history, spread].slice(-config.historyMax);
  return { abnormal, baseline, cap, spreadSamples: next };
}

// ---------------------------------------------------------------------------
// §10 Entry-sequence registration inputs
//
// A registered watch may now carry the two rules the analyst asserted
// alongside the levels: what has to have happened before entry is even
// live (the setup prerequisite, e.g. "M15 body close below 4324.71"),
// and what counts as invalidation (a touch of the level, or a body close
// through it). Both exist because a wick is not a close, and treating
// one as the other is how a setup gets entered early and killed late.

export function normalizeTimeframe(value) {
  const key = String(value || "").toUpperCase().replace(/_/g, "");
  return PERIOD_MS[key] ? key : null;
}

/**
 * The entry zone. ICT setups are registered against a band
 * ("4330.00–4334.00"), not a point; when only a point is given the band
 * is the point, and the caller widens it by the instrument tolerance.
 */
export function validateEntryZone(args, entry, direction) {
  const rawLow = args.entry_zone_low ?? args.entry_zone?.low ?? null;
  const rawHigh = args.entry_zone_high ?? args.entry_zone?.high ?? null;
  if (rawLow === null && rawHigh === null) return { low: null, high: null };
  const low = finiteNumber(rawLow);
  const high = finiteNumber(rawHigh);
  if (low === null || high === null) {
    throw new Error("entry_zone_low and entry_zone_high must both be numeric");
  }
  if (!(low > 0 && high > 0)) throw new Error("entry zone bounds must be greater than zero");
  if (low >= high) throw new Error("entry_zone_low must be below entry_zone_high");
  if (entry < low || entry > high) throw new Error("entry must sit inside the entry zone");
  if (direction === "buy" && args.sl !== undefined && finiteNumber(args.sl) >= low) {
    throw new Error("buy sl must sit below the entry zone");
  }
  if (direction === "sell" && args.sl !== undefined && finiteNumber(args.sl) <= high) {
    throw new Error("sell sl must sit above the entry zone");
  }
  return { low, high };
}

export function validatePrerequisite(args, direction) {
  const raw = args.prerequisite_level ?? args.prerequisite?.level ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const level = finiteNumber(raw);
  if (level === null || level <= 0) throw new Error("prerequisite_level must be greater than zero");
  const timeframe = normalizeTimeframe(
    args.prerequisite_timeframe ?? args.prerequisite?.timeframe ?? "M15",
  );
  if (!timeframe) throw new Error("prerequisite_timeframe is not a known timeframe");
  const rule = String(args.prerequisite_rule ?? args.prerequisite?.rule ?? "body_close")
    .toLowerCase();
  if (!["body_close", "touch"].includes(rule)) {
    throw new Error("prerequisite_rule must be body_close or touch");
  }
  const side = String(args.prerequisite_direction ?? args.prerequisite?.direction ?? direction)
    .toLowerCase();
  if (!["buy", "sell"].includes(side)) {
    throw new Error("prerequisite_direction must be buy or sell");
  }
  return { level, timeframe, rule, direction: side, note: args.prerequisite_note ? String(args.prerequisite_note).slice(0, 300) : null };
}

// ---------------------------------------------------------------------------
// §11 The ICT entry sequence
//
//   SETUP VALID → ENTRY TOUCHED → REJECTION → LTF STRUCTURE SHIFT →
//   DISPLACEMENT → ENTRY CONFIRMED
//
// Two rules run through every function here. First, only price action
// that printed *after* the touch may confirm the touch: a bar that had
// already closed when the zone was reached is history the analyst
// already saw. Second, each step requires the previous one — an MSS with
// no rejection behind it, or a displacement with no MSS behind it, is
// not this sequence, it is a coincidence with the right shape.

export const EXECUTION_STAGES = Object.freeze([
  "REGISTERED_WATCH",
  "WAITING_FOR_SETUP_CONFIRMATION",
  "READY_FOR_ENTRY",
  "ENTRY_TOUCHED",
  "REJECTION_DETECTED",
  "M5_MSS_CONFIRMED",
  "M1_CONTINUATION_CONFIRMED",
  "DISPLACEMENT_CONFIRMED",
  "ENTRY_CONFIRMED",
  "ORDER_SUBMITTED",
  "EXECUTED",
  "INVALIDATED",
  "EXPIRED",
]);

export function emptySequence() {
  return {
    rejection: null,
    mss: null,
    displacement: null,
    complete: false,
    resetCount: 0,
    lastReset: null,
  };
}

/** The band price has to enter for the entry to count as touched. */
export function entryZone(watch, tolerance) {
  const low = finiteNumber(watch.entry_zone_low);
  const high = finiteNumber(watch.entry_zone_high);
  if (low !== null && high !== null) return { low, high, derived: false };
  return { low: watch.entry - tolerance, high: watch.entry + tolerance, derived: true };
}

/**
 * The price at which the zone is first reached from the side price
 * approaches it. A sell zone is touched at its lower edge, a buy zone at
 * its upper edge; anything beyond that has passed through it.
 */
export function zoneTouchLevel(watch, tolerance) {
  const zone = entryZone(watch, tolerance);
  return watch.direction === "buy" ? zone.high : zone.low;
}

export function barClosedAfter(bar, span, afterMs) {
  if (!bar || !Number.isFinite(bar.timestampMs) || !Number.isFinite(span)) return false;
  if (!Number.isFinite(afterMs)) return true;
  return bar.timestampMs + span >= afterMs;
}

/**
 * Has the setup's own prerequisite printed? Returns an explicit
 * three-valued answer: satisfied, not satisfied, or unknown — because a
 * missing candle series is not permission to treat the prerequisite as
 * met.
 */
export function evaluatePrerequisite(prerequisite, bars, { nowMs = Date.now() } = {}) {
  if (!prerequisite) return { satisfied: true, known: true, detail: "no prerequisite declared" };
  if (!Array.isArray(bars) || bars.length === 0) {
    return { satisfied: false, known: false, detail: "prerequisite candles unavailable" };
  }
  const wanted = prerequisite.direction === "buy" ? "buy" : "sell";
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index];
    const hit =
      prerequisite.rule === "touch"
        ? wanted === "buy"
          ? bar.high >= prerequisite.level
          : bar.low <= prerequisite.level
        : bodyClosedBeyond(bar, prerequisite.level, wanted);
    if (hit) {
      return {
        satisfied: true,
        known: true,
        at: bar.timestampMs,
        close: bar.close,
        detail: `${prerequisite.timeframe} ${prerequisite.rule === "touch" ? "touch of" : "body close beyond"} ${formatLevel(prerequisite.level)}`,
      };
    }
  }
  return {
    satisfied: false,
    known: true,
    detail: `${prerequisite.timeframe} ${prerequisite.rule === "touch" ? "touch of" : "body close beyond"} ${formatLevel(prerequisite.level)} has not printed`,
    nowMs,
  };
}

/**
 * Rejection of the entry zone, measured on the last bar that closed
 * after the touch. Three shapes count, all of them meaning the same
 * thing: the zone is behaving like the barrier the setup said it was.
 */
export function checkZoneRejection(bar, watch, zone, atr, span, touchedAtMs) {
  if (!bar) return { present: false, reason: "no closed bar" };
  if (!barClosedAfter(bar, span, touchedAtMs)) {
    return { present: false, reason: "bar closed before the entry touch" };
  }
  const isBuy = watch.direction === "buy";
  const wick = classifyWick(bar, atr, watch.direction);
  // Traded into the zone at all.
  const penetrated = isBuy ? bar.low <= zone.high : bar.high >= zone.low;
  // Closed back out of the zone on the trade's side of it. A close still
  // inside the zone is price sitting in the zone, not price being pushed
  // out of it, and only the second one is a rejection.
  const closedOutside = isBuy ? bar.close > zone.high : bar.close < zone.low;
  const extreme = isBuy ? bar.low : bar.high;

  if (!penetrated) return { present: false, reason: "the bar never reached the zone" };
  if (closedOutside) {
    return { present: true, kind: "failure_to_hold_zone", tier: "strong", price: extreme, close: bar.close };
  }
  if (wick === "strong") {
    return { present: true, kind: "rejection_wick_strong", tier: "strong", price: extreme, close: bar.close };
  }
  return { present: false, reason: "the bar reached the zone and held inside it" };
}

/**
 * Market-structure shift: the close of the most recent bar breaks the
 * last identifiable swing against the prior leg. The swing has to be a
 * real pivot — a low with `strength` higher lows on each side — because
 * "broke the lowest print in the window" is satisfied by any drift, and
 * that is exactly the arbitrary few-tick break the sequence forbids.
 */
export function findSwing(bars, type, { strength = 2, exclude = 1 } = {}) {
  if (!Array.isArray(bars)) return null;
  const usable = exclude > 0 ? bars.slice(0, -exclude) : bars;
  for (let index = usable.length - 1 - strength; index >= strength; index -= 1) {
    const bar = usable[index];
    let pivot = true;
    for (let offset = 1; offset <= strength; offset += 1) {
      const left = usable[index - offset];
      const right = usable[index + offset];
      if (!left || !right) {
        pivot = false;
        break;
      }
      if (type === "low" ? left.low <= bar.low || right.low <= bar.low : left.high >= bar.high || right.high >= bar.high) {
        pivot = false;
        break;
      }
    }
    if (pivot) return { index, level: type === "low" ? bar.low : bar.high, at: bar.timestampMs };
  }
  return null;
}

export function checkMSS(bars, direction, span, touchedAtMs, { strength = 2 } = {}) {
  if (!Array.isArray(bars) || bars.length < 2 * strength + 3) {
    return { present: false, level: null, reason: "insufficient history" };
  }
  const current = bars.at(-1);
  if (!barClosedAfter(current, span, touchedAtMs)) {
    return { present: false, level: null, reason: "bar closed before the entry touch" };
  }
  const swing = findSwing(bars, direction === "buy" ? "high" : "low", { strength, exclude: 1 });
  if (!swing) return { present: false, level: null, reason: "no identifiable swing" };
  const broken =
    direction === "buy" ? current.close > swing.level : current.close < swing.level;
  return {
    present: broken,
    level: swing.level,
    swingAt: swing.at,
    close: current.close,
    reason: broken ? "swing broken by the close" : "swing intact",
  };
}

/**
 * Fold this tick's post-touch observations into the sequence. Each step
 * is recorded once, against the bar that produced it, and the whole
 * sequence resets if price leaves the zone the wrong way — a rejection
 * that price then trades back through was not a rejection.
 */
export function advanceEntrySequence(sequence, observations, ctx) {
  const current = sequence ? { ...sequence } : emptySequence();

  if (observations.faded) {
    if (current.rejection || current.mss || current.displacement) {
      return {
        ...emptySequence(),
        resetCount: (current.resetCount || 0) + 1,
        lastReset: { at: ctx.nowIso, reason: observations.fadedReason || "price left the zone" },
      };
    }
    return current;
  }

  if (!current.rejection && observations.rejection?.present) {
    current.rejection = {
      kind: observations.rejection.kind,
      tier: observations.rejection.tier,
      price: observations.rejection.price,
      close: observations.rejection.close,
      bar: observations.barKey,
      at: ctx.nowIso,
    };
  }
  if (current.rejection && !current.mss && observations.mss?.present) {
    current.mss = {
      level: observations.mss.level,
      close: observations.mss.close,
      timeframe: observations.mssTimeframe || "M5",
      bar: observations.barKey,
      at: ctx.nowIso,
    };
  }
  if (current.rejection && current.mss && !current.displacement && observations.displacement?.present) {
    current.displacement = {
      body: observations.displacement.body,
      threshold: observations.displacement.threshold,
      candle: observations.displacementCandle || null,
      bar: observations.barKey,
      at: ctx.nowIso,
    };
  }
  current.complete = Boolean(current.rejection && current.mss && current.displacement);
  return current;
}

/** The state-machine label a human reads, derived from what is proven. */
export function stageOf(watch) {
  // A trap watch is not on this state machine — it has no entry, so it
  // has no entry sequence — and labelling it with these names would
  // claim otherwise.
  if (watch.kind === "TRAP") {
    return watch.lifecycle === "RESOLVED" ? watch.status || "RESOLVED" : watch.lifecycle;
  }
  // A trade is past the setup state machine entirely: it has no entry
  // left to confirm, only an outcome (§33).
  if (watch.kind === "TRADE") {
    return watch.lifecycle === "RESOLVED" ? watch.status || "RESOLVED" : "ACTIVE_TRADE";
  }
  if (watch.lifecycle === "QUARANTINED") return "QUARANTINED";
  if (watch.lifecycle === "RESOLVED" || watch.status === "EXECUTED") {
    switch (watch.status) {
      case "EXECUTED":
        return "EXECUTED";
      case "CONFIRMED":
        return "ENTRY_CONFIRMED";
      case "FAILED":
        return "INVALIDATED";
      case "CANCELLED":
        return "CANCELLED";
      // The opportunity closed or the read needs redoing. Neither is an
      // expiry and neither is an invalidation, and calling them one would
      // lose the only fact that distinguishes them (§5, §18, §34).
      case "ENTRY_MISSED":
        return "ENTRY_MISSED";
      case "REANALYSIS_REQUIRED":
        return "REANALYSIS_REQUIRED";
      default:
        return "EXPIRED";
    }
  }
  if (watch.lifecycle === "ORDER_SUBMITTED") return "ORDER_SUBMITTED";
  // The anti-SL branch is a stage a human can see the watch sitting in,
  // because "why has this not entered yet" has a different answer here
  // than it does at ENTRY_TOUCHED.
  if (watch.lifecycle === "ANTI_SL_EVALUATION") return "ANTI_SL_EVALUATION";
  if (watch.lifecycle === "ENTRY_CONFIRMED") return "ENTRY_CONFIRMED";
  const sequence = watch.sequence || {};
  if (watch.entryTouched) {
    if (sequence.displacement) return "DISPLACEMENT_CONFIRMED";
    // A watch the analyst registered on the M1 defence profile may never
    // print the M5 sequence — its proof obligation was met on M1 — so
    // reporting it as ENTRY_TOUCHED would hide what it has proven.
    if (watch.defence_profile === "m1_continuation" && watch.m1ContinuationOk === true) {
      return "M1_CONTINUATION_CONFIRMED";
    }
    if (sequence.mss) return "M5_MSS_CONFIRMED";
    if (sequence.rejection) return "REJECTION_DETECTED";
    return "ENTRY_TOUCHED";
  }
  if (watch.prerequisiteSatisfied === false) return "WAITING_FOR_SETUP_CONFIRMATION";
  if (watch.lastReason === "armed") return "REGISTERED_WATCH";
  return "READY_FOR_ENTRY";
}

// ---------------------------------------------------------------------------
// §11b Skill context — what the analyst recorded, and nothing more
//
// This block used to drive a "fast lane": the skill could claim it had
// already read the M5 structure shift, and the monitor would accept an
// M1 proof in place of the M5 sequence.
//
// It was removed because it could not work. The lane opened only while
// the analysis was inside its own freshness window — three minutes by
// default — but an analysis is written, then registered, then waits for
// price to come back to the zone. On a live setup the context was
// already six minutes past its window *before the watch was even
// registered*, and thirty-four minutes past it by the time price
// arrived. The lane never opened; all it produced was a Telegram message
// announcing that it had been refused.
//
// So the context is now what it always honestly was: a record of what
// the analyst believed, carried alongside the setup and scored against
// the outcome. It changes no decision. Confirmation is the same for
// every setup, which is the only way the operator can predict it.
export const SKILL_CONVICTIONS = Object.freeze(["HIGH", "MEDIUM", "LOW"]);

export const SKILL_TRAP_PHASES = Object.freeze([
  "accumulation",
  "manipulation",
  "distribution",
  "delivery",
  "unknown",
]);

export const FORWARD_VALIDATION_STATES = Object.freeze([
  "WITHIN_ZONE",
  "FAVORABLE_EARLY",
  "STRONG_MOVE",
  "STALE",
  "FAILED",
]);

export const SKILL_CONTEXT_LIMITS = Object.freeze({
  // The shortest confirmation hold any path can ask for. Urgency is the
  // only thing that shortens the hold now, and this is its floor.
  holdFloorMs: 15_000,
  // How long a recorded analysis is still described as fresh. It no
  // longer withholds anything — nothing is conferred to withhold — but
  // the audit reports the age so a stale claim is visible as stale.
  defaultMaxAgeMs: 180_000,
  // Clocks drift. A timestamp slightly in the future is a clock, a
  // timestamp far in the future is a bug and is dropped.
  maxClockSkewMs: 60_000,
  maxBackdateMs: 24 * 60 * 60_000,
});

export const FORWARD_VALIDATION_THRESHOLDS = Object.freeze({
  // Fractions of the entry-to-risk distance, measured from entry.
  favorableR: 0.15,
  strongR: 0.5,
  adverseR: 0.5,
});

/**
 * Normalise a `skill_context` payload.
 *
 * Structural nonsense throws — a non-object, or a numeric field that is
 * not numeric, is a contract violation in the caller and should be loud.
 * Everything else is clamped into range and the clamp is recorded in
 * `warnings`, because the alternative — refusing to register a real
 * setup over an advisory metadata field — trades a live trade for a
 * tidy error. Unknown keys are dropped rather than stored.
 */
export function validateSkillContext(
  raw,
  { nowMs = Date.now(), limits = SKILL_CONTEXT_LIMITS, direction = null } = {},
) {
  if (raw === undefined || raw === null || raw === "") return null;
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      throw new Error("skill_context must be an object");
    }
  }
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error("skill_context must be an object");
  }

  const warnings = [];
  const flag = (key) => {
    const value = source[key];
    // Only an explicit true is true. "false", 0, null and absence all
    // mean the skill did not claim it, and a claim it did not make must
    // never be read as one it did.
    if (value === true || value === "true") return true;
    if (value !== undefined && value !== null && value !== false && value !== "false" && value !== "") {
      warnings.push(`${key} was not a boolean and is treated as false`);
    }
    return false;
  };
  const number = (key) => {
    const value = source[key];
    if (value === undefined || value === null || value === "") return null;
    const parsed = finiteNumber(value);
    if (parsed === null) throw new Error(`skill_context.${key} must be numeric`);
    return parsed;
  };
  const price = (key) => {
    const value = number(key);
    if (value === null) return null;
    if (!(value > 0)) {
      warnings.push(`${key} must be greater than zero and was dropped`);
      return null;
    }
    return value;
  };
  const stamp = (key) => {
    if (source[key] === undefined || source[key] === null || source[key] === "") return null;
    const value = numericTimestampMs(source[key]);
    if (value === null) throw new Error(`skill_context.${key} must be a timestamp`);
    if (value > nowMs + limits.maxClockSkewMs) {
      warnings.push(`${key} is in the future and was dropped`);
      return null;
    }
    if (value < nowMs - limits.maxBackdateMs) {
      warnings.push(`${key} is more than 24h old and was dropped`);
      return null;
    }
    return value;
  };
  const text = (key, max = 120) =>
    source[key] === undefined || source[key] === null || source[key] === ""
      ? null
      : String(source[key]).slice(0, max);

  const convictionRaw = String(source.conviction ?? "MEDIUM").trim().toUpperCase();
  let conviction = convictionRaw;
  if (!SKILL_CONVICTIONS.includes(conviction)) {
    warnings.push(`conviction="${convictionRaw}" is not HIGH, MEDIUM or LOW and is treated as MEDIUM`);
    conviction = "MEDIUM";
  }

  const phaseRaw = source.trap_phase === undefined || source.trap_phase === null || source.trap_phase === ""
    ? null
    : String(source.trap_phase).trim().toLowerCase();
  let trapPhase = phaseRaw;
  if (trapPhase !== null && !SKILL_TRAP_PHASES.includes(trapPhase)) {
    warnings.push(`trap_phase="${phaseRaw}" is not a known phase and is treated as unknown`);
    trapPhase = "unknown";
  }

  // The skill speaks in market language ("bullish"); the monitor speaks
  // in order language ("buy"). One of the two has to translate, and it
  // is not the side that places orders.
  const biasRaw = source.htf_bias === undefined || source.htf_bias === null || source.htf_bias === ""
    ? null
    : String(source.htf_bias).trim().toLowerCase();
  let htfBias = null;
  if (biasRaw !== null) {
    if (["buy", "bullish", "long", "up"].includes(biasRaw)) htfBias = "buy";
    else if (["sell", "bearish", "short", "down"].includes(biasRaw)) htfBias = "sell";
    else warnings.push(`htf_bias="${biasRaw}" is not a known bias and was dropped`);
  }

  const analysisAtMs = stamp("analysis_at_ms") ?? stamp("m5_mss_at_ms") ?? stamp("htf_mss_at_ms") ?? nowMs;

  const context = {
    htf_mss_confirmed: flag("htf_mss_confirmed"),
    htf_mss_at: price("htf_mss_at"),
    htf_mss_at_ms: stamp("htf_mss_at_ms"),
    trap_phase: trapPhase,
    trap_sub_type: text("trap_sub_type"),
    liquidity_swept: flag("liquidity_swept"),
    liquidity_target: price("liquidity_target"),
    m5_mss_already_observed: flag("m5_mss_already_observed"),
    m5_mss_at_ms: stamp("m5_mss_at_ms"),
    htf_bias: htfBias,
    conviction,
    expected_displacement_tf: text("expected_displacement_tf", 12),
    note: text("note", 300),
    analysis_at_ms: analysisAtMs,
    registered_at_ms: nowMs,
  };

  // A claim that contradicts the setup it is attached to is recorded, not
  // acted on: the context changes no decision, so there is nothing to
  // withhold. It is worth flagging because it usually means the analysis
  // and the order disagree about which way this trade goes.
  context.direction_conflict =
    direction !== null && context.htf_bias !== null && context.htf_bias !== direction;
  if (context.direction_conflict) {
    warnings.push(`htf_bias=${context.htf_bias} disagrees with a ${direction} setup`);
  }
  context.warnings = warnings;
  return context;
}

/** How old the skill's analysis is, in milliseconds. */
export function skillContextAgeMs(context, nowMs = Date.now()) {
  if (!context) return null;
  const base = finiteNumber(context.analysis_at_ms) ?? finiteNumber(context.registered_at_ms);
  if (base === null) return null;
  return Math.max(0, nowMs - base);
}

/**
 * Where price actually went after the touch, in units of the setup's own
 * risk — the one thing the skill could not know when it wrote its
 * context, and therefore the thing that decides whether that context is
 * still worth anything.
 *
 *   FAILED           price is halfway to the risk line with nothing proven
 *   STALE            the freshness window closed and price never left the zone
 *   STRONG_MOVE      price is already delivering toward the objective
 *   FAVORABLE_EARLY  price has taken the first step in the right direction
 *   WITHIN_ZONE      nothing decisive has happened yet
 */
export function forwardValidationState(
  watch,
  {
    mid,
    zone = null,
    nowMs = Date.now(),
    touchedAtMs = null,
    contextAgeMs = null,
    maxAgeMs = SKILL_CONTEXT_LIMITS.defaultMaxAgeMs,
    thresholds = FORWARD_VALIDATION_THRESHOLDS,
  },
) {
  const price = finiteNumber(mid);
  // Progress is reported in R, and an R is entry-to-stop.
  const risk = Math.abs(watch.entry - watch.sl);
  if (price === null || !(risk > 0)) {
    return { state: "WITHIN_ZONE", progressR: null, detail: "price or risk distance unavailable" };
  }
  const progressR =
    (watch.direction === "buy" ? price - watch.entry : watch.entry - price) / risk;
  const sinceTouchMs = Number.isFinite(touchedAtMs) ? Math.max(0, nowMs - touchedAtMs) : null;
  const ageMs = Number.isFinite(contextAgeMs) ? contextAgeMs : null;
  const expired =
    (sinceTouchMs !== null && sinceTouchMs > maxAgeMs) || (ageMs !== null && ageMs > maxAgeMs);

  if (progressR <= -thresholds.adverseR) {
    return {
      state: "FAILED",
      progressR,
      sinceTouchMs,
      detail: `price is ${Math.abs(progressR).toFixed(2)}R against the setup with nothing confirmed`,
    };
  }
  if (progressR >= thresholds.strongR) {
    return {
      state: "STRONG_MOVE",
      progressR,
      sinceTouchMs,
      detail: `price is ${progressR.toFixed(2)}R in favour since the touch`,
    };
  }
  if (progressR >= thresholds.favorableR) {
    return {
      state: "FAVORABLE_EARLY",
      progressR,
      sinceTouchMs,
      detail: `price is ${progressR.toFixed(2)}R in favour since the touch`,
    };
  }
  if (expired) {
    return {
      state: "STALE",
      progressR,
      sinceTouchMs,
      detail: `the skill's ${Math.round(maxAgeMs / 1000)}s freshness window closed with price still at ${progressR.toFixed(2)}R`,
    };
  }
  const inside =
    zone && Number.isFinite(zone.low) && Number.isFinite(zone.high)
      ? price >= zone.low && price <= zone.high
      : null;
  return {
    state: "WITHIN_ZONE",
    progressR,
    sinceTouchMs,
    detail: inside === false ? "price has left the zone but moved nowhere decisive" : "price is still in the entry zone",
  };
}

/**
 * The `m1_continuation` defence profile's obligation. It is the M5
 * sequence's obligation on a faster clock, not a smaller one: a
 * market-structure shift and a displacement, both carried by bars that
 * closed *after* the touch. An analyst who has already read the M5 shift
 * may declare this profile and prove continuation on M1 — declaring it
 * does not buy the right to skip proving it.
 */
export function verifyM1Continuation(
  bars,
  direction,
  touchedAtMs,
  {
    strength = 2,
    displacementMultiple = 1.8,
    displacementLookback = 10,
    minBarsAfterTouch = 2,
  } = {},
) {
  if (!Array.isArray(bars) || bars.length < 2 * strength + 3) {
    return { ok: false, barsAfterTouch: 0, reason: "insufficient M1 history" };
  }
  const barsAfterTouch = bars.filter((bar) =>
    barClosedAfter(bar, PERIOD_MS.M1, touchedAtMs),
  ).length;
  if (barsAfterTouch < minBarsAfterTouch) {
    return {
      ok: false,
      barsAfterTouch,
      reason: `only ${barsAfterTouch} closed M1 bar(s) since the touch, ${minBarsAfterTouch} required`,
    };
  }
  const mss = checkMSS(bars, direction, PERIOD_MS.M1, touchedAtMs, { strength });
  const displacement = barClosedAfter(bars.at(-1), PERIOD_MS.M1, touchedAtMs)
    ? displacementCheck(bars, direction, displacementMultiple, displacementLookback)
    : { present: false, body: null, threshold: null };
  const ok = mss.present === true && displacement.present === true;
  return {
    ok,
    barsAfterTouch,
    mss: {
      present: mss.present === true,
      level: mss.level ?? null,
      close: mss.close ?? null,
      reason: mss.reason ?? null,
    },
    displacement: {
      present: displacement.present === true,
      body: displacement.body ?? null,
      threshold: displacement.threshold ?? null,
    },
    reason: ok
      ? "M1 structure shift and displacement both printed after the touch"
      : mss.present !== true
        ? "no M1 structure shift since the touch"
        : "no M1 displacement since the touch",
  };
}

/**
 * The record that closes the loop: what the skill claimed, what the
 * monitor did with the claim, and what the market then did about it.
 *
 * This is the only way the conviction scale can ever be calibrated. A
 * skill that says HIGH on setups that go on to fail is miscalibrated
 * upward; one that says LOW on setups that confirm cleanly is leaving
 * trades on the table. Neither is visible without writing the claim and
 * the outcome into the same record, at the moment the watch resolves.
 */
export function skillContextAudit(watch, status, { nowMs = Date.now() } = {}) {
  const context = watch?.skill_context;
  if (!context) return null;
  const confirmed = status === "CONFIRMED" || status === "EXECUTED";
  const outcome = String(status || "UNRESOLVED").toLowerCase();
  const touchedAtMs = finiteNumber(watch.entryTouchedAtMs);
  const confirmedAtMs = finiteNumber(watch.confirmedAtMs);
  return {
    verdict: `skill_said_${context.conviction}_${confirmed ? "and" : "but"}_${outcome}`,
    conviction: context.conviction,
    outcome: status,
    claimed: {
      htf_mss_confirmed: context.htf_mss_confirmed,
      htf_bias: context.htf_bias,
      trap_phase: context.trap_phase,
      liquidity_swept: context.liquidity_swept,
      m5_mss_already_observed: context.m5_mss_already_observed,
      direction_conflict: context.direction_conflict,
      warnings: context.warnings?.length ? context.warnings : null,
    },
    observed: {
      defence_profile: watch.defenceState?.profile ?? watch.defence_profile ?? null,
      sequence_complete: watch.sequence?.complete === true,
      touch_to_confirm_ms:
        touchedAtMs !== null && confirmedAtMs !== null ? confirmedAtMs - touchedAtMs : null,
      context_age_ms: skillContextAgeMs(context, nowMs),
    },
  };
}

const AUDIT_OUTCOMES = Object.freeze(["CONFIRMED", "EXECUTED", "FAILED", "EXPIRED", "CANCELLED"]);

function emptyBucket() {
  const bucket = { total: 0, other: 0 };
  for (const outcome of AUDIT_OUTCOMES) bucket[outcome.toLowerCase()] = 0;
  return bucket;
}

function countInto(table, key, status) {
  if (!key) return;
  const bucket = (table[key] ??= emptyBucket());
  bucket.total += 1;
  const name = String(status || "").toUpperCase();
  if (AUDIT_OUTCOMES.includes(name)) bucket[name.toLowerCase()] += 1;
  else bucket.other += 1;
}

/**
 * Aggregate audits into the two questions worth asking of them: does
 * conviction predict outcome, and does the fast lane produce worse
 * trades than the full sequence?
 */
export function summariseSkillContextAudits(audits) {
  const list = (Array.isArray(audits) ? audits : []).filter(Boolean);
  const byConviction = {};
  const byProfile = {};
  let confirmSum = 0;
  let confirmCount = 0;
  for (const audit of list) {
    countInto(byConviction, audit.conviction, audit.outcome);
    countInto(byProfile, audit.observed?.defence_profile || "standard", audit.outcome);
    const elapsed = finiteNumber(audit.observed?.touch_to_confirm_ms);
    if (elapsed !== null) {
      confirmSum += elapsed;
      confirmCount += 1;
    }
  }
  return {
    total: list.length,
    by_conviction: byConviction,
    by_defence_profile: byProfile,
    mean_touch_to_confirm_ms: confirmCount ? Math.round(confirmSum / confirmCount) : null,
    note:
      "HIGH conviction that keeps resolving FAILED is a miscalibrated scale, not a monitor bug. " +
      "LOW conviction that keeps resolving CONFIRMED is a conservative one. by_defence_profile " +
      "compares what each declared defence actually produced. Confirmation itself is the same " +
      "for every setup: nothing in a context changes it.",
  };
}

// ---------------------------------------------------------------------------
// §12 Order sizing
//
// Volume is the one number in this service that is not derived from the
// feed, cannot be falsified against it, and is unrecoverable once wrong.
// So it is computed from an explicit contract specification, refused
// outright when any term of that specification is unknown, and reported
// with the arithmetic that produced it.

export const CONTRACT_SIZES = Object.freeze({
  XAUUSD: 100,
  XAGUSD: 5000,
  BTCUSD: 1,
  ETHUSD: 1,
  US30: 1,
  US500: 1,
  USTEC: 1,
  NAS100: 1,
  SPX500: 1,
});

export function contractSizeFor(symbol, overrides = {}) {
  const key = String(symbol || "").toUpperCase();
  const override = finiteNumber(overrides[key]);
  if (override !== null && override > 0) return override;
  if (CONTRACT_SIZES[key]) return CONTRACT_SIZES[key];
  if (INDEX_SYMBOLS.has(key)) return 1;
  const [, quote] = symbolCurrencies(key);
  // A pair whose currencies both resolve is a standard 100k-unit FX lot.
  return quote && key.length === 6 ? 100_000 : null;
}

export function roundToStep(value, step) {
  if (!(step > 0)) return value;
  const steps = Math.floor(Number((value / step).toFixed(8)));
  return Number((steps * step).toFixed(8));
}

/**
 * Lots for this trade. `mode: "fixed"` returns the configured size
 * unchanged; `mode: "risk"` derives it from the account balance and the
 * distance to the stop, and refuses rather than guessing whenever the
 * conversion from price distance to account currency is not known to be
 * one-to-one.
 */
export function computeOrderVolume({
  mode = "fixed",
  fixedVolume = null,
  explicitVolume = null,
  balance = null,
  riskPercent = null,
  entry,
  stop,
  symbol,
  accountCurrency = "USD",
  contractSizes = {},
  minVolume = 0.01,
  maxVolume = null,
  volumeStep = 0.01,
}) {
  if (explicitVolume !== null && explicitVolume !== undefined) {
    const rounded = roundToStep(explicitVolume, volumeStep);
    if (!(rounded >= minVolume)) {
      return { volume: null, reason: `requested volume ${explicitVolume} is below the minimum ${minVolume}` };
    }
    if (maxVolume !== null && rounded > maxVolume) {
      return { volume: null, reason: `requested volume ${rounded} exceeds the cap ${maxVolume}` };
    }
    return { volume: rounded, basis: "explicit", riskAmount: null };
  }

  if (mode === "fixed") {
    const size = finiteNumber(fixedVolume);
    if (size === null || size <= 0) {
      return { volume: null, reason: "AUTO_TRADE_FIXED_VOLUME is not configured" };
    }
    const rounded = roundToStep(size, volumeStep);
    if (!(rounded >= minVolume)) {
      return { volume: null, reason: `fixed volume ${size} is below the minimum ${minVolume}` };
    }
    if (maxVolume !== null && rounded > maxVolume) {
      return { volume: null, reason: `fixed volume ${rounded} exceeds the cap ${maxVolume}` };
    }
    return { volume: rounded, basis: "fixed", riskAmount: null };
  }

  const stopDistance = Math.abs(finiteNumber(entry) - finiteNumber(stop));
  if (!(stopDistance > 0)) return { volume: null, reason: "entry and stop are the same price" };
  const equity = finiteNumber(balance);
  if (equity === null || equity <= 0) {
    return { volume: null, reason: "account balance is unknown; risk-based sizing cannot be computed" };
  }
  const percent = finiteNumber(riskPercent);
  if (percent === null || percent <= 0) return { volume: null, reason: "risk percent is not configured" };

  const contractSize = contractSizeFor(symbol, contractSizes);
  if (contractSize === null) {
    return { volume: null, reason: `contract size for ${symbol} is unknown; set CONTRACT_SIZE_${symbol}` };
  }
  const [, quote] = symbolCurrencies(symbol);
  const account = String(accountCurrency || "").toUpperCase();
  if (quote && account && quote !== account) {
    // Converting a quote-currency risk into account currency needs a
    // live FX rate this service does not have. Guessing it mis-sizes
    // every trade in the same direction, so it refuses instead.
    return {
      volume: null,
      reason: `${symbol} is quoted in ${quote} but the account is ${account}; risk sizing needs a conversion rate this monitor does not have`,
    };
  }

  const riskAmount = equity * (percent / 100);
  const riskPerLot = stopDistance * contractSize;
  if (!(riskPerLot > 0)) return { volume: null, reason: "risk per lot computed as zero" };
  const raw = riskAmount / riskPerLot;
  const rounded = roundToStep(raw, volumeStep);
  if (!(rounded >= minVolume)) {
    return {
      volume: null,
      reason: `risk-based size ${raw.toFixed(4)} lots is below the minimum ${minVolume}; the stop is too wide for this balance`,
    };
  }
  const capped = maxVolume !== null ? Math.min(rounded, maxVolume) : rounded;
  return {
    volume: capped,
    basis: "risk",
    riskAmount,
    riskPerLot,
    stopDistance,
    contractSize,
    cappedByMax: maxVolume !== null && rounded > maxVolume,
  };
}

/** Lots → whatever unit the connector's order tool actually counts in. */
export function volumeInConnectorUnits(lots, symbol, unit, contractSizes = {}) {
  if (unit === "lots") return lots;
  const contractSize = contractSizeFor(symbol, contractSizes);
  if (contractSize === null) return null;
  if (unit === "units") return Math.round(lots * contractSize);
  if (unit === "centi_units") return Math.round(lots * contractSize * 100);
  return null;
}

// ---------------------------------------------------------------------------
// §13 Pre-submission checks
//
// The list from the execution spec, as one total function over facts the
// caller has already gathered. Every unknown counts as a failure: this
// is the last gate before real money moves, and "I could not check"
// must never read the same as "I checked and it was fine".

export function preflightExecution(input) {
  const failures = [];
  const fail = (code, detail, retryable = false) => failures.push({ code, detail, retryable });

  const watch = input.watch || {};
  if (!input.symbol || String(input.symbol).toUpperCase() !== String(watch.symbol).toUpperCase()) {
    fail("SYMBOL_MISMATCH", `order symbol ${input.symbol} does not match the watch symbol ${watch.symbol}`);
  }
  if (!["buy", "sell"].includes(input.direction) || input.direction !== watch.direction) {
    fail("DIRECTION_MISMATCH", `order direction ${input.direction} does not match the watch direction ${watch.direction}`);
  }
  if (input.symbolId === null || input.symbolId === undefined) {
    fail("SYMBOL_ID_UNKNOWN", "the broker symbol id could not be resolved", true);
  }

  const price = finiteNumber(input.price);
  if (price === null || price <= 0) {
    fail("PRICE_UNUSABLE", "no usable live price at submission time", true);
  }
  const priceAgeMs = finiteNumber(input.priceAgeMs);
  if (priceAgeMs === null) {
    fail("PRICE_AGE_UNKNOWN", "the age of the quote is unknown", true);
  } else if (priceAgeMs > (input.maxPriceAgeMs ?? 15_000)) {
    fail("PRICE_STALE", `quote is ${Math.round(priceAgeMs / 1000)}s old`, true);
  }

  const confirmationPrice = finiteNumber(input.confirmationPrice);
  const maxDeviation = finiteNumber(input.maxDeviation);
  if (price !== null && confirmationPrice !== null && maxDeviation !== null) {
    // Between the confirmation and the submission the market keeps
    // moving. Beyond a configured distance the trade being entered is no
    // longer the trade that was confirmed.
    const drift = Math.abs(price - confirmationPrice);
    if (drift > maxDeviation) {
      fail(
        "PRICE_MOVED",
        `price moved ${formatLevel(drift)} from the confirmation price ${formatLevel(confirmationPrice)}; the cap is ${formatLevel(maxDeviation)}`,
      );
    }
  }

  const sl = finiteNumber(input.sl);
  if (sl === null || sl <= 0) {
    fail("SL_MISSING", "the order has no usable stop loss");
  } else if (price !== null) {
    const wrongSide = input.direction === "buy" ? sl >= price : sl <= price;
    if (wrongSide) {
      fail("SL_WRONG_SIDE", `stop ${formatLevel(sl)} is on the wrong side of price ${formatLevel(price)}`);
    }
  }
  const tp = finiteNumber(input.tp);
  if (tp !== null && price !== null) {
    const wrongSide = input.direction === "buy" ? tp <= price : tp >= price;
    if (wrongSide) {
      fail("TP_REACHED", `target ${formatLevel(tp)} is already through price ${formatLevel(price)}`);
    }
  }

  const volume = finiteNumber(input.volume);
  if (volume === null || volume <= 0) {
    fail("VOLUME_INVALID", input.volumeReason || "position size could not be computed");
  }
  const connectorVolume = finiteNumber(input.connectorVolume);
  if (connectorVolume === null || connectorVolume <= 0) {
    fail("VOLUME_UNIT_UNKNOWN", "the volume could not be expressed in the connector's units");
  }

  const riskAmount = finiteNumber(input.riskAmount);
  const balance = finiteNumber(input.balance);
  if (riskAmount !== null && balance !== null && input.maxRiskPercent) {
    const cap = balance * (input.maxRiskPercent / 100);
    if (riskAmount > cap + 1e-9) {
      fail("RISK_EXCEEDS_CAP", `risk ${riskAmount.toFixed(2)} exceeds the ${input.maxRiskPercent}% cap of ${cap.toFixed(2)}`);
    }
  }

  if (!input.positionsKnown) {
    fail("POSITIONS_UNKNOWN", "open positions could not be read; a duplicate entry cannot be ruled out", true);
  } else if (input.existingPosition) {
    fail("POSITION_EXISTS", `an open position already exists for ${input.symbol} (${input.existingPosition})`);
  }
  if (input.openPositionCount !== undefined && input.maxOpenPositions !== undefined && input.openPositionCount >= input.maxOpenPositions) {
    fail("MAX_POSITIONS", `already holding ${input.openPositionCount} of a maximum ${input.maxOpenPositions} positions`);
  }
  if (input.tradesToday !== undefined && input.maxTradesPerDay !== undefined && input.tradesToday >= input.maxTradesPerDay) {
    fail("DAILY_LIMIT", `already executed ${input.tradesToday} of a maximum ${input.maxTradesPerDay} trades today`);
  }

  if (watch.lifecycle === "RESOLVED" || watch.status === "FAILED" || watch.status === "EXPIRED") {
    fail("WATCH_NOT_LIVE", `the watch is ${watch.status || watch.lifecycle}`);
  }
  if (input.alreadySubmitted) {
    fail("ALREADY_SUBMITTED", "an order for this watch has already been submitted");
  }

  const touchedAtMs = finiteNumber(input.touchedAtMs);
  const confirmedAtMs = finiteNumber(input.confirmedAtMs);
  if (touchedAtMs === null || confirmedAtMs === null) {
    fail("SEQUENCE_TIMING_UNKNOWN", "the touch or confirmation time is not recorded");
  } else if (confirmedAtMs < touchedAtMs) {
    fail("CONFIRMATION_BEFORE_TOUCH", "the confirmation predates the entry touch");
  }
  if (!input.sequenceComplete) {
    fail("SEQUENCE_INCOMPLETE", "rejection, structure shift and displacement are not all recorded");
  }
  if (!input.liveData) {
    fail("NOT_LIVE_DATA", "the confirmation is not backed by live market data", true);
  }

  return {
    ok: failures.length === 0,
    failures,
    retryable: failures.length > 0 && failures.every((failure) => failure.retryable),
  };
}

// ---------------------------------------------------------------------------
// §14 Setup lifecycle — validity, opportunity, time
//
// §5 of the lifecycle spec names four things that must never be mixed:
// setup validity (is the thesis still true?), entry opportunity (is the
// price still enterable?), entry confirmation (has the market defended
// the setup?) and trade outcome (what happened after ENTER NOW). The
// engine kept all four in one boolean. Each function below answers
// exactly one of them, and none of them can answer another's question.

export const SETUP_STATES = Object.freeze([
  "REGISTERED_WATCH",
  "WAITING_FOR_SETUP_CONFIRMATION",
  "READY_FOR_ENTRY",
  "ENTRY_TOUCHED",
  "REJECTION_DETECTED",
  "M5_MSS_CONFIRMED",
  "M1_CONTINUATION_CONFIRMED",
  "DISPLACEMENT_CONFIRMED",
  "ANTI_SL_EVALUATION",
  "ENTRY_CONFIRMED",
  "ORDER_SUBMITTED",
  "EXECUTED",
  "ACTIVE_TRADE",
  "ENTRY_MISSED",
  "REANALYSIS_REQUIRED",
  "INVALIDATED",
  "EXPIRED",
]);

export const URGENCIES = Object.freeze(["LOW", "NORMAL", "HIGH", "CRITICAL"]);

/**
 * Urgency buys time, never proof. It scales the *hold* — how long
 * evidence must persist before it counts — and touches nothing else: not
 * the required defence, not a gate, not a hard blocker. §24 is explicit
 * that a fast market with no defence still waits, and a fast market with
 * a hard invalidation still refuses.
 */
export const URGENCY_HOLD_MULTIPLIER = Object.freeze({
  LOW: 1.5,
  NORMAL: 1,
  HIGH: 0.5,
  CRITICAL: 0.25,
});

export function urgencyHoldMs(urgency, baseHoldMs, floorMs = SKILL_CONTEXT_LIMITS.holdFloorMs) {
  const base = finiteNumber(baseHoldMs) ?? 60_000;
  const floor = finiteNumber(floorMs) ?? SKILL_CONTEXT_LIMITS.holdFloorMs;
  const multiplier = URGENCY_HOLD_MULTIPLIER[String(urgency || "NORMAL").toUpperCase()] ?? 1;
  return Math.max(floor, Math.round(base * multiplier));
}

/**
 * Which live proof this setup requires. §22: confirmation is
 * setup-specific, and §26: the post-touch M5 structure shift stays only
 * where it brings information the analysis did not already have.
 *
 *   standard               rejection → M5 structure shift → displacement.
 *                          The default, and the only profile for a setup
 *                          whose LTF structure the analyst has not
 *                          already read.
 *   m1_continuation        rejection → M1 structure shift → M1
 *                          displacement. The same three-step obligation
 *                          on a faster clock, for a setup whose M5/HTF
 *                          shift the analyst already established. It is
 *                          refused outright once price has moved against
 *                          the setup.
 *   rejection_displacement rejection → displacement, no structure shift,
 *                          for setups whose thesis is a reaction from a
 *                          declared array rather than a structural break.
 *
 * The profile is declared by the analyst. The monitor never picks one:
 * guessing which proof a setup needs is the thing §27 forbids.
 */
export const DEFENCE_PROFILES = Object.freeze([
  "standard",
  "m1_continuation",
  "rejection_displacement",
]);

export function defenceSatisfied(profile, { sequence = {}, m1Continuation = null, forwardState = null } = {}) {
  const name = DEFENCE_PROFILES.includes(profile) ? profile : "standard";
  if (!sequence.rejection) {
    return { satisfied: false, profile: name, missing: "zone rejection", reason: "awaiting_zone_rejection" };
  }
  if (name === "rejection_displacement") {
    return sequence.displacement
      ? { satisfied: true, profile: name, missing: null, reason: "rejection_and_displacement" }
      : { satisfied: false, profile: name, missing: "displacement", reason: "awaiting_displacement" };
  }
  if (name === "m1_continuation") {
    // The fast profile is a faster clock, not a weaker one — and price
    // moving against the setup withdraws it, exactly as it withdraws the
    // declared M1 defence profile.
    if (forwardState === "FAILED") {
      return {
        satisfied: false,
        profile: name,
        missing: "M1 continuation (withdrawn: price moved against the setup)",
        reason: "m1_profile_withdrawn",
      };
    }
    return m1Continuation?.ok === true
      ? { satisfied: true, profile: name, missing: null, reason: "m1_continuation" }
      : {
          satisfied: false,
          profile: name,
          missing: m1Continuation?.reason || "M1 continuation",
          reason: "awaiting_m1_continuation",
        };
  }
  if (!sequence.mss) {
    return { satisfied: false, profile: name, missing: "M5 structure shift", reason: "awaiting_m5_structure_shift" };
  }
  if (!sequence.displacement) {
    return { satisfied: false, profile: name, missing: "displacement", reason: "awaiting_displacement" };
  }
  return { satisfied: true, profile: name, missing: null, reason: "m5_sequence_complete" };
}

/**
 * Entry opportunity — question B of §5, and the only question this
 * function answers. The thesis may be perfectly intact and the entry
 * still gone: price ran, and taking it here would be a different trade
 * with a different risk profile wearing the original trade's name.
 *
 * The cap is derived from the setup's own context rather than a fixed
 * number of points: the volatility it is being traded in, and the risk it
 * was sized against. An analyst-declared `max_entry_deviation` replaces
 * the derivation — it is their setup — but never past half the risk
 * distance, because beyond that the R:R the setup was accepted on no
 * longer exists.
 */
export function evaluateEntryOpportunity(
  watch,
  {
    mid,
    atr = null,
    tolerance = 0,
    maxEntryDeviation = null,
    atrFraction = 0.75,
    riskFraction = 0.3,
    minRemainingRR = 0.5,
    // Which target the remaining-R:R floor is measured against. Some
    // analysts' entry style is to fill instantly on the real-confirmation
    // candle rather than wait for a retrace, and their stated target for
    // that setup is TP2 (the DOL), not TP1 (an interim level). Measuring
    // the floor against TP1 for that style produces false ENTRY_MISSED
    // calls on setups that are, by the analyst's own target, still very
    // much alive. "tp2" falls back to tp1 if the watch has no tp2 set.
    rrTarget = "tp1",
    // Whether drift from the planned entry is itself disqualifying.
    // Off by default: the evidence engine (acceptance + a graduated
    // technical signal, §7) already discards a fake move on its own —
    // a signal fades and resets the moment price trades back against
    // it, which is what durability under observation means. A move
    // that survives that observation has proven itself precisely by
    // not reversing, and by then it is often well beyond the zone that
    // first drew attention to it. Capping distance on top of that
    // fights the same mechanism that already filters it, and it stood
    // down real, working entries that a distance-blind read would have
    // taken. RISK_INVERTED and RR_COLLAPSED stay on regardless — they
    // are not about how far price ran, they are about whether there is
    // still a trade left to take.
    enforceCap = true,
  } = {},
) {
  const price = finiteNumber(mid);
  if (price === null) {
    return { actionable: false, reason: "PRICE_UNUSABLE", detail: "no usable price to measure the entry against" };
  }
  const isBuy = watch.direction === "buy";
  const risk = Math.abs(watch.entry - watch.sl);
  const floor = Math.max(finiteNumber(tolerance) ?? 0, 0);
  const atrValue = finiteNumber(atr);
  const declared = finiteNumber(maxEntryDeviation);

  let cap;
  if (declared !== null && declared > 0) {
    cap = risk > 0 ? Math.min(Math.max(declared, floor), risk * 0.5) : Math.max(declared, floor);
  } else {
    const volatility = atrValue !== null && atrValue > 0 ? atrValue * atrFraction : floor;
    cap = risk > 0 ? Math.min(Math.max(floor, volatility), risk * riskFraction) : Math.max(floor, volatility);
  }

  // Only drift that makes the fill *worse* counts. A buy filling below
  // its planned entry is a better trade, not a missed one.
  const chase = isBuy ? price - watch.entry : watch.entry - price;
  const targetTp2 = finiteNumber(watch.tp2);
  const rewardTarget = rrTarget === "tp2" && targetTp2 !== null ? targetTp2 : watch.tp1;
  const remainingReward = isBuy ? rewardTarget - price : price - rewardTarget;
  const remainingRisk = isBuy ? price - watch.sl : watch.sl - price;
  const remainingRR = remainingRisk > 0 ? remainingReward / remainingRisk : null;

  const shape = {
    chase,
    cap,
    remainingRR,
    remainingReward,
    remainingRisk,
  };

  if (enforceCap && chase > cap) {
    return {
      ...shape,
      actionable: false,
      reason: "ENTRY_ESCAPED",
      detail: `price is ${formatLevel(chase)} beyond the planned entry; the context-aware cap is ${formatLevel(cap)}`,
    };
  }
  if (remainingRisk <= 0) {
    return {
      ...shape,
      actionable: false,
      reason: "RISK_INVERTED",
      detail: "price is already at or through the stop; there is no trade left to enter",
    };
  }
  if (remainingRR !== null && remainingRR < minRemainingRR) {
    const targetLabel = rrTarget === "tp2" && targetTp2 !== null ? "TP2" : "TP1";
    return {
      ...shape,
      actionable: false,
      reason: "RR_COLLAPSED",
      detail: `only ${remainingRR.toFixed(2)}R remains to ${targetLabel} from here; ${minRemainingRR}R is the floor`,
    };
  }
  return { ...shape, actionable: true, reason: "ACTIONABLE", detail: null };
}

/**
 * Time — question C. A confirmation that arrives outside the window the
 * setup was written for is not a late confirmation, it is a confirmation
 * of something else (§20). The inverse matters just as much (§21): inside
 * the window there is no waiting for a round number, a next candle or a
 * next minute. The gate is a boundary, never a delay.
 */
/**
 * Three clocks, and they bound three different things. Collapsing them
 * is how a setup that was still perfectly alive gets killed by the wrong
 * one:
 *
 *   entry_monitoring_window   how long to wait for price to reach the zone
 *   confirmation_deadline     how long confirmation may take ONCE it has
 *   expiration                when the setup is over regardless
 *
 * The confirmation deadline is measured from the touch, because that is
 * when there is a confirmation to bound. Running it from registration
 * makes it a second, shorter entry window wearing the wrong name — and
 * one that silently overrides the entry window the analyst declared.
 */
export function confirmationDeadlineFor(watch) {
  const minutes = finiteNumber(watch.confirmation_deadline_minutes);
  const touchedAtMs = finiteNumber(watch.entryTouchedAtMs);
  if (minutes === null || touchedAtMs === null) return null;
  return touchedAtMs + minutes * 60_000;
}

export function evaluateTimeWindow(
  watch,
  {
    nowMs = Date.now(),
    killZoneActive = null,
    killZoneEnabled = true,
    entryTouched = watch.entryTouched === true,
    // Whether a declared confirmation deadline may kill the setup.
    //
    // The deadline is always computed and reported — it is the analyst's
    // own statement about when the read goes stale, and worth recording.
    // Enforcing it is separate, because confirmation legitimately arrives
    // later than the analysis guessed: the evidence machine waits for
    // proof that persists, and a level can take longer than a declared
    // twenty minutes to deliver it. `expiration_minutes` still bounds the
    // setup's life either way, so nothing runs forever on this account.
    enforceConfirmationDeadline = true,
  } = {},
) {
  const expiry = finiteNumber(watch.expiresAt);
  const deadline = confirmationDeadlineFor(watch);
  if (expiry !== null && nowMs >= expiry) {
    return { state: "EXPIRED", detail: "the setup's expiry has passed", deadline, expiry };
  }

  if (!entryTouched) {
    // Nothing has been confirmed because nothing has been touched. What
    // bounds the wait here is the entry window, not the confirmation one.
    const window = finiteNumber(watch.entryMonitoringUntil);
    if (window !== null && nowMs >= window) {
      return {
        state: "ENTRY_WINDOW_CLOSED",
        detail: `the entry zone went unvisited for the whole ${Math.round((window - (finiteNumber(watch.armedAtMs) ?? window)) / 60_000)} minute entry window`,
        deadline,
        expiry,
      };
    }
    return { state: "OPEN", detail: null, deadline, expiry };
  }

  if (enforceConfirmationDeadline && deadline !== null && nowMs >= deadline) {
    return {
      state: "DEADLINE_PASSED",
      detail: `confirmation did not complete within ${Math.round((deadline - finiteNumber(watch.entryTouchedAtMs)) / 60_000)} minutes of the touch`,
      deadline,
      expiry,
    };
  }
  if (killZoneEnabled && killZoneActive === false) {
    return { state: "OUTSIDE_WINDOW", detail: "outside the allowed session window", deadline, expiry };
  }
  return { state: "OPEN", detail: null, deadline, expiry };
}

// ---------------------------------------------------------------------------
// §15 Anti-SL-Hunter defence
//
// This is a conditional branch, not a stage. Nothing here runs on a
// setup that never went near its stop, and nothing here is waited for
// before a normal entry: §10 — "do not wait for a problem that has not
// happened". It exists for one situation only, and it starts when that
// situation actually starts.
//
// What it must not become is either of the two lazy readings:
//
//   "price wicked the stop, XAUUSD hunts stops, therefore ignore it"
//   "price touched the stop, therefore the setup is dead"
//
// Both replace evidence with a prior. So the excursion is measured —
// depth against volatility, duration, speed, whether price came back,
// and above all whether any *closed body* accepted price beyond the line
// — and the verdict is whatever that evidence supports, including
// "cannot tell", which is a real answer here and resolves to a fresh
// analysis rather than to a guess.

export const ANTI_SL_OUTCOMES = Object.freeze(["PENDING", "SURVIVES", "UNCERTAIN", "INVALIDATED"]);

export const ANTI_SL_DEFAULTS = Object.freeze({
  // Depth at which an excursion stops being a wick through a level and
  // becomes a move away from it. Measured in ATR because the same number
  // of dollars means different things in different volatility regimes,
  // which is the whole of §14's "volatility" evidence.
  wickDepthAtr: 0.5,
  maxDepthAtr: 1,
  // The same two bounds as a fraction of the setup's own risk, used when
  // ATR cannot be read. Without either, the excursion is unclassifiable
  // and the answer is UNCERTAIN — never SURVIVES.
  wickDepthRisk: 0.15,
  maxDepthRisk: 0.35,
  // How long price may sit beyond the line. A stop run is fast; price
  // that settles beyond the level is not running, it is trading there.
  wickDurationMs: PERIOD_MS.M5,
  maxDurationMs: PERIOD_MS.M15,
  // A reclaim has to hold for a closed bar. Price flickering back across
  // the line for one tick is the excursion continuing, not ending.
  reclaimHoldMs: PERIOD_MS.M1,
  // Speed at which a deeper excursion is still credible as a sweep. This
  // is the only place depth tolerance is widened, and it is widened by
  // evidence (how violently price went and came back), never by the
  // instrument's reputation.
  fastAtrPerMinute: 1,
  // How long the branch may stay undecided before it stops being a
  // decision and becomes a stall. Past this the setup goes back to the
  // analyst rather than sitting in limbo.
  maxEvaluationMs: 2 * PERIOD_MS.M15,
});

export function emptyExcursion() {
  return {
    active: false,
    count: 0,
    startedAtMs: null,
    startPrice: null,
    maxDepth: 0,
    maxDepthPrice: null,
    beyondSinceMs: null,
    beyondMs: 0,
    lastBeyondAtMs: null,
    reclaimedAtMs: null,
    reclaimPrice: null,
    reclaimHeldMs: 0,
    outcome: "PENDING",
    detail: null,
    resolvedAtMs: null,
  };
}

/**
 * Fold one tick into the excursion record. Duration is accumulated from
 * observed samples rather than from `now - start`, so a monitoring gap
 * (a restart, a degraded feed) cannot be counted as time price spent
 * beyond the line — an unobserved minute is not evidence of anything.
 */
export function advanceSlExcursion(current, { beyond, price, depth, nowMs }) {
  const state = current && current.startedAtMs !== null ? { ...current } : emptyExcursion();
  const observed = finiteNumber(price);
  const measured = Math.max(0, finiteNumber(depth) ?? 0);

  if (beyond) {
    if (!state.active) {
      // A new excursion is a new event and is measured from scratch. The
      // depth, duration and reclaim of a previous visit to this level
      // describe a different move; carrying them forward would let an
      // earlier sweep's numbers classify a later breakdown, or the other
      // way round. Only the count survives.
      const count = (state.count || 0) + 1;
      Object.assign(state, emptyExcursion(), {
        active: true,
        count,
        startedAtMs: nowMs,
        startPrice: observed,
        beyondSinceMs: nowMs,
        outcome: "PENDING",
      });
    } else if (Number.isFinite(state.lastBeyondAtMs)) {
      state.beyondMs = (state.beyondMs || 0) + Math.max(0, nowMs - state.lastBeyondAtMs);
    }
    state.lastBeyondAtMs = nowMs;
    if (measured > (state.maxDepth || 0)) {
      state.maxDepth = measured;
      state.maxDepthPrice = observed;
    }
    return state;
  }

  if (state.active) {
    state.active = false;
    state.reclaimedAtMs = nowMs;
    state.reclaimPrice = observed;
    state.reclaimHeldMs = 0;
    return state;
  }
  if (state.reclaimedAtMs !== null) {
    state.reclaimHeldMs = Math.max(0, nowMs - state.reclaimedAtMs);
  }
  return state;
}

/**
 * Classify the excursion. The caller supplies the observations; this
 * function supplies only the reasoning, so the same verdict can be
 * reproduced from a recorded excursion in a test without a market.
 *
 * `evidence.closedBodyBeyond` is deliberately three-valued. `false` is
 * "no closed bar accepted price beyond the line", which is the single
 * strongest argument that the excursion was a sweep. `null` is "the
 * candles could not be read", which argues nothing at all — and must
 * never be allowed to argue the permissive case.
 */
export function evaluateAntiSl(watch, excursion, evidence = {}, config = {}) {
  const cfg = { ...ANTI_SL_DEFAULTS, ...config };
  const reasons = [];
  const supporting = [];
  const depth = Math.max(0, finiteNumber(excursion?.maxDepth) ?? 0);
  const atr = finiteNumber(evidence.atr);
  const risk = Math.abs(watch.entry - watch.sl);
  const depthAtr = atr !== null && atr > 0 ? depth / atr : null;
  const depthRisk = risk > 0 ? depth / risk : null;
  const beyondMs = Math.max(0, finiteNumber(excursion?.beyondMs) ?? 0);
  const reclaimed = Number.isFinite(excursion?.reclaimedAtMs) && excursion.active !== true;
  const reclaimHeldMs = Math.max(0, finiteNumber(excursion?.reclaimHeldMs) ?? 0);
  const durationMinutes = beyondMs / 60_000;
  const speedAtrPerMinute =
    depthAtr !== null && durationMinutes > 0 ? depthAtr / durationMinutes : null;
  const elapsedMs = Number.isFinite(excursion?.startedAtMs) && Number.isFinite(evidence.nowMs)
    ? Math.max(0, evidence.nowMs - excursion.startedAtMs)
    : null;

  const measured = {
    depth,
    depthAtr,
    depthRisk,
    beyondMs,
    reclaimed,
    reclaimHeldMs,
    speedAtrPerMinute,
    elapsedMs,
    closedBodyBeyond: evidence.closedBodyBeyond ?? null,
    opposingStructureBreak: evidence.opposingStructureBreak ?? null,
    opposingFollowThrough: evidence.opposingFollowThrough ?? null,
    withinTimeWindow: evidence.withinTimeWindow ?? null,
  };

  // -- Supporting context (§23): reported, never decisive ------------------
  if (evidence.liquiditySwept === true) {
    supporting.push("the analysis had already recorded the liquidity pool as swept");
  }
  if (finiteNumber(evidence.liquidityTarget) !== null) {
    supporting.push(`the setup's draw on liquidity is ${formatLevel(evidence.liquidityTarget)}`);
  }
  if (speedAtrPerMinute !== null) {
    supporting.push(`excursion travelled ${speedAtrPerMinute.toFixed(2)} ATR/min`);
  }

  const verdict = (outcome, detail) => ({
    outcome,
    detail,
    reasons,
    supporting,
    measured,
    exhausted: elapsedMs !== null && elapsedMs > cfg.maxEvaluationMs,
  });

  // -- Hard invalidation ---------------------------------------------------
  if (measured.closedBodyBeyond === true) {
    reasons.push("a closed body accepted price beyond the risk boundary");
    return verdict("INVALIDATED", "the market closed beyond the level rather than visiting it");
  }
  if (measured.opposingStructureBreak === true && measured.opposingFollowThrough === true) {
    reasons.push("structure broke against the setup and opposing displacement followed it");
    return verdict("INVALIDATED", "the structure the thesis rested on is gone");
  }
  if (depthAtr !== null && depthAtr > cfg.maxDepthAtr) {
    reasons.push(`excursion of ${depthAtr.toFixed(2)} ATR beyond the stop is a move, not a sweep`);
    return verdict("INVALIDATED", "the excursion is too deep to be a liquidity grab");
  }
  if (depthAtr === null && depthRisk !== null && depthRisk > cfg.maxDepthRisk) {
    reasons.push(
      `excursion of ${(depthRisk * 100).toFixed(0)}% of the setup's risk beyond the stop, with no ATR to read it against`,
    );
    return verdict("INVALIDATED", "the excursion is too deep to be a liquidity grab");
  }
  if (beyondMs > cfg.maxDurationMs && !reclaimed) {
    reasons.push(
      `price has held beyond the level for ${Math.round(beyondMs / 1000)}s with no reclaim`,
    );
    return verdict("INVALIDATED", "price is trading beyond the level, not running through it");
  }

  // -- Survival ------------------------------------------------------------
  // Every term has to be affirmatively true. An unknown is not a pass.
  const blockers = [];
  if (measured.closedBodyBeyond !== false) {
    blockers.push("no closed bar has been read back beyond the level yet");
  }
  if (!reclaimed) blockers.push("price has not reclaimed the level");
  else if (reclaimHeldMs < cfg.reclaimHoldMs) {
    blockers.push(
      `the reclaim has held for ${Math.round(reclaimHeldMs / 1000)}s of the ${Math.round(cfg.reclaimHoldMs / 1000)}s required`,
    );
  }
  if (measured.opposingStructureBreak !== false) {
    blockers.push("opposing structure could not be ruled out");
  }
  if (measured.opposingFollowThrough !== false) {
    blockers.push("opposing follow-through could not be ruled out");
  }
  if (measured.withinTimeWindow === false) {
    blockers.push("the excursion resolved outside the setup's allowed window");
  }

  // Depth tolerance widens only for an excursion that was demonstrably
  // violent and demonstrably reversed — the shape of an actual sweep.
  const fast = speedAtrPerMinute !== null && speedAtrPerMinute >= cfg.fastAtrPerMinute;
  const depthAllowanceAtr = fast ? cfg.maxDepthAtr : cfg.wickDepthAtr;
  const depthAllowanceRisk = fast ? cfg.maxDepthRisk : cfg.wickDepthRisk;
  if (depthAtr !== null) {
    if (depthAtr > depthAllowanceAtr) {
      blockers.push(
        `excursion of ${depthAtr.toFixed(2)} ATR exceeds the ${depthAllowanceAtr} ATR a sweep is allowed`,
      );
    }
  } else if (depthRisk !== null) {
    if (depthRisk > depthAllowanceRisk) {
      blockers.push(
        `excursion of ${(depthRisk * 100).toFixed(0)}% of risk exceeds what a sweep is allowed without an ATR reading`,
      );
    }
  } else {
    blockers.push("the excursion cannot be measured against volatility or risk");
  }
  if (beyondMs > cfg.wickDurationMs) {
    blockers.push(
      `price spent ${Math.round(beyondMs / 1000)}s beyond the level, more than the ${Math.round(cfg.wickDurationMs / 1000)}s a sweep is allowed`,
    );
  }

  if (blockers.length === 0) {
    reasons.push(
      `no closed body beyond the level, ${depthAtr !== null ? `${depthAtr.toFixed(2)} ATR` : `${((depthRisk ?? 0) * 100).toFixed(0)}% of risk`} deep, ` +
        `${Math.round(beyondMs / 1000)}s beyond it, reclaimed and held`,
    );
    return verdict("SURVIVES", "the excursion has the shape of a sweep and the thesis is intact");
  }

  reasons.push(...blockers);
  const result = verdict("UNCERTAIN", "the evidence does not settle whether the thesis survived");
  if (result.exhausted) {
    result.detail = `the excursion has been unresolved for ${Math.round(elapsedMs / 60_000)} minutes`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// §16 Event trail
//
// §35: every setup carries its own ordered record of what happened to
// it, so a decision can be reconstructed after the fact from the setup
// rather than from a log file that has since rotated. Bounded, because
// it is persisted with the watch and an unbounded trail is a slow disk
// leak that only shows up on the busiest day.

export const TRAIL_LIMIT = 200;

export function appendTrail(trail, event, limit = TRAIL_LIMIT) {
  const list = Array.isArray(trail) ? trail : [];
  const next = [...list, event];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function trailEvent(watch, type, detail = null, nowMs = Date.now()) {
  const sequence = (Array.isArray(watch?.trail) ? watch.trail.length : 0) + 1;
  return {
    event_id: `${watch?.id || "watch"}:${sequence}`,
    correlation_id: watch?.setup_id || watch?.id || null,
    setup_id: watch?.setup_id || null,
    watch_id: watch?.id || null,
    type,
    at: new Date(nowMs).toISOString(),
    at_ms: nowMs,
    stage: watch ? stageOf(watch) : null,
    detail: detail === null || detail === undefined ? null : detail,
  };
}

// ---------------------------------------------------------------------------
// §17 Post-entry trade lifecycle
//
// §7 and §33: after ENTER NOW the questions change. There is a position,
// so the stop is a real risk boundary rather than a level to interpret,
// and the targets are outcomes rather than reasons not to enter. It is
// deliberately a separate record from the setup that produced it: the
// setup's own resolution (§29's one ENTER_NOW per setup) is final and
// cannot be reopened by anything that happens to the trade.

export function tradeTargets(watch) {
  return [
    { name: "TP1", level: finiteNumber(watch.tp1) },
    { name: "TP2", level: finiteNumber(watch.tp2) },
    { name: "TP3", level: finiteNumber(watch.tp3) },
  ].filter((target) => target.level !== null);
}

/**
 * What this tick did to an open trade. Targets are reported in order and
 * only once each; the stop resolves the trade outright.
 */
export function evaluateTradeProgress(trade, { mid, protective, nowMs = Date.now() } = {}) {
  const isBuy = trade.direction === "buy";
  const price = finiteNumber(mid);
  const guard = finiteNumber(protective) ?? price;
  if (price === null || guard === null) {
    return { action: "WAIT", reason: "no usable price", reached: [] };
  }
  if (isBuy ? guard <= trade.sl : guard >= trade.sl) {
    return { action: "STOPPED", reason: "Stop loss hit", price: guard, reached: [], at: nowMs };
  }
  const hit = new Set(trade.targetsHit || []);
  const reached = tradeTargets(trade).filter(
    (target) => !hit.has(target.name) && (isBuy ? price >= target.level : price <= target.level),
  );
  if (reached.length === 0) return { action: "WAIT", reason: "in trade", reached: [] };
  const all = tradeTargets(trade);
  const final = all.length > 0 && reached.some((target) => target.name === all.at(-1).name);
  return {
    action: final ? "TARGET_FINAL" : "TARGET",
    reached,
    price,
    at: nowMs,
    reason: `${reached.map((target) => target.name).join(", ")} reached`,
  };
}

/**
 * Structural erosion on an open trade, tracked separately from the stop.
 * A stop is a price line; this is the market printing a fresh swing
 * against the position and then closing through it — proof the read is
 * failing well before price ever reaches the stop. Each qualifying close
 * is counted once, by bar timestamp, so re-evaluating the same closed
 * bar on a later tick never double-counts it. Reaching `limit` is a
 * recommendation to exit at market, not an instruction the monitor can
 * act on itself: there is no broker order behind an open manual trade,
 * only the human holding the position, so the caller's job is to say so
 * once and keep watching — never to resolve the trade on its own.
 */
export function advanceStructureFailure(state, bars, direction, { strength = 2, limit = 3 } = {}) {
  const current = state && Array.isArray(state.countedBarKeys) ? state : { count: 0, countedBarKeys: [] };
  const settle = (extra = {}) => ({ ...current, defensiveExit: current.count >= limit, ...extra });
  if (!Array.isArray(bars) || bars.length < 2 * strength + 3) return settle();

  const last = bars.at(-1);
  const key = last?.timestampMs;
  if (key === undefined || key === null || current.countedBarKeys.includes(key)) return settle();

  const swing = findSwing(bars, direction === "buy" ? "low" : "high", { strength, exclude: 1 });
  if (!swing) return settle();
  const brokeAgainst = direction === "buy" ? last.close < swing.level : last.close > swing.level;
  if (!brokeAgainst) return settle();

  const count = current.count + 1;
  return {
    count,
    countedBarKeys: [...current.countedBarKeys.slice(-19), key],
    defensiveExit: count >= limit,
    lastBreakAt: last.timestampMs,
    lastBreakLevel: swing.level,
  };
}
