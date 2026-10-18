/**
 * @weft/venues: real market data from public APIs for every Weft product
 * (perps, stocks, predictions, Solana tokens, options), plus signal providers
 * and token safety facts. Read-only: nothing here signs or sends orders.
 */
import type { Catalog, SignalProvider } from "./types.ts";
import { Yields } from "./signals/yields.ts";
import { createContext, type VenueContext, type VenueOptions } from "./context.ts";
import { VenueMarketData } from "./market-data.ts";
import { VenueCatalog } from "./catalog.ts";
import { VenueTokenFactsProvider } from "./tokens.ts";
import { createSignalProviders, SignalRouter } from "./signals/index.ts";
import { VenueHistory } from "./history.ts";

export type * from "./types.ts";
export type { VenueOptions, VenueContext } from "./context.ts";
export type { VenueQuote } from "./market-data.ts";
export type { VenueTokenFacts } from "./tokens.ts";
export { Http, HttpError, type FetchFn, type HttpOptions, type RequestOptions } from "./http.ts";
export { VenueMarketData } from "./market-data.ts";
export type { PostMatcher, Tweet } from "./signals/x.ts";
export type { LeaderTrade, HeliusTx } from "./signals/wallet.ts";
export { HeliusWallets } from "./signals/wallet.ts";
export type { TraderState, TraderPosition } from "./traders.ts";
import type { LeaderTrade } from "./signals/wallet.ts";
import { traderState, type TraderState } from "./traders.ts";
export { OiHistory, type OiHistoryOptions, type OiSample } from "./oi-history.ts";
export { VenueCatalog } from "./catalog.ts";
export { PAPERTRADE, PapertradeApi, DEFAULT_SYNTH_LIMITS, decodeTradingState, synthBustPrice, synthSettlement, type SynthLimits, type SynthParams } from "./papertrade.ts";
export { VenueTokenFactsProvider } from "./tokens.ts";
export { SignalRouter, createSignalProviders } from "./signals/index.ts";
export { walkBook, bookTop, depthWithin, type Book, type Level } from "./book.ts";
export { classifyHip3 } from "./hyperliquid/classify.ts";
export { USDC_MINT, WSOL_MINT } from "./jupiter/client.ts";
export { calendarFields } from "./signals/calendar.ts";
export { Yields, type YieldPool } from "./signals/yields.ts";
export { Kamino, type KaminoReserveRow } from "./kamino.ts";
export { JupiterLend, jupiterLendInstrument, type JupiterLendRow } from "./jupiter-lend.ts";
export {
  VenueHistory,
  INTERVAL_MS,
  GECKOTERMINAL_URL,
  fetchHlCandles,
  fetchHlFunding,
  fetchGeckoOhlcv,
  resolveSolanaPool,
  PartialHistoryError,
  parseHlCandles,
  parseHlFunding,
  parseGeckoOhlcv,
  mergeCandles,
  type Candle,
  type CandleInterval,
  type CandleSeries,
  type FundingPoint,
  type HistoryProvider,
  type VenueHistoryOptions,
} from "./history.ts";

export interface Venues {
  /** Implements MarketData; quotes also carry `depthExhausted`. */
  marketData: VenueMarketData;
  catalog: Catalog;
  /** One provider per signal kind group; `mode` says live vs simulated. */
  signalProviders: SignalProvider[];
  /** Convenience dispatcher over `signalProviders` (by kind). */
  signals: SignalRouter;
  tokenFacts: VenueTokenFactsProvider;
  /** Historical candles + funding for backtests (Hyperliquid, GeckoTerminal), cached. */
  history: VenueHistory;
  /** Shared clients + HTTP cache (stats, clearCache). */
  ctx: VenueContext;
  /** DeFi yields (DefiLlama): pools to search, for yield signals. */
  yields: Yields;
  /** Leaders' trades for copy trading: a Solana wallet's token buys and sells (needs Helius), a Hyperliquid account's positions. */
  copyFeeds: CopyFeeds;
}

export interface CopyFeeds {
  solanaWallet?: (address: string) => Promise<LeaderTrade[]>;
  hyperliquidTrader: (address: string) => Promise<TraderState>;
}

export function createVenues(opts: VenueOptions = {}): Venues {
  const ctx = createContext(opts);
  const marketData = new VenueMarketData(ctx);
  const signalProviders = createSignalProviders(marketData, {
    noaa: opts.noaaUrl,
    fred: opts.fredUrl,
    frankfurter: opts.frankfurterUrl,
  });
  return {
    marketData,
    catalog: new VenueCatalog(marketData),
    signalProviders,
    signals: new SignalRouter(signalProviders),
    tokenFacts: new VenueTokenFactsProvider(marketData),
    history: new VenueHistory(ctx.http, marketData, { hyperliquidUrl: opts.hyperliquidUrl, dexscreenerUrl: opts.dexscreenerUrl, now: ctx.now }),
    ctx,
    yields: new Yields(ctx.http),
    copyFeeds: {
      ...(ctx.helius ? { solanaWallet: (a: string) => ctx.helius!.trades(a) } : {}),
      hyperliquidTrader: (a: string) => traderState(ctx.hl, a),
    },
  };
}
