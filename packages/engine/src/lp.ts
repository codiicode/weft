/**
 * Liquidity positions (Meteora DLMM, "spot" shape: liquidity spread evenly over the range).
 *
 * The engine books a liquidity position in units that were worth $1 each when it opened (qty = USD
 * put in, entry price 1), so its mark is simply what one unit is worth now: the position's value
 * over what went in, plus the fees it has earned. P&L, exits on value and closing then work like
 * any other position.
 *
 * Value follows concentrated-liquidity math over [lower, upper] (constant liquidity in √price), the
 * close continuous version of an even spread over DLMM bins:
 *   price ≤ lower: all base token   x = L(1/√a − 1/√b),  value = x·p
 *   price ≥ upper: all quote token  y = L(√b − √a),      value = y
 *   in between:    x = L(1/√p − 1/√b), y = L(√p − √a),   value = x·p + y
 * Values are in the quote token; the USD value also moves with the quote token's own price.
 */

/** Position value at pool price `p` over its value at `p0` (quote-token terms; L cancels). */
export function lpValueRatio(p0: number, p: number, lower: number, upper: number): number {
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
export function lpBaseShare(p: number, lower: number, upper: number): number {
  const sa = Math.sqrt(lower), sb = Math.sqrt(upper);
  if (p <= lower) return 1;
  if (p >= upper) return 0;
  const sp = Math.sqrt(p);
  const x = (1 / sp - 1 / sb) * p, y = sp - sa;
  return x / (x + y);
}

/** The range in prices, from percentages around the opening price or as given. */
export function resolveRange(range: { lowerPct: number; upperPct: number } | { lower: number; upper: number }, p0: number): { lower: number; upper: number } {
  return "lowerPct" in range ? { lower: p0 * (1 - range.lowerPct / 100), upper: p0 * (1 + range.upperPct / 100) } : { lower: range.lower, upper: range.upper };
}
