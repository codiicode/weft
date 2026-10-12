/**
 * @weft/venues: real market data from public APIs for every Weft product
 * (perps, stocks, predictions, Solana tokens, options), plus signal providers
 * and token safety facts. Read-only: nothing here signs or sends orders.
 */
import type { Catalog, SignalProvider } from "./types.ts";
import { createContext, type VenueContext, type VenueOptions } from "./context.ts";
import { VenueMarketData } from "./market-data.ts";
import { VenueCatalog } from "./catalog.ts";
import { VenueTokenFactsProvider } from "./tokens.ts";
import { createSignalProviders, SignalRouter } from "./signals/index.ts";

export type * from "./types.ts";
export type { VenueOptions, VenueContext } from "./context.ts";
export type { VenueQuote } from "./market-data.ts";
export type { VenueTokenFacts } from "./tokens.ts";
export { Http, HttpError, type FetchFn, type HttpOptions, type RequestOptions } from "./http.ts";
export { VenueMarketData } from "./market-data.ts";
export { OiHistory, type OiHistoryOptions, type OiSample } from "./oi-history.ts";
export { VenueCatalog } from "./catalog.ts";
export { VenueTokenFactsProvider } from "./tokens.ts";
export { SignalRouter, createSignalProviders } from "./signals/index.ts";
export { walkBook, bookTop, depthWithin, type Book, type Level } from "./book.ts";
export { classifyHip3 } from "./hyperliquid/classify.ts";
export { USDC_MINT, WSOL_MINT } from "./jupiter/client.ts";

export interface Venues {
  /** Implements MarketData; quotes also carry `depthExhausted`. */
  marketData: VenueMarketData;
  catalog: Catalog;
  /** One provider per signal kind group; `mode` says live vs simulated. */
  signalProviders: SignalProvider[];
  /** Convenience dispatcher over `signalProviders` (by kind). */
  signals: SignalRouter;
  tokenFacts: VenueTokenFactsProvider;
  /** Shared clients + HTTP cache (stats, clearCache). */
  ctx: VenueContext;
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
    ctx,
  };
}
