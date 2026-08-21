/**
 * Watch Monitor MCP — v7.0
 *
 * An MCP server that monitors ICT sniper setups and TRAP_NOT_CONFIRMED
 * reads to a deterministic conclusion, notifies a human, and — when
 * auto-trade is explicitly armed — submits the entry order itself the
 * moment the confirmation sequence completes.
 *
 * Two state machines, one scheduler:
 *
 *   SETUP WATCH   ARMED → TOUCHED → CONFIRMING → ENTRY_CONFIRMED →
 *                 ORDER_SUBMITTED → RESOLVING → RESOLVED
 *                 resolutions: EXECUTED | CONFIRMED | FAILED | EXPIRED |
 *                 CANCELLED | EXECUTION_UNKNOWN
 *                 plus QUARANTINED, a non-terminal state entered when the
 *                 feed cannot be trusted to describe this instrument.
 *                 CONFIRMED (rather than EXECUTED) is what a confirmed
 *                 setup resolves to when auto-trade is off or the
 *                 pre-submission checklist refused: the human is told to
 *                 enter, exactly as in v6.
 *
 *   TRAP WATCH    ARMED → RESOLVING → RESOLVED
 *                 resolutions: CONDITIONS_MET | FLIPPED | EXPIRED | CANCELLED
 *                 A trap watch never produces an entry, SL or TP, and is
 *                 never auto-traded.
 *
 * The confirmation sequence a setup watch must complete before an order
 * exists — each step proven on price action that printed *after* the
 * entry touch, in this order and no other:
 *
 *   SETUP VALID → ENTRY TOUCHED → REJECTION → M5 STRUCTURE SHIFT →
 *   DISPLACEMENT → gates → ENTRY CONFIRMED → ORDER SUBMITTED → EXECUTED
 *
 * The invariant the whole design serves: a transient infrastructure
 * failure must never be able to present itself as market confirmation,
 * and an infrastructure failure must never silently erase a safety check.
 * Auto-trade extends that invariant rather than relaxing it — every
 * unknown in the pre-submission checklist (§13 of core.mjs) counts as a
 * refusal, because the cost of a wrong order is unrecoverable and the
 * cost of a missed one is a Telegram message.
 *
 * The Claude-facing MCP surface is unchanged: it still exposes market
 * data plus the monitor's own tools, and still refuses every account and
 * execution tool the upstream has. A client cannot ask this server to
 * trade. Only the monitor's own confirmation loop can, on a watch that
 * client registered, under the operator's env-level arming.
 */

import express from "express";
import "dotenv/config";
import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  PERIOD_MS,
  TRAP_TIMEFRAMES,
  advanceEntrySequence,
  advanceGeneration,
  barClosedAfter,
  barKey,
  bodyClosedBeyond,
  calcATR,
  checkAcceptance,
  checkCISD,
  checkMSS,
  checkSMT,
  checkZoneRejection,
  classifyEngulfing,
  classifyWick,
  closedSeries,
  computeOrderVolume,
  displacementCheck,
  emptySequence,
  entryZone,
  evaluateConfirmation,
  evaluatePrerequisite,
  evaluateSafety,
  finiteNumber,
  formatLevel,
  fvgCheck,
  killZoneStatus,
  newsBlackout,
  numericTimestampMs,
  oppositeBias,
  periodMs,
  preflightExecution,
  priceTolerance,
  stageOf,
  symbolCurrencies,
  trapWatchKey,
  updateSpreadHealth,
  validateTrapWatchInput,
  validateWatchInput,
  volumeInConnectorUnits,
  watchKey,
  zoneTouchLevel,
} from "./lib/core.mjs";
import { CTraderMcpClient, MarketData, asArray } from "./lib/upstream.mjs";
import { Executor } from "./lib/execution.mjs";
import { Notifier } from "./lib/notify.mjs";
import { WatchStore, publicWatch } from "./lib/store.mjs";

// ---------------------------------------------------------------------------
// §1 Configuration

const num = (value, fallback, min = -Infinity) =>
  Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback);
const bool = (value, fallback) =>
  value === undefined ? fallback : String(value).toLowerCase() === "true";

const CONFIG = {
  port: num(process.env.PORT, 8080),
  upstreamUrl: process.env.CTRADER_MCP_URL || "https://mcp.ctrader.com/trading/mcp",
  upstreamToken: process.env.CTRADER_MCP_TOKEN || "",
  mcpTimeoutMs: num(process.env.MCP_TIMEOUT_MS, 15000, 5000),
  protocolVersion: process.env.MCP_PROTOCOL_VERSION || "2024-11-05",

  tickMs: num(process.env.SCHEDULER_TICK_MS, 2500, 1000),
  setupIntervalMs: num(process.env.WATCH_INTERVAL_MS, 10000, 3000),
  trapIntervalMs: num(process.env.TRAP_WATCH_INTERVAL_MS, 30000, 10000),

  priceScale: num(process.env.CTRADER_PRICE_SCALE, 100000, 1),
  scaleTolerance: num(process.env.SCALE_TOLERANCE, 0.35, 0.05),
  symbolTtlMs: num(process.env.SYMBOL_TTL_MS, 10 * 60 * 1000, 60_000),
  missingSymbolBackoffMs: num(process.env.MISSING_SYMBOL_BACKOFF_MS, 15 * 60 * 1000, 60_000),
  spotCacheMs: num(process.env.SPOT_CACHE_MS, 2000, 0),
  barCacheFraction: num(process.env.BAR_CACHE_FRACTION, 0.2, 0.05),
  barCacheMaxMs: num(process.env.BAR_CACHE_MAX_MS, 60_000, 5_000),
  periodMs: PERIOD_MS,
  symbolIdHints: {
    EURUSD: 1,
    GBPUSD: 2,
    XAUUSD: 41,
    XAGUSD: 42,
    US30: 10015,
    BTCUSD: 10026,
    ETHUSD: 10029,
  },

  minConfirmationHoldMs: num(process.env.MIN_CONFIRMATION_HOLD_MS, 60000, 0),
  requireNewBar: process.env.REQUIRE_NEW_M1_CANDLE !== "false",
  acceptanceAtrFraction: num(process.env.ACCEPTANCE_ATR_FRACTION, 0.5, 0.05),
  acceptanceRiskFraction: num(process.env.ACCEPTANCE_RISK_FRACTION, 0.35, 0.05),

  killZoneEnabled: process.env.KILL_ZONE_FILTER_ENABLED !== "false",
  spreadEnabled: process.env.SPREAD_CHECK_ENABLED !== "false",
  spreadBaselineSamples: num(process.env.SPREAD_BASELINE_SAMPLES, 5, 3),
  spreadHistoryMax: num(process.env.SPREAD_HISTORY_MAX, 20, 5),
  spreadAnomalyMultiplier: num(process.env.SPREAD_ANOMALY_MULTIPLIER, 3, 1.5),

  newsEnabled: process.env.NEWS_FILTER_ENABLED !== "false",
  newsFailClosed: bool(process.env.NEWS_FAIL_CLOSED, true),
  newsFeedUrls: (
    process.env.NEWS_FEED_URL ||
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json,https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  newsCacheTtlMs: num(process.env.NEWS_CACHE_TTL_MS, 60 * 60 * 1000, 5 * 60 * 1000),
  newsBeforeMs: num(process.env.NEWS_BLACKOUT_BEFORE_MIN, 15, 0) * 60_000,
  newsAfterMs: num(process.env.NEWS_BLACKOUT_AFTER_MIN, 15, 0) * 60_000,
  newsImpacts: new Set(
    (process.env.NEWS_IMPACT_LEVELS || "high")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),

  trapDisplacementMultiple: num(process.env.TRAP_DISPLACEMENT_MULTIPLE, 3, 1.5),
  trapDisplacementLookback: num(process.env.TRAP_DISPLACEMENT_LOOKBACK, 10, 5),
  trapApproachAtrFraction: num(process.env.TRAP_APPROACH_ATR_FRACTION, 0.5, 0),
  trapExpiryMinutes: num(process.env.TRAP_WATCH_DEFAULT_EXPIRY_MIN, 720, 0),

  maxSetupWatches: num(process.env.MAX_ACTIVE_WATCHES, 25, 1),
  maxTrapWatches: num(process.env.MAX_TRAP_WATCHES, 25, 1),
  resolvedLimit: num(process.env.RESOLVED_WATCH_LIMIT, 60, 10),

  statePath: process.env.STATE_FILE || "./data/watch-state.json",
  authToken: String(process.env.WATCH_MONITOR_AUTH_TOKEN || ""),
  allowedOrigin: process.env.ALLOWED_ORIGIN || "*",

  // The post-touch confirmation sequence. Required by default: the whole
  // point of the sequence is that a touch, a wick, or a single bearish
  // candle is not an entry.
  entrySequenceRequired: process.env.ENTRY_SEQUENCE_REQUIRED !== "false",
  entryDisplacementMultiple: num(process.env.ENTRY_DISPLACEMENT_MULTIPLE, 1.8, 1.1),
  entryDisplacementLookback: num(process.env.ENTRY_DISPLACEMENT_LOOKBACK, 10, 5),
  entryMssSwingStrength: num(process.env.ENTRY_MSS_SWING_STRENGTH, 2, 1),
  entryFadeAtrFraction: num(process.env.ENTRY_FADE_ATR_FRACTION, 0.5, 0),

  autoTrade: autoTradeConfig(),
};

/**
 * Auto-trade configuration.
 *
 * Two independent switches have to be thrown before this service can
 * place an order: AUTO_TRADE_ENABLED and an exact confirmation phrase.
 * A single boolean is too easy to set by accident — by a copied env
 * file, a template, or a redeploy that inherits someone else's
 * variables — and the failure mode is real money.
 */
export const AUTO_TRADE_CONFIRMATION_PHRASE = "I ACCEPT AUTOMATED ORDER EXECUTION";

function contractSizeOverrides() {
  const overrides = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("CONTRACT_SIZE_")) continue;
    const size = Number(value);
    if (Number.isFinite(size) && size > 0) overrides[key.slice("CONTRACT_SIZE_".length).toUpperCase()] = size;
  }
  return overrides;
}

