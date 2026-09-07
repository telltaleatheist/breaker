/**
 * Generate Breaker's toolbar icons.
 *
 * The mark is a breaker switch: a dark panel, a recessed slot, and an amber handle
 * thrown to the up position. Amber carries it, because a toolbar icon has to read
 * on both a light and a dark Chrome theme and a dark-on-dark shape disappears.
 *
 * Written as code rather than committed as PNGs so the mark is reviewable and
 * editable in a pull request. The PNG encoder below is ~60 lines of node stdlib
 * (zlib for the pixel stream, a CRC32 table for the chunks) — a dependency-free
 * alternative to pulling in an image library for four small files.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'static', 'icons');
const SIZES = [16, 32, 48, 128];

// Matches the CSS brand mark in popup.css / options.css.
const PANEL = [0x23, 0x27, 0x2e, 255];
const SLOT = [0x12, 0x15, 0x1a, 255];
const HANDLE = [0xf5, 0x9e, 0x0b, 255];

/** 4× supersampling, box-downsampled — enough for clean edges at 16px. */
const SS = 4;

// ─── drawing ──────────────────────────────────────────────────────────────────

/** Is (px, py) inside the rounded rect [x0,y0]-[x1,y1] with corner radius r? */
function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundRect(pixels, width, x0, y0, x1, y1, r, colour) {
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(width - 1, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.ceil(y1);

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (!insideRoundRect(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) continue;
      const offset = (y * width + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = colour[3];
    }
  }
}

/** Average each SS×SS block, premultiplying so transparent edges do not darken. */
function downsample(pixels, width, height, factor) {
  const outWidth = width / factor;
  const outHeight = height / factor;
  const out = Buffer.alloc(outWidth * outHeight * 4);
  const samples = factor * factor;

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const offset = ((y * factor + sy) * width + (x * factor + sx)) * 4;
          const alpha = pixels[offset + 3] / 255;
          r += pixels[offset] * alpha;
          g += pixels[offset + 1] * alpha;
          b += pixels[offset + 2] * alpha;
          a += alpha;
        }
      }
      const outOffset = (y * outWidth + x) * 4;
      const coverage = a / samples;
      // Un-premultiply; a fully transparent block leaves black-transparent.
      out[outOffset] = coverage === 0 ? 0 : Math.round(r / a);
      out[outOffset + 1] = coverage === 0 ? 0 : Math.round(g / a);
      out[outOffset + 2] = coverage === 0 ? 0 : Math.round(b / a);
      out[outOffset + 3] = Math.round(coverage * 255);
    }
  }
  return out;
}

function renderIcon(size) {
  const width = size * SS;
  const height = size * SS;
  const pixels = new Uint8ClampedArray(width * height * 4); // transparent

  // Panel: full bleed, generously rounded.
  fillRoundRect(pixels, width, 0, 0, width, height, width * 0.22, PANEL);
  // Slot: the recess the handle sits in.
  fillRoundRect(pixels, width, width * 0.3, height * 0.14, width * 0.7, height * 0.86, width * 0.1, SLOT);
  // Handle, thrown up = circuit closed = blocking on.
  fillRoundRect(pixels, width, width * 0.34, height * 0.18, width * 0.66, height * 0.5, width * 0.08, HANDLE);

  return downsample(pixels, width, height, SS);
}

// ─── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type. 0 (None) keeps the encoder
  // trivial; these images are tiny and compress fine regardless.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ─── main ─────────────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(renderIcon(size), size));
  console.log(`[icons] wrote ${file}`);
}
