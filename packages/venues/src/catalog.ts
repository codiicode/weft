import { polymarketListings } from "./polymarket.ts";
import { dlmmInstrument, feePerDay } from "./meteora.ts";
import { instrumentKey, type Instrument } from "@weft/strategy";
import type { Catalog, CatalogQuery, MarketListing, Product } from "./types.ts";
import type { VenueMarketData } from "./market-data.ts";
import type { PerpMarket } from "./hyperliquid/parse.ts";
import type { OutcomeMarket } from "./hyperliquid/outcomes.ts";
import type { RawPredictionEvent, RawToken } from "./jupiter/client.ts";
import { isXStock, tokenVolume24h } from "./jupiter/parse.ts";
import { summaryToRow, type OptionRow } from "./options.ts";
import { mapLimit, matchesSearch, pctChange } from "./util.ts";

/**
 * What can be traded, per product, sorted by 24h volume (desc).
 *  perps        core Hyperliquid perps
 *  stocks       HIP-3 builder-dex perps classified equity/index/commodity/fx/other + Solana xStocks (tokens)
 *  predictions  HIP-4 outcome markets + Jupiter Prediction (Polymarket/Kalshi-backed) markets
 *  tokens       trending / searched Solana tokens (Jupiter Tokens v2)
 *  options      Deribit BTC/ETH/SOL options: 2 nearest expiries + first weekly and monthly, strikes within ±20% of spot
 *  pools        Meteora DLMM liquidity pools on Solana (search by pair, symbol or mint)
 *  papertrade   Papertrade's synthetic BTC and ETH perps (HyperEVM, up to 1000×), priced at Hyperliquid's mid
 */
export class VenueCatalog implements Catalog {
  private readonly md: VenueMarketData;

  constructor(md: VenueMarketData) {
    this.md = md;
  }

  async list(product: Product, q: CatalogQuery = {}): Promise<MarketListing[]> {
    const limit = q.limit ?? 50;
    let rows: (MarketListing & { _rank?: number; _searched?: boolean })[];
    switch (product) {
      case "perps":
        rows = await this.perps();
        break;
      case "stocks":
        rows = await this.stocks();
        break;
      case "predictions":
        rows = await this.predictions(q.search);
        break;
      case "tokens":
        rows = await this.tokens(q.search);
        break;
      case "options":
        rows = await this.options();
        break;
      case "pools":
        rows = await this.pools(q.search);
        break;
      case "papertrade":
        rows = await this.papertrade();
        break;
    }
    const filtered = rows.filter((r) =>
      r._searched ||
      matchesSearch(
        q.search,
        r.label,
        r.name,
        r.instrumentKey,
        typeof r.meta?.symbol === "string" ? r.meta.symbol : null,
        typeof r.meta?.category === "string" ? r.meta.category : null
      )
    );
    filtered.sort((a, b) => (b._rank ?? b.volume24hUsd ?? 0) - (a._rank ?? a.volume24hUsd ?? 0));
    return filtered.slice(0, limit).map(({ _rank, _searched, ...r }) => r);
  }

  /** Papertrade's two markets, with Hyperliquid's mid and 24h change, and Papertrade's own 24h volume and LP. */
  private async papertrade(): Promise<MarketListing[]> {
    const [hl, stats, limits, summary] = await Promise.all([
      this.md.perpMarkets(null),
      this.md.papertrade.marketStats().catch(() => ({}) as Record<string, number>),
      this.md.papertrade.tradingLimits(),
      this.md.papertrade.summary().catch(() => null),
    ]);
    return (["BTC", "ETH"] as const).map((symbol) => {
      const m = hl.find((x) => x.symbol === symbol && !x.dex);
      const instrument = { kind: "synth" as const, venue: "papertrade" as const, symbol, assetClass: "crypto" as const };
      return {
        product: "papertrade" as const,
        instrument,
        instrumentKey: instrumentKey(instrument),
        label: `${symbol} · Papertrade`,
        name: `Synthetic perp on HyperEVM · up to ${limits.markets[symbol].maxLeverage}× · positions from $${limits.minNotionalUsd.toLocaleString("en-US")} · a bust loses the whole margin`,
        price: m?.price ?? null,
        change24hPct: m?.price != null && m.prevDayPx ? pctChange(m.price, m.prevDayPx) : null,
        volume24hUsd: stats[symbol] ?? null,
        liquidityUsd: summary?.lpUsd ?? null,
        maxLeverage: limits.markets[symbol].maxLeverage,
        meta: { symbol, minNotionalUsd: limits.minNotionalUsd, minMarginUsd: limits.minMarginUsd },
        venue: "papertrade",
      };
    });
  }

