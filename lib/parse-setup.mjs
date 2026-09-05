/**
 * parse-setup.mjs — turns free-form trade-setup text into the structured
 * shape that `register_watch` consumes.
 *
 * Strategy: scan the text line by line. A "structured line" is one that
 * begins (after stripping box-drawing, emoji and markdown decoration)
 * with a recognised label and a value, separated by `:` or `=` or just
 * spaces. Anything else is treated as narrative and ignored. This stops
 * the parser from picking the word "sell" out of "sell-side liquidity"
 * or the word "WILL" out of "the market will execute".
 *
 * The label set is intentionally narrow; the parser is happy to leave a
 * field out rather than guess. Heuristics are layered on top only for
 * fields that have no recognised label, and only when the evidence is
 * unambiguous (e.g. "LONG" or "BULLISH" with no "SHORT" present).
 *
 * Two rules carry most of the reliability, and both exist because the
 * analysis text describes TWO moves — the trap and the trade:
 *
 *   1. The trap's own direction is never the trade's direction. A
 *      "Direction: UP sweep" line belongs to the KURTHI block; reading
 *      it as the trade side inverts the setup. Trap-shaped values are
 *      refused, and "after trap → real move" is read instead.
 *   2. Geometry outranks vocabulary. entry/sl/tp1 have exactly one
 *      consistent reading, and those are the numbers that reach MT5. A
 *      direction word that contradicts them is the thing that is wrong.
 */

const BOX_CHARS = /[╔╗╚╝╠╣║═─━┏┓┗┛┣┫┳┻]/g;

const SYMBOL_ALIASES = new Map([
  ["GOLD", "XAUUSD"],
  ["XAU/USD", "XAUUSD"],
  ["XAU", "XAUUSD"],
  ["SILVER", "XAGUSD"],
  ["XAG/USD", "XAGUSD"],
  ["XAG", "XAGUSD"],
  ["BITCOIN", "BTCUSD"],
  ["BTC/USDT", "BTCUSD"],
  ["BTC", "BTCUSD"],
  ["ETH/USDT", "ETHUSD"],
  ["ETHEREUM", "ETHUSD"],
  ["NAS", "NAS100"],
  ["NASDAQ", "NAS100"],
  ["US100", "NAS100"],
  ["DOW", "US30"],
  ["DJ30", "US30"],
  ["WS30", "US30"],
]);

// Map of label-key → list of acceptable label strings (case-insensitive).
// Order inside each entry matters only for logging.
const LABELS = {
  symbol:          ["INSTRUMENTI", "INSTRUMENT", "SIMBOLI", "SYMBOL", "PAIR", "ASSET", "MARKET"],
  direction:       ["DREJTIMI", "DIRECTION", "SIDE", "BIAS", "TYPE"],
  entry:           ["HYRJA", "SNIPER 0 FLOAT ENTRY PRICE", "SNIPER ENTRY", "FINAL ENTRY", "ENTRY PRICE", "ENTRY"],
  entry_zone:      ["ENTRY ZONE", "ZONA HYRJE", "ZONA ENTRY", "TP ENTRY", "TP_ENTRY"],
  // The KURTHI block names the same zone in the analyst's own vocabulary.
  // It is captured separately and only folded into the entry zone when it
  // is consistent with the rest of the setup — see §trap-zone below.
  trap_zone:       [
    "EXPECTED WICK TO", "KURTHI LANDING ZONE", "LANDING ZONE", "TRAP ZONE",
    "ZONA E KURTHIT", "ZONA KURTHIT", "SNIPER ZONE", "FIBO MASTER SNIPER ZONE",
    "PRITET WICK", "WICK I PRITSHEM",
  ],
  sl:              ["STOP HUMBJES", "SL ZONE", "STOP LOSS", "STOPLOSS", "STOP", "SL"],
  invalidation:    ["INVALIDATION", "THESIS INVALIDATION", "INVAL LEVEL"],
  tp1:             ["TARGET 1", "TARGETI 1", "TP 1", "TP1", "T1", "RR1"],
  tp2:             ["TARGET 2", "TARGETI 2", "TP 2", "TP2", "T2", "RR2"],
  tp3:             ["TARGET 3", "TARGETI 3", "TP 3", "TP3", "T3", "RR3"],
  setup_model:     ["MODELI", "ENTRY MODEL", "MODEL", "STRATEGY", "SETUP TYPE"],
  conviction:      ["BESIMI", "CONFIDENCE", "CONVICTION"],
  session:         ["ACTIVE KILL ZONE", "KILL ZONE ACTIVE", "SESSION", "SESIONI", "KILL ZONE", "KILLZONE"],
  season:          ["SEASON"],
  defence_profile: ["DEFENCE PROFILE", "DEFENSE PROFILE", "VALIDATION MODE", "MENYRA E VALIDIMIT", "PROFILI I MBROJTJES"],
  expiration_minutes: ["EXPIRES IN", "EXPIRATION", "TTL"],
};

