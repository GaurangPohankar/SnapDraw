/**
 * Generates the SnapDraw toolbar icons as real PNG files.
 *
 * The shapes mirror `src/components/Logo.tsx` (128x128 viewBox):
 * a rounded-square gradient tile, a white viewfinder frame and a pen stroke.
 * Icons are anti-aliased with 4x supersampling and encoded with zlib – no
 * image dependencies required.
 *
 * Usage: npm run icons
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "public", "icons");
const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;

/* -------------------------------------------------------------------------- */
/* Geometry (all in the 128x128 design space)                                 */
/* -------------------------------------------------------------------------- */

const TILE = { x: 4, y: 4, width: 120, height: 120, radius: 30 };
const GRADIENT_START = { x: 16, y: 8, color: [99, 102, 241] };
const GRADIENT_MID = { color: [124, 92, 240] };
const GRADIENT_END = { x: 112, y: 120, color: [168, 85, 247] };

const BRACKET_STROKE = 9;
const BRACKETS = [
  // top-left corner
  [{ x: 33, y: 30 }, { x: 45, y: 30 }],
  [{ x: 30, y: 33 }, { x: 30, y: 45 }],
  // top-right corner
  [{ x: 83, y: 30 }, { x: 95, y: 30 }],
  [{ x: 95, y: 33 }, { x: 95, y: 45 }],
  // bottom-left corner
  [{ x: 30, y: 83 }, { x: 30, y: 95 }],
  [{ x: 33, y: 95 }, { x: 45, y: 95 }],
  // bottom-right corner
  [{ x: 83, y: 95 }, { x: 95, y: 95 }],
  [{ x: 95, y: 83 }, { x: 95, y: 95 }],
];

const PEN_STROKE = { from: { x: 48, y: 82 }, to: { x: 74, y: 56 }, width: 11 };
const PEN_DOT = { x: 84, y: 46, radius: 8 };

/* -------------------------------------------------------------------------- */
/* Rasteriser                                                                 */
/* -------------------------------------------------------------------------- */

function pointInRoundedRect(px, py, rect) {
  const { x, y, width, height, radius } = rect;
  if (px < x || px > x + width || py < y || py > y + height) {
    return false;
  }
  const clampedX = Math.min(Math.max(px, x + radius), x + width - radius);
  const clampedY = Math.min(Math.max(py, y + radius), y + height - radius);
  const dx = px - clampedX;
  const dy = py - clampedY;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(px, py, from, to) {
  const vx = to.x - from.x;
  const vy = to.y - from.y;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) {
    return Math.hypot(px - from.x, py - from.y);
  }
  let t = ((px - from.x) * vx + (py - from.y) * vy) / lengthSquared;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (from.x + t * vx), py - (from.y + t * vy));
}

function mixColor(from, to, amount) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

/** Color of the tile gradient at a design-space point. */
function gradientColor(px, py) {
  const totalX = GRADIENT_END.x - GRADIENT_START.x;
  const totalY = GRADIENT_END.y - GRADIENT_START.y;
  const projection =
    ((px - GRADIENT_START.x) * totalX + (py - GRADIENT_START.y) * totalY) /
    (totalX * totalX + totalY * totalY);
  const t = Math.min(1, Math.max(0, projection));

  if (t < 0.55) {
    return mixColor(GRADIENT_START.color, GRADIENT_MID.color, t / 0.55);
  }
  return mixColor(GRADIENT_MID.color, GRADIENT_END.color, (t - 0.55) / 0.45);
}

/** White shape coverage (0..1) at a design-space point, ignoring the tile. */
function whiteCoverage(px, py) {
  let coverage = 0;

  for (const [from, to] of BRACKETS) {
    if (distanceToSegment(px, py, from, to) <= BRACKET_STROKE / 2) {
      coverage = Math.max(coverage, 0.92);
    }
  }

  if (
    distanceToSegment(px, py, PEN_STROKE.from, PEN_STROKE.to) <=
    PEN_STROKE.width / 2
  ) {
    coverage = 1;
  }

  if (Math.hypot(px - PEN_DOT.x, py - PEN_DOT.y) <= PEN_DOT.radius) {
    coverage = 1;
  }

  return coverage;
}

function renderIcon(size) {
  const scale = SUPERSAMPLE;
  const highSize = size * scale;
  const pixels = new Float32Array(highSize * highSize * 4);
  const designScale = 128 / highSize;

  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      const designX = (x + 0.5) * designScale;
      const designY = (y + 0.5) * designScale;
      const index = (y * highSize + x) * 4;

      if (!pointInRoundedRect(designX, designY, TILE)) {
        continue;
      }

      const [r, g, b] = gradientColor(designX, designY);
      const white = whiteCoverage(designX, designY);

      pixels[index] = r + (255 - r) * white;
      pixels[index + 1] = g + (255 - g) * white;
      pixels[index + 2] = b + (255 - b) * white;
      pixels[index + 3] = 255;
    }
  }

  // Box filter down to the target size.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * highSize + (x * scale + sx)) * 4;
          const alpha = pixels[index + 3] / 255;
          r += pixels[index] * alpha;
          g += pixels[index + 1] * alpha;
          b += pixels[index + 2] * alpha;
          a += alpha;
        }
      }

      const samples = scale * scale;
      const outIndex = (y * size + x) * 4;
      const alpha = a / samples;

      if (alpha > 0) {
        out[outIndex] = Math.round(r / a);
        out[outIndex + 1] = Math.round(g / a);
        out[outIndex + 2] = Math.round(b / a);
      }
      out[outIndex + 3] = Math.round(alpha * 255);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* PNG encoder                                                                */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: truecolor + alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */

await mkdir(outputDirectory, { recursive: true });

for (const size of SIZES) {
  const pixels = renderIcon(size);
  const filePath = path.join(outputDirectory, `icon${size}.png`);
  await writeFile(filePath, encodePng(size, pixels));
  console.log(`[icons] wrote ${path.relative(root, filePath)} (${size}x${size})`);
}
