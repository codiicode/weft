/**
 * Liquidity positions (Meteora DLMM).
 *
 * The engine books a liquidity position in units that were worth $1 each when it opened (qty = USD
 * put in, entry price 1), so its mark is simply what one unit is worth now: the position's value
 * over what went in, plus the fees it has earned. P&L, exits on value and closing then work like
 * any other position.
 *
 * "spot" (liquidity spread evenly) follows concentrated-liquidity math over [lower, upper] (constant
 * liquidity in √price), the close continuous version of an even spread over DLMM bins:
 *   price ≤ lower: all base token   x = L(1/√a − 1/√b),  value = x·p
 *   price ≥ upper: all quote token  y = L(√b − √a),      value = y
 *   in between:    x = L(1/√p − 1/√b), y = L(√p − √a),   value = x·p + y
 * "bid_ask" puts more liquidity the further a price is from the opening price (DLMM's bid-ask
 * shape: little near the price, most at the edges), worked out over bins: a bin above the opening
 * price starts as base token, one below as quote, and the price crossing a bin swaps it at that
 * bin's price.
 * A range can sit entirely on one side of the price ("one-sided"): below it the position starts
 * as all quote token (e.g. only SOL in a TOKEN-SOL pool), above it as all base token.
 * Values are in the quote token; the USD value also moves with the quote token's own price.
 */

export type LpShape = "spot" | "bid_ask";

/** Position value at pool price `p` over its value at `p0` (quote-token terms). */
export function lpValueRatio(p0: number, p: number, lower: number, upper: number, shape: LpShape = "spot"): number {
  if (shape === "bid_ask") return binned(p0, p, lower, upper).value;
  return lpValue(p, lower, upper) / lpValue(p0, lower, upper);
}

function lpValue(p: number, a: number, b: number): number {
  const sa = Math.sqrt(a), sb = Math.sqrt(b);
  if (p <= a) return (1 / sa - 1 / sb) * p;
  if (p >= b) return sb - sa;
  const sp = Math.sqrt(p);
  return (1 / sp - 1 / sb) * p + (sp - sa);
}

/** Share of the position held in the base token at price `p` (0 above the range, 1 below it). */
export function lpBaseShare(p: number, lower: number, upper: number, shape: LpShape = "spot", p0 = p): number {
  if (p <= lower) return 1;
  if (p >= upper) return 0;
  if (shape === "bid_ask") {
    const r = binned(p0, p, lower, upper);
    return r.value > 0 ? r.base / r.value : 0;
  }
  const sa = Math.sqrt(lower), sb = Math.sqrt(upper);
  const sp = Math.sqrt(p);
  const x = (1 / sp - 1 / sb) * p, y = sp - sa;
  return x / (x + y);
}

const BINS = 64;

/**
 * A bid-ask position worth 1 at `p0`, split over bins: each bin's share grows with its distance
 * from `p0`. Returns its value at `p` and the part of that value held in the base token.
 */
function binned(p0: number, p: number, lower: number, upper: number): { value: number; base: number } {
  const prices = Array.from({ length: BINS }, (_, k) => lower * Math.pow(upper / lower, (k + 0.5) / BINS));
  const w = prices.map((q) => Math.abs(Math.log(q / p0)) + 1e-9);
  const total = w.reduce((s, x) => s + x, 0);
  let base = 0, quote = 0;
  prices.forEach((q, k) => {
    const v = w[k]! / total;
    const startsBase = q > p0;
    if (q > p) base += (startsBase ? v / p0 : v / q) * p; // holds base now (bought at q if it started as quote)
    else quote += startsBase ? (v / p0) * q : v; // holds quote now (sold at q if it started as base)
  });
  return { value: base + quote, base };
}

/** The range in prices, from percentages around the opening price or as given. */
export function resolveRange(range: { lowerPct: number; upperPct: number } | { lower: number; upper: number }, p0: number): { lower: number; upper: number } {
  return "lowerPct" in range ? { lower: p0 * (1 - range.lowerPct / 100), upper: p0 * (1 + range.upperPct / 100) } : { lower: range.lower, upper: range.upper };
}