// A trap's direction is a sweep, not a trade side. These words in a
// DIRECTION value mean the line describes the manipulation move.
const TRAP_VALUE_RE = /\b(sweep|raid|manipulation|kurthi|trap)\b/i;

const DEFENCE_PROFILES = ["standard", "m1_continuation", "rejection_displacement"];

// Direction words → canonical
function normaliseDirection(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).toLowerCase();
  const letters = cleaned
    .replace(/[📈📉⬆️⬇️🟢🔴⭐✅❌↑↓➡️]/g, "")
    .replace(/[^\w\s]/g, " ")
    .trim();
  if (/\b(sell|short|bearish|down)\b/.test(letters)) return "sell";
  if (/\b(buy|long|bullish|bull|up)\b/.test(letters)) return "buy";
  return null;
}

function normaliseSymbol(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (SYMBOL_ALIASES.has(cleaned)) return SYMBOL_ALIASES.get(cleaned);
  const noSlash = cleaned.replace(/\//g, "");
  if (SYMBOL_ALIASES.has(noSlash)) return SYMBOL_ALIASES.get(noSlash);
  if (/^[A-Z0-9._]{3,20}$/.test(noSlash)) return noSlash;
  return null;
}

// A number written with comma group separators — "108,450.00". Matched
// before the plain form, because the plain form would read that as
// 108.45 and register a watch on a price the market will never trade.
const GROUPED_NUMBER_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/;
const PLAIN_NUMBER_RE = /-?\d+(?:[.,]\d+)?/;

/**
 * firstNumberToken — the first number in a string, as a JS number.
 *
 * A pasted price often comes with a trailing rationale ("4435.50 — FVG
 * CE / Premium …"), so the whole value cannot be trusted to be numeric.
 * Comma is read as a decimal separator ("4374,50") EXCEPT where it
 * groups thousands ("108,450.00"), which is decided by whether exactly
 * three digits follow it.
 */
function firstNumberToken(str) {
  const grouped = str.match(GROUPED_NUMBER_RE);
  const plain = str.match(PLAIN_NUMBER_RE);
  if (!grouped && !plain) return null;
  // Whichever starts earlier wins; on a tie the grouped form is the
  // longer, more specific read of the same digits.
  const useGrouped = grouped && (!plain || grouped.index <= plain.index);
  const cleaned = useGrouped
    ? grouped[0].replace(/,/g, "")
    : plain[0].replace(",", ".");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  return firstNumberToken(str);
}

function extractConviction(raw) {
  if (!raw) return null;
  // Take the first number in the value, ignoring any trailing
  // rationale. A Gemini-style line often looks like
  // "75% (MAX 75% — Tier 2 Cap)" and we want the leading 75.
  const num = toNumber(raw);
  if (num === null) return null;
  if (num <= 10) return String(num);
  if (num <= 100) return `${Math.round(num)}%`;
  return null;
}

function stripBox(line) {
  return line.replace(BOX_CHARS, " ");
}

function stripEmoji(s) {
  // Strip emoji and pictographic symbols. Covers the most common ones
  // used in trading setups; the goal is just to keep the line label-
  // prefix clean, not to be exhaustive.
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, "");
}

