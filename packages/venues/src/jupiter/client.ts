import type { Http } from "../http.ts";

/**
 * Read-only Jupiter client (lite-api.jup.ag: free, no key; api.jup.ag needs x-api-key).
 * Price v3, Swap v1 quote (no transaction building), Tokens v2, Prediction v1 (read endpoints only).
 */

export const JUP_LITE_URL = "https://lite-api.jup.ag";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/* ---------------- raw shapes (fields we use) ---------------- */

export interface RawPriceV3Entry {
  usdPrice: number;
  liquidity?: number;
  decimals?: number;
  priceChange24h?: number | null;
  blockId?: number;
  createdAt?: string;
}
export type RawPriceV3 = Record<string, RawPriceV3Entry | null>;

export interface RawSwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  swapUsdValue?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
  contextSlot?: number;
}

export interface RawTokenStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface RawToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  dev?: string;
  circSupply?: number;
  totalSupply?: number;
  tokenProgram?: string;
  holderCount?: number;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  launchpad?: string;
  graduatedPool?: string;
  graduatedAt?: string;
  bondingCurve?: number;
  mintAuthority?: string;
  freezeAuthority?: string;
  stats5m?: RawTokenStats;
  stats1h?: RawTokenStats;
  stats6h?: RawTokenStats;
  stats24h?: RawTokenStats;
  firstPool?: { id: string; createdAt: string };
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMints?: number;
    devMigrations?: number;
    isSus?: boolean;
  };
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  createdAt?: string;
}

export interface RawPredictionPricing {
  buyYesPriceUsd: number | null;
  sellYesPriceUsd: number | null;
  buyNoPriceUsd: number | null;
  sellNoPriceUsd: number | null;
  volume?: number | null;
}
export interface RawPredictionMarket {
  marketId: string;
  provider?: string;
  status?: string;
  title: string;
  closeTime?: number | null;
  pricing: RawPredictionPricing;
  outcomes?: string[];
  eventId?: string;
  imageUrl?: string;
}
export interface RawPredictionEvent {
  eventId: string;
  isActive?: boolean;
  category?: string;
  subcategory?: string;
  tags?: string[];
  metadata?: { title?: string; closeTime?: string; imageUrl?: string; slug?: string };
  volumeUsd?: string;
  volume24hr?: string;
  markets?: RawPredictionMarket[];
}
export interface RawPredictionEvents {
  data: RawPredictionEvent[];
  pagination?: { start: number; end: number; hasNext: boolean };
}
/** Bids per side: [priceCents, contracts]. */
export interface RawPredictionOrderbook {
  yes?: [number, number][];
  no?: [number, number][];
}

/* ---------------- client ---------------- */

export class JupiterClient {
  readonly url: string;
  private readonly headers: Record<string, string> | undefined;

  private readonly http: Http;

  constructor(http: Http, opts: { url?: string; apiKey?: string } = {}) {
    this.http = http;
    this.url = (opts.url ?? JUP_LITE_URL).replace(/\/$/, "");
    this.headers = opts.apiKey ? { "x-api-key": opts.apiKey } : undefined;
  }

  private get<T>(path: string, ttlMs: number): Promise<T> {
    return this.http.json<T>(`${this.url}${path}`, { ttlMs, headers: this.headers });
  }

  /** Up to 50 mints per call. */
  async prices(mints: string[]): Promise<RawPriceV3> {
    const out: RawPriceV3 = {};
    const uniq = [...new Set(mints)];
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50).sort();
      Object.assign(out, await this.get<RawPriceV3>(`/price/v3?ids=${chunk.join(",")}`, 5_000));
    }
    return out;
  }

  /** ExactIn swap quote. `amount` in input-token base units. */
  quote(inputMint: string, outputMint: string, amount: bigint | number, slippageBps = 50): Promise<RawSwapQuote> {
    const amt = typeof amount === "bigint" ? amount.toString() : Math.max(1, Math.floor(amount)).toString();
    return this.get(
      `/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amt}&slippageBps=${slippageBps}`,
      5_000
    );
  }

  searchTokens(query: string, limit?: number): Promise<RawToken[]> {
    const q = encodeURIComponent(query);
    return this.get(`/tokens/v2/search?query=${q}${limit ? `&limit=${limit}` : ""}`, 15_000);
  }

  /** Exact lookup by mint (search by mint returns that token first). */
  async token(mint: string): Promise<RawToken | null> {
    const rows = await this.searchTokens(mint);
    return rows.find((t) => t.id === mint) ?? null;
  }

  category(kind: "toptrending" | "toptraded" | "toporganicscore", interval: "5m" | "1h" | "6h" | "24h", limit = 50): Promise<RawToken[]> {
    return this.get(`/tokens/v2/${kind}/${interval}?limit=${limit}`, 30_000);
  }

  recent(limit = 30): Promise<RawToken[]> {
    return this.get(`/tokens/v2/recent?limit=${limit}`, 15_000);
  }

  /* ---- Prediction (beta; readable without a key on lite-api at time of writing) ---- */

  predictionEvents(params: { filter?: "trending" | "live" | "new" | "upcoming"; category?: string; start?: number; end?: number }): Promise<RawPredictionEvents> {
    const qs = new URLSearchParams({ includeMarkets: "true" });
    if (params.filter) qs.set("filter", params.filter);
    if (params.category) qs.set("category", params.category);
    qs.set("start", String(params.start ?? 0));
    qs.set("end", String(params.end ?? 20));
    return this.get(`/prediction/v1/events?${qs}`, 30_000);
  }

  predictionSearch(query: string, limit = 20): Promise<RawPredictionEvents> {
    return this.get(`/prediction/v1/events/search?query=${encodeURIComponent(query)}&limit=${limit}`, 30_000);
  }

  predictionEvent(eventId: string): Promise<RawPredictionEvent> {
    return this.get(`/prediction/v1/events/${encodeURIComponent(eventId)}`, 30_000);
  }

  predictionMarket(marketId: string): Promise<RawPredictionMarket> {
    return this.get(`/prediction/v1/markets/${encodeURIComponent(marketId)}`, 5_000);
  }

  predictionOrderbook(marketId: string): Promise<RawPredictionOrderbook> {
    return this.get(`/prediction/v1/orderbook/${encodeURIComponent(marketId)}`, 3_000);
  }
}
