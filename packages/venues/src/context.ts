import { Http, type HttpOptions } from "./http.ts";
import { HyperliquidClient } from "./hyperliquid/client.ts";
import { JupiterClient } from "./jupiter/client.ts";
import { DeribitClient, DeriveClient } from "./options.ts";
import { DexScreenerClient, SolanaRpcClient } from "./solana.ts";
import { OiHistory, type OiHistoryOptions } from "./oi-history.ts";

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
  /**
   * Persist the open-interest sampler (for `funding.oi_zscore_30d`) to this JSON
   * file. Default: in memory only (history restarts with the process).
   */
  oiHistoryPath?: string;
  /** Sampler tuning (bucket width, window, minimum buckets for a z-score, flush interval). */
  oiHistory?: Omit<OiHistoryOptions, "path" | "now">;
}

export interface VenueContext {
  http: Http;
  hl: HyperliquidClient;
  jup: JupiterClient;
  dex: DexScreenerClient;
  rpc: SolanaRpcClient;
  deribit: DeribitClient;
  derive: DeriveClient;
  /** Open-interest sampler fed by every metaAndAssetCtxs read. */
  oi: OiHistory;
  now: () => number;
  opts: VenueOptions;
}

export function createContext(opts: VenueOptions = {}): VenueContext {
  const http = opts.http ?? new Http(opts);
  const now = opts.now ?? Date.now;
  return {
    http,
    hl: new HyperliquidClient(http, { url: opts.hyperliquidUrl }),
    jup: new JupiterClient(http, { url: opts.jupiterUrl, apiKey: opts.jupiterApiKey }),
    dex: new DexScreenerClient(http, opts.dexscreenerUrl),
    rpc: new SolanaRpcClient(http, opts.solanaRpcUrl),
    deribit: new DeribitClient(http, opts.deribitUrl),
    derive: new DeriveClient(http, opts.deriveUrl),
    oi: new OiHistory({ ...opts.oiHistory, path: opts.oiHistoryPath, now }),
    now,
    opts,
  };
}
