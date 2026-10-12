import type { Instrument } from "@weft/strategy";
import type { SignalProvider } from "../types.ts";
import type { VenueMarketData } from "../market-data.ts";
import { bookTop, depthWithin, walkBook } from "../book.ts";
import type { RawCandle } from "../hyperliquid/client.ts";
import { normalizeYesNo, predictionPrice } from "../jupiter/parse.ts";
import { num, pctChange } from "../util.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * Live market signals: price, funding, liquidity, odds.
 * Field names follow SIGNAL_KINDS in @weft/strategy exactly.
 */

type OnError = (kind: string, err: unknown) => void;

/* ------------------------------------------------------------------ */
/* price                                                                 */
/* ------------------------------------------------------------------ */

/** Close of the last candle that ended at or before `t` (else first open). */
export function priceAt(candles: RawCandle[], t: number): number | null {
  let px: number | null = null;
  for (const c of candles) {
    if (c.T <= t) px = num(c.c);
    else break;
  }
  if (px == null && candles[0] && candles[0].t <= t) px = num(candles[0].o);
  return px;
}

export function candleChanges(candles: RawCandle[], price: number | null, now: number): { change_5m_pct: number | null; change_1h_pct: number | null } {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  return {
    change_5m_pct: pctChange(price, priceAt(sorted, now - 5 * 60_000)),
    change_1h_pct: pctChange(price, priceAt(sorted, now - 60 * 60_000)),
  };
}

export async function priceFields(md: VenueMarketData, i: Instrument, now: number): Promise<Fields | null> {
  const ctx = md.ctx;
  const hlCandles = async (coin: string, price: number | null) => {
    try {
      return candleChanges(await ctx.hl.candles(coin, "1m", now - 66 * 60_000, now), price, now);
    } catch {
      return { change_5m_pct: null, change_1h_pct: null };
    }
  };
  switch (i.kind) {
    case "perp": {
      const m = await md.perpMarket(i);
      const q = await md.getQuote(i).catch(() => null);
      const price = q?.price ?? m.price;
      return { price, ...(await hlCandles(m.coin, price)), change_24h_pct: pctChange(price, m.prevDayPx), volume_24h_usd: m.dayNtlVlm };
    }
    case "spot": {
      const m = await md.spotMarket(i.symbol);
      const q = await md.getQuote(i).catch(() => null);
      const price = q?.price ?? m.price;
      return { price, ...(await hlCandles(m.coin, price)), change_24h_pct: pctChange(price, m.prevDayPx), volume_24h_usd: m.dayNtlVlm };
    }
    case "token": {
      const t = await ctx.jup.token(i.mint).catch(() => null);
      if (t?.usdPrice != null) {
        const vol = t.stats24h ? (t.stats24h.buyVolume ?? 0) + (t.stats24h.sellVolume ?? 0) : null;
        return {
          price: t.usdPrice,
          change_5m_pct: t.stats5m?.priceChange ?? null,
          change_1h_pct: t.stats1h?.priceChange ?? null,
          change_24h_pct: t.stats24h?.priceChange ?? null,
          volume_24h_usd: vol,
        };
      }
      const d = await ctx.dex.summary(i.mint);
      if (!d || d.priceUsd == null) return null;
      return { price: d.priceUsd, change_5m_pct: d.priceChange.m5, change_1h_pct: d.priceChange.h1, change_24h_pct: d.priceChange.h24, volume_24h_usd: d.volume24hUsd };
    }
    case "outcome": {
      if (i.venue === "hyperliquid") {
        const { market, side } = await md.hlOutcome(i);
        return {
          price: side.mid,
          ...(await hlCandles(side.coin, side.mid)),
          change_24h_pct: pctChange(side.mid, side.prevDayPx),
          volume_24h_usd: market.volume24hUsd,
        };
      }
      const q = await md.getQuote(i);
      return { price: q.price, change_5m_pct: null, change_1h_pct: null, change_24h_pct: null, volume_24h_usd: null };
    }
    case "option": {
      const q = await md.getQuote(i);
      return { price: q.price, change_5m_pct: null, change_1h_pct: null, change_24h_pct: null, volume_24h_usd: null };
    }
  }
}

/* ------------------------------------------------------------------ */
/* funding                                                               */
/* ------------------------------------------------------------------ */

/** `oiZscore` comes from the OI sampler (null until it holds enough history). */
export function fundingFieldsFrom(m: { funding: number | null; openInterestUsd: number | null }, oiZscore: number | null = null): Fields {
  const h = m.funding;
  return {
    rate_1h_pct: h != null ? h * 100 : null,
    rate_8h_pct: h != null ? h * 100 * 8 : null,
    apr_pct: h != null ? h * 100 * 24 * 365 : null,
    open_interest_usd: m.openInterestUsd,
    // Hyperliquid has no public OI history: our own sampler (src/oi-history.ts) provides it.
    oi_zscore_30d: oiZscore,
  };
}

