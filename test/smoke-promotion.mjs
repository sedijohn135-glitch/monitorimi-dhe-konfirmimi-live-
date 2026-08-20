/**
 * End-to-end trap-promotion smoke test.
 *
 * Two traps run side by side against a fake broker, and the whole test
 * is about the difference between them:
 *
 *   XAUUSD  closes beyond its trigger on a real delivery candle
 *           → promoted into a registered setup with entry, stop, targets
 *   XAGUSD  closes beyond its trigger on a 0.8x drift, with the trap's
 *           own require_displacement deliberately switched OFF
 *           → the trap confirms, and promotion refuses anyway
 *
 * The second case is the one that matters. It proves the promotion gate
 * is a second, independent filter rather than something that just rides
 * along on the trap's own displacement check — which is exactly the
 * XAUUSD session that motivated this: a body closed through the trigger
 * at 0.74x–0.83x against a 3.0x threshold, and nothing should have been
 * ordered.
 *
 *   node test/smoke-promotion.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCALE = 100_000;
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;

const orders = [];
let phase = "pre";
const spot = { XAUUSD: 4318, XAGUSD: 39.9 };

const px = (value) => Math.round(value * SCALE);
const candle = (timestamp, open, high, low, close) => ({
  timestamp,
  open: px(open),
  high: px(high),
  low: px(low),
  close: px(close),
});

// -- scripted candles -------------------------------------------------------
//
// Dated so the newest bar closed a second ago rather than on the
// wall-clock grid: the bar is still closed and still fresh, it just
// closes on the test's schedule instead of the quarter hour's.

function goldM15() {
  const last = Date.now() - M15 - 1000;
  const start = last - 29 * M15;
  const at = (i) => start + i * M15;
  const bars = [];
  for (let i = 0; i < 22; i += 1) {
    const drift = i * 0.1;
    bars.push(candle(at(i), 4340 - drift, 4341 - drift, 4339 - drift, 4340.2 - drift));
  }
  bars.push(candle(at(22), 4338, 4346, 4337.5, 4345)); // the swing high the stop goes behind
  bars.push(candle(at(23), 4345, 4345.5, 4338, 4338.5));
  bars.push(candle(at(24), 4338.5, 4339, 4330, 4330.5));
  bars.push(candle(at(25), 4330.5, 4331, 4326, 4326.5)); // SIBI ladder on the way down
  bars.push(candle(at(26), 4326.5, 4327, 4322, 4322.5));
  bars.push(candle(at(27), 4322.5, 4323, 4318, 4318.5));
  bars.push(candle(at(28), 4318.5, 4319, 4316, 4317));
  bars.push(
    phase === "confirm"
      ? candle(at(29), 4317, 4317.5, 4300, 4301) // body ~16 vs ~1 average: real delivery
      : candle(at(29), 4317, 4318, 4315.5, 4316),
  );
  return bars;
}

function goldH1() {
  const last = Date.now() - H1 - 1000;
  return Array.from({ length: 30 }, (_, i) =>
    candle(last - (29 - i) * H1, 4350 - i * 2, 4360 - i * 2, 4340 - i * 2, 4345 - i * 2),
  );
}

function silverM15() {
  const last = Date.now() - M15 - 1000;
  const start = last - 24 * M15;
  const at = (i) => start + i * M15;
  const bars = [];
  for (let i = 0; i < 24; i += 1) {
    bars.push(candle(at(i), 40.0, 40.1, 39.4, 39.5)); // steady 0.5 bodies
  }
  bars.push(
    phase === "confirm"
      ? candle(at(24), 39.7, 39.75, 39.3, 39.3) // body 0.4 against a 0.5 average — a drift
      : candle(at(24), 39.7, 39.9, 39.6, 39.8),
  );
  return bars;
}

const SERIES = {
  41: { M_15: goldM15, H_1: goldH1 },
  42: { M_15: silverM15 },
};

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
          { name: "get_balance" },
          { name: "get_positions" },
          {
            name: "create_order",
            inputSchema: {
              type: "object",
              properties: { symbolId: {}, tradeSide: {}, volume: {}, stopLoss: {}, takeProfit: {} },
              required: ["symbolId", "tradeSide", "volume"],
            },
          },
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
        const id = args.symbolId[0];
        const price = id === 42 ? spot.XAGUSD : spot.XAUUSD;
        const half = id === 42 ? 0.005 : 0.1;
        return text([{ symbolId: id, bid: px(price - half), ask: px(price + half) }]);
      }
      if (name === "get_trendbars") {
        const series = SERIES[args.symbolId]?.[args.period];
        if (!series) {
          res.statusCode = 200;
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32602, message: `no series for ${args.symbolId}/${args.period}` },
            }),
          );
        }
        return text(series());
      }
      if (name === "get_balance") return text({ balance: 10_000, currency: "USD" });
      if (name === "get_positions") return text([]);
      if (name === "create_order") {
        orders.push(args);
        return text({ orderId: 1 });
      }
      return text({});
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601 } }));
  });
});

const listen = (server, port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
await listen(upstream, 9821);

const dir = mkdtempSync(join(tmpdir(), "wm-promo-"));
const env = {
  ...process.env,
  PORT: "9823",
  CTRADER_MCP_URL: "http://127.0.0.1:9821/mcp",
  STATE_FILE: join(dir, "state.json"),
  WATCH_MONITOR_AUTH_TOKEN: "secret",
  SCHEDULER_TICK_MS: "1000",
  TRAP_WATCH_INTERVAL_MS: "10000",
  WATCH_INTERVAL_MS: "5000",
  BAR_CACHE_MAX_MS: "5000",
  BAR_CACHE_FRACTION: "0.02",
  SPOT_CACHE_MS: "0",
  NEWS_FILTER_ENABLED: "false",
  KILL_ZONE_FILTER_ENABLED: "false",
  // Promotion armed; execution deliberately not, so this test isolates
  // the bridge. Nothing here should reach the broker.
  AUTO_PROMOTE_TRAPS: "true",
  PROMOTE_REQUIRE_KILL_ZONE: "false",
  PROMOTE_MIN_TRAP_SCORE: "6",
  PROMOTE_DISPLACEMENT_MULTIPLE: "3",
};

const child = spawn(process.execPath, ["index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stdout.write(`  [srv] ${chunk}`));

const rpc = async (method, params, id = 1) => {
  const response = await fetch("http://127.0.0.1:9823/mcp", {
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
const resolutionOf = async (id) => {
  const listed = await call("list_watches");
  return listed.recent.find((record) => record.id === id);
};

await sleep(1500);

console.log("\n— promotion is armed and reports itself —");
const status = await call("get_auto_trade_status");
assert(status.trap_promotion?.enabled === true, "get_auto_trade_status reports promotion armed");
assert(status.trap_promotion.displacement_multiple === 3, "at the analysis threshold, not the execution one");
assert(
  status.limits.symbol_allowlist_meaning.startsWith("empty"),
  `an empty symbol allowlist is documented as permitting everything (${status.limits.symbol_allowlist_meaning})`,
);

console.log("\n— two traps, one of which will only drift —");
const gold = await call("register_trap_watch", {
  setup_id: "promo-gold",
  symbol: "XAUUSD",
  bias: "sell",
  timeframe: "M15",
  trigger_level: 4310,
  invalidation_level: 4360,
  trap_score: "7/9",
});
const silver = await call("register_trap_watch", {
  setup_id: "promo-silver",
  symbol: "XAGUSD",
  bias: "sell",
  timeframe: "M15",
  trigger_level: 39.5,
  invalidation_level: 41,
  trap_score: "7/9",
  // The trap's own delivery requirement is off, so it will confirm on
  // the close alone. Promotion has to refuse it on its own account.
  require_displacement: false,
});
assert(Boolean(gold.watch_id && silver.watch_id), "both traps registered");

await sleep(6000);
const before = await call("list_watches");
assert(before.active.length === 0, `no setups exist before either trigger (${before.active.length})`);
assert(before.active_trap_watches.length === 2, "both traps are being watched");

console.log("\n— the delivery candle prints —");
phase = "confirm";
spot.XAUUSD = 4301;
spot.XAGUSD = 39.3;

const promoted = await waitFor(async () => {
  const listed = await call("list_watches");
  return listed.active.find((watch) => watch.symbol === "XAUUSD");
}, 45_000);
assert(Boolean(promoted), "the delivered trap produced a live setup");

const goldResolution = await resolutionOf(gold.watch_id);
assert(goldResolution?.status === "CONDITIONS_MET", `the trap resolved (${goldResolution?.status})`);
assert(goldResolution?.promotion?.promoted === true, "and reports itself promoted");
assert(
  goldResolution?.promotion?.displacement_ratio >= 3,
  `on a qualifying ratio (${goldResolution?.promotion?.displacement_ratio?.toFixed?.(2)})`,
);
assert(
  goldResolution?.promotion?.gates?.every((gate) => gate.pass),
  "with every gate recorded as passed",
);

if (promoted) {
  console.log("\n— the computed setup —");
  console.log(
    `       entry ${promoted.entry} (${promoted.entry_zone_low}–${promoted.entry_zone_high}) ` +
      `sl ${promoted.sl} tp1 ${promoted.tp1} tp2 ${promoted.tp2} tp3 ${promoted.tp3}`,
  );
  assert(promoted.direction === "sell", `the setup takes the trap's side (${promoted.direction})`);
  assert(promoted.sl > promoted.entry, "the stop sits above a sell entry");
  assert(promoted.tp1 < promoted.entry, "the target sits below it");
  assert(
    promoted.entry_zone_low < promoted.entry && promoted.entry < promoted.entry_zone_high,
    "the entry sits inside its own zone",
  );
  assert(promoted.entry > 4301, "the entry is an array above price, not the level just displaced through");
  assert(
    Math.abs(promoted.tp1 - promoted.entry) >= Math.abs(promoted.entry - promoted.sl),
    "tp1 is at least 1R away",
  );
  assert(/Trap promotion/.test(promoted.setup_model || ""), `the model names itself (${promoted.setup_model})`);
  assert(promoted.setup_id === "promo-gold-promoted", `traceable to its trap (${promoted.setup_id})`);
}

console.log("\n— the drift is refused —");
const silverResolution = await waitFor(async () => {
  const record = await resolutionOf(silver.watch_id);
  return record?.status === "CONDITIONS_MET" ? record : null;
}, 30_000);
if (!silverResolution) {
  const listed = await call("list_watches");
  const live = listed.active_trap_watches.find((watch) => watch.id === silver.watch_id);
  console.log(
    `       silver trap still live: lifecycle=${live?.lifecycle} reason=${live?.lastReason} price=${live?.lastPrice}`,
  );
}
assert(Boolean(silverResolution), "the drifting trap confirmed on its own terms");
assert(
  silverResolution?.promotion?.promoted === false,
  "but promotion refused it",
);
assert(
  /displacement/.test(silverResolution?.promotion?.reason || ""),
  `naming the displacement gate (${silverResolution?.promotion?.reason})`,
);
assert(
  silverResolution?.promotion?.displacement_ratio < 3,
  `on a sub-threshold ratio (${silverResolution?.promotion?.displacement_ratio?.toFixed?.(2)})`,
);

const after = await call("list_watches");
assert(
  !after.active.some((watch) => watch.symbol === "XAGUSD"),
  "and no XAGUSD setup was created",
);
assert(orders.length === 0, `nothing was sent to the broker with auto-trade off (${orders.length})`);

child.kill("SIGTERM");
await sleep(800);
upstream.close();
rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? "\nPROMOTION SMOKE FAILED\n" : "\nPROMOTION SMOKE PASSED\n");
process.exit(process.exitCode || 0);
