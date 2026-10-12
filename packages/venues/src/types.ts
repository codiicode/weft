/**
 * CONTRACTS between venues, the engine and the API. Keep these stable:
 * other packages are written against them.
 */
import type { Instrument, Signal, SignalKind, SignalSnapshot } from "@weft/strategy";

/** The five products Weft offers. */
export type Product = "perps" | "stocks" | "predictions" | "tokens" | "options";

/** A price for an instrument, optionally size-aware (quote with price impact). */
export interface Quote {
  instrumentKey: string;
  /** Mid / last price in USD (outcomes: probability 0–1; options: premium in USD). */
  price: number;
  bid?: number;
  ask?: number;
  /** Expected fill price for the requested size/side, if size-aware. */
  fillPrice?: number;
  priceImpactBps?: number;
  /** ms since epoch, when the venue/provider observed it */
  ts: number;
  source: string;
}

export interface QuoteRequest {
  side?: "buy" | "sell";
  /** USD notional, for size-aware quotes (router quotes, order book walks). */
  sizeUsd?: number;
}

/** Live prices for anything tradable. Used by the paper broker and exit monitoring. */
export interface MarketData {
  getQuote(instrument: Instrument, req?: QuoteRequest): Promise<Quote>;
  /** Batch helper; implementations may optimise (e.g. one allMids call). */
  getQuotes?(instruments: Instrument[]): Promise<Map<string, Quote>>;
  /**
   * Optional (additive): current funding rate of a perp as a fraction per hour
   * (0.0000125 = 0.00125 %/h; positive: longs pay shorts). Null for non-perps or
   * when unknown. Used by the paper engine to accrue funding.
   */
  getFundingRate?(instrument: Instrument): Promise<{ hourlyRate: number; ts: number } | null>;
  /**
   * Optional (additive): the venue's max leverage for a perp, null if unknown.
   * Used by the paper engine's liquidation model (maintenance = 1 / (2 × max)).
   */
  getMaxLeverage?(instrument: Instrument): Promise<number | null>;
}

/** One row in the markets explorer. */
export interface MarketListing {
  product: Product;
  instrument: Instrument;
  instrumentKey: string;
  /** Short display name, e.g. "NVDA", "BTC", "$WIF", "Fed cuts in Dec? · YES". */
  label: string;
  /** Long name / question / underlying description. */
  name?: string;
  price: number | null;
  change24hPct?: number | null;
  volume24hUsd?: number | null;
  openInterestUsd?: number | null;
  /** Perps: funding per hour in % */
  fundingHourlyPct?: number | null;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  maxLeverage?: number | null;
  /** Free-form extras for the UI (expiry, strike, dex, image url, venue…). */
  meta?: Record<string, string | number | boolean | null>;
  venue: string;
}

export interface CatalogQuery {
  search?: string;
  limit?: number;
}

/** Lists what can be traded, per product. */
export interface Catalog {
  list(product: Product, q?: CatalogQuery): Promise<MarketListing[]>;
}

/**
 * Produces values for one or more signal kinds. Providers must never throw for
 * "no data": return `null` and the evaluator treats the signal as unknown.
 */
export interface SignalProvider {
  readonly kinds: readonly SignalKind[];
  /** "live" = real public data; "simulated" = synthetic stand-in until a paid feed is wired. */
  readonly mode: "live" | "simulated";
  fetch(signal: Signal, now: number): Promise<SignalSnapshot | null>;
}

/** On-chain safety facts for a Solana token, for the risk engine's token gates. */
export interface TokenFactsProvider {
  getTokenFacts(mint: string, opts?: { sizeUsd?: number }): Promise<import("@weft/strategy").TokenFacts | null>;
}
