import { instrumentKey, type Instrument } from "@weft/strategy";
import type { Http } from "./http.ts";
import type { VenueMarketData } from "./market-data.ts";
import type { RawCandle } from "./hyperliquid/client.ts";
import { HL_INFO_URL } from "./hyperliquid/client.ts";
import { perpCoin } from "./hyperliquid/parse.ts";
import { DEXSCREENER_URL, type RawDexPair } from "./solana.ts";
import { num } from "./util.ts";

/**
 * Historical market data for backtests.
 *
 * - Hyperliquid `candleSnapshot` (core perps, HIP-3 coins like `xyz:NVDA`, spot `@107`) and
 *   `fundingHistory` (perps; hourly). The info endpoint serves only the most recent ~5000
 *   candles per coin and interval (1h ≈ 208 days, 15m ≈ 52 days, 5m ≈ 17 days), so older
 *   windows simply come back shorter. Funding pages 500 rows at a time.
 * - Solana tokens: GeckoTerminal's free, keyless OHLCV API
 *   (`/networks/solana/pools/{pool}/ohlcv/{hour|minute|day}`), with the pool resolved via
 *   DexScreener (deepest pair where the mint is the base) or GeckoTerminal token pools.
 *   Prices are USD per token; volume is USD. Public limit ≈ 30 requests/min.
 * - Prediction outcomes and options: unsupported (no free history source wired yet).
 *
 * Everything is cached in memory per series (merged ranges), so repeated backtests of
 * the same market only fetch the newest candles.
 */

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
};

/** One OHLC bar. `t` is the open time (ms); the bar closes at `t + interval`. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Traded volume in USD over the bar, when known. */
  volUsd: number | null;
}

export interface CandleSeries {
  instrumentKey: string;
  interval: CandleInterval;
  /** e.g. "hyperliquid:candleSnapshot BTC", "geckoterminal:<pool>". */
  source: string;
  /** Sorted by `t`, unique. Only bars with t in [start, end). May start later than requested. */
  candles: Candle[];
}

/** Funding rate observation: fraction per hour (positive: longs pay). */
export interface FundingPoint {
  time: number;
  rate: number;
}

export interface HistoryProvider {
  /** Why an instrument has no price history (null when supported). Synchronous and cheap. */
  unsupportedReason(i: Instrument): string | null;
  /** Bars with open time in [startMs, endMs). Throws on network failure. */
  candles(i: Instrument, interval: CandleInterval, startMs: number, endMs: number): Promise<CandleSeries>;
  /** Hourly funding in [startMs, endMs]; [] for non-perps. */
  funding(i: Instrument, startMs: number, endMs: number): Promise<FundingPoint[]>;
  /** The Hyperliquid websocket coin for live updates (null: poll instead). */
  liveCoin?(i: Instrument): Promise<string | null>;
}

/* ------------------------------------------------------------------ */
/* Parsers                                                               */
/* ------------------------------------------------------------------ */

export function parseHlCandles(raw: RawCandle[] | null | undefined): Candle[] {
  const out: Candle[] = [];
  for (const r of raw ?? []) {
    const o = num(r.o), h = num(r.h), l = num(r.l), c = num(r.c), v = num(r.v);
    if (typeof r.t !== "number" || o == null || h == null || l == null || c == null) continue;
    // HL reports base-asset volume; value it at the bar's close.
    out.push({ t: r.t, o, h, l, c, volUsd: v != null ? v * c : null });
  }
  return out;
}

export interface RawFunding {
  coin: string;
  fundingRate: string;
  premium?: string;
  time: number;
}

export function parseHlFunding(raw: RawFunding[] | null | undefined): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const r of raw ?? []) {
    const rate = num(r.fundingRate);
    if (rate == null || typeof r.time !== "number") continue;
    // Settlement timestamps land a few ms after the hour; snap to the minute.
    out.push({ time: Math.floor(r.time / 60_000) * 60_000, rate });
  }
  return out;
}

