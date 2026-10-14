/**
 * Chart indicators over closes. Each returns one value per bar (null until there is enough
 * history), so results line up with the bars by index.
 */

export interface OhlcBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export function sma(bars: OhlcBar[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.c;
    if (i >= n) sum -= bars[i - n]!.c;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(bars: OhlcBar[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  const k = 2 / (n + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!.c;
    if (prev == null) {
      seed += c;
      if (i === n - 1) prev = seed / n;
    } else {
      prev = c * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function bollinger(bars: OhlcBar[], n = 20, mult = 2): { upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(bars, n);
  const upper: (number | null)[] = new Array(bars.length).fill(null);
  const lower: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = n - 1; i < bars.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (bars[j]!.c - m) ** 2;
    const sd = Math.sqrt(v / n);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, lower };
}

/** Wilder's RSI. */
export function rsi(bars: OhlcBar[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.c - bars[i - 1]!.c;
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    if (i <= n) {
      gain += g;
      loss += l;
      if (i === n) {
        gain /= n;
        loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** Volume-weighted average price, restarting each UTC day. Bars without volume count equally. */
export function vwap(bars: OhlcBar[]): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const d = Math.floor(b.t / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const w = b.v && b.v > 0 ? b.v : 1;
    pv += ((b.h + b.l + b.c) / 3) * w;
    vol += w;
    out[i] = pv / vol;
  }
  return out;
}

export type IndicatorId = "ma20" | "ma50" | "ema21" | "vwap" | "bb" | "rsi" | "volume";

export const INDICATORS: { id: IndicatorId; label: string; hint: string; color: string }[] = [
  { id: "volume", label: "Volume", hint: "How much traded in each bar", color: "var(--faint)" },
  { id: "ma20", label: "MA 20", hint: "Average close of the last 20 bars", color: "#d4820a" },
  { id: "ma50", label: "MA 50", hint: "Average close of the last 50 bars", color: "#7c5cff" },
  { id: "ema21", label: "EMA 21", hint: "Faster average that weights recent bars more", color: "#0e9fb3" },
  { id: "vwap", label: "VWAP", hint: "Average price paid today, weighted by volume", color: "#d6457a" },
  { id: "bb", label: "Bollinger", hint: "Two standard deviations around the 20-bar average", color: "#8a8d94" },
  { id: "rsi", label: "RSI 14", hint: "Momentum from 0 to 100. Above 70 is stretched, below 30 washed out", color: "#7c5cff" },
];
