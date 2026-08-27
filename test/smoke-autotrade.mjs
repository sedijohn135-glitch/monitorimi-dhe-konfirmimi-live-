/**
 * End-to-end auto-trade smoke test.
 *
 * Boots the real server against a fake cTrader upstream that exposes the
 * execution tools, and drives a scripted XAUUSD sell setup through the
 * whole machine: prerequisite → touch → rejection → M5 structure shift →
 * displacement → gates → order.
 *
 * What it is really asserting is the boundary. The same upstream that
 * the monitor places an order through is still refused, tool by tool, to
 * the client talking to /mcp — and a second setup whose prerequisite
 * never printed is still sitting there untraded when the first one has
 * filled.
 *
 *   node test/smoke-autotrade.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCALE = 100_000;
const M1 = 60_000;
const M5 = 5 * M1;
const M15 = 15 * M1;

const orders = [];
const positions = [];
let phase = "pre";
let spotPrice = 4320;
let m1Offset = 3;

// -- scripted candles -------------------------------------------------------
//
// Written as shapes rather than generated noise, because every step of
// the sequence under test is a statement about a specific bar.

const px = (value) => Math.round(value * SCALE);
const candle = (timestamp, open, high, low, close) => ({
  timestamp,
  open: px(open),
  high: px(high),
  low: px(low),
  close: px(close),
});

function anchor(span, back = 0) {
  return Math.floor(Date.now() / span) * span - back * span;
}

/**
 * M5: chop with one clean pivot low, a retest leg, then the trigger bar.
 *
 * The newest bar is dated so that it closed one second ago rather than
 * on the wall-clock grid. That is not a shortcut around the engine's bar
 * discipline — the bar is still closed, still fresh, and still has to
 * have closed after the touch — it just makes "a new M5 bar has closed
 * since the touch" happen on the test's schedule instead of the hour's.
 */
function m5Series() {
  const count = 30;
  const last = Date.now() - M5 - 1000;
  const start = last - (count - 1) * M5;
  const bars = [];
  // 0..17 — chop that leaves the most recent pivot low at index 18.
  const chop = [
    [4322, 4325, 4320, 4324],
    [4324, 4326, 4322, 4323],
    [4323, 4325, 4321, 4324],
    [4324, 4327, 4323, 4325],
    [4325, 4326, 4322, 4323],
    [4323, 4324, 4321, 4322],
    [4322, 4325, 4321, 4324],
    [4324, 4326, 4323, 4325],
    [4325, 4327, 4324, 4326],
    [4326, 4327, 4324, 4325],
    [4325, 4326, 4323, 4324],
    [4324, 4326, 4322, 4325],
    [4325, 4327, 4324, 4326],
    [4326, 4328, 4325, 4327],
    [4327, 4328, 4325, 4326],
    [4326, 4327, 4324, 4325],
    [4325, 4326, 4323, 4324],
    [4324, 4325, 4322, 4323],
  ];
  chop.forEach((values, index) => bars.push(candle(start + index * M5, ...values)));
  // 18 — the pivot low the structure shift will break.
  bars.push(candle(start + 18 * M5, 4323, 4324, 4320, 4322));
  // 19..27 — the retest leg back up into 4330–4334, strictly rising lows
  // so it creates no new pivot.
  const rise = [
    [4322, 4325, 4321, 4324],
    [4324, 4327, 4323, 4326],
    [4326, 4329, 4325, 4328],
    [4328, 4330, 4327, 4329],
    [4329, 4331, 4328, 4330],
    [4330, 4332, 4329, 4331],
    [4331, 4333, 4330, 4332],
    [4332, 4334, 4331, 4333],
    [4333, 4334, 4332, 4333],
  ];
  rise.forEach((values, index) => bars.push(candle(start + (19 + index) * M5, ...values)));
  bars.push(candle(start + 28 * M5, 4333, 4334, 4332, 4333.5));
  if (phase === "confirm") {
    // The trigger bar, and it is the newest closed bar: it takes the
    // zone, fails to hold it, and closes through the pivot low with a
    // body many times the recent average.
    bars.push(candle(start + 29 * M5, 4333.5, 4334.8, 4318.5, 4319));
  } else {
    bars.push(candle(start + 29 * M5, 4333.5, 4334, 4332.5, 4333));
  }
  return bars;
}

