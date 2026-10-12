/** Deterministic PRNG so mock data is stable across server/client renders. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random walk with drift; used for sparklines. */
export function walk(seed: number, n = 32, drift = 0.02, vol = 0.12, start = 1): number[] {
  const r = mulberry32(seed);
  const out = [start];
  for (let i = 1; i < n; i++) {
    const shock = (r() - 0.5) * 2 * vol;
    out.push(Math.max(0.05, out[i - 1] * (1 + drift * 0.1 + shock * 0.1)));
  }
  return out;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function fmtUsd(v: number, digits = 0) {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
export function fmtNum(v: number, digits = 0) {
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtPct(v: number, digits = 1, sign = true) {
  const s = `${Math.abs(v).toFixed(digits)}%`;
  if (!sign) return s;
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}