  /** Meteora DLMM pools for a pair, symbol or mint; the busiest SOL and USDC pools without a search. */
  private async pools(search?: string): Promise<(MarketListing & { _rank?: number; _searched?: boolean })[]> {
    const found = await this.md.meteora.search(search?.trim() || "SOL", 30).catch(() => []);
    return found.map((p) => ({
      product: "pools" as const,
      instrument: dlmmInstrument(p),
      instrumentKey: `meteora:lp:${p.address}`,
      label: p.name || `${p.baseSymbol}-${p.quoteSymbol}`,
      name: `Meteora DLMM · bin step ${p.binStep ?? "?"} · base fee ${p.baseFeePct ?? "?"}%`,
      price: p.price,
      volume24hUsd: p.volume24hUsd,
      liquidityUsd: p.tvlUsd,
      meta: { feesPerDayPct: Math.round(feePerDay(p) * 1e6) / 1e4, fees24hUsd: Math.round(p.lpFees24hUsd), quote: p.quoteSymbol },
      venue: "meteora",
      _rank: p.volume24hUsd,
      _searched: true,
    }));
  }

  /** One listing by instrument key, looking in the products it could belong to. */
  async find(key: string): Promise<MarketListing | null> {
    const products: Product[] = key.startsWith("hl:perp:")
      ? key.split(":").length > 3 ? ["stocks", "perps"] : ["perps"]
      : key.startsWith("sol:token:") ? ["tokens", "stocks"]
      : key.includes(":outcome:") ? ["predictions"]
      : key.includes(":option:") ? ["options"]
      : [];
    for (const p of products) {
      const all = await this.list(p, { limit: 10_000 }).catch(() => []);
      const hit = all.find((r) => r.instrumentKey === key);
      if (hit) return hit;
    }
    // Polymarket odds (watch-only) aren't all listed: read the market directly.
    if (key.startsWith("pm:outcome:")) {
      const id = key.split(":")[2]!;
      const m = await this.md.ctx.pm.market(id).catch(() => null);
      return (m && polymarketListings(m).find((r) => r.instrumentKey === key)) ?? null;
    }
    // Tokens outside the trending list: search by mint.
    if (key.startsWith("sol:token:")) {
      const mint = key.slice("sol:token:".length);
      const rows = await this.list("tokens", { search: mint, limit: 10 }).catch(() => []);
      return rows.find((r) => r.instrumentKey === key) ?? null;
    }
    return null;
  }

  /* ---------------- perps ---------------- */

  private async perps(): Promise<MarketListing[]> {
    const markets = await this.md.perpMarkets(null);
    return markets.filter((m) => !m.isDelisted && m.price != null).map((m) => perpListing(m, "perps"));
  }

  /* ---------------- stocks ---------------- */

  private async stocks(): Promise<MarketListing[]> {
    const [hip3, xstocks] = await Promise.all([this.hip3NonCrypto(), this.xStocks().catch(() => [])]);
    return [...hip3, ...xstocks];
  }

  private async hip3NonCrypto(): Promise<MarketListing[]> {
    const dexes = await this.md.ctx.hl.perpDexs();
    const lists = await mapLimit(dexes, 4, (d) => this.md.perpMarkets(d.name));
    return lists
      .flatMap((l) => l ?? [])
      .filter((m) => !m.isDelisted && m.price != null && m.assetClass !== "crypto")
      .map((m) => perpListing(m, "stocks"));
  }

  private async xStocks(): Promise<MarketListing[]> {
    const rows = await this.md.ctx.jup.searchTokens("xStock", 100);
    const seen = new Set<string>();
    return rows
      .filter((t) => isXStock(t) && (t.isVerified || (t.tags ?? []).includes("verified")))
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .map((t) => tokenListing(t, "stocks"));
  }

  /* ---------------- predictions ---------------- */

  private async predictions(search?: string): Promise<(MarketListing & { _rank?: number; _searched?: boolean })[]> {
    // Tradable: Hyperliquid's own (HIP-4) markets, from the same account as perps. Jupiter's
    // prediction books are too thin to get out of a position, so they aren't listed.
    // Watch-only: Polymarket odds, to use as signals (busiest when browsing, Polymarket's own search
    // when searching). Tradable markets always sort first.
    const now = this.md.ctx.now();
    const [hl, pm] = await Promise.all([
      this.md.hlOutcomes().catch(() => null),
      (search?.trim() ? this.md.ctx.pm.search(search.trim(), 15) : this.md.ctx.pm.top(30)).catch(() => []),
    ]);
    const out: (MarketListing & { _rank?: number; _searched?: boolean })[] = [];
    for (const m of hl?.markets ?? []) {
      if (m.sides[0].mid == null) continue;
      if (m.expiresAt != null && m.expiresAt < now) continue;
      out.push({ ...hlOutcomeListing(m), _rank: 1e15 + (m.volume24hUsd ?? 0) });
    }
    // Searching keeps Polymarket's relevance order (below every tradable market).
    pm.forEach((m, i) => {
      for (const r of polymarketListings(m)) out.push({ ...r, ...(search?.trim() ? { _searched: true, _rank: 1e12 - i } : {}) });
    });
    return out;
  }

