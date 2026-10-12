/**
 * Hyperliquid tick and lot rules (docs: "Tick and lot size"; SDK: `Exchange._slippage_price`):
 *
 *  - Prices: at most 5 significant figures AND at most `MAX_DECIMALS − szDecimals` decimals,
 *    where MAX_DECIMALS is 6 for perps and 8 for spot. Integer prices are always valid.
 *  - Sizes: at most `szDecimals` decimals.
 */

export type MarketKind = "perp" | "spot";

export const MAX_DECIMALS: Record<MarketKind, number> = { perp: 6, spot: 8 };

/** Round to `decimals` places, avoiding binary artefacts (e.g. 1.005 → 1.01 not 1.00). */
function roundTo(x: number, decimals: number, mode: "nearest" | "down" | "up" = "nearest"): number {
  const f = 10 ** decimals;
  const scaled = Number((x * f).toPrecision(15));
  const r = mode === "down" ? Math.floor(scaled) : mode === "up" ? Math.ceil(scaled) : Math.round(scaled);
  return Number((r / f).toFixed(decimals));
}

export function priceDecimals(kind: MarketKind, szDecimals: number): number {
  return Math.max(0, MAX_DECIMALS[kind] - szDecimals);
}

/**
 * Round a price to a valid tick, like the SDK (`round(float(f"{px:.5g}"), MAX_DECIMALS − szDecimals)`),
 * except that integer prices are kept as-is (always valid per the docs).
 */
export function roundPrice(px: number, kind: MarketKind, szDecimals: number): number {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error(`invalid price ${px}`);
  if (Number.isInteger(px)) return px;
  const sig5 = Number(px.toPrecision(5));
  const out = roundTo(sig5, priceDecimals(kind, szDecimals));
  if (!(out > 0)) throw new Error(`price ${px} rounds to 0 with ${priceDecimals(kind, szDecimals)} decimals`);
  return out;
}

/** True if `px` is already a valid Hyperliquid price for this market. */
export function isValidPrice(px: number, kind: MarketKind, szDecimals: number): boolean {
  if (!(px > 0) || !Number.isFinite(px)) return false;
  if (Number.isInteger(px)) return true;
  return Number(px.toPrecision(5)) === px && roundTo(px, priceDecimals(kind, szDecimals)) === px;
}

/** Round a size to `szDecimals`. Defaults to rounding down so notional never exceeds what was approved. */
export function roundSize(sz: number, szDecimals: number, mode: "nearest" | "down" | "up" = "down"): number {
  if (!(sz >= 0) || !Number.isFinite(sz)) throw new Error(`invalid size ${sz}`);
  return roundTo(sz, szDecimals, mode);
}

/**
 * Aggressive IOC limit price for a "market" order: mid × (1 ± slippage), then tick-rounded.
 * Mirrors `Exchange._slippage_price` (default slippage there is 5%).
 */
export function slippagePrice(mid: number, isBuy: boolean, slippage: number, kind: MarketKind, szDecimals: number): number {
  if (!(slippage >= 0 && slippage < 1)) throw new Error(`slippage must be a fraction in [0, 1), got ${slippage}`);
  const px = mid * (isBuy ? 1 + slippage : 1 - slippage);
  return roundPrice(px, kind, szDecimals);
}