/** GeckoTerminal `ohlcv_list` rows: [unixSeconds, o, h, l, c, volumeUsd] (newest first). */
export function parseGeckoOhlcv(raw: unknown): Candle[] {
  const list = (raw as { data?: { attributes?: { ohlcv_list?: unknown[] } } })?.data?.attributes?.ohlcv_list ?? [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row)) continue;
    const [ts, o, h, l, c, v] = row.map((x) => num(x));
    if (ts == null || o == null || h == null || l == null || c == null) continue;
    out.push({ t: ts * 1000, o, h, l, c, volUsd: v ?? null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Merge bars by open time (later wins) and sort. */
export function mergeCandles(a: readonly Candle[], b: readonly Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of a) m.set(c.t, c);
  for (const c of b) m.set(c.t, c);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/* ------------------------------------------------------------------ */
/* Raw fetchers (exported for reuse and tests)                           */
/* ------------------------------------------------------------------ */

const HL_MAX_CANDLES = 5_000;
const HL_FUNDING_PAGE = 500;

/** Hyperliquid `candleSnapshot`, paged forward. Coins: "BTC", "xyz:NVDA", "@107". */
export async function fetchHlCandles(
  http: Http,
  coin: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number,
  opts: { url?: string; maxPages?: number } = {}
): Promise<Candle[]> {
  const step = INTERVAL_MS[interval];
  let out: Candle[] = [];
  let from = startMs;
  for (let page = 0; page < (opts.maxPages ?? 6) && from < endMs; page++) {
    const raw = await http.json<RawCandle[]>(opts.url ?? HL_INFO_URL, {
      method: "POST",
      body: { type: "candleSnapshot", req: { coin, interval, startTime: from, endTime: endMs - 1 } },
      timeoutMs: 12_000,
    });
    const got = parseHlCandles(raw);
    out = mergeCandles(out, got);
    // HL returns at most ~5000 bars (and only the most recent 5000 exist): stop on a short page.
    const last = got.at(-1);
    if (!last || got.length < HL_MAX_CANDLES || last.t + step >= endMs) break;
    from = last.t + step;
  }
  return out.filter((c) => c.t >= startMs && c.t < endMs);
}

/** Hyperliquid `fundingHistory`, paged forward (500 rows per page). */
export async function fetchHlFunding(
  http: Http,
  coin: string,
  startMs: number,
  endMs: number,
  opts: { url?: string; maxPages?: number } = {}
): Promise<FundingPoint[]> {
  const out = new Map<number, FundingPoint>();
  let from = startMs;
  for (let page = 0; page < (opts.maxPages ?? 12) && from <= endMs; page++) {
    const raw = await http.json<RawFunding[]>(opts.url ?? HL_INFO_URL, {
      method: "POST",
      body: { type: "fundingHistory", coin, startTime: from, endTime: endMs },
      timeoutMs: 12_000,
    });
    const rows = Array.isArray(raw) ? raw : [];
    for (const p of parseHlFunding(rows)) out.set(p.time, p);
    const last = rows.at(-1);
    if (!last || rows.length < HL_FUNDING_PAGE) break;
    from = last.time + 1;
  }
  return [...out.values()].filter((p) => p.time >= startMs && p.time <= endMs).sort((a, b) => a.time - b.time);
}

export const GECKOTERMINAL_URL = "https://api.geckoterminal.com/api/v2";

const GECKO_TIMEFRAME: Record<CandleInterval, [timeframe: "minute" | "hour" | "day", aggregate: number]> = {
  "1m": ["minute", 1],
  "5m": ["minute", 5],
  "15m": ["minute", 15],
  "1h": ["hour", 1],
  "4h": ["hour", 4],
  "1d": ["day", 1],
};

/**
 * Thrown when a backwards-paged fetch got some pages and then failed (e.g. a 429).
 * `items` holds the newest bars that did arrive; callers may use them as a shorter history.
 */
export class PartialHistoryError extends Error {
  readonly items: Candle[];
  constructor(message: string, items: Candle[]) {
    super(message);
    this.name = "PartialHistoryError";
    this.items = items;
  }
}

/**
 * GeckoTerminal pool OHLCV in USD for `token` (a mint), paged backwards (1000 bars per page).
 * If a later page fails, throws PartialHistoryError with the bars fetched so far.
 */
export async function fetchGeckoOhlcv(
  http: Http,
  pool: string,
  token: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number,
  opts: { url?: string; maxPages?: number } = {}
): Promise<Candle[]> {
  const [tf, agg] = GECKO_TIMEFRAME[interval];
  const base = opts.url ?? GECKOTERMINAL_URL;
  let out: Candle[] = [];
  let before = Math.floor(endMs / 1000);
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const url = `${base}/networks/solana/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=1000&currency=usd&token=${token}&before_timestamp=${before}`;
    let got: Candle[];
    try {
      got = parseGeckoOhlcv(await http.json(url, { timeoutMs: 12_000, retries: 1, headers: { accept: "application/json;version=20230302" } }));
    } catch (e) {
      if (!out.length) throw e;
      throw new PartialHistoryError(`geckoterminal: stopped after ${page} pages: ${(e as Error).message}`, out.filter((c) => c.t >= startMs && c.t < endMs));
    }
    out = mergeCandles(out, got);
    const first = got[0];
    if (!first || got.length < 1000 || first.t <= startMs) break;
    before = Math.floor(first.t / 1000) - 1;
  }
  return out.filter((c) => c.t >= startMs && c.t < endMs);
}

/** Deepest Solana pool where `mint` is the base token: DexScreener first, then GeckoTerminal. */
export async function resolveSolanaPool(http: Http, mint: string, opts: { dexscreenerUrl?: string; geckoUrl?: string } = {}): Promise<string | null> {
  try {
    const r = await http.json<RawDexPair[] | { pairs?: RawDexPair[] }>(`${opts.dexscreenerUrl ?? DEXSCREENER_URL}/tokens/v1/solana/${mint}`, { ttlMs: 10 * 60_000 });
    const pairs = (Array.isArray(r) ? r : (r.pairs ?? [])).filter((p) => p.chainId === "solana" && p.baseToken?.address === mint && p.pairAddress);
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (pairs[0]) return pairs[0].pairAddress;
  } catch {
    // fall through to GeckoTerminal
  }
  const g = await http.json<{ data?: { attributes?: { address?: string; reserve_in_usd?: string }; relationships?: { base_token?: { data?: { id?: string } } } }[] }>(
    `${opts.geckoUrl ?? GECKOTERMINAL_URL}/networks/solana/tokens/${mint}/pools?page=1`,
    { ttlMs: 10 * 60_000, headers: { accept: "application/json;version=20230302" } }
  );
  const pools = (g.data ?? [])
    .filter((p) => p.relationships?.base_token?.data?.id === `solana_${mint}` && p.attributes?.address)
    .sort((a, b) => (num(b.attributes?.reserve_in_usd) ?? 0) - (num(a.attributes?.reserve_in_usd) ?? 0));
  return pools[0]?.attributes?.address ?? null;
}

/* ------------------------------------------------------------------ */
/* Provider with a merged-range cache                                    */
/* ------------------------------------------------------------------ */

interface CacheEntry<T> {
  from: number;
  to: number;
  items: T[];
  /** When `to` was last extended to "now". */
  refreshedAt: number;
}

export interface VenueHistoryOptions {
  hyperliquidUrl?: string;
  geckoUrl?: string;
  dexscreenerUrl?: string;
  /** Don't re-fetch the newest bars of a series more often than this. Default 60 s. */
  tailRefreshMs?: number;
  now?: () => number;
}

/** Live history provider over Hyperliquid + GeckoTerminal. Resolves spot coins through VenueMarketData. */
export class VenueHistory implements HistoryProvider {
  private readonly http: Http;
  private readonly md: VenueMarketData | null;
  private readonly opts: VenueHistoryOptions;
  private readonly candleCache = new Map<string, CacheEntry<Candle>>();
  private readonly fundingCache = new Map<string, CacheEntry<FundingPoint>>();
  private readonly pools = new Map<string, string | null>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(http: Http, md: VenueMarketData | null = null, opts: VenueHistoryOptions = {}) {
    this.http = http;
    this.md = md;
    this.opts = opts;
  }

  unsupportedReason(i: Instrument): string | null {
    switch (i.kind) {
      case "perp":
      case "token":
        return null;
      case "spot":
        return this.md ? null : "spot coin resolution needs market data";
      case "outcome":
        if (i.venue !== "hyperliquid") return "Prediction-market price history is only available for Hyperliquid outcomes";
        return this.md ? null : "Prediction-market history needs market data";
      case "option":
        return "Options price history isn't available yet";
    }
  }

  async candles(i: Instrument, interval: CandleInterval, startMs: number, endMs: number): Promise<CandleSeries> {
    const reason = this.unsupportedReason(i);
    if (reason) throw new Error(reason);
    const key = instrumentKey(i);
    const { source, fetcher } = await this.candleSource(i, interval);
    const items = await this.cached(this.candleCache, `${source}|${interval}`, startMs, endMs, fetcher, (c) => c.t, INTERVAL_MS[interval]);
    return { instrumentKey: key, interval, source, candles: items.filter((c) => c.t >= startMs && c.t < endMs) };
  }

  async funding(i: Instrument, startMs: number, endMs: number): Promise<FundingPoint[]> {
    if (i.kind !== "perp") return [];
    const coin = perpCoin(i.symbol, i.dex);
    const items = await this.cached(
      this.fundingCache,
      coin,
      startMs,
      endMs,
      (from, to) => fetchHlFunding(this.http, coin, from, to, { url: this.opts.hyperliquidUrl }),
      (p) => p.time,
      3_600_000
    );
    return items.filter((p) => p.time >= startMs && p.time <= endMs);
  }

  /** The Hyperliquid coin that streams this instrument's trades and candles over the websocket, if any. */
  async liveCoin(i: Instrument): Promise<string | null> {
    switch (i.kind) {
      case "perp":
        return perpCoin(i.symbol, i.dex);
      case "spot":
        return this.md ? (await this.md.spotMarket(i.symbol)).coin : null;
      case "outcome":
        return i.venue === "hyperliquid" && this.md ? (await this.md.hlOutcome(i)).side.coin : null;
      default:
        return null;
    }
  }

  private async candleSource(i: Instrument, interval: CandleInterval): Promise<{ source: string; fetcher: (from: number, to: number) => Promise<Candle[]> }> {
    const hl = (coin: string) => ({
      source: `hyperliquid:${coin}`,
      fetcher: (from: number, to: number) => fetchHlCandles(this.http, coin, interval, from, to, { url: this.opts.hyperliquidUrl }),
    });
    switch (i.kind) {
      case "perp":
        return hl(perpCoin(i.symbol, i.dex));
      case "spot": {
        const m = await this.md!.spotMarket(i.symbol);
        return hl(m.coin);
      }
      case "outcome":
        return hl((await this.md!.hlOutcome(i)).side.coin);
      case "token": {
        let pool = this.pools.get(i.mint);
        if (pool === undefined) {
          pool = await resolveSolanaPool(this.http, i.mint, { dexscreenerUrl: this.opts.dexscreenerUrl, geckoUrl: this.opts.geckoUrl });
          this.pools.set(i.mint, pool);
        }
        if (!pool) throw new Error(`no Solana pool found for ${i.mint}`);
        const p = pool;
        return {
          source: `geckoterminal:${p}`,
          fetcher: (from, to) => fetchGeckoOhlcv(this.http, p, i.mint, interval, from, to, { url: this.opts.geckoUrl }),
        };
      }
      default:
        throw new Error(`no history for ${i.kind}`);
    }
  }

  /**
   * Range cache: fetch only what's missing in front of / behind what we hold. The newest
   * bars (still forming) are refreshed at most every `tailRefreshMs`. Calls per key are
   * serialized so concurrent backtests share one fetch.
   */
  private async cached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    start: number,
    end: number,
    fetcher: (from: number, to: number) => Promise<T[]>,
    tOf: (x: T) => number,
    step: number
  ): Promise<T[]> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const now = (this.opts.now ?? Date.now)();
      const tailMs = this.opts.tailRefreshMs ?? 60_000;
      const merge = (a: T[], b: T[]) => {
        const m = new Map<number, T>();
        for (const x of a) m.set(tOf(x), x);
        for (const x of b) m.set(tOf(x), x);
        return [...m.values()].sort((x, y) => tOf(x) - tOf(y));
      };
      // A partial (backwards-paged) result covers only from its oldest bar on, so the
      // missing older part is fetched again next time.
      const fetchRange = async (from: number, to: number): Promise<{ items: T[]; from: number }> => {
        try {
          return { items: await fetcher(from, to), from };
        } catch (err) {
          if (!(err instanceof PartialHistoryError)) throw err;
          const items = err.items as unknown as T[];
          return { items, from: items.length ? tOf(items[0]!) : to };
        }
      };
      let e = cache.get(key);
      if (!e) {
        const r = await fetchRange(start, end);
        e = { from: r.from, to: end, items: r.items, refreshedAt: now };
        cache.set(key, e);
        return e.items;
      }
      if (start < e.from) {
        try {
          const r = await fetchRange(start, e.from);
          e.items = merge(r.items, e.items);
          e.from = r.from;
        } catch {
          // keep what we have: a shorter history beats none
        }
      }
      if (end > e.to && (end - e.to > step || now - e.refreshedAt > tailMs)) {
        // Re-fetch from one bar before the cached end: that bar may have been incomplete.
        try {
          const r = await fetchRange(Math.max(e.from, e.to - step), end);
          e.items = merge(e.items, r.items);
          e.to = end;
          e.refreshedAt = now;
        } catch (err) {
          if (end - e.to > 6 * step) throw err; // too stale to serve
        }
      }
      return e.items;
    });
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }
}