  /* ---------------- tokens ---------------- */

  private async tokens(search?: string): Promise<(MarketListing & { _rank?: number })[]> {
    if (!search) {
      const rows = await this.md.ctx.jup.category("toptrending", "1h", 50);
      return rows.filter((t) => t.usdPrice != null).map((t) => tokenListing(t, "tokens"));
    }
    // Search: exact symbol matches first ("WIF" → the real $WIF, not "$swordcat"), then by liquidity.
    const rows = await this.md.ctx.jup.searchTokens(search, 50);
    return rows
      .filter((t) => t.usdPrice != null)
      .map((t) => ({ ...tokenListing(t, "tokens"), _rank: tokenSearchRank(t, search) }));
  }

  /* ---------------- options ---------------- */

  private async options(): Promise<(MarketListing & { _rank?: number })[]> {
    const now = this.md.ctx.now();
    const [btc, eth, usdc] = await Promise.all(
      (["BTC", "ETH", "USDC"] as const).map((c) => this.md.ctx.deribit.summaries(c).catch(() => []))
    );
    const rows = [...btc!, ...eth!, ...usdc!.filter((s) => s.instrument_name.startsWith("SOL_USDC-"))]
      .map(summaryToRow)
      .filter((r): r is OptionRow => r != null && r.markUsd != null);
    const out: (MarketListing & { _rank?: number })[] = [];
    for (const u of ["BTC", "ETH", "SOL"]) {
      const mine = rows.filter((r) => r.parsed.underlying === u);
      // Expiries more than 12h away (Deribit expires 08:00 UTC): the 2 nearest, plus the first
      // weekly (≥ 7d) and monthly (≥ 28d) so multi-day strategies have something to trade.
      const all = [...new Set(mine.map((r) => r.parsed.expiry))]
        .filter((e) => Date.parse(`${e}T08:00:00Z`) - now > 12 * 3_600_000)
        .sort();
      const after = (days: number) => all.find((e) => Date.parse(`${e}T08:00:00Z`) - now >= days * 86_400_000);
      const expiries = [...new Set([...all.slice(0, 2), after(7), after(28)].filter((e): e is string => !!e))];
      for (const r of mine) {
        if (!expiries.includes(r.parsed.expiry)) continue;
        const spot = r.underlyingPrice;
        if (spot != null && Math.abs(r.parsed.strike / spot - 1) > 0.2) continue;
        // rank by volume, then open interest (many strikes trade 0 on a given day)
        out.push({ ...optionListing(r), _rank: (r.volume24hUsd ?? 0) + (r.openInterestUsd ?? 0) * 0.01 });
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Row builders (exported for tests)                                     */
/* ------------------------------------------------------------------ */

export function perpListing(m: PerpMarket, product: Product): MarketListing {
  const instrument: Instrument = { kind: "perp", venue: "hyperliquid", ...(m.dex ? { dex: m.dex } : {}), symbol: m.symbol, assetClass: m.assetClass };
  return {
    product,
    instrument,
    instrumentKey: instrumentKey(instrument),
    label: m.symbol,
    ...(m.name ? { name: m.name } : {}),
    price: m.price,
    change24hPct: m.change24hPct,
    volume24hUsd: m.dayNtlVlm,
    openInterestUsd: m.openInterestUsd,
    fundingHourlyPct: m.funding != null ? m.funding * 100 : null,
    maxLeverage: m.maxLeverage,
    meta: { coin: m.coin, dex: m.dex, assetClass: m.assetClass, onlyIsolated: m.onlyIsolated, oraclePx: m.oraclePx },
    venue: "hyperliquid",
  };
}

/** Jupiter returns some symbols with a leading "$" (e.g. "$WIF"). */
export function cleanSymbol(symbol: string): string {
  return symbol.trim().replace(/^\$+/, "");
}

/** Exact symbol (or mint) match ranks above everything else; ties broken by liquidity. */
export function tokenSearchRank(t: RawToken, search: string): number {
  const q = cleanSymbol(search).toLowerCase();
  const exact = cleanSymbol(t.symbol).toLowerCase() === q || t.id === search.trim();
  return (exact ? 1e15 : 0) + (t.liquidity ?? 0);
}

export function tokenListing(t: RawToken, product: Product): MarketListing {
  const equity = isXStock(t);
  const symbol = cleanSymbol(t.symbol);
  const instrument: Instrument = {
    kind: "token",
    chain: "solana",
    mint: t.id,
    symbol,
    quote: equity ? "USDC" : "SOL",
    route: equity ? "jupiter" : "auto",
    assetClass: equity ? "equity" : "crypto",
  };
  return {
    product,
    instrument,
    instrumentKey: instrumentKey(instrument),
    label: equity ? symbol : `$${symbol}`,
    name: t.name,
    price: t.usdPrice ?? null,
    change24hPct: t.stats24h?.priceChange ?? null,
    volume24hUsd: tokenVolume24h(t),
    liquidityUsd: t.liquidity ?? null,
    marketCapUsd: t.mcap ?? null,
    meta: {
      symbol,
      mint: t.id,
      icon: t.icon ?? null,
      verified: !!t.isVerified,
      organicScore: t.organicScore ?? null,
      holders: t.holderCount ?? null,
      launchpad: t.launchpad ?? null,
      tags: (t.tags ?? []).join(","),
    },
    venue: "jupiter",
  };
}

export function hlOutcomeListing(m: OutcomeMarket): MarketListing {
  const s0 = m.sides[0];
  const yesNo = /^yes$/i.test(s0.name) ? "YES" : s0.name;
  const instrument: Instrument = { kind: "outcome", venue: "hyperliquid", market: String(m.id), outcome: yesNo, question: m.question };
  return {
    product: "predictions",
    instrument,
    instrumentKey: instrumentKey(instrument),
    label: `${m.question} · ${yesNo}`,
    name: m.groupTitle ?? m.question,
    price: s0.mid,
    change24hPct: pctChange(s0.mid, s0.prevDayPx),
    volume24hUsd: m.volume24hUsd,
    meta: {
      outcomeId: m.id,
      coin: s0.coin,
      change24hPp: s0.change24hPp,
      otherSide: m.sides[1].name,
      otherSidePrice: m.sides[1].mid,
      template: m.template,
      groupId: m.groupId,
      expiresAt: m.expiresAt != null ? new Date(m.expiresAt).toISOString() : null,
      deployer: m.deployerVenue,
    },
    venue: "hyperliquid",
  };
}

const MICRO = 1e6;

export function jupEventListings(e: RawPredictionEvent): (MarketListing & { _rank?: number })[] {
  const title = e.metadata?.title ?? e.eventId;
  const markets = (e.markets ?? []).filter((m) => (m.status ?? "open") === "open");
  const evVol24 = e.volume24hr != null ? Number(e.volume24hr) / MICRO : null;
  return markets.flatMap((m) => {
    const yb = m.pricing.sellYesPriceUsd ?? 0;
    const ya = m.pricing.buyYesPriceUsd ?? 0;
    const price = yb > 0 && ya > 0 ? (yb + ya) / 2 / MICRO : (yb || ya) / MICRO || null;
    if (price == null) return [];
    const question = markets.length === 1 && m.title === title ? title : `${title} · ${m.title}`;
    const instrument: Instrument = { kind: "outcome", venue: "jupiter", market: m.marketId, outcome: "YES", question };
    return [
      {
        product: "predictions" as const,
        instrument,
        instrumentKey: instrumentKey(instrument),
        label: `${question} · YES`,
        name: title,
        price,
        change24hPct: null,
        // 24h volume is only reported per event; exact for single-market events.
        volume24hUsd: markets.length === 1 ? evVol24 : null,
        _rank: evVol24 != null ? evVol24 / Math.max(1, markets.length) : 0,
        meta: {
          eventId: e.eventId,
          marketId: m.marketId,
          provider: m.provider ?? null,
          category: e.category ?? null,
          eventVolume24hUsd: evVol24,
          bid: yb ? yb / MICRO : null,
          ask: ya ? ya / MICRO : null,
          closeTime: m.closeTime ? new Date(m.closeTime * 1000).toISOString() : (e.metadata?.closeTime ?? null),
          image: m.imageUrl ?? e.metadata?.imageUrl ?? null,
        },
        venue: "jupiter",
      },
    ];
  });
}

export function optionListing(r: OptionRow): MarketListing {
  const p = r.parsed;
  const instrument: Instrument = { kind: "option", venue: "deribit", underlying: p.underlying, expiry: p.expiry, strike: p.strike, right: p.right };
  return {
    product: "options",
    instrument,
    instrumentKey: instrumentKey(instrument),
    label: `${p.underlying} ${p.expiry} ${p.strike}${p.right === "call" ? "C" : "P"}`,
    name: r.name,
    price: r.markUsd,
    volume24hUsd: r.volume24hUsd,
    openInterestUsd: r.openInterestUsd,
    meta: {
      instrumentName: r.name,
      expiry: p.expiry,
      strike: p.strike,
      right: p.right,
      ivPct: r.ivPct,
      bidUsd: r.bidUsd,
      askUsd: r.askUsd,
      underlyingPrice: r.underlyingPrice,
      settlement: p.linear ? "USDC" : p.underlying,
    },
    venue: "deribit",
  };
}
