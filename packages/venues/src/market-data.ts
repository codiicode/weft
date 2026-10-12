import {
  instrumentKey,
  type Instrument,
  type OptionInstrument,
  type OutcomeInstrument,
  type PerpInstrument,
  type SpotInstrument,
  type TokenInstrument,
} from "@weft/strategy";
import type { MarketData, Quote, QuoteRequest } from "./types.ts";
import type { VenueContext } from "./context.ts";
import { bookTop, walkBook, type Book } from "./book.ts";
import { parsePerpMarkets, parseSpotMarkets, perpCoin, resolveSpotCoin, outcomeCtxMap, type PerpMarket, type SpotMarket } from "./hyperliquid/parse.ts";
import { parseOutcomes, resolveOutcomeRef, type OutcomeMarket, type OutcomeSide } from "./hyperliquid/outcomes.ts";
import type { RawOutcomeMeta } from "./hyperliquid/client.ts";
import { USDC_MINT, type RawPredictionMarket } from "./jupiter/client.ts";
import { normalizeYesNo, predictionBook, predictionPrice, swapFill } from "./jupiter/parse.ts";
import { deribitBookUsd, deriveName, parseDeribitName, parseDeriveTicker } from "./options.ts";
import { num } from "./util.ts";

/** A quote that also says whether the visible book could absorb the full size. */
export interface VenueQuote extends Quote {
  depthExhausted?: boolean;
}

export class VenueMarketData implements MarketData {
  readonly ctx: VenueContext;

  constructor(ctx: VenueContext) {
    this.ctx = ctx;
  }

  /* ------------------------------------------------------------------ */
  /* Hyperliquid perps                                                     */
  /* ------------------------------------------------------------------ */

  async coreSymbols(): Promise<Set<string>> {
    const raw = await this.ctx.hl.metaAndAssetCtxs();
    return new Set(raw[0].universe.map((a) => a.name.toUpperCase()));
  }

  async perpMarkets(dex: string | null): Promise<PerpMarket[]> {
    const [raw, core] = await Promise.all([this.ctx.hl.metaAndAssetCtxs(dex ?? undefined), dex ? this.coreSymbols() : Promise.resolve(undefined)]);
    const markets = parsePerpMarkets(raw, dex, core);
    // Every OI observation feeds the sampler behind funding.oi_zscore_30d.
    this.ctx.oi.observe(markets, this.ctx.now());
    return markets;
  }

  async perpMarket(i: Pick<PerpInstrument, "symbol" | "dex">): Promise<PerpMarket> {
    const markets = await this.perpMarkets(i.dex ?? null);
    const coin = perpCoin(i.symbol, i.dex);
    const m = markets.find((x) => x.coin === coin) ?? markets.find((x) => x.coin.toUpperCase() === coin.toUpperCase());
    if (!m) throw new Error(`hyperliquid: unknown perp ${coin}`);
    return m;
  }

  /**
   * Current funding rate of a perp (core or HIP-3), as a fraction per hour
   * (positive: longs pay shorts). Null for other instruments or when unknown.
   */
  async getFundingRate(i: Instrument): Promise<{ hourlyRate: number; ts: number } | null> {
    if (i.kind !== "perp") return null;
    const m = await this.perpMarket(i);
    return m.funding != null ? { hourlyRate: m.funding, ts: this.ctx.now() } : null;
  }

  /** Venue max leverage of a perp (from meta). Null for other instruments or when unknown. */
  async getMaxLeverage(i: Instrument): Promise<number | null> {
    if (i.kind !== "perp") return null;
    const m = await this.perpMarket(i);
    return m.maxLeverage != null && m.maxLeverage > 0 ? m.maxLeverage : null;
  }

  /* ------------------------------------------------------------------ */
  /* Hyperliquid spot                                                      */
  /* ------------------------------------------------------------------ */

  async spotMarkets(): Promise<SpotMarket[]> {
    return parseSpotMarkets(await this.ctx.hl.spotMetaAndAssetCtxs());
  }

