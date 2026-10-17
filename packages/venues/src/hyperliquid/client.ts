import type { Http } from "../http.ts";
import type { Book } from "../book.ts";
import { normalizeBook } from "../book.ts";
import { num } from "../util.ts";

/**
 * Read-only Hyperliquid info client (POST https://api.hyperliquid.xyz/info).
 * Never signs, never touches /exchange.
 */

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

/* ---------------- raw response shapes (only fields we use) ---------------- */

export interface RawPerpAsset {
  name: string;
  szDecimals?: number;
  maxLeverage?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: string;
}
export interface RawPerpCtx {
  funding?: string;
  openInterest?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  premium?: string | null;
  oraclePx?: string;
  markPx?: string;
  midPx?: string | null;
  impactPxs?: string[] | null;
  dayBaseVlm?: string;
}
export type RawMetaAndAssetCtxs = [{ universe: RawPerpAsset[]; collateralToken?: number }, RawPerpCtx[]];

export interface RawPerpDex {
  name: string;
  fullName?: string;
  deployer?: string;
}

export interface RawSpotToken {
  name: string;
  index: number;
  szDecimals?: number;
  fullName?: string | null;
}
export interface RawSpotPair {
  name: string;
  tokens: [number, number];
  index: number;
  isCanonical?: boolean;
}
export interface RawSpotCtx {
  coin: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  markPx?: string;
  midPx?: string | null;
  circulatingSupply?: string;
  totalSupply?: string;
}
export type RawSpotMetaAndAssetCtxs = [{ universe: RawSpotPair[]; tokens: RawSpotToken[] }, RawSpotCtx[]];

export interface RawL2Book {
  coin: string;
  time: number;
  levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]];
}

export interface RawOutcome {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
  quoteToken?: string;
  venue?: string;
}
export interface RawQuestion {
  question: number;
  name: string;
  description: string;
  fallbackOutcome?: number;
  namedOutcomes?: number[];
  settledNamedOutcomes?: number[];
}
export interface RawOutcomeMeta {
  outcomes: RawOutcome[];
  questions?: RawQuestion[];
}

export interface RawCandle {
  t: number;
  T: number;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
}

/* ---------------- client ---------------- */

export interface HyperliquidTtls {
  meta: number;
  mids: number;
  book: number;
  dexes: number;
  outcomes: number;
  candles: number;
}

const DEFAULT_TTLS: HyperliquidTtls = {
  meta: 5_000,
  mids: 2_000,
  book: 1_000,
  dexes: 5 * 60_000,
  outcomes: 30_000,
  candles: 30_000,
};

export interface RawClearinghouseState {
  marginSummary?: { accountValue?: string };
  assetPositions?: { position: { coin: string; szi: string; entryPx?: string | null; positionValue?: string; returnOnEquity?: string; leverage?: { value?: number } } }[];
}

export class HyperliquidClient {
  readonly url: string;
  private readonly ttl: HyperliquidTtls;

  private readonly http: Http;

  constructor(http: Http, opts: { url?: string; ttl?: Partial<HyperliquidTtls> } = {}) {
    this.http = http;
    this.url = opts.url ?? HL_INFO_URL;
    this.ttl = { ...DEFAULT_TTLS, ...opts.ttl };
  }

  info<T>(body: Record<string, unknown>, ttlMs: number): Promise<T> {
    return this.http.json<T>(this.url, { method: "POST", body, ttlMs });
  }

  /** Builder dexes (HIP-3). Index 0 is `null` (the core dex). */
  async perpDexs(): Promise<RawPerpDex[]> {
    const raw = await this.info<(RawPerpDex | null)[]>({ type: "perpDexs" }, this.ttl.dexes);
    return raw.filter((d): d is RawPerpDex => d != null && typeof d.name === "string");
  }

  metaAndAssetCtxs(dex?: string): Promise<RawMetaAndAssetCtxs> {
    return this.info({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }, this.ttl.meta);
  }

  allMids(dex?: string): Promise<Record<string, string>> {
    return this.info({ type: "allMids", ...(dex ? { dex } : {}) }, this.ttl.mids);
  }

  spotMetaAndAssetCtxs(): Promise<RawSpotMetaAndAssetCtxs> {
    return this.info({ type: "spotMetaAndAssetCtxs" }, this.ttl.meta);
  }

  /** Any account's perp positions and margin (public on Hyperliquid). */
  clearinghouseState(user: string): Promise<RawClearinghouseState> {
    return this.info({ type: "clearinghouseState", user }, 10_000);
  }

  /** Next funding rates per coin on Hyperliquid, Binance and Bybit: [coin, [[venue, { fundingRate, fundingIntervalHours }]]]. */
  predictedFundings(): Promise<[string, [string, { fundingRate: string; fundingIntervalHours?: number } | null][]][]> {
    return this.info({ type: "predictedFundings" }, 60_000);
  }

  /** HIP-4 outcome markets (binary / multi-outcome questions). */
  outcomeMeta(): Promise<RawOutcomeMeta> {
    return this.info({ type: "outcomeMeta" }, this.ttl.outcomes);
  }

  async l2Book(coin: string): Promise<Book> {
    const raw = await this.info<RawL2Book | null>({ type: "l2Book", coin }, this.ttl.book);
    if (!raw || !Array.isArray(raw.levels)) throw new Error(`no order book for ${coin}`);
    return parseL2Book(raw);
  }

  candles(coin: string, interval: string, startTime: number, endTime: number): Promise<RawCandle[]> {
    // Round the window so identical requests within a minute share the cache.
    const bucket = 30_000;
    const end = Math.ceil(endTime / bucket) * bucket;
    const start = Math.floor(startTime / bucket) * bucket;
    return this.info({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } }, this.ttl.candles);
  }
}

export function parseL2Book(raw: RawL2Book): Book {
  const [bids = [], asks = []] = raw.levels;
  const conv = (ls: { px: string; sz: string }[]) => ls.map((l) => ({ px: num(l.px) ?? NaN, sz: num(l.sz) ?? NaN }));
  return normalizeBook({ bids: conv(bids), asks: conv(asks), ts: raw.time });
}
