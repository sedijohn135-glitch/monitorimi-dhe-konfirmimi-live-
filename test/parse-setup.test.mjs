// Quick test of the parse-setup module against the user's example text.
import { parseSetupText } from "../lib/parse-setup.mjs";

const sample = `The market will execute a sell-side liquidity (SSL) sweep below the local 4424.00–4423.51 lows to trap retail breakout short-sellers before initiating the PM Silver Bullet expansion upward.
🪤 KURTHI IDENTIFIED:
Direction of trap: DOWN sweep (SSL Raid)
Liquidity being hunted: SSL below 4424.00 / 4423.51 on M1/M5
Expected trap move: -3.5 to -4.5 USD sweep into H4 Breaker support
Kurthi landing zone: 4423.50 – 4425.00
PDA array at landing: H4 Bullish Breaker Block / M1 Bullish Order Block & SSL Sweep
Fibo Master Sniper Zone (5.0–16.8): 4423.80 – 4425.20
After trap → REAL direction: BULLISH
✅ VIABILITY CHECK:
Çmimi aktual : 4427.71
Distanca Entry→TP1 : 10.50 USD (105 pips) [VALID]
TP1 ende i gjallë : PO
Displacement ndodhur? : PO (gjendem para kurthit / gjatë retracement te zona e kurthit)
Verdict : ✅ SETUP VALID — VAZHDO
╔══════════════════════════════════════════════════════════╗
║ 🎯 ICT SNIPER TRADE SETUP                                ║
╠══════════════════════════════════════════════════════════╣
║ INSTRUMENT : XAUUSD                                      ║
║ DIRECTION : 📈 LONG                                      ║
║ ENTRY MODEL : Silver Bullet PM + SSL Sweep Breaker       ║
║ TIMEFRAME HTF : H4 Bullish Breaker / D1 Retracement      ║
║ TIMEFRAME LTF : M5/M1 SSL Sweep & Bullish Reversal       ║
╠══════════════════════════════════════════════════════════╣
║ 🟢 ENTRY ZONE : 4424.50 – 4426.00                        ║
║ 🔴 SL ZONE : 4419.00                                     ║
║ 🎯 TARGET 1 : 4435.50                                    ║
║ 🎯 TARGET 2 : 4440.00                                    ║
║ 🎯 TARGET 3 : 4452.50                                    ║
╠══════════════════════════════════════════════════════════╣
║ RR RATIO : 1:1.75 (TP1) / 1:2.5 (TP2) / 1:4.58 (TP3)     ║
║ CONFIDENCE : 85%                                         ║
╠══════════════════════════════════════════════════════════╣
║ PDA ARRAY (Entry) : H4 Bullish Breaker Block / M1 OB     ║
║ CISD CONFIRMATION : Yes                                  ║
║ LIQUIDITY (Target) : M5/M15 BSL (4435.96 & 4440.11)       ║
║ KILL ZONE ACTIVE : Yes (PM Session / Silver Bullet 2-3PM)║
║ MACRO CONFIRMATION : Yes (PM Macro 2:50–3:10 PM ET)      ║
║ BPR / CE : Yes (M5 SIBI CE at 4435.50)                   ║
║ BREAKAWAY GAP : No                                       ║
║ GAP RISK : No                                            ║
║ LUNCH MACRO TARGET : 4440.11 (First swing high post 10AM)║
║ PM INVERSION ARRAYS : Yes                                ║
╠══════════════════════════════════════════════════════════╣
║ ⛔ INVALIDATION: If price closes below 4419.00 on M5 body,║
║ exit immediately.                                        ║
╚══════════════════════════════════════════════════════════╝

ALGORITHMIC RATIONALE:
 * HTF Context: XAUUSD has completed a deep discount retracement on D1 into the major H4 Bullish Breaker Block formed around 4426.00 (the key August 17 structure high broken upward).
 * Entry PDA & CISD: M1/M5 price action shows a sell-side liquidity raid sweeping local stops down to 4423.51 followed by immediate wick rejection, confirming a Change in State of Delivery (CISD) back into institutional buy-side flow.
 * Targeted Liquidity: Algorithmic delivery targets clean buy-side liquidity (BSL) sitting at 4435.96 and 4440.11, as well as PM inversion resistance up to 4452.50.
 * Time & Macro Alignment: Current time is 14:35 NY ET (2:35 PM ET), placing execution directly inside the PM Silver Bullet window (2:00–3:00 PM ET) ahead of the 2:50–3:10 PM ET macro delivery window.
 * Entry Model: Limit / Shadow Entry inside the Kurthi sweep landing zone (4424.50–4426.00) anchored to the H4 Breaker and M1 Order Block.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🪤 KURTHI (TRAP):
Direction: DOWN sweep
Target liquidity: SSL below 4424.00 / 4423.51
Expected wick to: 4423.50 – 4425.00
After trap → real move: BULLISH
🎯 SNIPER SETUP:
BUY XAUUSD AT THIS PRICE:
SNIPER 0 FLOAT ENTRY PRICE : 4425.00
STOP LOSS : 4419.00
TP1 : 4435.50
TP2 : 4440.00
TP3 : 4452.50
CONFIDENCE : 85%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ OPERATOR WARNING: All prices are copied directly into MT5 terminal for live execution. Verify spread before entry.`;

const result = parseSetupText(sample);
console.log("=== PARSED ===");
console.log(JSON.stringify(result, null, 2));
console.log("\n=== Recognised fields ===");
console.log(result.recognised);
console.log("\n=== Missing fields ===");
console.log(result.missing);
console.log("\n=== Warnings ===");
console.log(result.warnings);

// Validate that the parsed input would pass register_watch validation
// by simulating what validateWatchInput would check
const p = result.parsed;
console.log("\n=== Sanity checks ===");
console.log("symbol:", p.symbol);
console.log("direction:", p.direction);
console.log("entry:", p.entry);
console.log("entry_zone:", [p.entry_zone_low, p.entry_zone_high]);
console.log("sl:", p.sl);
console.log("invalidation:", p.invalidation);
console.log("tp1:", p.tp1, "tp2:", p.tp2, "tp3:", p.tp3);

if (p.direction === "buy") {
  console.log("buy check entry > sl:", p.entry > p.sl);
  console.log("buy check tp1 > entry:", p.tp1 > p.entry);
  console.log("buy check invalidation < entry:", p.invalidation < p.entry);
}
const risk = Math.abs(p.entry - p.sl);
const reward = Math.abs(p.tp1 - p.entry);
console.log("R/R ratio (TP1):", (reward / risk).toFixed(2));
