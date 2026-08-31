/**
 * parse-setup.mjs — turns free-form trade-setup text into the structured
 * shape that `register_watch` consumes.
 *
 * Strategy: scan the text line by line. A "structured line" is one that
 * begins (after stripping box-drawing) with a recognised label and a
 * value, separated by `:` or `=` or just spaces. Anything else is treated
 * as narrative and ignored. This stops the parser from picking the
 * word "sell" out of "sell-side liquidity" or the word "WILL" out of
 * "the market will execute".
 *
 * The label set is intentionally narrow; the parser is happy to leave a
 * field out rather than guess. Heuristics are layered on top only for
 * fields that have no recognised label, and only when the evidence is
 * unambiguous (e.g. "LONG" or "BULLISH" with no "SHORT" present).
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
  sl:              ["STOP HUMBJES", "SL ZONE", "STOP LOSS", "STOPLOSS", "STOP", "SL"],
  invalidation:    ["INVALIDATION", "THESIS INVALIDATION", "INVAL LEVEL"],
  tp1:             ["TARGET 1", "TARGETI 1", "TP 1", "TP1", "T1", "RR1"],
  tp2:             ["TARGET 2", "TARGETI 2", "TP 2", "TP2", "T2", "RR2"],
  tp3:             ["TARGET 3", "TARGETI 3", "TP 3", "TP3", "T3", "RR3"],
  setup_model:     ["MODELI", "ENTRY MODEL", "MODEL", "STRATEGY", "SETUP TYPE"],
  conviction:      ["BESIMI", "CONFIDENCE", "CONVICTION"],
  session:         ["SESSION", "KILL ZONE", "KILLZONE"],
  season:          ["SEASON"],
  expiration_minutes: ["EXPIRES IN", "EXPIRATION", "TTL"],
};

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

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  // Extract the first numeric token. A pasted price often comes with
  // a trailing rationale ("4435.50 — FVG CE / Premium …") or a
  // surrounding note, so we cannot rely on the whole value being a
  // number. We grab the first sequence of digits, optional decimal,
  // and treat comma as decimal separator too.
  const match = str.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const cleaned = match[0].replace(",", ".");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractConviction(raw) {
  if (!raw) return null;
  // Take the first number in the value, ignoring any trailing
  // rationale. A Gemini-style line often looks like
  // "75% (MAX 75% — Tier 2 Cap)" and we want the leading 75.
  const str = String(raw).trim();
  const match = str.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const num = Number(match[0].replace(",", "."));
  if (!Number.isFinite(num)) return null;
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
  const re = /(-?\d+(?:[.,]\d+)?)\s*(?:\-|–|—|to|deri)\s*(-?\d+(?:[.,]\d+)?)/i;
  const m = String(value).match(re);
  if (!m) return [];
  return [toNumber(m[1]), toNumber(m[2])].filter((n) => n !== null);
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
    expiration_minutes: null,
  };

  if (typeof text !== "string" || !text.trim()) {
    return {
      parsed: out,
      recognised: [],
      missing: ["symbol", "direction", "entry", "sl", "tp1"],
      warnings: ["empty input"],
      raw: text || "",
    };
  }

  const lines = text.split(/\r?\n/).map((l) => stripEmoji(stripBox(l)));

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
        const d = normaliseDirection(trimEmoji(v));
        if (d) { out.direction = d; recognised.add("direction"); continue; }
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

  // ----- Strong direction override (post-loop) -----
  // An explicit "SELL XAUUSD" or "BUY XAUUSD" pattern anywhere in the
  // text ALWAYS wins over a "Direction:" label that may have been picked
  // up from a narrative section (e.g. a "TRAP" or "KURTHI" block that
  // describes the move *before* the actual trade). The trade line is
  // the one that matters; everything else is context.
  if (out.symbol) {
    const escapedSymbol = out.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strongRe = new RegExp(`\\b(SELL|BUY|SHORT|LONG)\\s+${escapedSymbol}\\b`, "i");
    const m = text.match(strongRe);
    if (m) {
      const word = m[1].toLowerCase();
      const newDir = (word === "sell" || word === "short") ? "sell" : "buy";
      if (out.direction !== newDir) {
        warnings.push(
          `direction corrected from ${out.direction || "null"} to ${newDir} ` +
          `(explicit "${m[1].toUpperCase()} ${out.symbol}" overrides earlier label)`,
        );
        out.direction = newDir;
      }
      if (!recognised.has("direction")) recognised.add("direction");
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
