import type { AssetClass } from "@weft/strategy";
import { num, pctChange } from "../util.ts";
import { classifyHip3, KNOWN_NAMES } from "./classify.ts";
import type { RawMetaAndAssetCtxs, RawSpotCtx, RawSpotMetaAndAssetCtxs } from "./client.ts";

/* ------------------------------------------------------------------ */
/* Perps (core + HIP-3)                                                  */
/* ------------------------------------------------------------------ */

export interface PerpMarket {
  /** Coin as Hyperliquid names it: "BTC" or "xyz:NVDA". */
  coin: string;
  dex: string | null;
  symbol: string;
  name: string | null;
  assetClass: AssetClass;
  maxLeverage: number | null;
  onlyIsolated: boolean;
  isDelisted: boolean;
  markPx: number | null;
  midPx: number | null;
  oraclePx: number | null;
  prevDayPx: number | null;
  /** Hourly funding rate as a fraction (0.0000125 = 0.00125 %/h). */
  funding: number | null;
  /** Open interest in base units. */
  openInterest: number | null;
  dayNtlVlm: number | null;
  /** Mid if available, else mark. */
  price: number | null;
  change24hPct: number | null;
  openInterestUsd: number | null;
}

/** Split "xyz:NVDA" → { dex: "xyz", symbol: "NVDA" }. */
export function splitCoin(coin: string): { dex: string | null; symbol: string } {
  const i = coin.indexOf(":");
  return i > 0 ? { dex: coin.slice(0, i), symbol: coin.slice(i + 1) } : { dex: null, symbol: coin };
}

export function perpCoin(symbol: string, dex?: string | null): string {
  return dex ? `${dex}:${symbol}` : symbol;
}

export function parsePerpMarkets(raw: RawMetaAndAssetCtxs, dex: string | null, coreSymbols?: ReadonlySet<string>): PerpMarket[] {
  const [meta, ctxs] = raw;
  const out: PerpMarket[] = [];
  meta.universe.forEach((a, i) => {
    const c = ctxs[i] ?? {};
    const split = splitCoin(a.name);
    const symbol = split.symbol;
    const markPx = num(c.markPx);
    const midPx = num(c.midPx);
    const price = midPx ?? markPx;
    const oi = num(c.openInterest);
    const prevDayPx = num(c.prevDayPx);
    out.push({
      coin: a.name,
      dex: dex ?? split.dex,
      symbol,
      name: dex ? (KNOWN_NAMES[symbol.toUpperCase()] ?? null) : null,
      assetClass: dex ? classifyHip3(symbol, coreSymbols) : "crypto",
      maxLeverage: a.maxLeverage ?? null,
      onlyIsolated: !!a.onlyIsolated,
      isDelisted: !!a.isDelisted,
      markPx,
      midPx,
      oraclePx: num(c.oraclePx),
      prevDayPx,
      funding: num(c.funding),
      openInterest: oi,
      dayNtlVlm: num(c.dayNtlVlm),
      price,
      change24hPct: pctChange(price, prevDayPx),
      openInterestUsd: oi != null && markPx != null ? oi * markPx : null,
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Spot                                                                 */
/* ------------------------------------------------------------------ */

export interface SpotMarket {
  /** Coin used by allMids / l2Book: "PURR/USDC" or "@107". */
  coin: string;
  /** Human pair "HYPE/USDC". */
  pair: string;
  base: string;
  quote: string;
  isCanonical: boolean;
  markPx: number | null;
  midPx: number | null;
  prevDayPx: number | null;
  dayNtlVlm: number | null;
  price: number | null;
  change24hPct: number | null;
}

export function parseSpotMarkets(raw: RawSpotMetaAndAssetCtxs): SpotMarket[] {
  const [meta, ctxs] = raw;
  const tokens = new Map(meta.tokens.map((t) => [t.index, t]));
  const ctxByCoin = new Map(ctxs.map((c) => [c.coin, c]));
  const out: SpotMarket[] = [];
  for (const u of meta.universe) {
    const base = tokens.get(u.tokens[0])?.name;
    const quote = tokens.get(u.tokens[1])?.name;
    if (!base || !quote) continue;
    const c: RawSpotCtx | undefined = ctxByCoin.get(u.name);
    const markPx = num(c?.markPx);
    const midPx = num(c?.midPx);
    const price = midPx ?? markPx;
    const prevDayPx = num(c?.prevDayPx);
    out.push({
      coin: u.name,
      pair: `${base}/${quote}`,
      base,
      quote,
      isCanonical: !!u.isCanonical,
      markPx,
      midPx,
      prevDayPx,
      dayNtlVlm: num(c?.dayNtlVlm),
      price,
      change24hPct: pctChange(price, prevDayPx),
    });
  }
  return out;
}

/**
 * Resolve a spot symbol ("HYPE/USDC", "HYPE", "@107", "PURR/USDC") to its coin.
 * When several pairs share a base name (non-canonical copies), prefer the one
 * with the highest 24h volume.
 */
export function resolveSpotCoin(markets: SpotMarket[], symbol: string): SpotMarket | null {
  const s = symbol.trim();
  const byCoin = markets.find((m) => m.coin === s);
  if (byCoin) return byCoin;
  const [b, q = "USDC"] = s.toUpperCase().split("/");
  const matches = markets.filter((m) => m.base.toUpperCase() === b && m.quote.toUpperCase() === q);
  if (!matches.length) return null;
  return matches.sort((x, y) => (y.dayNtlVlm ?? 0) - (x.dayNtlVlm ?? 0))[0] ?? null;
}

/** Outcome-side contexts ("#<encoding>") also live in spotMetaAndAssetCtxs. */
export function outcomeCtxMap(raw: RawSpotMetaAndAssetCtxs): Map<string, RawSpotCtx> {
  const m = new Map<string, RawSpotCtx>();
  for (const c of raw[1]) if (c.coin.startsWith("#")) m.set(c.coin, c);
  return m;
}
