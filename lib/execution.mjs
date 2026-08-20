/**
 * execution.mjs — the order side of the monitor.
 *
 * Everything in this file exists behind one boundary: the Claude-facing
 * MCP surface still refuses every execution tool (index.js §9), and the
 * only code path that can reach one is the monitor's own confirmation
 * loop, after the full entry sequence and the pre-submission checklist
 * have passed. A client talking to this server cannot ask it to trade;
 * it can only ask it to watch, and watching is what decides to trade.
 *
 * Three things about the upstream connector cannot be verified from
 * inside this process, and each of them is capable of silently placing
 * the wrong trade rather than no trade:
 *
 *   1. the name of the order tool,
 *   2. the unit its `volume` field counts in (lots, units, centi-units),
 *   3. whether its price fields are real prices or feed-scaled integers.
 *
 * So none of them is guessed. The tool is discovered from the upstream's
 * own tools/list and its declared inputSchema drives which arguments are
 * sent; the two unit questions are explicit configuration with
 * conservative defaults, every submission logs the exact payload, and
 * AUTO_TRADE_DRY_RUN runs the whole path — checks, sizing, payload,
 * Telegram — without sending it, so the payload can be read before a
 * single real order exists.
 */

import { finiteNumber } from "./core.mjs";
import { asArray, unwrapMcpResult } from "./upstream.mjs";

export const ORDER_TOOL_CANDIDATES = Object.freeze([
  "create_order",
  "place_order",
  "new_order",
  "submit_order",
  "create_market_order",
  "market_order",
  "open_position",
]);

export const POSITIONS_TOOL_CANDIDATES = Object.freeze([
  "get_positions",
  "get_open_positions",
  "list_positions",
  "get_open_trades",
  "positions",
]);

export const BALANCE_TOOL_CANDIDATES = Object.freeze([
  "get_balance",
  "get_account",
  "get_account_info",
  "get_account_details",
  "get_trader",
  "get_accounts",
]);

// Canonical field → the names a connector might actually declare for it.
// Order matters: the first alias the upstream schema declares wins.
const FIELD_ALIASES = Object.freeze({
  symbolId: ["symbolId", "symbol_id", "symbolID"],
  symbol: ["symbol", "symbolName", "symbol_name", "instrument"],
  side: ["tradeSide", "trade_side", "side", "orderSide", "order_side", "direction"],
  orderType: ["orderType", "order_type", "type"],
  volume: ["volume", "quantity", "size", "lots", "amount", "units"],
  stopLoss: ["stopLoss", "stop_loss", "slPrice", "sl", "stopLossPrice"],
  takeProfit: ["takeProfit", "take_profit", "tpPrice", "tp", "takeProfitPrice"],
  label: ["label", "clientOrderId", "client_order_id", "clientMsgId", "comment"],
});

const SIDE_VALUES = { buy: "BUY", sell: "SELL" };

function pickTool(tools, override, candidates) {
  const byName = new Map((tools || []).filter((tool) => tool?.name).map((tool) => [tool.name, tool]));
  if (override) {
    const found = byName.get(override);
    return found ? { name: override, schema: found.inputSchema || null, source: "configured" } : { name: override, schema: null, source: "configured-unlisted" };
  }
  for (const candidate of candidates) {
    if (byName.has(candidate)) {
      return { name: candidate, schema: byName.get(candidate).inputSchema || null, source: "discovered" };
    }
  }
  return null;
}

/**
 * Which alias of a canonical field this tool declares. Returns null when
 * the tool declares none of them, which is what stops the monitor from
 * inventing an argument name the connector will ignore — an ignored
 * stopLoss is an unprotected position.
 */
export function schemaField(schema, canonical) {
  const properties = schema?.properties;
  const aliases = FIELD_ALIASES[canonical] || [canonical];
  if (!properties || typeof properties !== "object") return aliases[0];
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(properties, alias)) return alias;
  }
  return null;
}

/**
 * Build the order payload against the tool's own schema. Anything the
 * schema requires but the monitor cannot supply is a hard refusal, not a
 * best-effort submission: an order the connector has to fill in the
 * blanks on is an order nobody specified.
 */
