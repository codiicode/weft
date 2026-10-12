import type { Book } from "../book.ts";
import { normalizeBook } from "../book.ts";
import { num } from "../util.ts";
import type { RawPredictionOrderbook, RawPredictionPricing, RawSwapQuote, RawToken } from "./client.ts";

/* ------------------------------------------------------------------ */
/* Swap quotes                                                          */
/* ------------------------------------------------------------------ */

export interface SwapFill {
  /** USD per token. */
  fillPrice: number;
  /** Jupiter's priceImpactPct is a fraction (0.011 = 1.1%); converted to bps. */
  priceImpactBps: number;
  route: string | null;
}

/**
 * Buy: USDC → token (in = USDC 6dp). Sell: token → USDC (out = USDC 6dp).
 * If Jupiter reports 0 impact but the fill is worse than `refPrice`, use the
 * observed slippage instead (it includes fees and stale-price drift).
 */
export function swapFill(q: RawSwapQuote, side: "buy" | "sell", tokenDecimals: number, refPrice?: number | null): SwapFill | null {
  const inAmt = num(q.inAmount);
  const outAmt = num(q.outAmount);
  if (!inAmt || !outAmt) return null;
  const fillPrice =
    side === "buy" ? inAmt / 1e6 / (outAmt / 10 ** tokenDecimals) : outAmt / 1e6 / (inAmt / 10 ** tokenDecimals);
  const reported = Math.abs(num(q.priceImpactPct) ?? 0) * 1e4;
  let observed = 0;
  if (refPrice && refPrice > 0) observed = Math.max(0, (side === "buy" ? fillPrice - refPrice : refPrice - fillPrice) / refPrice) * 1e4;
  const labels = (q.routePlan ?? []).map((r) => r.swapInfo?.label).filter((x): x is string => !!x);
  return {
    fillPrice,
    priceImpactBps: Math.max(reported, observed),
    route: labels.length ? [...new Set(labels)].join(">") : null,
  };
}

/* ------------------------------------------------------------------ */
/* Prediction                                                            */
/* ------------------------------------------------------------------ */

const MICRO = 1e6;

/** YES/NO price from micro-USD pricing; NO falls back to the complement when unquoted. */
export function predictionPrice(p: RawPredictionPricing, outcome: "YES" | "NO"): { price: number; bid: number | null; ask: number | null } | null {
  const pos = (x: number | null | undefined) => (x != null && x > 0 ? x / MICRO : null);
  const yb = pos(p.sellYesPriceUsd);
  const ya = pos(p.buyYesPriceUsd);
  let bid: number | null;
  let ask: number | null;
  if (outcome === "YES") {
    bid = yb;
    ask = ya;
  } else {
    bid = pos(p.sellNoPriceUsd) ?? (ya != null ? 1 - ya : null);
    ask = pos(p.buyNoPriceUsd) ?? (yb != null ? 1 - yb : null);
  }
  const price = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
  return price == null ? null : { price, bid, ask };
}

/**
 * Jupiter's orderbook lists resting bids for each side in cents. Asks for one
 * side are the complement of the other side's bids (buying YES at p matches
 * someone bidding NO at 1−p).
 */
export function predictionBook(ob: RawPredictionOrderbook, outcome: "YES" | "NO"): Book {
  const own = (outcome === "YES" ? ob.yes : ob.no) ?? [];
  const other = (outcome === "YES" ? ob.no : ob.yes) ?? [];
  return normalizeBook({
    bids: own.map(([c, sz]) => ({ px: c / 100, sz })),
    asks: other.map(([c, sz]) => ({ px: (100 - c) / 100, sz })),
  });
}

export function normalizeYesNo(outcome: string): "YES" | "NO" | null {
  const o = outcome.trim().toUpperCase();
  if (o === "YES" || o === "Y") return "YES";
  if (o === "NO" || o === "N") return "NO";
  return null;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                               */
/* ------------------------------------------------------------------ */

export function isXStock(t: Pick<RawToken, "tags">): boolean {
  return (t.tags ?? []).includes("xstocks");
}

export function tokenVolume24h(t: RawToken): number | null {
  const s = t.stats24h;
  if (!s || (s.buyVolume == null && s.sellVolume == null)) return null;
  return (s.buyVolume ?? 0) + (s.sellVolume ?? 0);
}

export function tokenAgeMinutes(t: RawToken, now: number): number | null {
  const iso = t.firstPool?.createdAt ?? t.createdAt;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.max(0, (now - ms) / 60_000) : null;
}

/** true / false / null (unknown → caller may ask the chain). */
export function authorityRevoked(t: RawToken, which: "mint" | "freeze"): boolean | null {
  const disabled = which === "mint" ? t.audit?.mintAuthorityDisabled : t.audit?.freezeAuthorityDisabled;
  if (disabled === true) return true;
  const holder = which === "mint" ? t.mintAuthority : t.freezeAuthority;
  if (holder) return false;
  if (disabled === false) return false;
  return null;
}

/** Launchpad progress: 100 once graduated, Jupiter's bondingCurve % if present, else null. */
export function bondingCurvePct(t: RawToken): number | null {
  if (t.graduatedPool || t.graduatedAt) return 100;
  if (typeof t.bondingCurve === "number") return t.bondingCurve;
  return null;
}

export function migrated(t: RawToken): boolean | null {
  if (t.graduatedPool || t.graduatedAt) return true;
  if (t.launchpad) return false;
  return null; // never on a launchpad curve: not applicable
}