function autoTradeConfig() {
  const mode = String(process.env.AUTO_TRADE_VOLUME_MODE || "fixed").toLowerCase();
  const volumeUnit = String(process.env.AUTO_TRADE_VOLUME_UNIT || "lots").toLowerCase();
  const priceFormat = String(process.env.AUTO_TRADE_PRICE_FORMAT || "raw").toLowerCase();
  return {
    enabled: bool(process.env.AUTO_TRADE_ENABLED, false),
    confirmation: String(process.env.AUTO_TRADE_CONFIRMED || ""),
    dryRun: bool(process.env.AUTO_TRADE_DRY_RUN, false),
    mode: ["fixed", "risk"].includes(mode) ? mode : "invalid",
    fixedVolume: finiteNumber(process.env.AUTO_TRADE_FIXED_VOLUME),
    riskPercent: num(process.env.AUTO_TRADE_RISK_PERCENT, 0.5, 0.01),
    maxRiskPercent: num(process.env.AUTO_TRADE_MAX_RISK_PERCENT, 2, 0.01),
    volumeUnit: ["lots", "units", "centi_units"].includes(volumeUnit) ? volumeUnit : "invalid",
    volumeStep: num(process.env.AUTO_TRADE_VOLUME_STEP, 0.01, 0.000001),
    minVolume: num(process.env.AUTO_TRADE_MIN_VOLUME, 0.01, 0.000001),
    maxVolume: finiteNumber(process.env.AUTO_TRADE_MAX_VOLUME),
    accountCurrency: String(process.env.AUTO_TRADE_ACCOUNT_CURRENCY || "USD").toUpperCase(),
    contractSizes: contractSizeOverrides(),
    priceFormat: ["raw", "scaled"].includes(priceFormat) ? priceFormat : "invalid",
    priceScale: num(process.env.CTRADER_PRICE_SCALE, 100000, 1),
    balanceIsScaled: bool(process.env.AUTO_TRADE_BALANCE_IS_SCALED, false),
    orderType: String(process.env.AUTO_TRADE_ORDER_TYPE || "MARKET").toUpperCase(),
    orderToolName: process.env.AUTO_TRADE_ORDER_TOOL || null,
    positionsToolName: process.env.AUTO_TRADE_POSITIONS_TOOL || null,
    balanceToolName: process.env.AUTO_TRADE_BALANCE_TOOL || null,
    labelPrefix: String(process.env.AUTO_TRADE_LABEL_PREFIX || "WM"),
    maxOpenPositions: num(process.env.AUTO_TRADE_MAX_OPEN_POSITIONS, 1, 1),
    maxTradesPerDay: num(process.env.AUTO_TRADE_MAX_TRADES_PER_DAY, 3, 1),
    maxPriceAgeMs: num(process.env.AUTO_TRADE_MAX_PRICE_AGE_MS, 15_000, 1000),
    maxSlippageRiskFraction: num(process.env.AUTO_TRADE_MAX_SLIPPAGE_RISK_FRACTION, 0.25, 0.01),
    maxAttempts: num(process.env.AUTO_TRADE_MAX_ATTEMPTS, 3, 1),
    executionToolsTtlMs: num(process.env.UPSTREAM_TOOLS_TTL_MS, 10 * 60 * 1000, 60_000),
    symbolAllowlist: new Set(
      String(process.env.AUTO_TRADE_SYMBOLS || "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ),
  };
}

/**
 * Is auto-trade armed right now, and if not, exactly why? Returned as a
 * reason rather than a boolean so /health, list_watches and the refusal
 * notification all say the same specific thing.
 */
let autoTradePausedReason = null;

export function autoTradeStatus(config = CONFIG.autoTrade) {
  if (!config.enabled) return { armed: false, reason: "AUTO_TRADE_ENABLED is not true" };
  if (config.confirmation !== AUTO_TRADE_CONFIRMATION_PHRASE) {
    return {
      armed: false,
      reason: `AUTO_TRADE_CONFIRMED must be set to the exact phrase "${AUTO_TRADE_CONFIRMATION_PHRASE}"`,
    };
  }
  if (config.mode === "invalid") return { armed: false, reason: "AUTO_TRADE_VOLUME_MODE must be fixed or risk" };
  if (config.volumeUnit === "invalid") {
    return { armed: false, reason: "AUTO_TRADE_VOLUME_UNIT must be lots, units or centi_units" };
  }
  if (config.priceFormat === "invalid") {
    return { armed: false, reason: "AUTO_TRADE_PRICE_FORMAT must be raw or scaled" };
  }
  if (config.mode === "fixed" && !(config.fixedVolume > 0)) {
    return { armed: false, reason: "AUTO_TRADE_FIXED_VOLUME must be set when the volume mode is fixed" };
  }
  if (autoTradePausedReason) return { armed: false, reason: autoTradePausedReason, paused: true };
  return { armed: true, reason: null, dryRun: config.dryRun };
}

// Degradation must be measured against the watch's own cadence, not a
// fixed wall-clock constant, or a slow trap watch reports itself broken.
const staleBudget = (watch) =>
  Math.max(120_000, (watch.kind === "TRAP" ? CONFIG.trapIntervalMs : CONFIG.setupIntervalMs) * 8);

function log(message, ...args) {
  console.error(`[watch-monitor] ${message}`, ...args);
}

// ---------------------------------------------------------------------------
// §2 Wiring

const client = new CTraderMcpClient({
  url: CONFIG.upstreamUrl,
  token: CONFIG.upstreamToken,
  timeoutMs: CONFIG.mcpTimeoutMs,
  protocolVersion: CONFIG.protocolVersion,
  log,
});
const market = new MarketData({ client, config: CONFIG, log });
// The executor shares the upstream client with the market-data layer but
// is reachable only from the confirmation loop below — never from a
// tools/call, which is filtered against MARKET_DATA_TOOL_ALLOWLIST.
const executor = new Executor({ client, config: CONFIG.autoTrade, log });
const notifier = new Notifier({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  log,
});
const store = new WatchStore({
  path: CONFIG.statePath,
  log,
  limits: {
    setups: CONFIG.maxSetupWatches,
    traps: CONFIG.maxTrapWatches,
    resolved: CONFIG.resolvedLimit,
  },
});

let manualNewsLockout = { active: false, reason: null, setAt: null };
let newsCache = { events: [], fetchedAt: 0, expiresAt: 0, lastError: null };
let newsRefreshInFlight = null;
const watchSessions = new Map();

const app = express();
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function notify(text, options = {}) {
  return notifier.enqueue(text, options);
}

let saveTimer = null;
function scheduleSave(immediate = false) {
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    store.save({ outbox: notifier.serialize(), autoTrade: { ...tradeCounter } });
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (store.dirty) store.save({ outbox: notifier.serialize(), autoTrade: { ...tradeCounter } });
  }, 1000);
}

// ---------------------------------------------------------------------------
// §3 Resolution paths
//
// Every terminal transition funnels through resolveWatch. It is
// idempotent by construction: store.beginResolution() is the only door,
// and it can be walked through once. Notification is enqueued, never
// awaited, so a slow or failing Telegram cannot hold a watch in
// RESOLVING — but the delivery outcome is recorded against the
// resolution so a silent non-delivery is visible in list_watches.

function resolveWatch(watch, status, extra = {}, message = null, priority = "critical") {
  if (!store.beginResolution(watch.id)) return false;
  try {
    const record = store.finalize(watch, status, extra);
    if (message) {
      const result = notify(message, { dedupeKey: `${watch.id}:${status}`, priority });
      record.notification = { queued: result.queued, at: new Date().toISOString() };
    }
    scheduleSave(true);
    return true;
  } finally {
    store.endResolution(watch.id);
  }
}

function confirmWatch(watch, price, result, gates) {
  return resolveWatch(
    watch,
    "CONFIRMED",
    {
      resolvedPrice: price,
      signals: result.signals,
      strength: result.strength,
      gates: gates.summary,
    },
    `<b>REAL CONFIRMATION — ENTER NOW</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)}\n` +
      `<b>Direction:</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
      `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))} | <b>Price:</b> ${htmlEscape(formatLevel(price))}\n` +
      `<b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
      `<b>Evidence:</b> ${htmlEscape(result.signals.join(" + "))}\n` +
      `<b>Strength:</b> ${htmlEscape(result.strength)}\n` +
      `<b>Kill zone:</b> ${htmlEscape(gates.zone || "disabled")}`,
  );
}

/**
 * The execution record, written in the exact terms the entry decision
 * was made in. "Confirmation detected" is not an audit trail; this is.
 */
function executionLogLines(watch, execution) {
  const sequence = watch.sequence || {};
  const displacement = sequence.displacement || {};
  const candle = displacement.candle;
  return [
    `<b>SETUP_ID:</b> ${htmlEscape(watch.setup_id || watch.id)}`,
    `<b>TOUCH_PRICE:</b> ${htmlEscape(formatLevel(watch.entryTouchPrice ?? watch.entry))}`,
    `<b>TOUCH_TIME:</b> ${htmlEscape(watch.entryTouchedAt || "unrecorded")}`,
    `<b>REJECTION_PRICE:</b> ${htmlEscape(sequence.rejection ? `${formatLevel(sequence.rejection.price)} (${sequence.rejection.kind})` : "n/a")}`,
    `<b>MSS_LEVEL:</b> ${htmlEscape(sequence.mss ? formatLevel(sequence.mss.level) : "n/a")}`,
    `<b>DISPLACEMENT_CANDLE:</b> ${htmlEscape(
      candle
        ? `${new Date(candle.timestampMs).toISOString()} O ${formatLevel(candle.open)} C ${formatLevel(candle.close)} · body ${formatLevel(displacement.body)} vs ${formatLevel(displacement.threshold)} required`
        : "n/a",
    )}`,
    `<b>CONFIRMATION_TIME:</b> ${htmlEscape(watch.confirmedAt || "unrecorded")}`,
    `<b>EXECUTION_PRICE:</b> ${htmlEscape(formatLevel(execution.price))}`,
    `<b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP:</b> ${htmlEscape(formatLevel(watch.tp1))}`,
    `<b>VOLUME:</b> ${htmlEscape(String(execution.volume))} lot(s) → ${htmlEscape(String(execution.connectorVolume))} ${htmlEscape(execution.volumeUnit)}` +
      (execution.riskAmount ? ` · risk ${htmlEscape(execution.riskAmount.toFixed(2))} ${htmlEscape(execution.accountCurrency)}` : ""),
    `<b>ORDER:</b> ${htmlEscape(execution.orderId || execution.positionId || "accepted, no id returned")}`,
  ];
}

function executedWatch(watch, execution) {
  const direction = watch.direction === "buy" ? "LONG" : "SHORT";
  const evidence = [
    "Entry zone rejection",
    `M5 ${watch.direction === "buy" ? "bullish" : "bearish"} MSS`,
    `${watch.direction === "buy" ? "bullish" : "bearish"} displacement`,
  ].join(" + ");
  return resolveWatch(
    watch,
    "EXECUTED",
    { resolvedPrice: execution.price, execution, signals: watch.lastSignals || [] },
    `<b>ENTRY CONFIRMED — ${htmlEscape(direction)}</b>${execution.dryRun ? " <i>(DRY RUN — no order was sent)</i>" : ""}\n` +
      `<b>Reason:</b> ${htmlEscape(evidence)}\n` +
      `<b>Execution:</b> ${htmlEscape(formatLevel(execution.price))} on ${htmlEscape(watch.symbol)}\n` +
      executionLogLines(watch, execution).join("\n"),
  );
}

/**
 * Confirmed, but no order was placed. The setup is still real — this is
 * the v6 outcome — so the human gets the same actionable alert plus the
 * exact reason the automated path stood down.
 */
function confirmedNotExecutedWatch(watch, price, result, gates, refusal) {
  return resolveWatch(
    watch,
    "CONFIRMED",
    {
      resolvedPrice: price,
      signals: result.signals,
      strength: result.strength,
      gates: gates.summary,
      execution: { submitted: false, refused: refusal.failures, reason: refusal.reason },
    },
    `<b>REAL CONFIRMATION — ENTER MANUALLY</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)}\n` +
      `<b>Direction:</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
      `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))} | <b>Price:</b> ${htmlEscape(formatLevel(price))}\n` +
      `<b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
      `<b>Evidence:</b> ${htmlEscape(result.signals.join(" + "))}\n` +
      `<b>Auto-trade stood down:</b> ${htmlEscape(refusal.reason)}\n` +
      (refusal.failures?.length
        ? `<b>Checks that failed:</b> ${htmlEscape(refusal.failures.map((failure) => `${failure.code} (${failure.detail})`).join(" | "))}\n`
        : "") +
      `<i>The setup is confirmed. The order was not placed.</i>`,
    "critical",
  );
}

/**
 * The one outcome that must never be quiet: an order left the process and
 * its fate is unknown. No retry, no assumption in either direction — the
 * human is told to look at the terminal.
 */
