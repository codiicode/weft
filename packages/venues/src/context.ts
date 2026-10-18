import { Http, type HttpOptions } from "./http.ts";
import { HyperliquidClient } from "./hyperliquid/client.ts";
import { JupiterClient } from "./jupiter/client.ts";
import { DeribitClient, DeriveClient } from "./options.ts";
import { DexScreenerClient, SolanaRpcClient } from "./solana.ts";
import { OiHistory, type OiHistoryOptions } from "./oi-history.ts";
import { PolymarketClient } from "./polymarket.ts";
import type { PostMatcher } from "./signals/x.ts";
import { HeliusWallets } from "./signals/wallet.ts";
import { Kamino } from "./kamino.ts";
import { JupiterLend } from "./jupiter-lend.ts";

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
  /** twitterapi.io key: makes the social and post_match signals live (otherwise simulated). */
  twitterApiKey?: string;
  /** Semantic matcher for post_match (e.g. a small model); keyword overlap when absent. */
  postMatcher?: PostMatcher;
  /** Helius key: makes the wallet signal live and powers on-chain lookups. */
  heliusApiKey?: string;
  /** Polymarket Gamma API (read-only odds). */
  polymarketUrl?: string;
  /** Kamino lending: tokens per kToken for a reserve, read from the chain (the API server provides it). */
  lendRate?: (reserve: string) => Promise<number>;
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
  pm: PolymarketClient;
  /** Helius wallet histories (when a Helius key is set). */
  helius: HeliusWallets | null;
  kamino: Kamino;
  jupiterLend: JupiterLend;
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
    pm: new PolymarketClient(http, opts.polymarketUrl),
    helius: opts.heliusApiKey ? new HeliusWallets(http, opts.heliusApiKey) : null,
    kamino: new Kamino(http),
    jupiterLend: new JupiterLend(http, { url: opts.jupiterUrl, apiKey: opts.jupiterApiKey }),
    oi: new OiHistory({ ...opts.oiHistory, path: opts.oiHistoryPath, now }),
    now,
    opts,
  };
}