/**
 * stripMarkdown — remove the decoration a chat model puts around a label.
 *
 * Gemini and Claude emit the same setup as `**ENTRY:** 4374.50` or
 * `- ENTRY: 4374.50` at least as often as they emit the bordered table.
 * The label matcher is anchored to the start of the line, so that
 * decoration made the difference between a setup being accepted and the
 * same setup being refused for "missing entry, sl, tp1".
 */
function stripMarkdown(line) {
  return line
    // Leading blockquote markers, headings, bullets and ordered-list
    // numbering, in any combination and repeated.
    .replace(/^[\s ]*(?:[>#]+[\s ]*|[-*+•▪·—–][\s ]+|\d{1,2}[.)][\s ]+)+/u, "")
    // Bold/italic emphasis. Paired markers go unconditionally; a lone
    // marker only where it is not inside a word.
    .replace(/\*\*|__/g, "")
    .replace(/(?<![A-Za-z0-9])[*_](?![A-Za-z0-9])/g, "");
}

function trimEmoji(s) {
  return s.replace(/[📈📉⬆️⬇️🟢🔴⭐✅❌⛔⚠️🎯🪤]/g, "").trim();
}

// Try to match a single line against a list of labels. Returns
// { key, rawValue } on success or null.
function matchLabel(line, labels) {
  // Build a single regex like  ^(?:LABEL1|LABEL2|LABEL3)\b\s*[:=\-]?\s*(.+)$
  const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // Match: optional leading spaces, label, then either a separator
  // ( : = - ) or 2+ spaces, then capture the value up to the end.
  const re = new RegExp(
    `^[\\s\\u00A0]*(?:${escaped})(?:\\s*[:=\\-–—]\\s*|\\s{2,})(.+?)\\s*$`,
    "i",
  );
  const m = line.match(re);
  return m ? m[1].trim() : null;
}

// Extract numeric ranges from a value: "4424.50 – 4426.00" → [4424.5, 4426]
function parseRange(value) {
  if (!value) return [];
  const re = /(-?[\d,]*\d(?:\.\d+)?)\s*(?:\-|–|—|to|deri|\.\.)\s*(-?[\d,]*\d(?:\.\d+)?)/i;
  const m = String(value).match(re);
  if (!m) return [];
  return [toNumber(m[1]), toNumber(m[2])].filter((n) => n !== null);
}

/**
 * geometryDirection — the side implied by the numbers themselves.
 *
 * entry/sl/tp1 admit exactly one consistent side, and they are the
 * numbers that get copied into the terminal. Returns null unless one
 * side fits and the other is impossible, so a partial or contradictory
 * read never speaks.
 */
function geometryDirection({ entry, sl, tp1, tp2, tp3 }) {
  const known = (n) => typeof n === "number" && Number.isFinite(n);
  if (!known(entry) || !known(sl) || !known(tp1)) return null;
  const above = (n) => !known(n) || n > entry;
  const below = (n) => !known(n) || n < entry;
  const buyFits = entry > sl && tp1 > entry && above(tp2) && above(tp3);
  const sellFits = entry < sl && tp1 < entry && below(tp2) && below(tp3);
  if (buyFits && !sellFits) return "buy";
  if (sellFits && !buyFits) return "sell";
  return null;
}

/**
 * parseSetupText — best-effort structured extraction from pasted text.
 *
 * @param {string} text
 * @returns {{
 *   parsed: object,
 *   recognised: string[],
 *   missing: string[],
 *   warnings: string[],
 *   raw: string
 * }}
 */
export function parseSetupText(text) {
  const warnings = [];
  const recognised = new Set();
  const out = {
    symbol: null,
    direction: null,
    entry: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: null,
    invalidation: null,
    tp1: null,
    tp2: null,
    tp3: null,
    setup_model: null,
    conviction: null,
    session: null,
    season: null,
    defence_profile: null,
    expiration_minutes: null,
  };
  // Captured but not published: the KURTHI zone only becomes the entry
  // zone if it survives the consistency check below.
  let trapZone = { low: null, high: null };

  if (typeof text !== "string" || !text.trim()) {
    return {
      parsed: out,
      recognised: [],
      missing: ["symbol", "direction", "entry", "sl", "tp1"],
      warnings: ["empty input"],
      raw: text || "",
    };
  }

  const lines = text.split(/\r?\n/).map((l) => stripMarkdown(stripEmoji(stripBox(l))));

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Symbol
    if (out.symbol === null) {
      const v = matchLabel(line, LABELS.symbol);
      if (v) {
        const s = normaliseSymbol(v.split(/\s/)[0]); // first token only
        if (s) { out.symbol = s; recognised.add("symbol"); continue; }
      }
    }

    // Direction
    if (out.direction === null) {
      const v = matchLabel(line, LABELS.direction);
      if (v) {
        // "Direction: UP sweep" is the trap's move, not the trade's.
        // Reading it as the trade side inverts the setup, so it is
        // refused here and recovered from "after trap → real move".
        if (TRAP_VALUE_RE.test(v)) {
          warnings.push(`ignored trap-move direction "${v.trim()}" — that is the sweep, not the trade side`);
        } else {
          const d = normaliseDirection(trimEmoji(v));
          if (d) { out.direction = d; recognised.add("direction"); continue; }
        }
      }
    }

    // Entry zone (must come before plain entry, since the zone label
    // starts with the same word)
    if (out.entry_zone_low === null) {
      const v = matchLabel(line, LABELS.entry_zone);
      if (v) {
        const [low, high] = parseRange(v);
        if (low !== undefined) {
          out.entry_zone_low = low;
          out.entry_zone_high = high;
          recognised.add("entry_zone_low");
          if (high !== undefined) recognised.add("entry_zone_high");
          continue;
        }
        // Fallback: a single number
        const single = toNumber(v);
        if (single !== null) {
          out.entry_zone_low = single;
          out.entry_zone_high = single;
          recognised.add("entry_zone_low");
          recognised.add("entry_zone_high");
          continue;
        }
      }
    }

    // Trap / Kurthi landing zone — the same zone under the analyst's
    // own name. Held aside; folded in after the direction is settled.
    if (trapZone.low === null) {
      const v = matchLabel(line, LABELS.trap_zone);
      if (v) {
        const [low, high] = parseRange(v);
        if (low !== undefined && high !== undefined) {
          trapZone = { low: Math.min(low, high), high: Math.max(low, high) };
          continue;
        }
      }
    }

    // Entry
    if (out.entry === null) {
      const v = matchLabel(line, LABELS.entry);
      if (v) {
        const n = toNumber(v);
        if (n !== null) { out.entry = n; recognised.add("entry"); continue; }
      }
    }

    // SL
    if (out.sl === null) {
      const v = matchLabel(line, LABELS.sl);
      if (v) {
        const n = toNumber(v);
        if (n !== null) { out.sl = n; recognised.add("sl"); continue; }
      }
    }

    // Invalidation
    if (out.invalidation === null) {
      const v = matchLabel(line, LABELS.invalidation);
      if (v) {
        const n = toNumber(v);
        if (n !== null) { out.invalidation = n; recognised.add("invalidation"); continue; }
      }
    }

    // TP1/2/3
    for (const key of ["tp1", "tp2", "tp3"]) {
      if (out[key] !== null) continue;
      const v = matchLabel(line, LABELS[key]);
      if (v) {
        const n = toNumber(v);
        if (n !== null) {
          // Reject tiny values that look like distances/pips, not prices.
          // A gold or FX price is at least 3 digits before the dot.
          if (n < 1) {
            warnings.push(`${key.toUpperCase()} value ${n} looks like a distance, not a price — ignored`);
            continue;
          }
          out[key] = n;
          recognised.add(key);
          break;
        }
      }
    }

    // Setup model
    if (out.setup_model === null) {
      const v = matchLabel(line, LABELS.setup_model);
      if (v) { out.setup_model = v; recognised.add("setup_model"); continue; }
    }

    // Conviction
    if (out.conviction === null) {
      const v = matchLabel(line, LABELS.conviction);
      if (v) {
        const c = extractConviction(v);
        if (c) { out.conviction = c; recognised.add("conviction"); continue; }
      }
    }

    // Session / Kill Zone
    if (out.session === null) {
      const v = matchLabel(line, LABELS.session);
      if (v) { out.session = v; recognised.add("session"); continue; }
    }

    // Season
    if (out.season === null) {
      const v = matchLabel(line, LABELS.season);
      if (v) { out.season = v; recognised.add("season"); continue; }
    }

    // Defence profile — which live proof the setup requires after the
    // touch. Left null unless the operator names one, so the monitor
    // keeps its own default rather than the parser inventing one.
    if (out.defence_profile === null) {
      const v = matchLabel(line, LABELS.defence_profile);
      if (v) {
        const canon = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
        if (DEFENCE_PROFILES.includes(canon)) {
          out.defence_profile = canon;
          recognised.add("defence_profile");
          continue;
        }
        warnings.push(`defence profile "${v.trim()}" is not one of ${DEFENCE_PROFILES.join(", ")} — left to the monitor's default`);
      }
    }

    // Expiration
    if (out.expiration_minutes === null) {
      const v = matchLabel(line, LABELS.expiration_minutes);
      if (v) {
        const n = toNumber(v);
        if (n !== null && n > 0) { out.expiration_minutes = n; recognised.add("expiration_minutes"); continue; }
      }
    }
  }

  // ----- Heuristics, only when a field is still missing -----

  if (out.symbol === null) {
    // Look for a known symbol anywhere in the text — but only as a
    // standalone token, never as a fragment of a word.
    const known = ["XAUUSD","XAGUSD","EURUSD","GBPUSD","USDJPY","USDCAD","BTCUSD","ETHUSD","US30","NAS100","UK100","DE40"];
    for (const s of known) {
      const re = new RegExp(`\\b${s}\\b`, "i");
      if (re.test(text)) {
        out.symbol = s;
        recognised.add("symbol");
        warnings.push(`symbol inferred as ${s} from raw text`);
        break;
      }
    }
  }

  if (out.direction === null) {
    // Be very conservative: standalone "LONG" or "SHORT" anywhere.
    if (/\b(SELL|SHORT)\b/.test(text) && !/\b(BUY|LONG)\b/.test(text)) {
      out.direction = "sell";
      recognised.add("direction");
      warnings.push("direction inferred as SELL from standalone SELL/SHORT");
    } else if (/\b(BUY|LONG)\b/.test(text) && !/\b(SELL|SHORT)\b/.test(text)) {
      out.direction = "buy";
      recognised.add("direction");
      warnings.push("direction inferred as BUY from standalone BUY/LONG");
    } else if (/\bBEARISH\b/.test(text) && !/\bBULLISH\b/.test(text)) {
      out.direction = "sell";
      recognised.add("direction");
      warnings.push("direction inferred as SELL from BEARISH context");
    } else if (/\bBULLISH\b/.test(text) && !/\bBEARISH\b/.test(text)) {
      out.direction = "buy";
      recognised.add("direction");
      warnings.push("direction inferred as BUY from BULLISH context");
    }
  }

  // ----- Direction overrides, weakest first -----

  const setDirection = (next, why) => {
    if (!next) return;
    if (out.direction !== next) {
      warnings.push(`direction corrected from ${out.direction || "null"} to ${next.toUpperCase()} (${why})`);
      out.direction = next;
    }
    recognised.add("direction");
  };

  // 1. "After trap → real move: BEARISH". The KURTHI block states the
  //    trade side explicitly, one line under the sweep it must not be
  //    confused with.
  const realMove = text.match(
    /after\s+(?:the\s+)?trap\s*(?:→|->|=>|:|—|–)?\s*real\s+(?:move|direction)\s*[:=]\s*([A-Za-z]+)/i,
  );
  if (realMove) setDirection(normaliseDirection(realMove[1]), 'from "after trap → real move"');

  // 2. The trade line itself: "SELL XAUUSD AT THIS PRICE" — or the same
  //    line with the symbol left off, which is just as common.
  const strongPatterns = [];
  if (out.symbol) {
    const escapedSymbol = out.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    strongPatterns.push(new RegExp(`\\b(SELL|BUY|SHORT|LONG)\\s+${escapedSymbol}\\b`, "i"));
  }
  strongPatterns.push(/\b(SELL|BUY|SHORT|LONG)\b(?:\s+[A-Z0-9./]{2,12})?\s+(?:AT|@)\s+(?:THIS\s+PRICE|THE\s+PRICE|PRICE)/i);
  for (const re of strongPatterns) {
    const m = text.match(re);
    if (!m) continue;
    const word = m[1].toLowerCase();
    setDirection(word === "sell" || word === "short" ? "sell" : "buy", `explicit "${m[0].trim().toUpperCase()}"`);
    break;
  }

  // 3. Geometry has the last word. entry/sl/tp1 are the numbers that
  //    reach the terminal, and they admit one side only. Where a word
  //    disagrees with them the word is what is wrong — and refusing the
  //    paste instead would reject a setup whose prices were never in
  //    doubt.
  const geo = geometryDirection(out);
  if (geo) setDirection(geo, "entry/SL/TP geometry — the prices only fit this side");

  // ----- §trap-zone: fold the KURTHI zone into the entry zone --------
  //
  // In Active validation the trap zone IS the entry zone: the monitor
  // waits for price to reach it and then requires the rejection there.
  // Adopted only when it is consistent with the entry and the stop, so
  // a zone quoted from a different leg cannot turn a working paste into
  // a rejected one.
  if (out.entry_zone_low === null && trapZone.low !== null && trapZone.high !== null) {
    const { low, high } = trapZone;
    const entryInside = out.entry === null || (out.entry >= low && out.entry <= high);
    const stopClear =
      out.sl === null || out.direction === null
        ? true
        : out.direction === "buy"
          ? out.sl < low
          : out.sl > high;
    if (low < high && entryInside && stopClear) {
      out.entry_zone_low = low;
      out.entry_zone_high = high;
      recognised.add("entry_zone_low");
      recognised.add("entry_zone_high");
      warnings.push(`entry zone taken from the KURTHI landing zone (${low} – ${high})`);
    } else {
      warnings.push(
        `KURTHI zone ${low} – ${high} ignored: it does not sit consistently with entry ${out.entry} and stop ${out.sl}`,
      );
    }
  }

  if (out.entry === null && out.entry_zone_low !== null && out.entry_zone_high !== null) {
    out.entry = (out.entry_zone_low + out.entry_zone_high) / 2;
    recognised.add("entry");
    warnings.push(`entry derived as midpoint of zone (${out.entry})`);
  }

  if (out.invalidation === null && out.sl !== null && out.entry !== null) {
    const risk = Math.abs(out.entry - out.sl);
    out.invalidation = out.direction === "buy" ? out.sl - risk * 0.1 : out.sl + risk * 0.1;
    recognised.add("invalidation");
    warnings.push(`invalidation inferred just past SL (${out.invalidation})`);
  }

  // ----- Final validation -----

  const required = ["symbol", "direction", "entry", "sl", "tp1"];
  const missing = required.filter((k) => out[k] === null || out[k] === undefined);

  return {
    parsed: out,
    recognised: [...recognised],
    missing,
    warnings,
    raw: text,
  };
}
