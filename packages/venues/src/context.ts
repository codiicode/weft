import { Http, type HttpOptions } from "./http.ts";
import { HyperliquidClient } from "./hyperliquid/client.ts";
import { JupiterClient } from "./jupiter/client.ts";
import { DeribitClient, DeriveClient } from "./options.ts";
import { DexScreenerClient, SolanaRpcClient } from "./solana.ts";

export interface VenueOptions extends HttpOptions {
  /** Share an existing Http instance (cache + coalescing) instead of creating one. */
  http?: Http;
  hyperliquidUrl?: string;
  /** Default https://lite-api.jup.ag (free). Set to https://api.jup.ag with `jupiterApiKey` for higher limits. */
  jupiterUrl?: string;
  jupiterApiKey?: string;
  dexscreenerUrl?: string;
  /** Public mainnet-beta is heavily rate limited; use a private RPC (Helius, Triton…) in production. */
  solanaRpcUrl?: string;
  deribitUrl?: string;
  deriveUrl?: string;
  /** Base URLs for macro/forecast sources (overridable for tests). */
  noaaUrl?: string;
  fredUrl?: string;
  frankfurterUrl?: string;
  /**
   * dev_sold_pct cannot be derived from free public APIs (needs the dev's initial
   * allocation from an indexer). TokenFacts must carry a number, so this value is
   * used when unknown. Default 0 (permissive); set 100 to fail closed.
   */
  devSoldPctWhenUnknown?: number;
}

export interface VenueContext {
  http: Http;
  hl: HyperliquidClient;
  jup: JupiterClient;
  dex: DexScreenerClient;
  rpc: SolanaRpcClient;
  deribit: DeribitClient;
  derive: DeriveClient;
  now: () => number;
  opts: VenueOptions;
}

export function createContext(opts: VenueOptions = {}): VenueContext {
  const http = opts.http ?? new Http(opts);
  return {
    http,
    hl: new HyperliquidClient(http, { url: opts.hyperliquidUrl }),
    jup: new JupiterClient(http, { url: opts.jupiterUrl, apiKey: opts.jupiterApiKey }),
    dex: new DexScreenerClient(http, opts.dexscreenerUrl),
    rpc: new SolanaRpcClient(http, opts.solanaRpcUrl),
    deribit: new DeribitClient(http, opts.deribitUrl),
    derive: new DeriveClient(http, opts.deriveUrl),
    now: opts.now ?? Date.now,
    opts,
  };
}