function executionUnknownWatch(watch, detail) {
  return resolveWatch(
    watch,
    "EXECUTION_UNKNOWN",
    { execution: { ...(watch.execution || {}), outcome: "UNKNOWN", detail } },
    `<b>⚠ ORDER OUTCOME UNKNOWN — CHECK YOUR TERMINAL NOW</b>\n` +
      `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())} ` +
      `${htmlEscape(String(watch.execution?.volume ?? "?"))} lot(s)\n` +
      `<b>Problem:</b> ${htmlEscape(detail)}\n` +
      `<b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
      `<b>Action:</b> an order was sent and the monitor could not read back whether it filled. ` +
      `Check the account manually. This watch is no longer monitored.`,
    "critical",
  );
}

function failWatch(watch, price, reason) {
  return resolveWatch(
    watch,
    "FAILED",
    { resolvedPrice: price, reason },
    `<b>SETUP FAILED</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)} (${htmlEscape(watch.direction)})\n` +
      `<b>Reason:</b> ${htmlEscape(reason)}\n` +
      `<b>Price:</b> ${htmlEscape(formatLevel(price))}\n<b>Action:</b> Do not enter.`,
  );
}

function expireWatch(watch, reason, price) {
  return resolveWatch(
    watch,
    "EXPIRED",
    { reason, resolvedPrice: price ?? null },
    `<b>SETUP EXPIRED</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)} (${htmlEscape(watch.direction)})\n` +
      `<b>Reason:</b> ${htmlEscape(reason)}\n` +
      (Number.isFinite(price) ? `<b>Price:</b> ${htmlEscape(formatLevel(price))}\n` : "") +
      `<b>Action:</b> Do not enter.`,
  );
}

function cancelWatchById(watchId, reason) {
  const watch = store.get(watchId);
  if (!watch) {
    // Idempotent by design: cancelling an already-resolved watch is a
    // reportable no-op, not an error. mcp_contract.md §7 previously
    // warned this was unverified; it is now specified.
    const resolved = store.resolved.get(watchId);
    if (resolved) {
      return { status: "ALREADY_RESOLVED", watch_id: watchId, resolution: resolved.status };
    }
    return null;
  }
  const kind = watch.kind || "SETUP";
  const ok = resolveWatch(
    watch,
    "CANCELLED",
    { reason },
    `<b>WATCH CANCELLED</b>\n` +
      `<b>${htmlEscape(watch.symbol)}</b> (${htmlEscape(kind)})\n` +
      `<b>Reason:</b> ${htmlEscape(reason)}`,
    "normal",
  );
  return ok
    ? { status: "CANCELLED", watch_id: watchId, kind }
    : { status: "ALREADY_RESOLVING", watch_id: watchId, kind };
}

// ---------------------------------------------------------------------------
// §4 Data quality
//
// A watch whose feed is unreliable is not a watch that has failed and not
// a watch that is fine. It is a watch that cannot be evaluated, and the
// human is told so once, with a recovery message when it clears.

function noteDataQuality(watch, ok, detail = null) {
  const now = Date.now();
  if (ok) {
    watch.lastGoodUpdateAt = now;
    watch.degradedSince = null;
    if (watch.degradedNotified) {
      watch.degradedNotified = false;
      notify(
        `<b>MONITORING RECOVERED</b>\n<b>${htmlEscape(watch.symbol)}</b> live data is stable again.`,
        { dedupeKey: `${watch.id}:recovered:${Math.floor(now / 60000)}` },
      );
    }
    return;
  }
  if (!watch.degradedSince) watch.degradedSince = now;
  if (now - watch.degradedSince >= staleBudget(watch) && !watch.degradedNotified) {
    watch.degradedNotified = true;
    notify(
      `<b>LIVE DATA DEGRADED</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> confirmation is paused` +
        `${detail ? `: ${htmlEscape(detail)}` : ""}.\n` +
        `<i>Safety checks continue whenever a usable price is available.</i>`,
      { dedupeKey: `${watch.id}:degraded`, priority: "critical" },
    );
  }
}

/**
 * Quarantine — the feed produced a price that cannot be reconciled with
 * the levels this watch was registered against. Nothing about this watch
 * can be evaluated safely, including its stop, so the only honest action
 * is to stop pretending it is monitored and say so loudly.
 */
function quarantine(watch, detail) {
  if (watch.lifecycle === "QUARANTINED") return;
  watch.lifecycle = "QUARANTINED";
  watch.lastReason = "quarantined_scale_mismatch";
  watch.quarantine = { detail, at: new Date().toISOString() };
  store.dirty = true;
  notify(
    `<b>⚠ WATCH QUARANTINED — NOT MONITORED</b>\n` +
      `<b>${htmlEscape(watch.symbol)}</b> (${htmlEscape(watch.kind || "SETUP")})\n` +
      `<b>Problem:</b> ${htmlEscape(detail)}\n` +
      `<b>Action:</b> this watch is NOT being monitored. Treat any position as unwatched, ` +
      `cancel the watch and re-run the pipeline.`,
    { dedupeKey: `${watch.id}:quarantine`, priority: "critical" },
  );
}

// ---------------------------------------------------------------------------
// §5 Gates

async function fetchNewsCalendar() {
  for (const url of CONFIG.newsFeedUrls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        log(`news ${url} returned HTTP ${response.status}`);
        continue;
      }
      const raw = await response.json();
      if (!Array.isArray(raw)) continue;
      return raw
        .map((event) => {
          const timestamp = numericTimestampMs(
            event.timestamp ?? event.date ?? event.datetime ?? event.time,
          );
          if (timestamp === null) return null;
          return {
            title: String(event.title || event.event || "").trim(),
            country: String(event.country || event.currency || "").trim().toUpperCase(),
            impact: String(event.impact || event.Impact || "").trim().toLowerCase(),
            timestamp,
          };
        })
        .filter(Boolean);
    } catch (error) {
      log(`news ${url} failed: ${error.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

async function getNewsCalendar() {
  const now = Date.now();
  if (now < newsCache.expiresAt) return newsCache.events;
  if (newsRefreshInFlight) return newsRefreshInFlight;
  newsRefreshInFlight = (async () => {
    const events = await fetchNewsCalendar();
    if (events !== null) {
      newsCache = {
        events,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + CONFIG.newsCacheTtlMs,
        lastError: null,
      };
    } else {
      newsCache.lastError = "All configured news feeds failed";
      newsCache.expiresAt = Date.now() + (newsCache.events.length ? 5 * 60 * 1000 : 60 * 1000);
    }
    return newsCache.events;
  })();
  try {
    return await newsRefreshInFlight;
  } finally {
    newsRefreshInFlight = null;
  }
}

async function newsStatusForWatch(watch, nowMs = Date.now()) {
  if (manualNewsLockout.active) {
    return { blocked: true, reason: manualNewsLockout.reason || "Manual lockout", source: "manual" };
  }
  if (!CONFIG.newsEnabled) return { blocked: false, source: "disabled" };
  const events = await getNewsCalendar();
  const hit = newsBlackout(events, symbolCurrencies(watch.symbol), nowMs, {
    before: CONFIG.newsBeforeMs,
    after: CONFIG.newsAfterMs,
    impacts: CONFIG.newsImpacts,
  });
  if (hit) {
    return {
      blocked: true,
      reason: `${hit.title || hit.country} (${hit.country})`,
      source: "scheduled",
    };
  }
  if (newsCache.lastError) {
    // Defaulting to fail-closed: an unknown news state during a
    // high-impact window is exactly when a confirmation is most likely to
    // be a liquidity artefact rather than a signal.
    return CONFIG.newsFailClosed
      ? { blocked: true, reason: newsCache.lastError, source: "unavailable" }
      : { blocked: false, source: "unavailable-fail-open" };
  }
  return { blocked: false, source: "scheduled" };
}

async function applyExternalGates(watch, spread) {
  const reasons = [];
  const session = killZoneStatus();
  if (CONFIG.killZoneEnabled && !session.active) {
    reasons.push(session.weekend ? "Weekend" : session.inLunch ? "NY Lunch" : "Outside kill zone");
  }
  const news = await newsStatusForWatch(watch);
  if (news.blocked) reasons.push(`News: ${news.reason}`);
  return {
    pass: reasons.length === 0,
    reasons,
    zone: session.zone,
    summary: { kill_zone: session, spread, news },
  };
}

// ---------------------------------------------------------------------------
// §6 Setup watch engine

/**
 * The two rules a setup may declare about its own validity, both of them
 * about closes rather than prints:
 *
 *   prerequisite   what must have happened before entry is live at all
 *                  ("M15 body close below 4324.71")
 *   invalidation   what kills the setup ("M15 body close above 4368.31")
 *
 * Both return an explicit unknown when the candles cannot be read, and
 * the caller treats unknown as "do not proceed" for the prerequisite and
 * "do not invalidate" for the invalidation — in both directions the
 * unknown answer is the one that does not open or abandon a position on
 * missing data.
 */
async function evaluateStructuralRules(watch, symbolId, nowMs) {
  const result = {
    prerequisite: { satisfied: true, known: true, detail: "no prerequisite declared" },
    invalidationConfirmed: watch.invalidation_rule === "body_close" ? null : undefined,
  };

  const series = async (timeframe) => {
    const raw = await market.bars(watch.symbol, symbolId, timeframe, 40);
    return closedSeries(raw || [], timeframe, { nowMs, staleBars: 3 });
  };

  if (watch.prerequisite) {
    const bars = await series(watch.prerequisite.timeframe);
    result.prerequisite =
      bars.status === "OK" && bars.bars.length
        ? evaluatePrerequisite(watch.prerequisite, bars.bars.slice(-30), { nowMs })
        : {
            satisfied: false,
            known: false,
            detail: `${watch.prerequisite.timeframe} candles unavailable (${bars.status})`,
          };
  }

  if (watch.invalidation_rule === "body_close") {
    const timeframe = watch.invalidation_timeframe || "M15";
    const bars = await series(timeframe);
    const span = periodMs(timeframe);
    const riskLine = watch.invalidation ?? watch.sl;
    if (bars.status === "OK" && bars.bars.length) {
      // Only bars that closed after this watch was armed can invalidate
      // it: an earlier close beyond the level is part of the history the
      // analyst already priced in.
      result.invalidationConfirmed = bars.bars.some(
        (bar) =>
          barClosedAfter(bar, span, watch.armedAtMs) &&
          bodyClosedBeyond(bar, riskLine, oppositeBias(watch.direction)),
      );
    } else {
      result.invalidationConfirmed = null;
    }
  }

  return result;
}

const SMT_BUNDLES = {
  XAUUSD: [{ symbol: "XAGUSD" }, { symbol: "EURUSD", inverse: true }],
  XAGUSD: [{ symbol: "XAUUSD" }, { symbol: "EURUSD", inverse: true }],
  BTCUSD: [{ symbol: "ETHUSD" }],
  ETHUSD: [{ symbol: "BTCUSD" }],
  USTEC: [{ symbol: "US500" }, { symbol: "US30" }],
  US30: [{ symbol: "US500" }, { symbol: "USTEC" }],
  US500: [{ symbol: "USTEC" }, { symbol: "US30" }],
  NAS100: [{ symbol: "US500" }],
  SPX500: [{ symbol: "USTEC" }],
  EURUSD: [{ symbol: "GBPUSD" }],
  GBPUSD: [{ symbol: "EURUSD" }],
};

async function tickSetupWatch(watch) {
  const now = Date.now();

  // Expiry is checked before anything that can fail, so an unreachable
  // upstream can never keep a watch alive past its own deadline.
  if (watch.expiresAt && now >= watch.expiresAt) {
    watch.lastReason = "expired";
    expireWatch(watch, "Watch expiration reached");
    return;
  }

  const bundle = SMT_BUNDLES[watch.symbol] || [];
  const wanted = [watch.symbol, ...bundle.map((item) => item.symbol)];
  const ids = await market.resolveSymbols(wanted);
  const mainId = ids.get(watch.symbol);
  if (mainId === undefined) {
    watch.lastReason = "symbol_unavailable";
    noteDataQuality(watch, false, "symbol is unavailable from cTrader");
    return;
  }

  // A watch that reached ORDER_SUBMITTED and is still being ticked means
  // the submission path did not finish — the process survived, but the
  // outcome was never written back. Resolve it against the account
  // rather than letting it sit in a state that keeps re-entering the
  // execution branch.
  if (watch.lifecycle === "ORDER_SUBMITTED" && watch.execution?.submitted && !watch.execution?.completed) {
    const positions = await executor.openPositions(watch.symbol, mainId);
    if (positions.known && positions.forSymbol.length) {
      watch.execution.completed = true;
      watch.execution.reconciled = true;
      watch.execution.positionId = positions.forSymbol[0].id;
      executedWatch(watch, watch.execution);
    } else {
      executionUnknownWatch(
        watch,
        positions.known
          ? "the submission did not complete and no matching position exists"
          : "the submission did not complete and open positions could not be read",
      );
    }
    return;
  }

  const spot = await market.spot(watch.symbol, mainId);
  if (!spot) {
    watch.lastReason = "spot_unavailable";
    noteDataQuality(watch, false, "live spot price unavailable");
    return;
  }

  const mid = (spot.bid + spot.ask) / 2;

  // Falsify the price scale against the level the pipeline computed
  // independently. If gold quotes come back at 0.044 against an entry of
  // 4414.69, every comparison below is meaningless and the watch must
  // stop, not "keep waiting for a touch that never comes".
  const scale = market.checkScale(mid, watch.entry);
  if (!scale.ok) {
    quarantine(
      watch,
      `feed price ${formatLevel(mid)} is irreconcilable with registered entry ${formatLevel(watch.entry)}` +
        (scale.impliedFactor ? ` (implied scale factor ${scale.impliedFactor})` : ""),
    );
    return;
  }

  const spread = spot.ask - spot.bid;
  const tolerance = priceTolerance(watch.symbol, mid);
  const executable = watch.direction === "buy" ? spot.ask : spot.bid;
  const protective = watch.direction === "buy" ? spot.bid : spot.ask;

  const spreadHealth = updateSpreadHealth(watch, spread, tolerance, mid, {
    enabled: CONFIG.spreadEnabled,
    baselineSamples: CONFIG.spreadBaselineSamples,
    historyMax: CONFIG.spreadHistoryMax,
    anomalyMultiplier: CONFIG.spreadAnomalyMultiplier,
    capOverride: finiteNumber(process.env[`SPREAD_CAP_${watch.symbol}`]),
  });
  watch.spreadSamples = spreadHealth.spreadSamples;

  // -- Safety first, in every lifecycle state -------------------------------
  //
  // v5 gated the entire tick on lifecycle ∈ {ARMED, TOUCHED}, so a watch
  // that reached CONFIRMING and was held by a gate stopped checking its
  // own stop loss, its invalidation, and its expiry — permanently. Safety
  // now runs before evidence, on every tick, in ARMED, TOUCHED and
  // CONFIRMING alike, and it runs even when the spread is abnormal: a bad
  // quote must not make the service ignore an adverse move.
  const rules = await evaluateStructuralRules(watch, mainId, now);
  const zone = entryZone(watch, tolerance);
  const safety = evaluateSafety(watch, {
    mid,
    executable,
    protective,
    tolerance,
    touchLevel: zoneTouchLevel(watch, tolerance),
    invalidationConfirmed: rules.invalidationConfirmed === true,
  });
  if (safety.action === "FAIL") {
    watch.lastReason = "risk_line_breached";
    failWatch(watch, safety.price, safety.reason);
    return;
  }
  if (safety.action === "EXPIRE") {
    watch.lastReason = "tp1_reached";
    expireWatch(watch, safety.reason, safety.price);
    return;
  }

  // The setup's own prerequisite gates everything downstream of it. An
  // untouched entry cannot be armed, and an unproven prerequisite is not
  // a satisfied one — but the safety checks above still ran, so an
  // adverse move is still caught while the setup waits.
  watch.prerequisiteSatisfied = rules.prerequisite.satisfied;
  watch.prerequisiteDetail = rules.prerequisite.detail;
  if (!rules.prerequisite.satisfied) {
    watch.lastReason = rules.prerequisite.known
      ? "waiting_for_setup_confirmation"
      : "prerequisite_unverifiable";
    noteDataQuality(watch, rules.prerequisite.known, rules.prerequisite.detail);
    return;
  }

  if (safety.action === "TOUCH") {
    watch.entryTouched = true;
    watch.entryTouchedAt = new Date().toISOString();
    watch.entryTouchedAtMs = now;
    watch.entryTouchPrice = safety.price;
    watch.sequence = emptySequence();
    watch.lifecycle = "TOUCHED";
    watch.lastReason = "entry_touched";
    store.dirty = true;
    notify(
      `<b>ENTRY TOUCHED</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        `<b>Zone:</b> ${htmlEscape(formatLevel(zone.low))}–${htmlEscape(formatLevel(zone.high))} | ` +
        `<b>Price:</b> ${htmlEscape(formatLevel(safety.price))}\n` +
        `<i>No entry yet. Waiting for rejection → M5 structure shift → displacement.</i>`,
      { dedupeKey: `${watch.id}:touched` },
    );
  } else if (safety.action === "WAIT") {
    watch.lastReason = "armed_waiting_for_touch";
    noteDataQuality(watch, !spreadHealth.abnormal);
    return;
  }

  // -- Evidence -------------------------------------------------------------
  const [m5raw, m1raw] = await Promise.all([
    market.bars(watch.symbol, mainId, "M5", 60),
    market.bars(watch.symbol, mainId, "M1", 80),
  ]);
  const m5 = closedSeries(m5raw || [], "M5", { nowMs: now });
  const m1 = closedSeries(m1raw || [], "M1", { nowMs: now, staleBars: 5 });
  if (m5.status !== "OK" || m1.status !== "OK" || m5.bars.length < 20 || m1.bars.length < 20) {
    watch.lastReason = `candles_${(m5.status !== "OK" ? m5.status : m1.status).toLowerCase()}`;
    noteDataQuality(
      watch,
      false,
      m5.status === "NO_TIMESTAMP" || m1.status === "NO_TIMESTAMP"
        ? "candle feed omitted bar timestamps; closure cannot be verified"
        : "insufficient or stale candle history",
    );
    return;
  }

  // Candle bodies and the live quote must describe the same instrument.
  // Disagreement here means one of the two feeds is wrong and neither can
  // be used as evidence.
  const barVsSpot = market.checkScale(m5.bars.at(-1).close, mid);
  if (!barVsSpot.ok) {
    watch.lastReason = "candle_spot_divergence";
    noteDataQuality(
      watch,
      false,
      `candle close ${formatLevel(m5.bars.at(-1).close)} disagrees with live mid ${formatLevel(mid)}`,
    );
    return;
  }

  const partners = [];
  for (const item of bundle) {
    const partnerId = ids.get(item.symbol);
    if (partnerId === undefined) continue;
    const bars = await market.bars(item.symbol, partnerId, "M5", 45);
    const series = closedSeries(bars || [], "M5", { nowMs: now });
    if (series.status === "OK" && series.bars.length >= 20) {
      partners.push({ symbol: item.symbol, bars: series.bars, inverse: item.inverse === true });
    }
  }

  watch.generation = advanceGeneration(watch.generation || { generation: 0 }, m1.latestCloseMs);
  const atrM5 = calcATR(m5.bars, 14);

  const signals = {
    cisd: checkCISD(m1.bars, watch.direction),
    smt: checkSMT(m5.bars, partners, watch.direction),
    engulfM5: classifyEngulfing(m5.bars, watch.direction, "M5"),
    engulfM1: classifyEngulfing(m1.bars, watch.direction, "M1"),
    wick: classifyWick(m5.bars.at(-1), atrM5, watch.direction),
    acceptance: checkAcceptance(watch, mid, protective, atrM5, tolerance, {
      atrFraction: CONFIG.acceptanceAtrFraction,
      riskFraction: CONFIG.acceptanceRiskFraction,
    }),
  };

  if (spreadHealth.abnormal) {
    // Evidence is not advanced on a bad quote — the acceptance term is
    // derived from bid/ask and would be measuring the spread, not the
    // market.
    watch.lastReason = "spread_abnormal";
    noteDataQuality(watch, false, `spread ${formatLevel(spread)} exceeds cap ${formatLevel(spreadHealth.cap)}`);
    return;
  }
  noteDataQuality(watch, true);

  // -- The post-touch entry sequence ----------------------------------------
  //
  // Rejection → M5 structure shift → displacement, each proven on a bar
  // that closed after the touch, in that order. This runs alongside the
  // evidence machine rather than replacing it: the evidence machine
  // proves the read persisted under observation, the sequence proves it
  // is the read the setup actually described.
  const lastM5 = m5.bars.at(-1);
  const touchedAtMs =
    finiteNumber(watch.entryTouchedAtMs) ??
    (watch.entryTouchedAt ? Date.parse(watch.entryTouchedAt) : null);
  const fadeBuffer = Math.max(tolerance, atrM5 * CONFIG.entryFadeAtrFraction);
  const faded =
    watch.direction === "buy" ? mid < zone.low - fadeBuffer : mid > zone.high + fadeBuffer;
  const displacement = barClosedAfter(lastM5, PERIOD_MS.M5, touchedAtMs)
    ? displacementCheck(
        m5.bars,
        watch.direction,
        CONFIG.entryDisplacementMultiple,
        CONFIG.entryDisplacementLookback,
      )
    : { present: false, body: null, threshold: null };

  watch.sequence = advanceEntrySequence(
    watch.sequence,
    {
      faded,
      fadedReason: faded ? `price left the entry zone by more than ${formatLevel(fadeBuffer)}` : null,
      rejection: checkZoneRejection(lastM5, watch, zone, atrM5, PERIOD_MS.M5, touchedAtMs),
      mss: checkMSS(m5.bars, watch.direction, PERIOD_MS.M5, touchedAtMs, {
        strength: CONFIG.entryMssSwingStrength,
      }),
      mssTimeframe: "M5",
      displacement,
      displacementCandle: displacement.present
        ? {
            timestampMs: lastM5.timestampMs,
            open: lastM5.open,
            high: lastM5.high,
            low: lastM5.low,
            close: lastM5.close,
          }
        : null,
      barKey: barKey(lastM5),
    },
    { nowIso: new Date(now).toISOString() },
  );
  const sequenceReady = !CONFIG.entrySequenceRequired || watch.sequence.complete;

  const result = evaluateConfirmation(watch, signals, {
    mid,
    tolerance,
    nowMs: now,
    generation: watch.generation.generation,
    hasBarTime: watch.generation.hasBarTime,
    minHoldMs: CONFIG.minConfirmationHoldMs,
    requireNewBar: CONFIG.requireNewBar,
  });
  watch.evidence = result.evidence;
  watch.lastSignals = result.signals;
  store.dirty = true;

  if (!result.enter || !sequenceReady) {
    // Evidence that had graduated and then decayed must walk the
    // lifecycle backwards, visibly, rather than leaving the watch parked
    // in CONFIRMING with nothing behind it.
    if (watch.lifecycle === "CONFIRMING") {
      watch.lifecycle = "TOUCHED";
      watch.lastReason = "evidence_decayed";
      watch.lastGateBlockReason = null;
    } else if (!sequenceReady) {
      watch.lastReason = !watch.sequence.rejection
        ? "awaiting_zone_rejection"
        : !watch.sequence.mss
          ? "awaiting_m5_structure_shift"
          : "awaiting_displacement";
    } else {
      watch.lastReason = "evidence_pending";
    }
    return;
  }

  watch.lifecycle = "CONFIRMING";
  watch.lastReason = "awaiting_gates";

  const gates = await applyExternalGates(watch, spread);
  if (gates.pass) {
    watch.lifecycle = "ENTRY_CONFIRMED";
    watch.confirmedAt = new Date(now).toISOString();
    watch.confirmedAtMs = now;
    watch.lastReason = "entry_confirmed";
    store.dirty = true;

    const auto = autoTradeStatus();
    if (!auto.armed) {
      // v6 behaviour, unchanged, and it is still the default: the human
      // is told to enter and nothing is sent to the broker.
      confirmWatch(watch, mid, result, gates);
      return;
    }
    await executeConfirmedWatch(watch, {
      mid,
      spot,
      symbolId: mainId,
      result,
      gates,
      nowMs: now,
      dryRun: auto.dryRun === true,
    });
    return;
  }
  const reasonText = gates.reasons.join(" | ");
  if (watch.lastGateBlockReason !== reasonText) {
    watch.lastGateBlockReason = reasonText;
    watch.lastReason = "gate_blocked";
    notify(
      `<b>TECHNICALLY CONFIRMED — WAITING ON GATE</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        `<b>Evidence:</b> ${htmlEscape(result.signals.join(" + "))}\n` +
        `<b>Blocked by:</b> ${htmlEscape(reasonText)}`,
      { dedupeKey: `${watch.id}:gate:${reasonText}` },
    );
  }
}

// ---------------------------------------------------------------------------
// §6b Order execution
//
// Reached only from the confirmation branch above, only for a SETUP
// watch whose entry sequence completed after its own touch and whose
// gates passed, and only when auto-trade is armed at the environment
// level. Everything here is written so that the failure modes rank in
// this order, worst first:
//
//   1. two orders for one setup        — prevented by a single-shot
//                                        submission flag persisted
//                                        BEFORE the call leaves
//   2. an order whose fate is unknown  — never assumed; reconciled
//                                        against open positions, and if
//                                        that cannot be read, resolved
//                                        EXECUTION_UNKNOWN and shouted
//   3. no order when there should be   — resolves CONFIRMED, which is
//                                        the v6 behaviour and a Telegram
//                                        message the human can act on
//
// Anything that cannot be established counts as a refusal, so the third
// outcome absorbs every unknown the first two do not.

const tradeCounter = { day: null, count: 0 };

function todayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function tradesToday(nowMs) {
  const day = todayKey(nowMs);
  if (tradeCounter.day !== day) {
    tradeCounter.day = day;
    tradeCounter.count = 0;
  }
  return tradeCounter.count;
}

function recordTrade(nowMs) {
  tradesToday(nowMs);
  tradeCounter.count += 1;
}

function refuse(watch, reason, failures, context) {
  confirmedNotExecutedWatch(watch, context.mid, context.result, context.gates, { reason, failures });
}

async function executeConfirmedWatch(watch, context) {
  const config = CONFIG.autoTrade;
  const { symbolId, nowMs, dryRun } = context;
  watch.execution = watch.execution || { attempts: 0, submitted: false };

  if (watch.execution.submitted) {
    // Belt and braces: the scheduler cannot re-enter a submitted watch,
    // but if it ever did, this is the line that stops a second order.
    watch.lastReason = "order_already_submitted";
    return;
  }
  if (config.symbolAllowlist.size && !config.symbolAllowlist.has(watch.symbol)) {
    refuse(watch, `${watch.symbol} is not in AUTO_TRADE_SYMBOLS`, [], context);
    return;
  }
  if (watch.auto_trade === false) {
    refuse(watch, "this setup was registered with auto_trade disabled", [], context);
    return;
  }

  // -- Facts the checklist needs -------------------------------------------
  const account = config.mode === "risk" ? await executor.balance() : { known: true, balance: null };
  const positions = await executor.openPositions(watch.symbol, symbolId);

  const sizing = computeOrderVolume({
    mode: config.mode,
    fixedVolume: config.fixedVolume,
    explicitVolume: watch.volume ?? null,
    balance: account.balance ?? null,
    riskPercent: watch.risk_percent ?? config.riskPercent,
    entry: watch.entry,
    stop: watch.sl,
    symbol: watch.symbol,
    accountCurrency: config.accountCurrency,
    contractSizes: config.contractSizes,
    minVolume: config.minVolume,
    maxVolume: config.maxVolume,
    volumeStep: config.volumeStep,
  });
  const connectorVolume =
    sizing.volume === null
      ? null
      : volumeInConnectorUnits(sizing.volume, watch.symbol, config.volumeUnit, config.contractSizes);

  // The quote the order is checked against is fetched fresh, not reused
  // from the top of the tick: seconds matter here and a cached mid is
  // exactly the kind of stale input this service refuses elsewhere.
  // There is deliberately no fallback to the tick's cached quote: if the
  // upstream cannot produce a live price at the moment of submission,
  // the confirmation is not backed by live market data and the checklist
  // must be able to see that.
  const fetchedAtMs = Date.now();
  const fresh = await market.spot(watch.symbol, symbolId, { maxAgeMs: 0 });
  const price = fresh ? (watch.direction === "buy" ? fresh.ask : fresh.bid) : null;
  const priceAgeMs = fresh
    ? finiteNumber(fresh.timestampMs) !== null
      ? Date.now() - fresh.timestampMs
      : Date.now() - fetchedAtMs
    : null;
  const riskDistance = Math.abs(watch.entry - (watch.invalidation ?? watch.sl));

  const preflight = preflightExecution({
    watch,
    symbol: watch.symbol,
    symbolId,
    direction: watch.direction,
    price,
    priceAgeMs,
    maxPriceAgeMs: config.maxPriceAgeMs,
    confirmationPrice: context.mid,
    maxDeviation: riskDistance * config.maxSlippageRiskFraction,
    sl: watch.sl,
    tp: watch.tp1,
    volume: sizing.volume,
    volumeReason: sizing.reason,
    connectorVolume,
    riskAmount: sizing.riskAmount ?? null,
    balance: account.balance ?? null,
    maxRiskPercent: config.maxRiskPercent,
    positionsKnown: positions.known,
    // A position the connector reports without an id is still a position.
    existingPosition:
      positions.known && positions.forSymbol.length
        ? positions.forSymbol[0].id || "an open position with no id"
        : null,
    openPositionCount: positions.known ? positions.list.length : undefined,
    maxOpenPositions: config.maxOpenPositions,
    tradesToday: tradesToday(nowMs),
    maxTradesPerDay: config.maxTradesPerDay,
    alreadySubmitted: watch.execution.submitted === true,
    touchedAtMs: finiteNumber(watch.entryTouchedAtMs),
    confirmedAtMs: finiteNumber(watch.confirmedAtMs),
    sequenceComplete: Boolean(watch.sequence?.complete),
    liveData: Boolean(fresh),
  });

  if (!preflight.ok) {
    watch.execution.attempts += 1;
    watch.execution.lastFailures = preflight.failures;
    const canRetry = preflight.retryable && watch.execution.attempts < config.maxAttempts;
    if (canRetry) {
      // A stale quote or an unreadable positions call is a reason to look
      // again on the next tick, not a reason to abandon a confirmed
      // setup. The lifecycle steps back so the sequence keeps being
      // re-proven while it waits.
      watch.lifecycle = "CONFIRMING";
      watch.lastReason = "execution_retry";
      log(
        `watch ${watch.id} execution deferred (${preflight.failures.map((failure) => failure.code).join(",")})`,
      );
      return;
    }
    refuse(
      watch,
      preflight.retryable
        ? `pre-submission checks did not clear after ${watch.execution.attempts} attempts`
        : "a pre-submission check failed",
      preflight.failures,
      context,
    );
    return;
  }

  // -- Single-shot submission ----------------------------------------------
  //
  // The flag is written and flushed to disk before the request leaves the
  // process. A crash between here and the response therefore comes back
  // as "submitted, outcome unknown" on the next boot, which is
  // reconcilable — rather than as a re-armed watch that submits again.
  const label = `${config.labelPrefix}-${(watch.setup_id || watch.id).slice(0, 24)}`;
  watch.execution = {
    ...watch.execution,
    submitted: true,
    completed: false,
    submittedAt: new Date().toISOString(),
    label,
    volume: sizing.volume,
    connectorVolume,
    volumeUnit: config.volumeUnit,
    volumeBasis: sizing.basis,
    riskAmount: sizing.riskAmount ?? null,
    accountCurrency: config.accountCurrency,
    balance: account.balance ?? null,
    price,
    dryRun,
  };
  watch.lifecycle = "ORDER_SUBMITTED";
  watch.lastReason = "order_submitted";
  store.dirty = true;
  scheduleSave(true);

  const submission = await executor.submit({
    symbol: watch.symbol,
    symbolId,
    direction: watch.direction,
    volume: connectorVolume,
    stopLoss: watch.sl,
    takeProfit: watch.tp1,
    label,
    dryRun,
  });

  if (submission.ok) {
    watch.execution.completed = true;
    watch.execution.orderId = submission.orderId ?? null;
    watch.execution.positionId = submission.positionId ?? null;
    watch.execution.tool = submission.tool;
    watch.execution.args = submission.args;
    recordTrade(nowMs);
    executedWatch(watch, watch.execution);
    return;
  }

  // A deterministic rejection means nothing was opened; the setup falls
  // back to the manual path with the broker's own reason attached.
  if (submission.code === "REJECTED" || submission.code === "PAYLOAD_INCOMPLETE" || submission.code === "NO_ORDER_TOOL") {
    watch.execution.completed = true;
    watch.execution.submitted = false;
    watch.execution.error = submission.error;
    refuse(
      watch,
      `the broker did not accept the order: ${submission.error}`,
      [{ code: submission.code, detail: submission.error }],
      context,
    );
    return;
  }

  // A transport failure is the ambiguous case: the order may or may not
  // have reached the broker. Never retried blindly — reconciled.
  const after = await executor.openPositions(watch.symbol, symbolId);
  if (after.known && after.forSymbol.length) {
    watch.execution.completed = true;
    watch.execution.reconciled = true;
    watch.execution.positionId = after.forSymbol[0].id;
    watch.execution.error = submission.error;
    recordTrade(nowMs);
    executedWatch(watch, watch.execution);
    return;
  }
  if (after.known) {
    // Provably nothing opened, so retrying is safe.
    watch.execution.submitted = false;
    watch.execution.completed = false;
    watch.execution.attempts += 1;
    watch.execution.error = submission.error;
    if (watch.execution.attempts < config.maxAttempts) {
      watch.lifecycle = "CONFIRMING";
      watch.lastReason = "execution_retry_after_transport_error";
      store.dirty = true;
      return;
    }
    refuse(
      watch,
      `the order could not be sent after ${watch.execution.attempts} attempts: ${submission.error}`,
      [{ code: submission.code || "UPSTREAM_ERROR", detail: submission.error }],
      context,
    );
    return;
  }
  executionUnknownWatch(
    watch,
    `${submission.error}; open positions could not be read back to establish whether the order landed`,
  );
}

// ---------------------------------------------------------------------------
// §7 Trap watch engine
//
// A trap watch is not a trade. It monitors one falsifiable statement —
// a body close beyond the re-entry trigger, normally carried by a
// displacement candle — and resolves by handing the question back to the
// pipeline. It never emits an entry, a stop or a target.

function trapHeader(watch) {
  return `<b>${htmlEscape(watch.symbol)}</b> — ${htmlEscape(watch.bias.toUpperCase())} bias · ${htmlEscape(watch.timeframe)}\n`;
}

async function tickTrapWatch(watch) {
  const now = Date.now();
  if (watch.expiresAt && now >= watch.expiresAt) {
    watch.lastReason = "expired";
    resolveWatch(
      watch,
      "EXPIRED",
      { reason: "Trap watch expiration reached" },
      `<b>TRAP WATCH EXPIRED</b>\n` +
        trapHeader(watch) +
        `<b>Trigger never printed:</b> ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
        `<i>Re-run the pipeline from scratch if you still want this instrument.</i>`,
      "normal",
    );
    return;
  }

  const ids = await market.resolveSymbols([watch.symbol]);
  const symbolId = ids.get(watch.symbol);
  if (symbolId === undefined) {
    watch.lastReason = "symbol_unavailable";
    noteDataQuality(watch, false, "symbol is unavailable from cTrader");
    return;
  }

  const span = periodMs(watch.timeframe);
  const raw = await market.bars(watch.symbol, symbolId, watch.timeframe, 40);
  const series = closedSeries(raw || [], watch.timeframe, { nowMs: now, staleBars: 3 });
  if (series.status !== "OK" || series.bars.length < 5) {
    watch.lastReason = `candles_${series.status.toLowerCase()}`;
    noteDataQuality(
      watch,
      false,
      series.status === "NO_TIMESTAMP"
        ? "candle feed omitted bar timestamps; a closed body cannot be proven"
        : "insufficient or stale candle history",
    );
    return;
  }
  const closed = series.bars;
  const current = closed.at(-1);

  const spot = await market.spot(watch.symbol, symbolId);
  const price = spot ? (spot.bid + spot.ask) / 2 : current.close;

  const scale = market.checkScale(price, watch.trigger_level);
  if (!scale.ok) {
    quarantine(
      watch,
      `feed price ${formatLevel(price)} is irreconcilable with trigger level ${formatLevel(watch.trigger_level)}`,
    );
    return;
  }
  noteDataQuality(watch, true);
  watch.lastPrice = price;

  const atr = calcATR(closed, 14);
  const approachDistance = Math.max(
    priceTolerance(watch.symbol, price),
    atr * CONFIG.trapApproachAtrFraction,
  );
  const approaching =
    watch.bias === "buy"
      ? price >= watch.trigger_level - approachDistance && price < watch.trigger_level
      : price <= watch.trigger_level + approachDistance && price > watch.trigger_level;
  if (approaching && !watch.approachNotified) {
    watch.approachNotified = true;
    watch.lastReason = "approaching";
    store.dirty = true;
    notify(
      `<b>TRAP TRIGGER APPROACHING</b>\n` +
        trapHeader(watch) +
        `<b>Price:</b> ${htmlEscape(formatLevel(price))} → <b>trigger</b> ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
        `<i>No action yet. Waiting for a ${htmlEscape(watch.timeframe)} body close beyond it.</i>`,
      { dedupeKey: `${watch.id}:approach` },
    );
  }

  // A bar that closed before this watch was armed is history, not a
  // signal — the analysis that produced the trigger already saw it.
  const closeTimeMs = current.timestampMs + span;
  if (closeTimeMs < watch.armedAtMs) {
    watch.lastReason = "awaiting_post_arm_candle";
    return;
  }

  const key = barKey(current);
  if (key === null) {
    watch.lastReason = "unidentifiable_candle";
    noteDataQuality(watch, false, "candle has no usable identity");
    return;
  }
  if (watch.lastEvaluatedCandle === key) {
    watch.lastReason = "awaiting_new_closed_candle";
    return;
  }
  watch.lastEvaluatedCandle = key;
  watch.lastReason = "evaluating_closed_candle";
  store.dirty = true;

  // The flip is tested first: if the read broke the other way, the
  // trigger is no longer the relevant question. Testing them in the other
  // order would let a single bar that closed through both levels report
  // CONDITIONS_MET on a thesis that had already died.
  if (
    watch.invalidation_level !== null &&
    bodyClosedBeyond(current, watch.invalidation_level, oppositeBias(watch.bias))
  ) {
    watch.lastReason = "flipped";
    resolveWatch(
      watch,
      "FLIPPED",
      { reason: "Invalidation level closed through against the bias", resolvedPrice: current.close },
      `<b>TRAP READ FLIPPED</b>\n` +
        trapHeader(watch) +
        `<b>${htmlEscape(watch.timeframe)} close:</b> ${htmlEscape(formatLevel(current.close))} through ${htmlEscape(formatLevel(watch.invalidation_level))}\n` +
        (watch.flip_note ? `<b>Opens:</b> ${htmlEscape(watch.flip_note)}\n` : "") +
        `<b>Action:</b> the ${htmlEscape(watch.bias.toUpperCase())} read is dead. Do not enter. ` +
        `Re-run the pipeline if you want the other side.`,
    );
    return;
  }

  if (!bodyClosedBeyond(current, watch.trigger_level, watch.bias)) {
    watch.lastReason = "awaiting_trigger";
    return;
  }

  const displacement = displacementCheck(
    closed,
    watch.bias,
    CONFIG.trapDisplacementMultiple,
    CONFIG.trapDisplacementLookback,
  );
  const fvg = fvgCheck(closed, watch.bias);
  const missing = [];
  if (watch.require_displacement && !displacement.present) missing.push("displacement");
  if (watch.require_fvg && !fvg.present) missing.push("FVG");

  if (missing.length) {
    watch.partialCount = (watch.partialCount || 0) + 1;
    // Bounded, not one-shot: the second and third time the level is taken
    // without delivery is information, but the tenth is noise.
    if (watch.partialCount <= 2) {
      watch.lastReason = "trigger_level_taken_conditions_incomplete";
      notify(
        `<b>TRIGGER LEVEL TAKEN — CONDITIONS INCOMPLETE</b>\n` +
          trapHeader(watch) +
          `<b>${htmlEscape(watch.timeframe)} close:</b> ${htmlEscape(formatLevel(current.close))} beyond ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
          `<b>Still missing:</b> ${htmlEscape(missing.join(" + "))}\n` +
          (displacement.body !== null
            ? `<b>Body:</b> ${htmlEscape(formatLevel(displacement.body))} vs ${htmlEscape(formatLevel(displacement.threshold))} required\n`
            : "") +
          `<i>Still watching. No entry.</i>`,
        { dedupeKey: `${watch.id}:partial:${key}` },
      );
    } else {
      watch.lastReason = "still_missing_conditions";
    }
    return;
  }

  const session = killZoneStatus();
  const news = await newsStatusForWatch(watch);
  const ageHours = (now - watch.armedAtMs) / 3_600_000;
  watch.lastReason = "conditions_met";
  resolveWatch(
    watch,
    "CONDITIONS_MET",
    {
      reason: "Trigger close with required delivery",
      resolvedPrice: current.close,
      displacement,
      fvg,
      session,
      news,
      context_age_hours: Number(ageHours.toFixed(2)),
    },
    `<b>TRAP CONDITIONS MET — RE-RUN THE PIPELINE</b>\n` +
      trapHeader(watch) +
      `<b>${htmlEscape(watch.timeframe)} close:</b> ${htmlEscape(formatLevel(current.close))} beyond ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
      (displacement.present
        ? `<b>Displacement:</b> body ${htmlEscape(formatLevel(displacement.body))} vs ${htmlEscape(formatLevel(displacement.threshold))} required\n`
        : "") +
      (fvg.present
        ? `<b>FVG:</b> ${htmlEscape(formatLevel(fvg.from))} – ${htmlEscape(formatLevel(fvg.to))}\n`
        : "") +
      (watch.what_is_missing ? `<b>Was missing:</b> ${htmlEscape(watch.what_is_missing)}\n` : "") +
      (watch.trigger_note ? `<b>Note:</b> ${htmlEscape(watch.trigger_note)}\n` : "") +
      `<b>Session:</b> ${htmlEscape(session.zone || (session.inLunch ? "NY Lunch" : "outside kill zone"))} | ` +
      `<b>News:</b> ${htmlEscape(news.blocked ? news.reason : "clear")}\n` +
      `<b>Context age:</b> ${htmlEscape(ageHours.toFixed(1))}h` +
      (ageHours > 8 ? ` — <b>stale, re-derive every level from live data</b>` : "") +
      `\n<b>Action:</b> re-run the sniper pipeline on ${htmlEscape(watch.symbol)}. ` +
      `This watch produces no entry, SL or TP.`,
  );
}

// ---------------------------------------------------------------------------
// §8 Scheduler
//
// One timer for the whole service. v5 created a setInterval per watch,
// which meant N watches produced N uncoordinated upstream bursts, N
// independent chances to trip a session reset, and a timer leak on any
// path that forgot to clear. Here each watch carries nextDueAt and the
// scheduler drains what is due, serially per watch, with the market-data
// layer coalescing shared symbol lookups across all of them.

let schedulerTimer = null;
let schedulerRunning = false;

async function runDueWatches() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const now = Date.now();
  try {
    const due = [...store.active(), ...store.activeTraps()].filter(
      (watch) =>
        !watch.monitorRunning &&
        watch.lifecycle !== "RESOLVED" &&
        watch.lifecycle !== "RESOLVING" &&
        watch.lifecycle !== "QUARANTINED" &&
        (watch.nextDueAt ?? 0) <= now,
    );
    for (const watch of due) {
      watch.monitorRunning = true;
      const cadence = watch.kind === "TRAP" ? CONFIG.trapIntervalMs : CONFIG.setupIntervalMs;
      try {
        if (watch.kind === "TRAP") await tickTrapWatch(watch);
        else await tickSetupWatch(watch);
      } catch (error) {
        log(`watch ${watch.id} failed safely: ${error.message}`);
        noteDataQuality(watch, false, "monitor tick failed");
      } finally {
        watch.monitorRunning = false;
        watch.lastTickAt = new Date().toISOString();
        // Scheduled from completion, not from start: a slow upstream
        // cannot cause ticks to pile up on top of each other.
        watch.nextDueAt = Date.now() + cadence;
      }
    }
    await notifier.drain();
    if (store.dirty) scheduleSave();
  } finally {
    schedulerRunning = false;
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => void runDueWatches(), CONFIG.tickMs);
}

// ---------------------------------------------------------------------------
// §9 Tool surface

const CUSTOM_TOOLS = [
  {
    name: "register_watch",
    description:
      "Registers a trading setup for live monitoring and, when the operator has armed auto-trade, for automatic execution. The monitor tracks live price and safety levels, waits for the entry zone to be touched, and then requires the full post-touch sequence — zone rejection, an M5 market-structure shift, and displacement — plus persistent evidence and the kill-zone/news/spread gates before it acts. A touch alone, a wick into the zone, a single candle, or an MSS without displacement never triggers an entry. If auto-trade is not armed, the confirmation is sent to Telegram for the human to take.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        setup_id: { type: "string" },
        symbol: { type: "string", description: "For example XAUUSD or BTCUSD." },
        direction: { type: "string", enum: ["buy", "sell"] },
        state: { type: "string", enum: ["WAIT", "ENGAGE", "ACTIVE"] },
        entry: { type: "number" },
        entry_zone_low: {
          type: "number",
          description:
            "Lower bound of the entry zone, e.g. 4330 for a 4330.00–4334.00 zone. The zone is touched at the edge price approaches from, not at its midpoint.",
        },
        entry_zone_high: { type: "number", description: "Upper bound of the entry zone." },
        sl: { type: "number" },
        invalidation: { type: "number" },
        invalidation_rule: {
          type: "string",
          enum: ["touch", "body_close"],
          description:
            "How the invalidation level dies. body_close means a wick through the level is not invalidation — only a closed body beyond it on invalidation_timeframe is. The stop loss stays a hard price line either way.",
        },
        invalidation_timeframe: { type: "string", enum: TRAP_TIMEFRAMES },
        prerequisite_level: {
          type: "number",
          description:
            "A level the setup requires before entry is live at all, e.g. 4324.71 for 'M15 body close below 4324.71'. Until it prints, the watch reports WAITING_FOR_SETUP_CONFIRMATION and no touch is armed.",
        },
        prerequisite_timeframe: { type: "string", enum: TRAP_TIMEFRAMES },
        prerequisite_rule: { type: "string", enum: ["body_close", "touch"] },
        prerequisite_direction: { type: "string", enum: ["buy", "sell"] },
        prerequisite_note: { type: "string" },
        tp1: { type: "number" },
        tp2: { type: "number" },
        tp3: { type: "number" },
        risk_percent: {
          type: "number",
          description: "Per-setup override of the account risk percentage used to size the order.",
        },
        volume: {
          type: "number",
          description: "Explicit lot size for this setup, overriding both fixed and risk-based sizing.",
        },
        auto_trade: {
          type: "boolean",
          description:
            "Set false to monitor this setup without ever executing it, even while auto-trade is armed. Setting true does not arm auto-trade; only the operator's environment can do that.",
        },
        setup_model: { type: "string" },
        conviction: { type: "string" },
        session: { type: "string" },
        season: { type: "string" },
        liquidity: { oneOf: [{ type: "string" }, { type: "object" }, { type: "array" }] },
        expiration_minutes: { type: "number" },
      },
      required: ["symbol", "direction", "entry", "sl", "tp1"],
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "register_trap_watch",
    description:
      "Registers a TRAP_NOT_CONFIRMED read for live monitoring. There is no entry, stop or target: the monitor watches closed candles on the chosen timeframe and sends one Telegram message when the missing setup conditions actually print (body close beyond trigger_level, by default carried by a displacement candle), and one if invalidation_level breaks first instead. It never produces an entry — the human re-runs the analysis pipeline on that notification.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        setup_id: { type: "string" },
        symbol: { type: "string" },
        bias: { type: "string", enum: ["buy", "sell"] },
        timeframe: { type: "string", enum: TRAP_TIMEFRAMES },
        trigger_level: { type: "number" },
        invalidation_level: { type: "number" },
        require_displacement: { type: "boolean" },
        require_fvg: { type: "boolean" },
        trap_sub_type: { type: "string" },
        trap_active: { type: "string" },
        trap_score: { type: "string" },
        collection_grade: { type: "string" },
        what_is_missing: { type: "string" },
        dol: { type: "string" },
        trigger_note: { type: "string" },
        flip_note: { type: "string" },
        session: { type: "string" },
        expiration_minutes: { type: "number" },
      },
      required: ["symbol", "bias", "trigger_level"],
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "list_watches",
    description:
      "Returns active setup watches, active trap watches, quarantined watches, bounded recent outcomes with their real status and evidence, and the monitor's own health (restart recovery, undelivered notifications, feed quality).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "cancel_watch",
    description:
      "Cancels an active setup watch or trap watch by id. Idempotent: cancelling an already-resolved watch reports ALREADY_RESOLVED rather than failing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { watch_id: { type: "string" }, reason: { type: "string" } },
      required: ["watch_id"],
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "get_news_calendar",
    description:
      "Returns the cached scheduled high-impact economic events and current manual news lockout state.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "set_news_lockout",
    description:
      "Blocks new confirmations while a human or upstream workflow reports unscheduled breaking news.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "clear_news_lockout",
    description: "Removes the manual breaking-news lockout.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "get_auto_trade_status",
    description:
      "Reports whether the monitor is armed to place orders on confirmation, the sizing and connector settings it would use, which upstream execution tools it discovered, and how many trades it has executed today.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "pause_auto_trade",
    description:
      "Kill switch. Stops the monitor placing any further orders; watches keep being monitored and confirmations keep arriving on Telegram for manual entry. Reversible with resume_auto_trade. It can never arm auto-trade — only the operator's environment can do that.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string" } },
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "resume_auto_trade",
    description:
      "Lifts a pause set by pause_auto_trade. If auto-trade was never armed in the environment, this reports that it is still off.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true }
  },
];
const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map((tool) => tool.name));