/* ------------------------------------------------------------------ */
/* liquidity                                                             */
/* ------------------------------------------------------------------ */

/**
 * AMM-routed tokens have no book, so depth within 2% is ESTIMATED from two
 * router quotes ($1k and $25k): impact(s) ≈ a + b·s, solve for 200 bps, capped
 * at pool liquidity. The intercept `a` absorbs fees/spread so it isn't mistaken
 * for depth.
 */
export function estimateDepth2pct(impact1k: number | null, impact25k: number | null, liquidityUsd: number | null): number | null {
  const cap = liquidityUsd ?? Infinity;
  if (impact1k == null) return liquidityUsd != null ? liquidityUsd * 0.01 : null;
  if (impact1k >= 200) return Math.min(1_000 * (200 / impact1k), cap);
  if (impact25k == null) return impact1k > 0 ? Math.min((1_000 * 200) / impact1k, cap) : liquidityUsd != null ? liquidityUsd * 0.01 : null;
  const b = (impact25k - impact1k) / 24_000;
  if (!(b > 1e-9)) return Number.isFinite(cap) ? cap : null;
  const a = impact1k - b * 1_000;
  return Math.max(0, Math.min((200 - a) / b, cap));
}

export async function liquidityFields(md: VenueMarketData, i: Instrument): Promise<Fields | null> {
  if (i.kind === "token") {
    const [buy, big, sell, t] = await Promise.all([
      md.getQuote(i, { side: "buy", sizeUsd: 1_000 }),
      md.getQuote(i, { side: "buy", sizeUsd: 25_000 }).catch(() => null),
      md.getQuote(i, { side: "sell", sizeUsd: 1_000 }).catch(() => null),
      md.ctx.jup.token(i.mint).catch(() => null),
    ]);
    const impact = buy.priceImpactBps ?? null;
    const depth = estimateDepth2pct(impact, big?.priceImpactBps ?? null, t?.liquidity ?? null);
    const spread = buy.fillPrice != null && sell?.fillPrice != null ? ((buy.fillPrice - sell.fillPrice) / buy.price) * 1e4 : null;
    return { depth_2pct_usd: depth, spread_bps: spread != null ? Math.max(0, spread) : null, price_impact_bps_1k: impact };
  }
  if (i.kind === "option" && i.venue === "derive") {
    const q = await md.getQuote(i, { side: "buy", sizeUsd: 1_000 });
    const spread = q.bid != null && q.ask != null ? ((q.ask - q.bid) / q.price) * 1e4 : null;
    return { depth_2pct_usd: null, spread_bps: spread, price_impact_bps_1k: q.priceImpactBps ?? null };
  }
  const b = await md.book(i);
  if (!b) return null;
  const top = bookTop(b.book);
  const depth = depthWithin(b.book, 200);
  const fill = walkBook(b.book, "buy", 1_000);
  return {
    depth_2pct_usd: depth?.total ?? null,
    spread_bps: top.spreadBps,
    price_impact_bps_1k: fill ? fill.priceImpactBps : null,
  };
}

/* ------------------------------------------------------------------ */
/* providers                                                             */
/* ------------------------------------------------------------------ */

export function marketProviders(md: VenueMarketData, onError?: OnError): SignalProvider[] {
  return [
    defineProvider(["price"], "live", (s, now) => priceFields(md, s.params.instrument, now), onError),
    defineProvider(
      ["funding"],
      "live",
      async (s) => {
        const m = await md.perpMarket(s.params.instrument);
        return fundingFieldsFrom(m, m.openInterestUsd != null ? md.ctx.oi.zscore(m.coin, m.openInterestUsd, md.ctx.now()) : null);
      },
      onError
    ),
    defineProvider(["liquidity"], "live", (s) => liquidityFields(md, s.params.instrument), onError),
    defineProvider(
      ["odds"],
      "live",
      async (s) => {
        const i = s.params.instrument;
        if (i.venue === "hyperliquid") {
          const { market, side } = await md.hlOutcome(i);
          return { prob: side.mid, change_24h_pp: side.change24hPp, volume_24h_usd: market.volume24hUsd };
        }
        const outcome = normalizeYesNo(i.outcome);
        if (!outcome) return null;
        const m = await md.ctx.jup.predictionMarket(i.market);
        const p = predictionPrice(m.pricing, outcome);
        let vol: number | null = null;
        if (m.eventId) {
          const ev = await md.ctx.jup.predictionEvent(m.eventId).catch(() => null);
          // Jupiter reports 24h volume per event (micro-USD): exact only for single-market events.
          if (ev && (ev.markets?.length ?? 0) <= 1 && ev.volume24hr != null) vol = Number(ev.volume24hr) / 1e6;
        }
        return { prob: p?.price ?? null, change_24h_pp: null, volume_24h_usd: vol };
      },
      onError
    ),
  ];
}

