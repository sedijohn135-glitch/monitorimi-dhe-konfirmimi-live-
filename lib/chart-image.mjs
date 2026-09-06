/**
 * chart-image.mjs — candlestick charts as PNG, with no dependencies.
 *
 * The monitor already holds the only thing a chart needs: OHLC bars from
 * the upstream feed. Drawing them here rather than photographing a
 * terminal means the picture and the numbers are the same object — the
 * levels in the image ARE the live levels, to the tick.
 *
 * PNG is written by hand (zlib is in the standard library, and
 * `zlib.crc32` since Node 20.15) because pulling an image library into a
 * service whose whole job is to stay up for weeks is a poor trade for
 * what amounts to rectangles and lines.
 */

import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// §1 PNG encoding

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * encodePng — width × height RGB bytes to a PNG buffer.
 * Colour type 2 (truecolour), 8 bits per channel, no interlace.
 */
export function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte; 0 means "none",
  // which costs a little size and saves a lot of code.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// §2 A canvas, in the only three operations a chart needs

export class Canvas {
  constructor(width, height, background = [12, 14, 18]) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      this.data[i * 3] = background[0];
      this.data[i * 3 + 1] = background[1];
      this.data[i * 3 + 2] = background[2];
    }
  }

  pixel(x, y, colour) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const offset = (py * this.width + px) * 3;
    this.data[offset] = colour[0];
    this.data[offset + 1] = colour[1];
    this.data[offset + 2] = colour[2];
  }

  fillRect(x, y, w, h, colour) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.pixel(px, py, colour);
    }
  }

  /** A horizontal rule, optionally dashed — price levels are drawn with it. */
  hLine(y, x0, x1, colour, dash = 0) {
    for (let x = Math.round(x0); x < Math.round(x1); x += 1) {
      if (dash > 0 && Math.floor(x / dash) % 2 === 1) continue;
      this.pixel(x, y, colour);
    }
  }

  toPng() {
    return encodePng(this.width, this.height, this.data);
  }
}

// ---------------------------------------------------------------------------
// §3 A 3×5 bitmap font — digits and the punctuation a price needs.
//
// Prices are the whole point of the picture: a chart whose levels cannot
// be read is a mood board. Letters are not here yet because nothing in
// the axis needs them.

const GLYPHS = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  ".": [0b000, 0b000, 0b000, 0b000, 0b010],
  "-": [0b000, 0b000, 0b111, 0b000, 0b000],
  ":": [0b000, 0b010, 0b000, 0b010, 0b000],
  " ": [0b000, 0b000, 0b000, 0b000, 0b000],
};

/** Draws `text` at (x, y), each glyph pixel expanded to `scale` square. */
export function drawText(canvas, text, x, y, colour, scale = 2) {
  let cursor = x;
  for (const character of String(text)) {
    const glyph = GLYPHS[character];
    if (glyph) {
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          if (glyph[row] & (1 << (2 - col))) {
            canvas.fillRect(cursor + col * scale, y + row * scale, scale, scale, colour);
          }
        }
      }
    }
    cursor += 4 * scale;
  }
  return cursor;
}

export function textWidth(text, scale = 2) {
  return String(text).length * 4 * scale;
}

// ---------------------------------------------------------------------------
// §4 The chart

const COLOURS = {
  background: [12, 14, 18],
  grid: [38, 42, 50],
  axis: [120, 128, 140],
  up: [38, 166, 108],
  down: [214, 68, 74],
  level: [232, 106, 196],
  label: [200, 206, 214],
};

/**
 * renderCandles — OHLC bars to a PNG.
 *
 * @param {Array<{open:number,high:number,low:number,close:number}>} bars
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {Array<{price:number,label?:string}>} [options.levels]
 *        Horizontal rules — entry, stop and targets, drawn dashed so they
 *        read as annotations rather than price action.
 * @returns {Buffer} PNG
 */