// Claude-facing exposure: MARKET DATA only, unchanged by auto-trade. The
// account and execution tools the upstream exposes remain unreachable
// from this endpoint. Enforced twice — once when building tools/list so
// a client never learns the tool exists, and again on tools/call so a
// guessed name cannot be invoked.
//
// The monitor's own loop is a separate code path and is NOT filtered by
// this list: besides the three market-data reads it calls the balance,
// positions and order tools (lib/execution.mjs). That asymmetry is the
// design. A client can ask this server to watch a setup; only the
// server, having watched it to a complete confirmation sequence, can ask
// the broker for a position. Widening this list would hand that decision
// back to whoever holds the endpoint's token, which is the one thing the
// arrangement is meant to prevent.
const MARKET_DATA_TOOL_ALLOWLIST = new Set([
  "get_version",
  "get_symbols",
  "get_spot_prices",
  "get_trendbars",
]);

function filterToMarketData(tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) =>
    MARKET_DATA_TOOL_ALLOWLIST.has(tool?.name),
  );
}

function createSetupWatch(args) {
  const input = validateWatchInput(args);
  const dedupeKey = watchKey(input);
  const existing = store.findByDedupeKey("SETUP", dedupeKey);
  if (existing) return { watch: existing, duplicate: true };
  const now = Date.now();
  const watch = store.add({
    id: `${input.symbol}_${now}_${randomUUID().slice(0, 8)}`,
    kind: "SETUP",
    lifecycle: "ARMED",
    status: "ARMED",
    dedupeKey,
    ...input,
    entryTouched: false,
    entryTouchedAt: null,
    evidence: {},
    generation: { lastBarTimeMs: null, generation: 0, hasBarTime: false },
    spreadSamples: [],
    lastGoodUpdateAt: null,
    degradedSince: null,
    degradedNotified: false,
    lastGateBlockReason: null,
    createdAt: new Date(now).toISOString(),
    armedAtMs: now,
    expiresAt: input.expiration_minutes ? now + input.expiration_minutes * 60_000 : null,
    lastReason: "armed",
    monitorRunning: false,
    nextDueAt: now,
  });
  scheduleSave(true);
  void runDueWatches();
  return { watch, duplicate: false };
}

