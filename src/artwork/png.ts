/**
 * Zero-dependency pure-JS raster PNG encoder & studio cover-art renderer.
 *
 * Works identically in Cloudflare Workers (`workerd`) and Node.js using Web-standard
 * `CompressionStream("deflate")`. Generates crisp 512x512 raster PNG artwork for:
 *   - `/icon.png` (PWA manifest, Apple touch icon, MediaMetadata fallback)
 *   - `/feed/:token/art/master.png` (Master channel show art)
 *   - `/feed/:token/art/source-<id>.png` (Per-source show art)
 *   - `/feed/:token/art/episode-<id>.png` (Per-episode fallback cover art)
 */

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const writePromise = writer.write(raw as BufferSource).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await writePromise;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Encode an RGBA pixel buffer (`width * height * 4` bytes) into a standard PNG. */
export async function encodeRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  // Use filter type 1 (Sub) per scanline — compresses smooth gradients ~4x smaller than filter 0.
  const stride = width * 4;
  const filtered = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowOut = y * (1 + stride);
    const rowIn = y * stride;
    filtered[rowOut] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[rowIn + x - 4]! : 0;
      filtered[rowOut + 1 + x] = (rgba[rowIn + x]! - a) & 0xff;
    }
  }

  const idat = await zlibDeflate(filtered);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const cIhdr = pngChunk("IHDR", ihdr);
  const cIdat = pngChunk("IDAT", idat);
  const cIend = pngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(PNG_SIG.length + cIhdr.length + cIdat.length + cIend.length);
  let off = 0;
  png.set(PNG_SIG, off);
  off += PNG_SIG.length;
  png.set(cIhdr, off);
  off += cIhdr.length;
  png.set(cIdat, off);
  off += cIdat.length;
  png.set(cIend, off);
  return png;
}

type Rgb = [number, number, number];

interface CoverPalette {
  bgTop: Rgb;
  bgBottom: Rgb;
  glow: Rgb;
  accent: Rgb;
  ink: Rgb;
}

const PALETTES: readonly CoverPalette[] = [
  // Signature warm amber / obsidian studio (matches Audio Feed brand)
  { bgTop: [24, 21, 30], bgBottom: [12, 11, 16], glow: [245, 158, 11], accent: [251, 191, 36], ink: [255, 251, 235] },
  // Deep indigo / cyan broadcast
  { bgTop: [19, 24, 48], bgBottom: [10, 14, 28], glow: [56, 189, 248], accent: [125, 211, 252], ink: [240, 249, 255] },
  // Emerald / mint editorial
  { bgTop: [13, 35, 32], bgBottom: [9, 20, 20], glow: [16, 185, 129], accent: [52, 211, 153], ink: [236, 253, 245] },
  // Terracotta / coral sunset
  { bgTop: [45, 20, 24], bgBottom: [22, 11, 15], glow: [244, 63, 94], accent: [251, 113, 133], ink: [255, 241, 242] },
  // Royal violet / orchid
  { bgTop: [34, 20, 52], bgBottom: [16, 11, 28], glow: [168, 85, 247], accent: [192, 132, 252], ink: [250, 245, 255] },
  // Cobalt / electric blue
  { bgTop: [16, 30, 56], bgBottom: [9, 16, 32], glow: [59, 130, 246], accent: [96, 165, 250], ink: [239, 246, 255] },
  // Warm bronze / sand
  { bgTop: [42, 29, 18], bgBottom: [20, 14, 10], glow: [234, 88, 12], accent: [251, 146, 60], ink: [255, 247, 237] },
  // Slate teal / seafoam
  { bgTop: [15, 34, 44], bgBottom: [9, 18, 25], glow: [20, 184, 166], accent: [45, 212, 191], ink: [240, 253, 250] },
];

function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed distance to a rounded capsule / vertical pill centered at (cx, cy). */
function sdRoundedBox(
  px: number,
  py: number,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  radius: number,
): number {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

/** Minimal crisp 5x7 geometric bitmap font for cover monogram letters (A-Z, 0-9). */
const GLYPHS: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10011", "10101", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "11110", "10001", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
};