export function renderCandles(bars, options = {}) {
  const width = options.width || 900;
  const height = options.height || 520;
  const levels = Array.isArray(options.levels) ? options.levels : [];

  const canvas = new Canvas(width, height, COLOURS.background);
  const usable = bars.filter(
    (bar) =>
      bar &&
      [bar.open, bar.high, bar.low, bar.close].every((n) => typeof n === "number" && Number.isFinite(n)),
  );
  if (usable.length === 0) {
    drawText(canvas, "0", 10, 10, COLOURS.label, 2);
    return canvas.toPng();
  }

  // The price axis has to hold the annotated levels too, or a stop drawn
  // outside the range silently vanishes and the chart lies by omission.
  let min = Math.min(...usable.map((b) => b.low));
  let max = Math.max(...usable.map((b) => b.high));
  for (const level of levels) {
    if (typeof level?.price === "number" && Number.isFinite(level.price)) {
      min = Math.min(min, level.price);
      max = Math.max(max, level.price);
    }
  }
  const span = max - min || Math.abs(max) * 0.001 || 1;
  min -= span * 0.06;
  max += span * 0.06;

  const padRight = 86; // the price axis
  const padBottom = 6;
  const padTop = 6;
  const plotWidth = width - padRight;
  const plotHeight = height - padTop - padBottom;
  const yOf = (price) => padTop + ((max - price) / (max - min)) * plotHeight;

  // Grid and axis labels: six rules, priced.
  for (let i = 0; i <= 5; i += 1) {
    const price = min + ((max - min) * i) / 5;
    const y = yOf(price);
    canvas.hLine(Math.round(y), 0, plotWidth, COLOURS.grid);
    const decimals = max - min < 50 ? 2 : 1;
    drawText(canvas, price.toFixed(decimals), plotWidth + 6, Math.round(y) - 5, COLOURS.axis, 2);
  }

  // Candles. Wick is one pixel column at the body's centre; body is at
  // least a pixel tall so a doji is still visible.
  const slot = plotWidth / usable.length;
  const bodyWidth = Math.max(1, Math.floor(slot * 0.62));
  usable.forEach((bar, index) => {
    const centre = index * slot + slot / 2;
    const rising = bar.close >= bar.open;
    const colour = rising ? COLOURS.up : COLOURS.down;
    canvas.fillRect(centre - 0.5, yOf(bar.high), 1, Math.max(1, yOf(bar.low) - yOf(bar.high)), colour);
    const top = yOf(Math.max(bar.open, bar.close));
    const bottom = yOf(Math.min(bar.open, bar.close));
    canvas.fillRect(centre - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top), colour);
  });

  // Annotated levels last, so they sit above the price action.
  for (const level of levels) {
    if (typeof level?.price !== "number" || !Number.isFinite(level.price)) continue;
    const y = Math.round(yOf(level.price));
    canvas.hLine(y, 0, plotWidth, COLOURS.level, 5);
    const decimals = max - min < 50 ? 2 : 1;
    drawText(canvas, level.price.toFixed(decimals), plotWidth + 6, y - 5, COLOURS.level, 2);
  }

  return canvas.toPng();
}

/**
 * demoBars — a fixed, recognisable candle sequence.
 *
 * Its only job is to prove that an MCP client actually renders an image
 * block into the model's context. The shape is deliberately distinctive
 * — a rise, a sharp rejection, a drop — so a client that quietly drops
 * the image cannot be mistaken for one that delivered it.
 */
export function demoBars() {
  const pattern = [
    [100, 104, 99, 103], [103, 107, 102, 106], [106, 111, 105, 110],
    [110, 118, 109, 117], [117, 119, 111, 112], [112, 114, 104, 105],
    [105, 106, 98, 99], [99, 101, 94, 95], [95, 100, 93, 99],
    [99, 103, 97, 102], [102, 104, 96, 97], [97, 98, 90, 91],
  ];
  return pattern.map(([open, high, low, close]) => ({ open, high, low, close }));
}