function createTrapWatch(args) {
  const input = validateTrapWatchInput(args, { trapExpiryMinutes: CONFIG.trapExpiryMinutes });
  const dedupeKey = trapWatchKey(input);
  const existing = store.findByDedupeKey("TRAP", dedupeKey);
  if (existing) return { watch: existing, duplicate: true };
  const now = Date.now();
  const watch = store.add({
    id: `TRAP_${input.symbol}_${now}_${randomUUID().slice(0, 8)}`,
    kind: "TRAP",
    lifecycle: "ARMED",
    status: "ARMED",
    dedupeKey,
    ...input,
    armedAtMs: now,
    lastEvaluatedCandle: null,
    approachNotified: false,
    partialCount: 0,
    lastPrice: null,
    lastGoodUpdateAt: null,
    degradedSince: null,
    degradedNotified: false,
    createdAt: new Date(now).toISOString(),
    expiresAt: input.expiration_minutes ? now + input.expiration_minutes * 60_000 : null,
    lastReason: "armed",
    monitorRunning: false,
    nextDueAt: now,
  });
  scheduleSave(true);
  void runDueWatches();
  return { watch, duplicate: false };
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Everything a human needs to answer "would this place a trade right
 * now, with what size, through which tool?" — including the three
 * connector conventions that cannot be verified from inside this
 * process and therefore have to be read and confirmed by a person.
 */
async function autoTradeReport() {
  const config = CONFIG.autoTrade;
  const status = autoTradeStatus();
  const tools = status.armed ? await executor.resolveTools() : executor.resolved;
  return {
    ...status,
    dry_run: config.dryRun,
    confirmation_phrase_required: AUTO_TRADE_CONFIRMATION_PHRASE,
    sizing: {
      mode: config.mode,
      fixed_volume: config.fixedVolume,
      risk_percent: config.riskPercent,
      max_risk_percent: config.maxRiskPercent,
      min_volume: config.minVolume,
      max_volume: config.maxVolume,
      volume_step: config.volumeStep,
      account_currency: config.accountCurrency,
      contract_size_overrides: config.contractSizes,
    },
    connector_conventions: {
      volume_unit: config.volumeUnit,
      price_format: config.priceFormat,
      order_type: config.orderType,
      note: "These three cannot be verified from here. Run once with AUTO_TRADE_DRY_RUN=true and read the payload in the logs before trusting them.",
    },
    limits: {
      max_open_positions: config.maxOpenPositions,
      max_trades_per_day: config.maxTradesPerDay,
      max_price_age_ms: config.maxPriceAgeMs,
      max_slippage_risk_fraction: config.maxSlippageRiskFraction,
      max_attempts: config.maxAttempts,
      symbol_allowlist: [...config.symbolAllowlist],
    },
    entry_sequence: {
      required: CONFIG.entrySequenceRequired,
      displacement_multiple: CONFIG.entryDisplacementMultiple,
      displacement_lookback: CONFIG.entryDisplacementLookback,
      mss_swing_strength: CONFIG.entryMssSwingStrength,
      states: [
        "REGISTERED_WATCH",
        "WAITING_FOR_SETUP_CONFIRMATION",
        "READY_FOR_ENTRY",
        "ENTRY_TOUCHED",
        "REJECTION_DETECTED",
        "M5_MSS_CONFIRMED",
        "DISPLACEMENT_CONFIRMED",
        "ENTRY_CONFIRMED",
        "ORDER_SUBMITTED",
        "EXECUTED",
      ],
    },
    upstream_tools: {
      order: tools?.order?.name ?? null,
      order_source: tools?.order?.source ?? null,
      order_schema_known: Boolean(tools?.order?.schema),
      positions: tools?.positions?.name ?? null,
      balance: tools?.balance?.name ?? null,
    },
    trades_today: tradesToday(Date.now()),
    executor: executor.snapshot(),
  };
}

function monitorHealth() {
  return {
    schema: "watch-monitor/7.0",
    auto_trade: autoTradeStatus(),
    auto_trade_dry_run: CONFIG.autoTrade.dryRun,
    trades_today: tradesToday(Date.now()),
    execution: executor.snapshot(),
    recovered_at: store.recoveredAt,
    state_persisted: Boolean(CONFIG.statePath),
    last_saved_at: store.lastSavedAt,
    last_save_error: store.lastSaveError,
    notifications: notifier.snapshot(),
    telegram_configured: notifier.configured,
    market_data: market.snapshot(),
    capacity: {
      setups: `${store.setups.size}/${CONFIG.maxSetupWatches}`,
      traps: `${store.traps.size}/${CONFIG.maxTrapWatches}`,
    },
  };
}

async function handleCustomTool(name, args = {}) {
  if (name === "register_watch") {
    const { watch, duplicate } = createSetupWatch(args);
    const auto = autoTradeStatus();
    const willTrade = auto.armed && watch.auto_trade !== false;
    if (!duplicate) {
      notify(
        `<b>WATCH ACTIVE</b>\n` +
          `<b>${htmlEscape(watch.symbol)}</b> — ${htmlEscape(watch.direction.toUpperCase())}\n` +
          `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))}` +
          (watch.entry_zone_low !== null
            ? ` (zone ${htmlEscape(formatLevel(watch.entry_zone_low))}–${htmlEscape(formatLevel(watch.entry_zone_high))})`
            : "") +
          ` | <b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
          (watch.prerequisite
            ? `<b>Prerequisite:</b> ${htmlEscape(watch.prerequisite.timeframe)} ${htmlEscape(watch.prerequisite.rule)} beyond ${htmlEscape(formatLevel(watch.prerequisite.level))}\n`
            : "") +
          `<b>Auto-trade:</b> ${willTrade ? (CONFIG.autoTrade.dryRun ? "armed (DRY RUN — no order will be sent)" : "ARMED — an order will be placed on confirmation") : `off (${htmlEscape(watch.auto_trade === false ? "disabled for this setup" : auto.reason)})`}\n` +
          `<i>Waiting for the entry touch, then rejection → M5 structure shift → displacement.</i>`,
        { dedupeKey: `${watch.id}:armed` },
      );
    }
    return textResult({
      status: duplicate ? "ALREADY_WATCHING" : "WATCHING",
      watch_id: watch.id,
      lifecycle: watch.lifecycle,
      stage: stageOf(watch),
      auto_trade: {
        will_execute: willTrade,
        dry_run: CONFIG.autoTrade.dryRun,
        reason: willTrade ? null : watch.auto_trade === false ? "auto_trade disabled for this setup" : auto.reason,
      },
      message: duplicate
        ? "This setup is already being monitored."
        : `Monitoring started; first check runs immediately and then every ${CONFIG.setupIntervalMs / 1000}s. ` +
          (willTrade
            ? "On a completed post-touch confirmation sequence the order is submitted automatically."
            : "On confirmation a Telegram alert is sent; no order is placed."),
    });
  }

  if (name === "register_trap_watch") {
    const { watch, duplicate } = createTrapWatch(args);
    if (!duplicate) {
      notify(
        `<b>TRAP WATCH ARMED</b>\n` +
          trapHeader(watch) +
          `<b>Status:</b> TRAP NOT CONFIRMED` +
          (watch.trap_score ? ` — ${htmlEscape(watch.trap_score)}` : "") +
          (watch.collection_grade ? ` · collection ${htmlEscape(watch.collection_grade)}` : "") +
          `\n` +
          (watch.what_is_missing ? `<b>Missing:</b> ${htmlEscape(watch.what_is_missing)}\n` : "") +
          `<b>Trigger:</b> ${htmlEscape(watch.timeframe)} body close ` +
          `${watch.bias === "buy" ? "&gt;" : "&lt;"} ${htmlEscape(formatLevel(watch.trigger_level))}` +
          (watch.require_displacement ? " + displacement" : "") +
          (watch.require_fvg ? " + FVG" : "") +
          `\n` +
          (watch.invalidation_level !== null
            ? `<b>Flip level:</b> ${htmlEscape(formatLevel(watch.invalidation_level))}\n`
            : "") +
          `<i>No entry exists yet. You get one message when the conditions print.</i>`,
        { dedupeKey: `${watch.id}:armed` },
      );
    }
    return textResult({
      status: duplicate ? "ALREADY_WATCHING" : "TRAP_WATCHING",
      watch_id: watch.id,
      lifecycle: watch.lifecycle,
      kind: "TRAP",
      timeframe: watch.timeframe,
      trigger_level: watch.trigger_level,
      invalidation_level: watch.invalidation_level,
      message: duplicate
        ? "This trap read is already being monitored."
        : `Trap monitoring started; closed ${watch.timeframe} candles are checked every ${CONFIG.trapIntervalMs / 1000}s. No entry will be produced — a notification means re-run the pipeline.`,
    });
  }

  if (name === "cancel_watch") {
    const watchId = String(args.watch_id || "").trim();
    if (!watchId) throw new Error("watch_id is required");
    const reason = args.reason ? String(args.reason).slice(0, 300) : "Cancelled by request";
    const result = cancelWatchById(watchId, reason);
    if (!result) {
      return textResult({
        status: "NOT_FOUND",
        watch_id: watchId,
        message: "No watch with that id, active or recently resolved.",
      });
    }
    return textResult(result);
  }

  if (name === "list_watches") {
    return textResult({
      active: store.active().map(publicWatch),
      active_trap_watches: store.activeTraps().map(publicWatch),
      quarantined: [...store.active(), ...store.activeTraps()]
        .filter((watch) => watch.lifecycle === "QUARANTINED")
        .map(publicWatch),
      recent: store.recent(),
      monitor_health: monitorHealth(),
    });
  }

  if (name === "get_news_calendar") {
    const events = await getNewsCalendar();
    return textResult({
      enabled: CONFIG.newsEnabled,
      fail_closed: CONFIG.newsFailClosed,
      events,
      fetched_at: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null,
      expires_at: newsCache.expiresAt ? new Date(newsCache.expiresAt).toISOString() : null,
      last_error: newsCache.lastError,
      manual_lockout: manualNewsLockout,
      blackout_minutes: {
        before: CONFIG.newsBeforeMs / 60000,
        after: CONFIG.newsAfterMs / 60000,
      },
      note: "Scheduled calendar data does not detect unscheduled political or geopolitical headlines.",
    });
  }

  if (name === "set_news_lockout") {
    const reason = String(args.reason || "").trim().slice(0, 300);
    if (!reason) throw new Error("reason is required");
    manualNewsLockout = { active: true, reason, setAt: new Date().toISOString() };
    notify(`<b>NEWS LOCKOUT ACTIVE</b>\n<b>Reason:</b> ${htmlEscape(reason)}`);
    return textResult({ status: "LOCKOUT_ACTIVE", reason });
  }

  if (name === "clear_news_lockout") {
    manualNewsLockout = { active: false, reason: null, setAt: null };
    notify("<b>NEWS LOCKOUT CLEARED</b>");
    return textResult({ status: "LOCKOUT_CLEARED" });
  }

  if (name === "get_auto_trade_status") {
    return textResult(await autoTradeReport());
  }

  if (name === "pause_auto_trade") {
    const reason = args.reason ? String(args.reason).slice(0, 300) : "Paused by request";
    autoTradePausedReason = reason;
    notify(
      `<b>AUTO-TRADE PAUSED</b>\n<b>Reason:</b> ${htmlEscape(reason)}\n` +
        `<i>Watches keep running; confirmations will be sent for manual entry.</i>`,
      { priority: "critical" },
    );
    return textResult({ status: "AUTO_TRADE_PAUSED", reason, ...autoTradeStatus() });
  }

  if (name === "resume_auto_trade") {
    autoTradePausedReason = null;
    const status = autoTradeStatus();
    notify(
      status.armed
        ? `<b>AUTO-TRADE RESUMED</b>${CONFIG.autoTrade.dryRun ? " <i>(dry run)</i>" : ""}`
        : `<b>AUTO-TRADE STILL OFF</b>\n${htmlEscape(status.reason)}`,
      { priority: "critical" },
    );
    return textResult({ status: status.armed ? "AUTO_TRADE_ARMED" : "AUTO_TRADE_OFF", ...status });
  }

  throw new Error(`Tool "${name}" not found`);
}

// ---------------------------------------------------------------------------
// §10 HTTP / MCP surface

function parseAuthToken(req) {
  const authorization = String(req.get("authorization") || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(req.get("x-api-key") || "");
}

function authorized(req) {
  if (!CONFIG.authToken) return true;
  const provided = Buffer.from(parseAuthToken(req));
  const expected = Buffer.from(CONFIG.authToken);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function rejectUnauthorized(req, res) {
  if (authorized(req)) return false;
  res.status(401).json({
    error: "Unauthorized",
    message: "A valid monitor authorization token is required.",
  });
  return true;
}

function setupCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CONFIG.allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

let upstreamToolsCache = { tools: null, fetchedAt: 0, lastError: null };
const UPSTREAM_TOOLS_TTL_MS = num(process.env.UPSTREAM_TOOLS_TTL_MS, 10 * 60 * 1000, 60_000);

async function getUpstreamTools(force = false) {
  const fresh =
    upstreamToolsCache.tools && Date.now() - upstreamToolsCache.fetchedAt < UPSTREAM_TOOLS_TTL_MS;
  if (fresh && !force) return upstreamToolsCache.tools;
  try {
    const tools = await client.listTools();
    upstreamToolsCache = { tools, fetchedAt: Date.now(), lastError: null };
    return tools;
  } catch (error) {
    upstreamToolsCache.lastError = error.message;
    log(`upstream tools/list failed: ${error.message}`);
    return upstreamToolsCache.tools || [];
  }
}

async function mergedToolList() {
  const upstream = await getUpstreamTools();
  const native = filterToMarketData(
    upstream.filter((tool) => !CUSTOM_TOOL_NAMES.has(tool?.name)),
  );
  // Mark every client-facing tool as read-only so Spark skips the
  // per-call confirmation. The monitor's own write loop goes through
  // a separate code path (lib/execution.mjs) and is not affected.
  const withReadOnlyHint = (tool) => ({
    ...tool,
    annotations: { ...(tool.annotations || {}), readOnlyHint: true },
  });
  return [...native.map(withReadOnlyHint), ...CUSTOM_TOOLS];
}

function jsonRpcError(res, id, code, message) {
  res.status(200).json({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMcpRequest(req, res) {
  if (rejectUnauthorized(req, res)) return;
  setupCors(res);

  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => clearInterval(ping));
    return;
  }

  const body = req.body || {};
  const id = body.id ?? null;
  const method = body.method;
  let sessionId = req.get("mcp-session-id") || null;

  if (method === "initialize") {
    sessionId = sessionId || randomUUID();
    watchSessions.set(sessionId, { createdAt: Date.now() });
    res.setHeader("Mcp-Session-Id", sessionId);
    void getUpstreamTools(true);
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: body.params?.protocolVersion || CONFIG.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cTrader + Watch Monitor MCP", version: "7.0.0" },
      },
    });
    return;
  }

  if (sessionId) {
    watchSessions.set(sessionId, watchSessions.get(sessionId) || { createdAt: Date.now() });
    res.setHeader("Mcp-Session-Id", sessionId);
  }

  if (method === "ping") {
    res.json({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    res.status(202).end();
    return;
  }

  if (method === "tools/list") {
    const tools = await mergedToolList();
    if (tools.length === CUSTOM_TOOLS.length && upstreamToolsCache.lastError) {
      // Fail loudly. A list containing only the monitor tools means the
      // native market-data side is unreachable, and returning it silently
      // is what hid this class of bug in the 4.x build.
      jsonRpcError(
        res,
        id,
        -32603,
        `Native cTrader tools unavailable: ${upstreamToolsCache.lastError}`,
      );
      return;
    }
    res.json({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    if (CUSTOM_TOOL_NAMES.has(name)) {
      try {
        res.json({ jsonrpc: "2.0", id, result: await handleCustomTool(name, args) });
      } catch (error) {
        jsonRpcError(res, id, -32602, error.message);
      }
      return;
    }
    if (!MARKET_DATA_TOOL_ALLOWLIST.has(name)) {
      jsonRpcError(
        res,
        id,
        -32601,
        `Tool "${name}" is not exposed on this endpoint (account/execution tools are not available to this client)`,
      );
      return;
    }
    try {
      res.json({ jsonrpc: "2.0", id, result: await client.callToolRaw(name, args) });
    } catch (error) {
      jsonRpcError(res, id, -32603, `cTrader upstream: ${error.message}`);
    }
    return;
  }

  jsonRpcError(res, id, -32601, `Method "${method}" not supported`);
}

for (const path of ["/icmarkets/mcp", "/mcp", "/watch-mcp"]) {
  app.options(path, (_req, res) => {
    setupCors(res);
    res.status(204).end();
  });
  app.get(path, (req, res) => void handleMcpRequest(req, res));
  app.post(path, (req, res) => void handleMcpRequest(req, res));
}

app.get("/health", (req, res) => {
  const detailed = authorized(req) && Boolean(CONFIG.authToken);
  const base = {
    status: "ok",
    service: "watch-monitor-mcp",
    version: "7.0.0",
    watches: store.setups.size,
    trap_watches: store.traps.size,
    uptime_seconds: Math.floor(process.uptime()),
  };
  if (!detailed && CONFIG.authToken) {
    res.json(base);
    return;
  }
  res.json({
    ...base,
    resolved_recent: store.resolved.size,
    quarantined: [...store.setups.values(), ...store.traps.values()].filter(
      (watch) => watch.lifecycle === "QUARANTINED",
    ).length,
    scheduler_tick_ms: CONFIG.tickMs,
    setup_interval_seconds: CONFIG.setupIntervalMs / 1000,
    trap_interval_seconds: CONFIG.trapIntervalMs / 1000,
    ctrader_token_configured: Boolean(CONFIG.upstreamToken),
    upstream: CONFIG.upstreamUrl,
    upstream_tools_cached: upstreamToolsCache.tools ? upstreamToolsCache.tools.length : 0,
    upstream_tools_last_error: upstreamToolsCache.lastError,
    custom_tools: CUSTOM_TOOLS.length,
    local_auth_configured: Boolean(CONFIG.authToken),
    news_filter_enabled: CONFIG.newsEnabled,
    news_fail_closed: CONFIG.newsFailClosed,
    kill_zone_filter_enabled: CONFIG.killZoneEnabled,
    spread_check_enabled: CONFIG.spreadEnabled,
    ...monitorHealth(),
  });
});

app.get("/test-telegram", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  const result = await notifier.deliver("<b>Watch Monitor MCP</b>\nTelegram test succeeded.");
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, error: result.error || null });
});

app.get("/test-news", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  const events = await getNewsCalendar();
  res.json({
    ok: !newsCache.lastError,
    events,
    fetched_at: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null,
    last_error: newsCache.lastError,
  });
});

// REST mirrors of the two registration tools, for non-MCP callers. They
// share the exact same code path — including notification and dedup — so
// the two surfaces cannot drift apart.
app.post("/register_watch", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  try {
    const result = await handleCustomTool("register_watch", req.body || {});
    res.json(JSON.parse(result.content[0].text));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/register_trap_watch", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  try {
    const result = await handleCustomTool("register_trap_watch", req.body || {});
    res.json(JSON.parse(result.content[0].text));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// §11 Boot and shutdown

const sessionCleanup = setInterval(
  () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [sessionId, session] of watchSessions) {
      if (session.createdAt < cutoff) watchSessions.delete(sessionId);
    }
  },
  60 * 60 * 1000,
);

const heartbeat = process.env.SERVER_URL
  ? setInterval(
      () => {
        fetch(`${process.env.SERVER_URL.replace(/\/$/, "")}/health`).catch(() => {});
      },
      10 * 60 * 1000,
    )
  : null;

function boot() {
  if (!CONFIG.authToken) {
    log(
      "WARNING: WATCH_MONITOR_AUTH_TOKEN is unset — this endpoint is open to anyone who knows the URL.",
    );
  }
  const auto = autoTradeStatus();
  log(
    auto.armed
      ? `AUTO-TRADE ARMED${CONFIG.autoTrade.dryRun ? " (DRY RUN — no orders will be sent)" : ""}: ` +
          `mode=${CONFIG.autoTrade.mode} unit=${CONFIG.autoTrade.volumeUnit} ` +
          `priceFormat=${CONFIG.autoTrade.priceFormat} maxOpen=${CONFIG.autoTrade.maxOpenPositions} ` +
          `maxPerDay=${CONFIG.autoTrade.maxTradesPerDay}`
      : `auto-trade is OFF (${auto.reason}); confirmations will be notified, not executed`,
  );
  if (auto.armed) void executor.resolveTools(true);

  const recovery = store.load();
  notifier.restore(recovery.outbox);
  if (recovery.autoTrade?.day === todayKey(Date.now())) {
    tradeCounter.day = recovery.autoTrade.day;
    tradeCounter.count = Number(recovery.autoTrade.count) || 0;
    if (tradeCounter.count) log(`recovered today's trade count: ${tradeCounter.count}`);
  }
  for (const pending of recovery.executionUnknown || []) {
    notify(
      `<b>⚠ ORDER OUTCOME UNKNOWN AFTER RESTART</b>\n` +
        `<b>${htmlEscape(pending.symbol)}</b> ${htmlEscape(String(pending.direction || "").toUpperCase())} ` +
        `${htmlEscape(String(pending.volume ?? "?"))} lot(s), submitted ${htmlEscape(pending.submittedAt || "unknown")}\n` +
        `<b>Action:</b> the monitor restarted between sending this order and recording what happened to it. ` +
        `Check the account manually. It has NOT been resubmitted and is no longer monitored.`,
      { dedupeKey: `${pending.id}:execution-unknown`, priority: "critical" },
    );
  }
  if (recovery.setups || recovery.traps || recovery.expired) {
    const offlineFor = recovery.savedAt
      ? `${Math.round((Date.now() - Date.parse(recovery.savedAt)) / 60000)} min`
      : "unknown";
    log(
      `recovered ${recovery.setups} setup watch(es), ${recovery.traps} trap watch(es), expired ${recovery.expired}`,
    );
    notify(
      `<b>MONITOR RESTARTED</b>\n` +
        `<b>Recovered:</b> ${recovery.setups} setup · ${recovery.traps} trap\n` +
        (recovery.expired ? `<b>Expired while offline:</b> ${recovery.expired}\n` : "") +
        `<b>Gap:</b> ${htmlEscape(offlineFor)}\n` +
        `<i>Evidence was discarded and must re-accumulate under live observation. ` +
        `Anything that happened during the gap was not seen — re-check any position manually.</i>`,
      { priority: "critical" },
    );
  }
  startScheduler();
  void runDueWatches();
}

const server = app.listen(CONFIG.port, "0.0.0.0", () => {
  log(`listening on ${CONFIG.port}; tick=${CONFIG.tickMs}ms; upstream=${CONFIG.upstreamUrl}`);
  boot();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down; flushing state");
  if (schedulerTimer) clearInterval(schedulerTimer);
  clearInterval(sessionCleanup);
  if (heartbeat) clearInterval(heartbeat);
  scheduleSave(true);
  server.close(() => process.exit(0));
  // Never hang a redeploy on a lingering keep-alive stream.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error.stack || error.message}`);
  scheduleSave(true);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason?.stack || reason}`);
});

export { app, store, market, notifier, CONFIG, handleCustomTool, asArray };