export function buildOrderArgs(schema, values, { priceFormat = "raw", priceScale = 100_000 } = {}) {
  const args = {};
  const missing = [];
  const scale = (price) =>
    priceFormat === "scaled" ? Math.round(price * priceScale) : Number(price.toFixed(5));

  const set = (canonical, value) => {
    if (value === null || value === undefined) return false;
    const field = schemaField(schema, canonical);
    if (!field) return false;
    args[field] = value;
    return true;
  };

  const symbolIdSet = set("symbolId", values.symbolId);
  const symbolSet = set("symbol", values.symbol);
  const sideSet = set("side", SIDE_VALUES[values.direction]);
  set("orderType", values.orderType || "MARKET");
  const volumeSet = set("volume", values.volume);
  const hasStop = values.stopLoss !== null && values.stopLoss !== undefined;
  const slSet = hasStop ? set("stopLoss", scale(values.stopLoss)) : false;
  if (values.takeProfit !== null && values.takeProfit !== undefined) {
    set("takeProfit", scale(values.takeProfit));
  }
  set("label", values.label);

  if (!volumeSet) missing.push("volume");
  if (!symbolIdSet && !symbolSet) missing.push("symbol");
  if (!sideSet) missing.push("side");
  if (hasStop && !slSet) {
    // The connector takes no stop-loss argument. Submitting anyway would
    // open an unprotected position on the strength of a stop this
    // service believes it sent.
    missing.push("stopLoss");
  }

  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const field of required) {
    if (args[field] === undefined) missing.push(field);
  }

  return { args, missing: [...new Set(missing)] };
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = finiteNumber(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).length) return String(value);
  }
  return null;
}