/** M1: flat until the confirm phase, then a sweep-and-reclaim (CISD). */
function m1Series() {
  const count = 25;
  const last = anchor(M1, m1Offset);
  if (m1Offset > 1) m1Offset -= 1;
  const start = last - (count - 1) * M1;
  const bars = [];
  for (let index = 0; index < count - 2; index += 1) {
    bars.push(candle(start + index * M1, 4322, 4325, 4319, 4323));
  }
  if (phase === "confirm") {
    bars.push(candle(start + (count - 2) * M1, 4325, 4335, 4324, 4330));
    bars.push(candle(start + (count - 1) * M1, 4330, 4331, 4318, 4319));
  } else {
    bars.push(candle(start + (count - 2) * M1, 4325, 4326, 4324, 4325));
    bars.push(candle(start + (count - 1) * M1, 4325, 4326, 4324, 4325.5));
  }
  return bars;
}

/** M15: contains the body close below 4324.71 the setup declared. */
function m15Series() {
  const count = 20;
  const last = anchor(M15, 1);
  const start = last - (count - 1) * M15;
  return Array.from({ length: count }, (_, index) =>
    index === count - 3
      ? candle(start + index * M15, 4330, 4331, 4318, 4322)
      : candle(start + index * M15, 4326, 4330, 4324, 4327),
  );
}

const SERIES = { M_1: m1Series, M_5: m5Series, M_15: m15Series };

// -- fake upstream ----------------------------------------------------------

const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const rpc = JSON.parse(body || "{}");
    const reply = (result) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "fake-session");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
    };
    const text = (payload) => reply({ content: [{ type: "text", text: JSON.stringify(payload) }] });

    if (rpc.method === "initialize") return reply({ protocolVersion: "2024-11-05" });
    if (rpc.method?.startsWith("notifications/")) return res.end("{}");
    if (rpc.method === "tools/list") {
      return reply({
        tools: [
          { name: "get_symbols" },
          { name: "get_spot_prices" },
          { name: "get_trendbars" },
          { name: "get_version" },
          { name: "get_balance" },
          { name: "get_positions" },
          {
            name: "create_order",
            inputSchema: {
              type: "object",
              properties: {
                symbolId: { type: "number" },
                tradeSide: { type: "string" },
                orderType: { type: "string" },
                volume: { type: "number" },
                stopLoss: { type: "number" },
                takeProfit: { type: "number" },
                label: { type: "string" },
              },
              required: ["symbolId", "tradeSide", "volume"],
            },
          },
          { name: "close_position" },
        ],
      });
    }
    if (rpc.method === "tools/call") {
      const { name, arguments: args } = rpc.params;
      if (name === "get_symbols") {
        return text([
          { symbolId: 41, symbolName: "XAUUSD" },
          { symbolId: 42, symbolName: "XAGUSD" },
          { symbolId: 1, symbolName: "EURUSD" },
        ]);
      }
      if (name === "get_spot_prices") {
        return text([
          {
            symbolId: args.symbolId[0],
            bid: px(spotPrice - 0.1),
            ask: px(spotPrice + 0.1),
          },
        ]);
      }
      if (name === "get_trendbars") {
        const series = SERIES[args.period];
        if (!series) {
          res.statusCode = 200;
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32602, message: "period: invalid value" },
            }),
          );
        }
        return text(series());
      }
      if (name === "get_balance") return text({ balance: 10_000, currency: "USD" });
      if (name === "get_positions") return text(positions);
      if (name === "create_order") {
        orders.push(args);
        positions.push({ positionId: 900 + orders.length, symbolId: 41, tradeSide: args.tradeSide, volume: args.volume });
        return text({ orderId: 5000 + orders.length, positionId: 900 + orders.length });
      }
      return text({});
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601 } }));
  });
});

const telegram = createServer((req, res) => {
  req.resume();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
});

