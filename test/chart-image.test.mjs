/**
 * chart-image suite — the picture has to be a real PNG, and it has to
 * show what the caller asked for.
 *
 * The reason this is tested at all: an image that renders as a blank or
 * malformed file fails silently. The model receives *something*, says
 * nothing useful, and the failure looks like a bad analysis rather than
 * a broken encoder.
 *
 *   node --test test/chart-image.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { encodePng, renderCandles, demoBars, Canvas, drawText } from "../lib/chart-image.mjs";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function readHeader(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), PNG_SIGNATURE, "PNG signature");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR", "IHDR comes first");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colourType: png[25],
  };
}

// ---------------------------------------------------------------------------
// The encoder.

test("CI1 — a rendered chart is a structurally valid PNG", () => {
  const png = renderCandles(demoBars(), { width: 640, height: 400 });
  const header = readHeader(png);
  assert.deepEqual(header, { width: 640, height: 400, bitDepth: 8, colourType: 2 });
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
});

test("CI2 — the pixel data round-trips through zlib", () => {
  // A 2×1 image: one red pixel, one blue. If the scanline filter bytes or
  // the stride were wrong this is where it shows.
  const rgb = Buffer.from([255, 0, 0, 0, 0, 255]);
  const png = encodePng(2, 1, rgb);
  const idatStart = png.indexOf(Buffer.from("IDAT", "ascii")) + 4;
  const idatLength = png.readUInt32BE(idatStart - 8);
  const inflated = zlib.inflateSync(png.subarray(idatStart, idatStart + idatLength));
  assert.equal(inflated[0], 0, "filter byte is 'none'");
  assert.deepEqual([...inflated.subarray(1)], [255, 0, 0, 0, 0, 255]);
});

// ---------------------------------------------------------------------------
// The chart.

test("CI3 — the demo chart is a fixed, recognisable sequence", () => {
  const bars = demoBars();
  assert.equal(bars.length, 12);
  for (const bar of bars) {
    assert.ok(bar.high >= Math.max(bar.open, bar.close), "high tops the body");
    assert.ok(bar.low <= Math.min(bar.open, bar.close), "low bottoms the body");
  }
  assert.ok(bars.some((b) => b.close > b.open), "it contains up candles");
  assert.ok(bars.some((b) => b.close < b.open), "and down candles");
});

test("CI4 — an annotated level outside the candle range still fits on the axis", () => {
  // The failure this prevents: a stop drawn beyond the highest high gets
  // clipped away, and the chart quietly omits the one level the analysis
  // most needs to see.
  const bars = demoBars();
  const plain = renderCandles(bars, { width: 320, height: 200 });
  const withFarLevel = renderCandles(bars, { width: 320, height: 200, levels: [{ price: 400 }] });
  assert.notEqual(
    plain.toString("base64"),
    withFarLevel.toString("base64"),
    "a level far outside the range must rescale the axis, not be dropped",
  );
});

test("CI5 — degenerate inputs render rather than throw", () => {
  assert.doesNotThrow(() => renderCandles([], { width: 200, height: 120 }));
  assert.doesNotThrow(() => renderCandles(null ?? [], { width: 200, height: 120 }));
  // A flat market: every bar identical, so the price span is zero.
  const flat = Array.from({ length: 5 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
  const png = renderCandles(flat, { width: 200, height: 120 });
  assert.equal(readHeader(png).width, 200);
});

test("CI6 — bars carrying junk are skipped, not drawn", () => {
  const mixed = [
    { open: 10, high: 12, low: 9, close: 11 },
    { open: null, high: 12, low: 9, close: 11 },
    { open: 11, high: NaN, low: 9, close: 10 },
    { open: 11, high: 13, low: 10, close: 12 },
  ];
  assert.doesNotThrow(() => renderCandles(mixed, { width: 200, height: 120 }));
});

// ---------------------------------------------------------------------------
// Text, because a chart whose prices cannot be read is decoration.

test("CI7 — drawing text puts ink on the canvas and advances the cursor", () => {
  const canvas = new Canvas(60, 20, [0, 0, 0]);
  const before = Buffer.from(canvas.data);
  const end = drawText(canvas, "4374.50", 2, 2, [255, 255, 255], 2);
  assert.ok(end > 2, "the cursor advanced");
  assert.notDeepEqual([...canvas.data], [...before], "pixels were written");
});

test("CI8 — an unknown character costs space but draws nothing", () => {
  const canvas = new Canvas(60, 20, [0, 0, 0]);
  const end = drawText(canvas, "§", 0, 0, [255, 255, 255], 2);
  assert.equal(end, 8, "it still advances one cell");
  assert.ok(canvas.data.every((byte) => byte === 0), "and leaves no ink");
});
