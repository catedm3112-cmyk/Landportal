/**
 * Generates public/og-cover.png — the TruTerra Land Analysis social-preview card
 * (1200×630) used as the default og:image for the branded report at /r/:contactId.
 *
 * Pure Node (zlib only) so it runs anywhere with no image dependencies. Draws a
 * diagonal forest-green gradient, faint topographic contour rings, the TRUTERRA
 * wordmark, a "LAND ANALYSIS" subtitle, and a locality tagline using a hand-rolled
 * 5×7 bitmap font.
 *
 *   node scripts/generate-og-cover.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const W = 1200;
const H = 630;

// ── RGBA canvas ────────────────────────────────────────────────────────────────
const buf = new Uint8Array(W * H * 4);
const setPx = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const ia = a / 255;
  buf[i] = Math.round(buf[i] * (1 - ia) + r * ia);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - ia) + g * ia);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - ia) + b * ia);
  buf[i + 3] = 255;
};

const lerp = (a, b, t) => a + (b - a) * t;

// ── Diagonal gradient background (deep forest → warm pine) ──────────────────────
const top = [0x14, 0x2c, 0x20];
const bot = [0x24, 0x43, 0x2f];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = (x / W) * 0.35 + (y / H) * 0.65;
    setPx(x, y, lerp(top[0], bot[0], t), lerp(top[1], bot[1], t), lerp(top[2], bot[2], t));
  }
}

// ── Faint topographic contour rings (lighter green, low alpha) ─────────────────
const cx = W * 0.82;
const cy = H * 0.28;
for (let ring = 0; ring < 9; ring++) {
  const rad = 70 + ring * 62;
  for (let a = 0; a < 3600; a++) {
    const ang = (a / 3600) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(ang) * rad);
    const y = Math.round(cy + Math.sin(ang) * rad * 0.82);
    setPx(x, y, 0x5f, 0x8a, 0x63, 26);
  }
}

// ── 5×7 bitmap font ─────────────────────────────────────────────────────────────
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "·": ["00000", "00000", "00100", "01110", "00100", "00000", "00000"],
};

const glyphW = 5;
const glyphH = 7;

const textWidth = (text, scale, spacing) =>
  text.length * glyphW * scale + (text.length - 1) * spacing;

function drawText(text, x, y, scale, [r, g, b], spacing = scale * 2) {
  let cursor = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] || FONT[" "];
    for (let gy = 0; gy < glyphH; gy++) {
      for (let gx = 0; gx < glyphW; gx++) {
        if (glyph[gy][gx] === "1") {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              setPx(cursor + gx * scale + sx, y + gy * scale + sy, r, g, b);
        }
      }
    }
    cursor += glyphW * scale + spacing;
  }
}

const CREAM = [0xf4, 0xf1, 0xe6];
const GOLD = [0xc9, 0xa2, 0x4b];

// ── Accent rule above the wordmark ─────────────────────────────────────────────
for (let x = 0; x < 96; x++)
  for (let y = 0; y < 6; y++) setPx(96 + x, 150, GOLD[0], GOLD[1], GOLD[2]);

// ── Wordmark: TRUTERRA ─────────────────────────────────────────────────────────
{
  const scale = 16;
  const spacing = 14;
  drawText("TRUTERRA", 92, 196, scale, CREAM, spacing);
}

// ── Subtitle: LAND ANALYSIS ────────────────────────────────────────────────────
{
  const scale = 9;
  const spacing = 8;
  drawText("LAND ANALYSIS", 96, 340, scale, GOLD, spacing);
}

// ── Tagline: SEVIER COUNTY · TENNESSEE ─────────────────────────────────────────
{
  const scale = 5;
  const spacing = 5;
  drawText("SEVIER COUNTY · TENNESSEE", 98, 430, scale, CREAM, spacing);
}

// ── Footer strip ───────────────────────────────────────────────────────────────
for (let y = H - 10; y < H; y++)
  for (let x = 0; x < W; x++) setPx(x, y, GOLD[0], GOLD[1], GOLD[2]);

// ── Encode PNG (truecolor+alpha, filter 0 per scanline) ────────────────────────
function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter: none
  buf.copy
    ? buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4)
    : raw.set(buf.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "og-cover.png");
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes, ${W}×${H})`);