export class Executor {
  constructor({ client, config, log }) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.toolsCache = { tools: null, fetchedAt: 0, error: null };
    this.resolved = null;
    this.lastError = null;
    this.stats = { submitted: 0, failed: 0, dryRun: 0 };
  }

  async listTools(force = false) {
    const ttl = this.config.executionToolsTtlMs ?? 10 * 60 * 1000;
    if (!force && this.toolsCache.tools && Date.now() - this.toolsCache.fetchedAt < ttl) {
      return this.toolsCache.tools;
    }
    try {
      const tools = await this.client.listTools();
      this.toolsCache = { tools, fetchedAt: Date.now(), error: null };
      this.resolved = null;
      return tools;
    } catch (error) {
      this.toolsCache.error = error.message;
      this.log(`execution tools/list failed: ${error.message}`);
      return this.toolsCache.tools || [];
    }
  }

  async resolveTools(force = false) {
    if (this.resolved && !force) return this.resolved;
    const tools = await this.listTools(force);
    this.resolved = {
      order: pickTool(tools, this.config.orderToolName, ORDER_TOOL_CANDIDATES),
      positions: pickTool(tools, this.config.positionsToolName, POSITIONS_TOOL_CANDIDATES),
      balance: pickTool(tools, this.config.balanceToolName, BALANCE_TOOL_CANDIDATES),
      upstreamToolCount: tools.length,
      listError: this.toolsCache.error,
    };
    return this.resolved;
  }

  /**
   * Account balance. Returns known:false rather than a zero — a zero
   * balance and an unreadable one size very differently, and only one of
   * them is a reason to keep going.
   */
  async balance() {
    const { balance } = await this.resolveTools();
    if (!balance) return { known: false, reason: "no balance tool is exposed upstream" };
    try {
      const raw = await this.client.callTool(balance.name, {});
      const candidates = [raw, ...asArray(raw)].filter((item) => item && typeof item === "object");
      for (const item of candidates) {
        const value = firstNumber(item, ["balance", "equity", "freeMargin", "free_margin", "cash"]);
        if (value !== null) {
          const scaled = this.config.balanceIsScaled ? value / 100 : value;
          return {
            known: true,
            balance: scaled,
            equity: firstNumber(item, ["equity"]) ?? null,
            currency: firstString(item, ["currency", "depositCurrency", "deposit_currency", "accountCurrency"]),
            tool: balance.name,
          };
        }
      }
      return { known: false, reason: `${balance.name} returned no readable balance` };
    } catch (error) {
      this.lastError = `${balance.name}: ${error.message}`;
      return { known: false, reason: `${balance.name} failed: ${error.message}` };
    }
  }

  /**
   * Open positions, optionally narrowed to one symbol. known:false means
   * the question could not be answered — the caller treats that as a
   * refusal to trade, never as "there are none".
   */
  async openPositions(symbol = null, symbolId = null) {
    const { positions } = await this.resolveTools();
    if (!positions) return { known: false, reason: "no positions tool is exposed upstream", list: [] };
    try {
      const raw = await this.client.callTool(positions.name, {});
      const list = asArray(raw).filter((item) => item && typeof item === "object");
      if (!list.length) {
        const unwrapped = unwrapMcpResult(raw);
        // An explicitly empty answer is knowledge; an unreadable one is not.
        const empty =
          Array.isArray(unwrapped) ||
          (unwrapped && typeof unwrapped === "object" && Object.keys(unwrapped).length === 0);
        if (!empty) {
          return { known: false, reason: `${positions.name} returned an unreadable payload`, list: [] };
        }
      }
      const normalized = list.map((item) => ({
        id: firstString(item, ["positionId", "position_id", "id", "dealId"]),
        symbol: (firstString(item, ["symbolName", "symbol", "symbol_name"]) || "").toUpperCase(),
        symbolId: firstNumber(item, ["symbolId", "symbol_id"]),
        side: (firstString(item, ["tradeSide", "side", "direction"]) || "").toUpperCase(),
        volume: firstNumber(item, ["volume", "quantity", "size"]),
        label: firstString(item, ["label", "comment", "clientOrderId"]),
      }));
      const wanted = symbol ? String(symbol).toUpperCase() : null;
      const forSymbol = wanted
        ? normalized.filter(
            (item) =>
              item.symbol === wanted || (symbolId !== null && item.symbolId === Number(symbolId)),
          )
        : normalized;
      return { known: true, list: normalized, forSymbol, tool: positions.name };
    } catch (error) {
      this.lastError = `${positions.name}: ${error.message}`;
      return { known: false, reason: `${positions.name} failed: ${error.message}`, list: [] };
    }
  }

  /**
   * Submit the order. The payload is returned on every path — success,
   * refusal and failure alike — so the exact bytes that were or were not
   * sent are always in the audit trail.
   */
  async submit({ symbol, symbolId, direction, volume, stopLoss, takeProfit, label, dryRun }) {
    const { order } = await this.resolveTools();
    if (!order) {
      return {
        ok: false,
        code: "NO_ORDER_TOOL",
        error:
          "the upstream connector exposes no order tool; set AUTO_TRADE_ORDER_TOOL if it uses a name this monitor does not know",
      };
    }
    const { args, missing } = buildOrderArgs(order.schema, {
      symbol,
      symbolId,
      direction,
      volume,
      stopLoss,
      takeProfit,
      label,
      orderType: this.config.orderType || "MARKET",
    }, {
      priceFormat: this.config.priceFormat,
      priceScale: this.config.priceScale,
    });

    if (missing.length) {
      return {
        ok: false,
        code: "PAYLOAD_INCOMPLETE",
        error: `${order.name} cannot be called safely: ${missing.join(", ")} could not be supplied`,
        tool: order.name,
        args,
      };
    }

    if (dryRun) {
      this.stats.dryRun += 1;
      this.log(`DRY RUN — would call ${order.name} with ${JSON.stringify(args)}`);
      return { ok: true, dryRun: true, tool: order.name, args, orderId: null, positionId: null };
    }

    this.log(`submitting ${order.name} ${JSON.stringify(args)}`);
    try {
      const raw = await this.client.callTool(order.name, args);
      const payload = unwrapMcpResult(raw);
      const candidates = [payload, ...asArray(raw)].filter((item) => item && typeof item === "object");
      let orderId = null;
      let positionId = null;
      for (const item of candidates) {
        orderId = orderId ?? firstString(item, ["orderId", "order_id", "id", "dealId"]);
        positionId = positionId ?? firstString(item, ["positionId", "position_id"]);
      }
      const errorText = candidates
        .map((item) => firstString(item, ["error", "errorCode", "message", "rejectReason"]))
        .find(Boolean);
      // A connector that answers 200 with an error body has rejected the
      // order; reporting that as filled is the failure this whole file
      // is built to avoid.
      if (errorText && !orderId && !positionId) {
        this.stats.failed += 1;
        return { ok: false, code: "REJECTED", error: errorText, tool: order.name, args, raw: payload };
      }
      this.stats.submitted += 1;
      return { ok: true, tool: order.name, args, orderId, positionId, raw: payload };
    } catch (error) {
      this.stats.failed += 1;
      this.lastError = `${order.name}: ${error.message}`;
      return { ok: false, code: "UPSTREAM_ERROR", error: error.message, tool: order.name, args, retryable: true };
    }
  }

  snapshot() {
    return {
      order_tool: this.resolved?.order?.name ?? null,
      order_tool_source: this.resolved?.order?.source ?? null,
      order_tool_schema_known: Boolean(this.resolved?.order?.schema),
      positions_tool: this.resolved?.positions?.name ?? null,
      balance_tool: this.resolved?.balance?.name ?? null,
      upstream_tools_seen: this.resolved?.upstreamToolCount ?? 0,
      tools_list_error: this.toolsCache.error,
      last_error: this.lastError,
      ...this.stats,
    };
  }
}
