/**
 * Order book math, venue-agnostic. Levels are { px, sz } with sz in base units
 * (contracts / shares / coins) and px in USD (or probability for outcomes).
 */

export interface Level {
  px: number;
  sz: number;
}

export interface Book {
  /** Best first (descending px). */
  bids: Level[];
  /** Best first (ascending px). */
  asks: Level[];
  /** ms since epoch when the venue produced the book, if known. */
  ts?: number;
}

export interface BookTop {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
}

export interface FillEstimate {
  /** Volume-weighted average fill price for the filled part. */
  fillPrice: number;
  /** Adverse move vs mid in bps (always ≥ 0 for a sane book). */
  priceImpactBps: number;
  filledUsd: number;
  filledQty: number;
  /** True if the visible book could not absorb the full size. */
  exhausted: boolean;
}

export function normalizeBook(b: Book): Book {
  const clean = (ls: Level[]) => ls.filter((l) => Number.isFinite(l.px) && Number.isFinite(l.sz) && l.px > 0 && l.sz > 0);
  return {
    bids: clean(b.bids).sort((a, c) => c.px - a.px),
    asks: clean(b.asks).sort((a, c) => a.px - c.px),
    ts: b.ts,
  };
}

export function bookTop(b: Book): BookTop {
  const bid = b.bids[0]?.px ?? null;
  const ask = b.asks[0]?.px ?? null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
  const spreadBps = bid != null && ask != null && mid ? ((ask - bid) / mid) * 1e4 : null;
  return { bid, ask, mid, spreadBps };
}

/**
 * Walk the book for a USD notional. Buy consumes asks, sell consumes bids.
 * Impact is measured against `refMid` (defaults to the book mid).
 */
export function walkBook(b: Book, side: "buy" | "sell", sizeUsd: number, refMid?: number): FillEstimate | null {
  const levels = side === "buy" ? b.asks : b.bids;
  const mid = refMid ?? bookTop(b).mid;
  if (!levels.length || mid == null || !(sizeUsd > 0)) return null;
  let remaining = sizeUsd;
  let cost = 0;
  let qty = 0;
  for (const l of levels) {
    if (remaining <= 0) break;
    const levelUsd = l.px * l.sz;
    const take = Math.min(remaining, levelUsd);
    cost += take;
    qty += take / l.px;
    remaining -= take;
  }
  if (qty <= 0) return null;
  const fillPrice = cost / qty;
  const impact = side === "buy" ? (fillPrice - mid) / mid : (mid - fillPrice) / mid;
  return {
    fillPrice,
    priceImpactBps: Math.max(0, impact * 1e4),
    filledUsd: cost,
    filledQty: qty,
    exhausted: remaining > 1e-9,
  };
}

/** USD resting within ±bps of mid, both sides summed (and per side). */
export function depthWithin(b: Book, bps: number): { total: number; bid: number; ask: number } | null {
  const { mid } = bookTop(b);
  if (mid == null) return null;
  const lo = mid * (1 - bps / 1e4);
  const hi = mid * (1 + bps / 1e4);
  let bid = 0;
  let ask = 0;
  for (const l of b.bids) if (l.px >= lo) bid += l.px * l.sz;
  for (const l of b.asks) if (l.px <= hi) ask += l.px * l.sz;
  return { total: bid + ask, bid, ask };
}
