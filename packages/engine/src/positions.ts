import type { Exits, Level } from "@weft/strategy";
import type { FillReason, Position } from "./types.ts";

/**
 * Position math. All P&L is linear in price:
 *   pnl = qty × (mark − entry) × dir,  dir = +1 long / −1 short
 * For perps qty = margin × leverage / entry, so P&L on margin is multiplied by leverage.
 * Outcome shares are priced as probabilities (0–1), option legs on premium.
 */

export const dirOf = (p: Pick<Position, "side">): 1 | -1 => (p.side === "long" ? 1 : -1);

export function markPosition(p: Position, price: number, now: number): void {
  p.markPrice = price;
  p.markedAt = now;
  p.unrealizedPnlUsd = p.qty * (price - p.entryPrice) * dirOf(p);
  p.unrealizedPnlPct = p.sizeUsd > 0 ? (p.unrealizedPnlUsd / p.sizeUsd) * 100 : 0;
  p.peakPrice = p.side === "long" ? Math.max(p.peakPrice, price) : Math.min(p.peakPrice, price);
}

/** Notional exposure as the risk engine counts it: margin × leverage. */
export const exposureOf = (positions: Position[]) => positions.reduce((s, p) => s + p.sizeUsd * p.leverage, 0);
export const marginOf = (positions: Position[]) => positions.reduce((s, p) => s + p.sizeUsd, 0);
export const unrealizedOf = (positions: Position[]) => positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);

const levelValue = (l: Level): number => ("price" in l ? l.price : "prob" in l ? l.prob : NaN);

/** A relative level as a price move from entry, in percent: `positionPct` is spread over the leverage. */
export const levelMovePct = (l: Level, leverage: number): number | null =>
  "pct" in l ? l.pct : "positionPct" in l ? l.positionPct / Math.max(1, leverage) : null;

/**
 * Exit check for a single position. Order: stop-loss, trailing stop, take-profit, time.
 * - `pct` levels are price moves from entry: in favour for TP, against for SL (not leveraged ROE).
 * - `positionPct` levels are gain/loss on the position's margin (leveraged ROE): pct × leverage.
 * - `price` / `prob` levels are absolute: long TP when mark ≥ level, SL when mark ≤ level; mirrored for shorts.
 * - trailing: long exits when mark ≤ peak × (1 − t%), short when mark ≥ trough × (1 + t%).
 */
export function exitReason(p: Position, now: number): FillReason | null {
  const e = p.exits;
  const d = dirOf(p);
  const px = p.markPrice;
  const movePct = ((px - p.entryPrice) / p.entryPrice) * 100 * d;
  if (e.stopLoss) {
    const sl = e.stopLoss;
    const rel = levelMovePct(sl, p.leverage);
    const hit = rel != null ? movePct <= -rel : d === 1 ? px <= levelValue(sl) : px >= levelValue(sl);
    if (hit) return "stop_loss";
  }
  if (e.trailingStopPct != null) {
    const t = e.trailingStopPct / 100;
    const hit = d === 1 ? px <= p.peakPrice * (1 - t) : px >= p.peakPrice * (1 + t);
    if (hit) return "trailing_stop";
  }
  if (e.takeProfit) {
    const tp = e.takeProfit;
    const rel = levelMovePct(tp, p.leverage);
    const hit = rel != null ? movePct >= rel : d === 1 ? px >= levelValue(tp) : px <= levelValue(tp);
    if (hit) return "take_profit";
  }
  if (timeUp(e, p.openedAt, now)) return "time_exit";
  return null;
}

/**
 * Exit check for a multi-leg options group, on premium:
 * - `pct`: group P&L as % of the net premium paid (|Σ dir × cost|).
 * - `price`: net value of one spread unit (Σ dir × mark × ratio).
 * - trailing: on the net unit value, from its best level since entry.
 */
export function groupExitReason(legs: Position[], now: number): FillReason | null {
  const first = legs[0];
  if (!first?.group) return null;
  const e = first.exits;
  const pnl = unrealizedOf(legs);
  const basis = Math.abs(legs.reduce((s, l) => s + dirOf(l) * l.sizeUsd, 0)) || marginOf(legs);
  const pnlPct = basis > 0 ? (pnl / basis) * 100 : 0;
  const value = groupUnitValue(legs);
  if (e.stopLoss) {
    const sl = e.stopLoss;
    const rel = levelMovePct(sl, 1);
    if (rel != null ? pnlPct <= -rel : value <= levelValue(sl)) return "stop_loss";
  }
  if (e.trailingStopPct != null) {
    const peak = first.group.peakValue;
    if (peak > 0 && value <= peak * (1 - e.trailingStopPct / 100)) return "trailing_stop";
  }
  if (e.takeProfit) {
    const tp = e.takeProfit;
    const rel = levelMovePct(tp, 1);
    if (rel != null ? pnlPct >= rel : value >= levelValue(tp)) return "take_profit";
  }
  if (timeUp(e, first.openedAt, now)) return "time_exit";
  return null;
}

export function groupUnitValue(legs: Position[]): number {
  return legs.reduce((s, l) => s + dirOf(l) * l.markPrice * (l.group?.ratio ?? 1), 0);
}

function timeUp(e: Exits, openedAt: number, now: number): boolean {
  return e.timeExitHours != null && now - openedAt >= e.timeExitHours * 3_600_000;
}