  async spotMarket(symbol: string): Promise<SpotMarket> {
    const m = resolveSpotCoin(await this.spotMarkets(), symbol);
    if (!m) throw new Error(`hyperliquid: unknown spot pair ${symbol}`);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* HIP-4 outcomes                                                        */
  /* ------------------------------------------------------------------ */

  async hlOutcomes(): Promise<{ markets: OutcomeMarket[]; meta: RawOutcomeMeta }> {
    const [meta, spot, mids] = await Promise.all([this.ctx.hl.outcomeMeta(), this.ctx.hl.spotMetaAndAssetCtxs(), this.ctx.hl.allMids()]);
    return { markets: parseOutcomes(meta, outcomeCtxMap(spot), mids), meta };
  }

  async hlOutcome(i: Pick<OutcomeInstrument, "market" | "outcome">): Promise<{ market: OutcomeMarket; side: OutcomeSide }> {
    const { markets, meta } = await this.hlOutcomes();
    const ref = resolveOutcomeRef(i.market, i.outcome, meta);
    if (!ref) throw new Error(`hyperliquid: cannot resolve outcome ${i.market}/${i.outcome} (market must be a HIP-4 outcome id)`);
    const market = markets.find((m) => m.id === ref.id);
    if (!market) throw new Error(`hyperliquid: outcome ${ref.id} not listed (settled or unknown)`);
    return { market, side: market.sides[ref.side] };
  }

  /* ------------------------------------------------------------------ */
  /* Jupiter prediction                                                    */
  /* ------------------------------------------------------------------ */

  async jupMarket(i: Pick<OutcomeInstrument, "market" | "outcome">): Promise<{ market: RawPredictionMarket; outcome: "YES" | "NO" }> {
    const outcome = normalizeYesNo(i.outcome);
    if (!outcome) throw new Error(`jupiter prediction: outcome must be YES or NO, got ${i.outcome}`);
    return { market: await this.ctx.jup.predictionMarket(i.market), outcome };
  }

  /* ------------------------------------------------------------------ */
  /* Books (for size-aware quotes and the liquidity signal)                */
  /* ------------------------------------------------------------------ */

  /** Order book in USD (or probability) per unit; null for AMM-routed tokens. */
  async book(i: Instrument): Promise<{ book: Book; source: string } | null> {
    switch (i.kind) {
      case "perp":
        return { book: await this.ctx.hl.l2Book(perpCoin(i.symbol, i.dex)), source: "hyperliquid:l2Book" };
      case "spot": {
        const m = await this.spotMarket(i.symbol);
        return { book: await this.ctx.hl.l2Book(m.coin), source: "hyperliquid:l2Book" };
      }
      case "outcome": {
        if (i.venue === "hyperliquid") {
          const { side } = await this.hlOutcome(i);
          return { book: await this.ctx.hl.l2Book(side.coin), source: "hyperliquid:l2Book" };
        }
        const outcome = normalizeYesNo(i.outcome);
        if (!outcome) return null;
        return { book: predictionBook(await this.ctx.jup.predictionOrderbook(i.market), outcome), source: "jupiter:prediction/orderbook" };
      }
      case "option": {
        if (i.venue !== "deribit") return null;
        const name = await this.ctx.deribit.resolve(i);
        if (!name) return null;
        const parsed = parseDeribitName(name)!;
        return { book: deribitBookUsd(await this.ctx.deribit.orderBook(name), parsed.linear), source: "deribit:get_order_book" };
      }
      case "token":
        return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* MarketData                                                            */
  /* ------------------------------------------------------------------ */

  async getQuote(i: Instrument, req: QuoteRequest = {}): Promise<VenueQuote> {
    switch (i.kind) {
      case "perp":
        return this.perpQuote(i, req);
      case "spot":
        return this.spotQuote(i, req);
      case "token":
        return this.tokenQuote(i, req);
      case "outcome":
        return i.venue === "hyperliquid" ? this.hlOutcomeQuote(i, req) : this.jupOutcomeQuote(i, req);
      case "option":
        return this.optionQuote(i, req);
    }
  }

  async getQuotes(instruments: Instrument[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    const now = this.ctx.now();
    const perpByDex = new Map<string, PerpInstrument[]>();
    const tokens: TokenInstrument[] = [];
    const rest: Instrument[] = [];
    for (const i of instruments) {
      if (i.kind === "perp") {
        const k = i.dex ?? "";
        perpByDex.set(k, [...(perpByDex.get(k) ?? []), i]);
      } else if (i.kind === "token") tokens.push(i);
      else rest.push(i);
    }
    const tasks: Promise<void>[] = [];
    for (const [dex, list] of perpByDex) {
      tasks.push(
        this.ctx.hl.allMids(dex || undefined).then((mids) => {
          for (const i of list) {
            const px = lookupMid(mids, perpCoin(i.symbol, i.dex));
            if (px != null) out.set(instrumentKey(i), { instrumentKey: instrumentKey(i), price: px, ts: now, source: "hyperliquid:allMids" });
          }
        }, () => undefined)
      );
    }
    if (tokens.length) {
      tasks.push(
        this.ctx.jup.prices(tokens.map((t) => t.mint)).then((prices) => {
          for (const t of tokens) {
            const p = prices[t.mint];
            if (p?.usdPrice != null) out.set(instrumentKey(t), { instrumentKey: instrumentKey(t), price: p.usdPrice, ts: now, source: "jupiter:price/v3" });
          }
        }, () => undefined)
      );
    }
    for (const i of rest) {
      tasks.push(this.getQuote(i).then((q) => void out.set(q.instrumentKey, q), () => undefined));
    }
    await Promise.all(tasks);
    return out;
  }

  /* ---------------- per kind ---------------- */

  private async perpQuote(i: PerpInstrument, req: QuoteRequest): Promise<VenueQuote> {
    const key = instrumentKey(i);
    const coin = perpCoin(i.symbol, i.dex);
    if (req.sizeUsd && req.sizeUsd > 0) return this.bookQuote(key, await this.ctx.hl.l2Book(coin), req, "hyperliquid:l2Book");
    const px = lookupMid(await this.ctx.hl.allMids(i.dex), coin);
    if (px == null) throw new Error(`hyperliquid: no mid for ${coin}`);
    return { instrumentKey: key, price: px, ts: this.ctx.now(), source: "hyperliquid:allMids" };
  }

  private async spotQuote(i: SpotInstrument, req: QuoteRequest): Promise<VenueQuote> {
    const key = instrumentKey(i);
    const m = await this.spotMarket(i.symbol);
    if (req.sizeUsd && req.sizeUsd > 0) return this.bookQuote(key, await this.ctx.hl.l2Book(m.coin), req, "hyperliquid:l2Book");
    const px = lookupMid(await this.ctx.hl.allMids(), m.coin) ?? m.price;
    if (px == null) throw new Error(`hyperliquid: no price for spot ${i.symbol}`);
    return { instrumentKey: key, price: px, ts: this.ctx.now(), source: "hyperliquid:allMids" };
  }

  private async hlOutcomeQuote(i: OutcomeInstrument, req: QuoteRequest): Promise<VenueQuote> {
    const key = instrumentKey(i);
    const { side } = await this.hlOutcome(i);
    if (req.sizeUsd && req.sizeUsd > 0) return this.bookQuote(key, await this.ctx.hl.l2Book(side.coin), req, "hyperliquid:l2Book");
    if (side.mid == null) throw new Error(`hyperliquid: no mid for outcome ${side.coin}`);
    return { instrumentKey: key, price: side.mid, ts: this.ctx.now(), source: "hyperliquid:allMids" };
  }

  private async jupOutcomeQuote(i: OutcomeInstrument, req: QuoteRequest): Promise<VenueQuote> {
    const key = instrumentKey(i);
    const { market, outcome } = await this.jupMarket(i);
    const p = predictionPrice(market.pricing, outcome);
    if (!p) throw new Error(`jupiter prediction: no price for ${i.market}`);
    const base: VenueQuote = {
      instrumentKey: key,
      price: p.price,
      ...(p.bid != null ? { bid: p.bid } : {}),
      ...(p.ask != null ? { ask: p.ask } : {}),
      ts: this.ctx.now(),
      source: "jupiter:prediction/markets",
    };
    if (!(req.sizeUsd && req.sizeUsd > 0)) return base;
    try {
      const book = predictionBook(await this.ctx.jup.predictionOrderbook(i.market), outcome);
      const fill = walkBook(book, req.side ?? "buy", req.sizeUsd, p.price);
      if (fill) return { ...base, fillPrice: fill.fillPrice, priceImpactBps: fill.priceImpactBps, depthExhausted: fill.exhausted, source: "jupiter:prediction/orderbook" };
    } catch {
      /* fall through to top-of-book */
    }
    const px = (req.side ?? "buy") === "buy" ? p.ask : p.bid;
    return px != null ? { ...base, fillPrice: px, priceImpactBps: Math.abs(px - p.price) / p.price * 1e4 } : base;
  }

  private async tokenQuote(i: TokenInstrument, req: QuoteRequest): Promise<VenueQuote> {
    const key = instrumentKey(i);
    const now = this.ctx.now();
    let price: number | null = null;
    let decimals: number | null = null;
    let source = "jupiter:price/v3";
    try {
      const p = (await this.ctx.jup.prices([i.mint]))[i.mint];
      price = p?.usdPrice ?? null;
      decimals = p?.decimals ?? null;
    } catch {
      /* fall back below */
    }
    if (price == null || decimals == null) {
      const t = await this.ctx.jup.token(i.mint).catch(() => null);
      if (t) {
        price ??= t.usdPrice ?? null;
        decimals ??= t.decimals;
        source = "jupiter:tokens/v2";
      }
    }
    if (price == null) {
      const d = await this.ctx.dex.summary(i.mint).catch(() => null);
      if (d?.priceUsd != null) {
        price = d.priceUsd;
        source = "dexscreener";
      }
    }
    if (price == null) throw new Error(`no price for token ${i.mint}`);
    const base: VenueQuote = { instrumentKey: key, price, ts: now, source };
    if (!(req.sizeUsd && req.sizeUsd > 0) || decimals == null) return base;
    const side = req.side ?? "buy";
    const q =
      side === "buy"
        ? await this.ctx.jup.quote(USDC_MINT, i.mint, Math.round(req.sizeUsd * 1e6))
        : await this.ctx.jup.quote(i.mint, USDC_MINT, BigInt(Math.round((req.sizeUsd / price) * 10 ** decimals)));
    const fill = swapFill(q, side, decimals, price);
    if (!fill) return base;
    return { ...base, fillPrice: fill.fillPrice, priceImpactBps: fill.priceImpactBps, source: `jupiter:swap/v1/quote${fill.route ? ` (${fill.route})` : ""}` };
  }

  private async optionQuote(i: OptionInstrument, req: QuoteRequest): Promise<VenueQuote> {
    const key = instrumentKey(i);
    if (i.venue === "deribit") {
      const name = await this.ctx.deribit.resolve(i);
      if (!name) throw new Error(`deribit: no listed option ${i.underlying} ${i.expiry} ${i.strike} ${i.right}`);
      const linear = parseDeribitName(name)!.linear;
      const t = await this.ctx.deribit.ticker(name);
      const mult = linear ? 1 : t.index_price;
      const usd = (x: number | null | undefined) => (x != null && x > 0 ? x * mult : undefined);
      const base: VenueQuote = {
        instrumentKey: key,
        price: t.mark_price * mult,
        bid: usd(t.best_bid_price),
        ask: usd(t.best_ask_price),
        ts: t.timestamp,
        source: `deribit:${name}`,
      };
      if (base.bid === undefined) delete base.bid;
      if (base.ask === undefined) delete base.ask;
      if (!(req.sizeUsd && req.sizeUsd > 0)) return base;
      const book = deribitBookUsd(await this.ctx.deribit.orderBook(name), linear);
      const fill = walkBook(book, req.side ?? "buy", req.sizeUsd, base.price);
      return fill ? { ...base, fillPrice: fill.fillPrice, priceImpactBps: fill.priceImpactBps, depthExhausted: fill.exhausted } : { ...base, depthExhausted: true };
    }
    if (i.venue === "derive") {
      const name = deriveName(i);
      const t = parseDeriveTicker(await this.ctx.derive.ticker(name));
      const price = t.mark ?? (t.bid != null && t.ask != null ? (t.bid + t.ask) / 2 : null);
      if (price == null) throw new Error(`derive: no price for ${name}`);
      const base: VenueQuote = {
        instrumentKey: key,
        price,
        ...(t.bid != null ? { bid: t.bid } : {}),
        ...(t.ask != null ? { ask: t.ask } : {}),
        ts: t.ts ?? this.ctx.now(),
        source: `derive:${name}`,
      };
      if (!(req.sizeUsd && req.sizeUsd > 0)) return base;
      // Derive's public ticker only exposes top of book: fill at best bid/ask, flag if it can't absorb the size.
      const side = req.side ?? "buy";
      const px = side === "buy" ? t.ask : t.bid;
      const amt = side === "buy" ? t.askAmount : t.bidAmount;
      if (px == null) return { ...base, depthExhausted: true };
      return {
        ...base,
        fillPrice: px,
        priceImpactBps: (Math.abs(px - price) / price) * 1e4,
        depthExhausted: amt == null || amt * px < req.sizeUsd,
      };
    }
    throw new Error(`options on ${i.venue} are not supported yet`);
  }

  private bookQuote(key: string, book: Book, req: QuoteRequest, source: string): VenueQuote {
    const top = bookTop(book);
    if (top.mid == null) throw new Error(`empty book for ${key}`);
    const q: VenueQuote = { instrumentKey: key, price: top.mid, ts: book.ts ?? this.ctx.now(), source };
    if (top.bid != null) q.bid = top.bid;
    if (top.ask != null) q.ask = top.ask;
    const fill = walkBook(book, req.side ?? "buy", req.sizeUsd ?? 0);
    if (fill) {
      q.fillPrice = fill.fillPrice;
      q.priceImpactBps = fill.priceImpactBps;
      q.depthExhausted = fill.exhausted;
    } else {
      q.depthExhausted = true;
    }
    return q;
  }
}

function lookupMid(mids: Record<string, string>, coin: string): number | null {
  const direct = num(mids[coin]);
  if (direct != null) return direct;
  const up = coin.toUpperCase();
  for (const [k, v] of Object.entries(mids)) if (k.toUpperCase() === up) return num(v);
  return null;
}

