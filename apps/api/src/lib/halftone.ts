import { crc32, deflateSync } from "node:zlib";

/**
 * Weft's print look, server-side: the same halftone as content/x-banner/v2/banners.html (dots on a
 * 45° screen whose area follows the tone, type and rules printed solid like a riso plate, paper
 * grain), on raw RGBA so the API can print its cards without a browser.
 */
export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, opaque. */
  data: Uint8Array;
}

export interface Plate {
  paper: string;
  ink: string;
  cell?: number;
  angle?: number;
  contrast?: number;
  lift?: number;
  grain?: number;
  /** Below this luminance the source prints as solid ink (type, rules). */
  solid?: number;
  /** A second ink for source pixels that are clearly this colour (e.g. a red loss). */
  accent?: { ink: string; match: (r: number, g: number, b: number) => boolean };
}

const hex = (c: string): [number, number, number] => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) as [number, number, number];

/** The banner generator's seeded random (same constants), so every card's grain is stable. */
function srnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

export function halftone(src: Pixels, o: Plate): Pixels {
  const { width: w, height: h, data: d } = src;
  const cell = o.cell ?? 6, angle = o.angle ?? 45, contrast = o.contrast ?? 1.1, lift = o.lift ?? 0, grain = o.grain ?? 0.06, solid = o.solid ?? 0;
  const paper = hex(o.paper), ink = hex(o.ink), accent = o.accent ? hex(o.accent.ink) : null;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = paper[0]; out[i + 1] = paper[1]; out[i + 2] = paper[2]; out[i + 3] = 255; }
  const lum = (x: number, y: number) => {
    x = Math.max(0, Math.min(w - 1, x | 0)); y = Math.max(0, Math.min(h - 1, y | 0));
    const i = (y * w + x) * 4;
    return (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) / 255;
  };
  const area = (x: number, y: number, rr: number) => {
    let s = 0, n = 0;
    for (let dy = -rr; dy <= rr; dy += 2) for (let dx = -rr; dx <= rr; dx += 2) { s += lum(x + dx, y + dy); n++; }
    return s / n;
  };
  const isAccent = (x: number, y: number) => {
    if (!o.accent) return false;
    x = Math.max(0, Math.min(w - 1, x | 0)); y = Math.max(0, Math.min(h - 1, y | 0));
    const i = (y * w + x) * 4;
    return o.accent.match(d[i]!, d[i + 1]!, d[i + 2]!);
  };
  // One anti-aliased dot.
  const disc = (cx: number, cy: number, r: number, col: [number, number, number]) => {
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const cov = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
        if (cov <= 0) continue;
        const i = (y * w + x) * 4;
        out[i] = out[i]! * (1 - cov) + col[0] * cov;
        out[i + 1] = out[i + 1]! * (1 - cov) + col[1] * cov;
        out[i + 2] = out[i + 2]! * (1 - cov) + col[2] * cov;
      }
  };
  const dark = (L: number) => Math.max(0, Math.min(1, (1 - L - 0.5) * contrast + 0.5 + lift));
  // Dot area follows the tone, as in print: area = coverage × cell².
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a), D = Math.hypot(w, h);
  for (let v = -D; v < D; v += cell)
    for (let u = -D; u < D; u += cell) {
      const x = w / 2 + u * ca - v * sa, y = h / 2 + u * sa + v * ca;
      if (x < -cell || y < -cell || x > w + cell || y > h + cell) continue;
      const rad = cell * Math.min(0.74, 0.5642 * 1.06 * Math.sqrt(dark(area(x, y, Math.max(1, (cell / 2) | 0)))));
      if (rad > 0.25) disc(x, y, rad, accent && isAccent(x, y) ? accent : ink);
    }
  // Type and rules print solid; then the paper grain.
  const rnd = srnd(w * 7 + h);
  for (let i = 0; i < out.length; i += 4) {
    if (solid) {
      const L = (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) / 255;
      const k = Math.max(0, Math.min(1, (solid - L) / 0.12));
      if (k > 0) {
        const col = accent && o.accent!.match(d[i]!, d[i + 1]!, d[i + 2]!) ? accent : ink;
        for (let c = 0; c < 3; c++) out[i + c] = out[i + c]! * (1 - k) + col[c]! * k;
      }
    }
    const n = (rnd() - 0.5) * 255 * grain;
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, out[i + c]! + n));
  }
  return { width: w, height: h, data: out };
}

/** Half the size, averaging 2×2 blocks (how the banners are shown at 1×). */
export function half(p: Pixels): Pixels {
  const w = p.width >> 1, h = p.height >> 1, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        const i = ((2 * y) * p.width + 2 * x) * 4 + c, j = i + p.width * 4;
        out[(y * w + x) * 4 + c] = (p.data[i]! + p.data[i + 4]! + p.data[j]! + p.data[j + 4]! + 2) >> 2;
      }
  return { width: w, height: h, data: out };
}

/** A plain RGBA PNG. */
export function encodePng(p: Pixels): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(p.width, 0); ihdr.writeUInt32BE(p.height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((p.width * 4 + 1) * p.height);
  for (let y = 0; y < p.height; y++) {
    raw[y * (p.width * 4 + 1)] = 0;
    Buffer.from(p.data.buffer, p.data.byteOffset + y * p.width * 4, p.width * 4).copy(raw, y * (p.width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