const listen = (server, port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
await listen(upstream, 9811);
await listen(telegram, 9812);

const dir = mkdtempSync(join(tmpdir(), "wm-auto-"));
const env = {
  ...process.env,
  PORT: "9813",
  CTRADER_MCP_URL: "http://127.0.0.1:9811/mcp",
  STATE_FILE: join(dir, "state.json"),
  WATCH_MONITOR_AUTH_TOKEN: "secret",
  SCHEDULER_TICK_MS: "1000",
  WATCH_INTERVAL_MS: "3000",
  MIN_CONFIRMATION_HOLD_MS: "2000",
  // The post-touch sequence is opt-in now. This suite is the one that
  // proves it still works end to end, so it turns it on explicitly.
  ENTRY_SEQUENCE_REQUIRED: "true",
  BAR_CACHE_MAX_MS: "5000",
  BAR_CACHE_FRACTION: "0.05",
  SPOT_CACHE_MS: "0",
  KILL_ZONE_FILTER_ENABLED: "false",
  NEWS_FILTER_ENABLED: "false",
  AUTO_TRADE_ENABLED: "true",
  AUTO_TRADE_CONFIRMED: "I ACCEPT AUTOMATED ORDER EXECUTION",
  AUTO_TRADE_VOLUME_MODE: "risk",
  AUTO_TRADE_RISK_PERCENT: "0.5",
  AUTO_TRADE_VOLUME_UNIT: "centi_units",
  AUTO_TRADE_MAX_OPEN_POSITIONS: "1",
};

const child = spawn(process.execPath, ["index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stdout.write(`  [srv] ${chunk}`));

const rpc = async (method, params, id = 1) => {
  const response = await fetch("http://127.0.0.1:9813/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return response.json();
};
const call = async (name, args = {}) => {
  const response = await rpc("tools/call", { name, arguments: args });
  if (response.error) return { error: response.error };
  return JSON.parse(response.result.content[0].text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, label) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${label}`);
  if (!condition) process.exitCode = 1;
};
const waitFor = async (predicate, budgetMs, step = 1500) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(step);
  }
  return null;
};

await sleep(1500);

console.log("\n— the boundary is unchanged —");
const tools = (await rpc("tools/list", {})).result.tools.map((tool) => tool.name);
assert(!tools.includes("create_order"), "the order tool is still hidden from the client");
assert(!tools.includes("get_positions"), "account tools are still hidden from the client");
assert(tools.includes("get_trendbars"), "market data is still exposed");
const blocked = await rpc("tools/call", { name: "create_order", arguments: { volume: 1 } });
assert(
  blocked.error && /not available to this client/.test(blocked.error.message),
  "the client still cannot call the order tool it cannot see",
);

const status = await call("get_auto_trade_status");
assert(status.armed === true, `auto-trade reports armed (${status.reason || "no reason"})`);
assert(status.upstream_tools.order === "create_order", `the order tool was discovered (${status.upstream_tools.order})`);
assert(status.upstream_tools.order_schema_known === true, "its input schema was read");

console.log("\n— registration —");
const armed = await call("register_watch", {
  setup_id: "auto-1",
  symbol: "XAUUSD",
  direction: "sell",
  entry: 4332,
  entry_zone_low: 4330,
  entry_zone_high: 4334,
  sl: 4370,
  invalidation: 4368.31,
  invalidation_rule: "body_close",
  tp1: 4290,
  prerequisite_level: 4324.71,
  prerequisite_timeframe: "M15",
});
assert(armed.auto_trade.will_execute === true, "the watch reports that it will execute");

const gated = await call("register_watch", {
  setup_id: "auto-2",
  symbol: "XAUUSD",
  direction: "sell",
  entry: 4332,
  sl: 4370,
  tp1: 4290,
  prerequisite_level: 4100,
  prerequisite_timeframe: "M15",
});
assert(Boolean(gated.watch_id), "a second setup with an unmet prerequisite is registered too");

const stageOf = async (id) => {
  const listed = await call("list_watches");
  const live = listed.active.find((watch) => watch.id === id);
  return live ? live.stage : listed.recent.find((record) => record.id === id)?.stage;
};

console.log("\n— the prerequisite gates the entry —");
await sleep(6000);
assert(
  (await stageOf(gated.watch_id)) === "WAITING_FOR_SETUP_CONFIRMATION",
  `an unmet prerequisite holds the watch (${await stageOf(gated.watch_id)})`,
);
assert(
  (await stageOf(armed.watch_id)) === "READY_FOR_ENTRY",
  `a met prerequisite arms the entry (${await stageOf(armed.watch_id)})`,
);
assert(orders.length === 0, "nothing has been ordered yet");

console.log("\n— a touch alone does not trade —");
phase = "touch";
spotPrice = 4331;
const touched = await waitFor(async () => (await stageOf(armed.watch_id)) === "ENTRY_TOUCHED", 20_000);
assert(Boolean(touched), `the entry zone was touched (${await stageOf(armed.watch_id)})`);
await sleep(4000);
assert(orders.length === 0, "a touch with no rejection, structure shift or displacement placed no order");

console.log("\n— the sequence completes and the order goes —");
phase = "confirm";
// Close enough to the planned entry that the entry is still the entry the
// setup described. §19's cap is context-aware — ATR and the setup's own
// risk — and the far price this used to run at is now correctly refused as
// a chase; that refusal is asserted on its own below.
spotPrice = 4329.4;
const executed = await waitFor(async () => (await stageOf(armed.watch_id)) === "EXECUTED", 45_000);
assert(Boolean(executed), `the watch reached EXECUTED (${await stageOf(armed.watch_id)})`);
assert(orders.length === 1, `exactly one order was placed (${orders.length})`);

const order = orders[0] || {};
assert(order.tradeSide === "SELL", `the order side matches the setup (${order.tradeSide})`);
assert(order.symbolId === 41, `the order carries the resolved symbol id (${order.symbolId})`);
assert(order.volume === 100, `0.01 lots was sent as 100 centi-units (${order.volume})`);
assert(order.stopLoss === 4370, `the stop was sent (${order.stopLoss})`);
assert(order.takeProfit === 4290, `the target was sent (${order.takeProfit})`);
assert(typeof order.label === "string" && order.label.includes("auto-1"), `the order is labelled (${order.label})`);

const listed = await call("list_watches");
const record = listed.recent.find((item) => item.id === armed.watch_id);
assert(record?.status === "EXECUTED", `the resolution is EXECUTED (${record?.status})`);
assert(Boolean(record?.execution?.orderId), `the broker order id was recorded (${record?.execution?.orderId})`);
assert(record?.execution?.volume === 0.01, `the lot size is recorded as lots (${record?.execution?.volume})`);
assert(Boolean(record?.sequence?.rejection), "the rejection that triggered it was recorded");
assert(Boolean(record?.sequence?.mss), "so was the structure shift");
assert(Boolean(record?.sequence?.displacement), "so was the displacement");

// §36 — the decision latency this entry actually ran at. Printed rather
// than bounded: the number depends on the host, and asserting a threshold
// here would make the suite fail on a slow CI box rather than on a bug.
console.log(
  `  [latency] market close → decision ${record?.latency?.marketToDecisionMs}ms ` +
    `(data fetch ${record?.latency?.dataFetchMs}ms, decision ${record?.latency?.decisionMs}ms, ` +
    `hold ${record?.latency?.holdMs}ms, lane ${record?.latency?.lane}, profile ${record?.latency?.profile})`,
);
assert(
  Number.isFinite(record?.latency?.marketToDecisionMs),
  "the entry records the latency it was decided at",
);

console.log("\n— the trade outlives the setup —");
const withTrade = await call("list_watches");
const trade = withTrade.active_trades.find((item) => item.parentWatchId === armed.watch_id);
assert(Boolean(trade), "an entry opens a tracked trade, separate from the setup that produced it");
assert(trade?.stage === "ACTIVE_TRADE", `the trade is on its own lifecycle (${trade?.stage})`);
assert(
  record?.status === "EXECUTED" && trade?.lifecycle === "ACTIVE_TRADE",
  "the setup stays resolved while the trade runs; nothing about the trade can reopen it",
);
const tradeTrail = await call("get_setup_trail", { watch_id: trade.id });
assert(
  tradeTrail.trail.some((event) => event.type === "trade_opened"),
  "and the trade carries its own event trail",
);
assert(
  Date.parse(record?.confirmedAt) >= Date.parse(record?.entryTouchedAt),
  "the confirmation is stamped after the touch",
);

console.log("\n— no second order —");
await sleep(6000);
assert(orders.length === 1, `still exactly one order after the setup resolved (${orders.length})`);
assert(
  (await stageOf(gated.watch_id)) === "WAITING_FOR_SETUP_CONFIRMATION",
  "the gated setup never traded",
);

console.log("\n— the kill switch —");
const paused = await call("pause_auto_trade", { reason: "smoke test" });
assert(paused.armed === false, "pausing disarms auto-trade");
const resumed = await call("resume_auto_trade");
assert(resumed.armed === true, "resuming re-arms it");

child.kill("SIGTERM");
await sleep(800);
upstream.close();
telegram.close();
rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? "\nAUTO-TRADE SMOKE FAILED\n" : "\nAUTO-TRADE SMOKE PASSED\n");
process.exit(process.exitCode || 0);