function extractMonogram(title: string): string {
  const words = title
    .replace(/[^a-zA-Z0-9\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length >= 2) {
    return `${words[0]![0]!.toUpperCase()}${words[1]![0]!.toUpperCase()}`;
  }
  if (words.length === 1) {
    const w = words[0]!.toUpperCase();
    return w.length >= 2 ? w.slice(0, 2) : w;
  }
  return "AF";
}

export interface RenderCoverOptions {
  seed: string;
  title?: string;
  mode?: "direct" | "deepdive" | "master";
  /** Output square size in pixels (default 512). */
  size?: number;
  /** Force the brand warm-amber palette (used for `/icon.png` and master feed). */
  brandPalette?: boolean;
}

/**
 * Render a deterministic, studio-grade square raster PNG cover (default 512x512).
 */
export async function renderCoverPng(options: RenderCoverOptions): Promise<Uint8Array> {
  const size = Math.max(64, Math.min(1024, Math.floor(options.size ?? 512)));
  const h = hashSeed(options.seed || options.title || "audio-feed");
  const palette = options.brandPalette
    ? PALETTES[0]!
    : PALETTES[h % PALETTES.length]!;
  const isDeepDive = options.mode === "deepdive";
  const isBrandIcon = options.brandPalette && !options.title;
  const monogram = options.title ? extractMonogram(options.title) : "";

  const rgba = new Uint8Array(size * size * 4);
  const invSize = 1 / size;

  // Deterministic waveform bar heights (7 symmetric bars for direct/master, twin cluster for deepdive).
  const barCount = isBrandIcon ? 5 : 7;
  const barHeights: number[] = [];
  for (let i = 0; i < barCount; i++) {
    const centerBias = 1 - Math.abs(i - (barCount - 1) / 2) / ((barCount + 1) / 2);
    const jitter = (((h >>> (i * 3)) & 7) / 7) * 0.14;
    const base = isBrandIcon
      ? [0.16, 0.28, 0.42, 0.28, 0.16][i]!
      : 0.11 + centerBias * 0.24 + jitter;
    barHeights.push(base);
  }

  // Soft ambient light centers
  const glow1X = 0.28 + ((h & 0xff) / 255) * 0.44;
  const glow1Y = 0.24 + (((h >>> 8) & 0xff) / 255) * 0.22;
  const glow2X = 1 - glow1X;
  const glow2Y = 0.78;

  // Precompute waveform pill geometry in normalized [0..1] coords
  const waveCenterY = monogram ? 0.66 : 0.50;
  const barSpacing = isBrandIcon ? 0.115 : 0.088;
  const barHalfW = isBrandIcon ? 0.032 : 0.022;
  const barStartX = 0.5 - ((barCount - 1) * barSpacing) / 2;

  // Precompute monogram cells in normalized coords (centered in upper card)
  const monoCells: Array<{ cx: number; cy: number; r: number }> = [];
  if (monogram) {
    const chars = [...monogram].filter((ch) => GLYPHS[ch]);
    const cell = 0.024;
    const gap = 0.004;
    const step = cell + gap;
    const charW = 5 * step;
    const charGap = 0.038;
    const totalW = chars.length * charW + Math.max(0, chars.length - 1) * charGap;
    const originX = 0.5 - totalW / 2;
    const originY = 0.23;
    chars.forEach((ch, ci) => {
      const grid = GLYPHS[ch]!;
      for (let row = 0; row < 7; row++) {
        const line = grid[row]!;
        for (let col = 0; col < 5; col++) {
          if (line[col] === "1") {
            monoCells.push({
              cx: originX + ci * (charW + charGap) + col * step + cell / 2,
              cy: originY + row * step + cell / 2,
              r: cell * 0.46,
            });
          }
        }
      }
    });
  }

  const aa = 1.5 * invSize;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * invSize;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * invSize;

      // Diagonal rich dark studio backdrop
      const gradT = clamp01(0.65 * v + 0.35 * u);
      let r = palette.bgTop[0] + (palette.bgBottom[0] - palette.bgTop[0]) * gradT;
      let g = palette.bgTop[1] + (palette.bgBottom[1] - palette.bgTop[1]) * gradT;
      let b = palette.bgTop[2] + (palette.bgBottom[2] - palette.bgTop[2]) * gradT;

      // Soft primary radial studio glow
      const d1 = Math.hypot(u - glow1X, v - glow1Y);
      const glowAmt1 = Math.exp(-d1 * d1 * 4.2) * 0.42;
      const d2 = Math.hypot(u - glow2X, v - glow2Y);
      const glowAmt2 = Math.exp(-d2 * d2 * 5.0) * 0.24;
      const glowAmt = glowAmt1 + glowAmt2;
      r += (palette.glow[0] - r) * glowAmt;
      g += (palette.glow[1] - g) * glowAmt;
      b += (palette.glow[2] - b) * glowAmt;

      // Subtle concentric acoustic rings centered behind waveform
      const ringDist = Math.hypot(u - 0.5, v - waveCenterY);
      for (let ri = 0; ri < 3; ri++) {
        const radius = 0.22 + ri * 0.13;
        const delta = Math.abs(ringDist - radius);
        if (delta < 0.0045) {
          const ringAlpha = (1 - smoothstep(0.001, 0.0045, delta)) * (0.14 - ri * 0.032);
          r += (palette.accent[0] - r) * ringAlpha;
          g += (palette.accent[1] - g) * ringAlpha;
          b += (palette.accent[2] - b) * ringAlpha;
        }
      }

      // Subtle inner frame border
      const frameD = Math.abs(sdRoundedBox(u, v, 0.5, 0.5, 0.44, 0.44, 0.075));
      if (frameD < 0.004) {
        const borderAlpha = (1 - smoothstep(0.001, 0.004, frameD)) * 0.16;
        r += (palette.ink[0] - r) * borderAlpha;
        g += (palette.ink[1] - g) * borderAlpha;
        b += (palette.ink[2] - b) * borderAlpha;
      }

      // Deep Dive twin-voice subtle indicator dots in top-right corner
      if (isDeepDive) {
        const dot1 = Math.hypot(u - 0.80, v - 0.14) - 0.022;
        const dot2 = Math.hypot(u - 0.855, v - 0.14) - 0.022;
        const dDot = Math.min(dot1, dot2);
        if (dDot < aa) {
          const a = (1 - smoothstep(-aa, aa, dDot)) * 0.92;
          r += (palette.accent[0] - r) * a;
          g += (palette.accent[1] - g) * a;
          b += (palette.accent[2] - b) * a;
        }
      }

      // Waveform capsules
      let minWave = 1;
      for (let i = 0; i < barCount; i++) {
        const cx = barStartX + i * barSpacing;
        const halfH = (barHeights[i]! * 0.5) * (monogram ? 0.62 : 1.0);
        const d = sdRoundedBox(u, v, cx, waveCenterY, barHalfW, halfH, barHalfW);
        if (d < minWave) minWave = d;
      }
      if (minWave < aa) {
        const a = 1 - smoothstep(-aa, aa, minWave);
        const blend = clamp01((v - (waveCenterY - 0.2)) / 0.4);
        const wr = palette.ink[0] * (1 - blend) + palette.accent[0] * blend;
        const wg = palette.ink[1] * (1 - blend) + palette.accent[1] * blend;
        const wb = palette.ink[2] * (1 - blend) + palette.accent[2] * blend;
        r += (wr - r) * a;
        g += (wg - g) * a;
        b += (wb - b) * a;
      }

      // Crisp geometric monogram (rounded dots for studio editorial aesthetic)
      if (monoCells.length > 0 && v >= 0.18 && v <= 0.47 && u >= 0.22 && u <= 0.78) {
        let minMono = 1;
        for (let i = 0; i < monoCells.length; i++) {
          const c = monoCells[i]!;
          const d = Math.hypot(u - c.cx, v - c.cy) - c.r;
          if (d < minMono) minMono = d;
        }
        if (minMono < aa) {
          const a = (1 - smoothstep(-aa, aa, minMono)) * 0.96;
          r += (palette.ink[0] - r) * a;
          g += (palette.ink[1] - g) * a;
          b += (palette.ink[2] - b) * a;
        }
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[idx + 3] = 255;
    }
  }

  return await encodeRgbaPng(size, size, rgba);
}

let cachedAppIconPng: Promise<Uint8Array> | null = null;

/** Cached 512x512 raster PNG app icon for `/icon.png`, PWA manifest, and MediaSession fallback. */
export function getAppIconPng(): Promise<Uint8Array> {
  if (!cachedAppIconPng) {
    cachedAppIconPng = renderCoverPng({
      seed: "audio-feed-brand-icon-v1",
      brandPalette: true,
      mode: "master",
      size: 512,
    });
  }
  return cachedAppIconPng;
}
