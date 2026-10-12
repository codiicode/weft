import type { Position } from "./types.ts";

/**
 * Paper realism for perps (Hyperliquid core and HIP-3): funding payments and an
 * isolated-margin liquidation estimate. Pure helpers; the tick wires them in.
 */

export const HOUR_MS = 3_600_000;

/** Maintenance margin rate used when the venue's max leverage is unknown. */
export const DEFAULT_MAINTENANCE_MARGIN = 0.03;

/**
 * Hyperliquid: maintenance margin is half the initial margin at max leverage,
 * i.e. 1 / (2 × maxLeverage). Falls back to 3 % when unknown.
 */
export function maintenanceMarginRate(maxLeverage: number | null | undefined): number {
  return maxLeverage != null && Number.isFinite(maxLeverage) && maxLeverage > 0 ? 1 / (2 * maxLeverage) : DEFAULT_MAINTENANCE_MARGIN;
}

/**
 * Liquidation price of an isolated position whose margin is entry × qty / leverage:
 * the price where margin + P&L equals maintenance margin (mm × qty × price).
 *   long:  entry × (1 − 1/L) / (1 − mm)
 *   short: entry × (1 + 1/L) / (1 + mm)
 * Same as Hyperliquid's `price − side × margin_available / size / (1 − mm × side)`.
 * Null when there is none (a 1× long can't be liquidated) or inputs are invalid.
 */
export function liquidationPrice(side: "long" | "short", entry: number, leverage: number, mm: number): number | null {
  if (!(entry > 0) || !(leverage >= 1) || !(mm >= 0) || !(mm < 1)) return null;
  const px = side === "long" ? (entry * (1 - 1 / leverage)) / (1 - mm) : (entry * (1 + 1 / leverage)) / (1 + mm);
  return px > 0 && Number.isFinite(px) ? px : null;
}

/** Perp positions the liquidation model applies to (a 1× long has no liquidation price). */
export function needsLiquidationPrice(p: Pick<Position, "instrument" | "side" | "leverage">): boolean {
  return p.instrument.kind === "perp" && (p.leverage > 1 || p.side === "short");
}

/** True when the mark has reached the position's liquidation price. */
export function liquidationCrossed(p: Pick<Position, "side" | "markPrice" | "liquidationPrice">): boolean {
  const liq = p.liquidationPrice;
  if (liq == null || !(p.markPrice > 0)) return false;
  return p.side === "long" ? p.markPrice <= liq : p.markPrice >= liq;
}

/**
 * Funding paid by a position over `hours` at `hourlyRate` (fraction per hour):
 * notional × rate × hours, positive when paid (longs pay when the rate is
 * positive, shorts receive), negative when received.
 */
export function fundingPayment(p: Pick<Position, "side" | "qty" | "markPrice">, hourlyRate: number, hours: number): number {
  const dir = p.side === "long" ? 1 : -1;
  return dir * p.qty * p.markPrice * hourlyRate * hours;
}
