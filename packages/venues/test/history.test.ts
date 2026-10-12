import { describe, expect, it } from "vitest";
import { Http } from "../src/http.ts";
import {
  VenueHistory,
  fetchGeckoOhlcv,
  fetchHlCandles,
  fetchHlFunding,
  parseGeckoOhlcv,
  parseHlCandles,
  parseHlFunding,
  resolveSolanaPool,
} from "../src/history.ts";
import { createVenues } from "../src/index.ts";
import { fixture, fixtureRouter, mockFetch } from "./helpers.ts";

const H = 3_600_000;
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const WIF_POOL = "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx";

const btc = fixture<{ start: number; end: number; candles: any[] }>("hl_candles_btc_1h.json");
const btcFunding = fixture<{ start: number; end: number; funding: any[] }>("hl_funding_btc.json");
const nvda = fixture<{ start: number; end: number; candles: any[] }>("hl_candles_nvda_1h.json");
const gt = fixture("gt_ohlcv_wif_hour.json");
const gtPools = fixture("gt_pools_wif.json");

const http = (router: Parameters<typeof mockFetch>[0]) => {
  const f = mockFetch(router);
  return { f, http: new Http({ fetch: f, retries: 0, sleep: async () => {} }) };
};

/** Serves the recorded candles filtered to the requested window (like the real endpoint). */
const hlRouter = (url: string, body: any) => {
  if (!url.includes("hyperliquid")) return undefined;
  if (body?.type === "candleSnapshot") {
    const src = body.req.coin === "xyz:NVDA" ? nvda.candles : btc.candles;
    return src.filter((c) => c.t >= body.req.startTime && c.t <= body.req.endTime);
  }
  if (body?.type === "fundingHistory") return btcFunding.funding.filter((p) => p.time >= body.startTime && p.time <= (body.endTime ?? Infinity));
  return undefined;
};

describe("history parsers", () => {
  it("parses Hyperliquid candles with USD volume", () => {
    const c = parseHlCandles(btc.candles);
    expect(c).toHaveLength(btc.candles.length);
    const first = c[0]!;
    expect(first.c).toBe(Number(btc.candles[0].c));
    expect(first.volUsd).toBeCloseTo(Number(btc.candles[0].v) * Number(btc.candles[0].c), 3);
  });

  it("snaps funding timestamps to the minute", () => {
    const f = parseHlFunding(btcFunding.funding);
    expect(f.length).toBe(btcFunding.funding.length);
    expect(f.every((p) => p.time % 60_000 === 0)).toBe(true);
    expect(f[0]!.rate).toBe(Number(btcFunding.funding[0].fundingRate));
  });

  it("parses GeckoTerminal OHLCV oldest first, in ms", () => {
    const c = parseGeckoOhlcv(gt);
    expect(c.length).toBe(48);
    expect(c[0]!.t).toBeLessThan(c.at(-1)!.t);
    expect(c[0]!.t % 1000).toBe(0);
    expect(c.at(-1)!.volUsd).toBeGreaterThan(0);
  });
});

describe("raw fetchers", () => {
  it("fetches HL candles for a HIP-3 coin and clips to [start, end)", async () => {
    const { http: h, f } = http(hlRouter);
    const c = await fetchHlCandles(h, "xyz:NVDA", "1h", nvda.start + 2 * H, nvda.end);
    expect(c[0]!.t).toBe(nvda.start + 2 * H);
    expect(c.every((x) => x.t < nvda.end)).toBe(true);
    expect(f.calls[0]!.body).toMatchObject({ type: "candleSnapshot", req: { coin: "xyz:NVDA", interval: "1h" } });
  });

  it("pages HL funding in 500-row pages", async () => {
    // A synthetic 1,200-hour history forces three pages.
    const rows = Array.from({ length: 1_200 }, (_, k) => ({ coin: "BTC", fundingRate: String(k * 1e-7), time: k * H + 7 }));
    const { http: h, f } = http((_u, body) => rows.filter((r) => r.time >= body.startTime && r.time <= body.endTime).slice(0, 500));
    const out = await fetchHlFunding(h, "BTC", 0, 1_200 * H);
    expect(out).toHaveLength(1_200);
    expect(f.calls).toHaveLength(3);
    expect(out[1]!.time).toBe(H);
  });

  it("pages GeckoTerminal backwards with before_timestamp", async () => {
    const all = Array.from({ length: 2_500 }, (_, k) => [k * 3600, 1, 1, 1, 1 + k / 1e4, 100]);
    const { http: h, f } = http((url) => {
      const before = Number(new URL(url).searchParams.get("before_timestamp"));
      const rows = all.filter((r) => r[0]! <= before).reverse().slice(0, 1_000);
      return { data: { attributes: { ohlcv_list: rows } } };
    });
    const out = await fetchGeckoOhlcv(h, WIF_POOL, WIF, "1h", 100 * H, 2_400 * H);
    expect(out[0]!.t).toBe(100 * H);
    expect(out.at(-1)!.t).toBe(2_399 * H);
    expect(f.calls.length).toBe(3);
    expect(f.calls[0]!.url).toContain(`/pools/${WIF_POOL}/ohlcv/hour?aggregate=1`);
    expect(f.calls[0]!.url).toContain(`token=${WIF}`);
  });

  it("resolves a token's pool from DexScreener, falling back to GeckoTerminal", async () => {
    const dex = http((url) => (url.includes("dexscreener") ? fixture("dexscreener_jup.json") : undefined));
    const jup = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    expect(await resolveSolanaPool(dex.http, jup)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    const gecko = http((url) => (url.includes("dexscreener") ? [] : url.includes("geckoterminal") ? gtPools : undefined));
    expect(await resolveSolanaPool(gecko.http, WIF)).toBe(WIF_POOL);
  });
});

describe("VenueHistory", () => {
  it("serves perps from Hyperliquid and caches merged ranges", async () => {
    let now = btc.end;
    const { http: h, f } = http(hlRouter);
    const hist = new VenueHistory(h, null, { now: () => now });
    const perp = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" } as const;

    const a = await hist.candles(perp, "1h", btc.start + 48 * H, btc.end);
    expect(a.instrumentKey).toBe("hl:perp:BTC");
    expect(a.candles).toHaveLength(72);
    expect(f.calls).toHaveLength(1);

    // Same window again: cache hit.
    await hist.candles(perp, "1h", btc.start + 48 * H, btc.end);
    expect(f.calls).toHaveLength(1);

    // Wider window: only the missing head is fetched.
    const b = await hist.candles(perp, "1h", btc.start, btc.end);
    expect(b.candles).toHaveLength(120);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.body.req.startTime).toBe(btc.start);

    // Funding works for perps, is empty for others.
    const fund = await hist.funding(perp, btc.start, btc.end);
    expect(fund.length).toBeGreaterThan(100);
    expect(await hist.funding({ kind: "spot", venue: "hyperliquid", symbol: "HYPE/USDC", assetClass: "crypto" }, btc.start, btc.end)).toEqual([]);
    now += 1;
  });

  it("keeps the newest GeckoTerminal pages when an older page is rate limited", async () => {
    const all = Array.from({ length: 2_500 }, (_, k) => [k * 3600, 1, 1, 1, 1, 100]);
    let pages = 0;
    const { http: h } = http((url) => {
      if (url.includes("dexscreener")) return [{ chainId: "solana", pairAddress: WIF_POOL, baseToken: { address: WIF }, liquidity: { usd: 1 } }];
      if (++pages > 1) return { status: 429, body: "slow down" };
      const before = Number(new URL(url).searchParams.get("before_timestamp"));
      return { data: { attributes: { ohlcv_list: all.filter((r) => r[0]! <= before).reverse().slice(0, 1_000) } } };
    });
    const hist = new VenueHistory(h, null, { now: () => 2_500 * H });
    const token = { kind: "token", chain: "solana", mint: WIF, quote: "SOL", route: "auto", assetClass: "crypto" } as const;
    const s = await hist.candles(token, "1h", 0, 2_500 * H);
    expect(s.candles).toHaveLength(1_000);
    expect(s.candles[0]!.t).toBe(1_500 * H);
  });

  it("reports unsupported products", () => {
    const hist = new VenueHistory(new Http(), null);
    expect(hist.unsupportedReason({ kind: "outcome", venue: "hyperliquid", market: "1", outcome: "YES" })).toMatch(/Prediction-market/);
    expect(hist.unsupportedReason({ kind: "option", venue: "deribit", underlying: "ETH", expiry: "2026-12-25", strike: 5000, right: "call" })).toMatch(/Options/);
    expect(hist.unsupportedReason({ kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" })).toBeNull();
  });

  it("serves Solana tokens from GeckoTerminal via createVenues", async () => {
    const f = mockFetch((url, body) => {
      if (url.includes("dexscreener")) return [];
      if (url.includes("/tokens/") && url.includes("geckoterminal")) return gtPools;
      if (url.includes("/ohlcv/")) return gt;
      return fixtureRouter(url, body);
    });
    const v = createVenues({ fetch: f, retries: 0 });
    const end = parseGeckoOhlcv(gt).at(-1)!.t;
    const s = await v.history.candles({ kind: "token", chain: "solana", mint: WIF, quote: "SOL", route: "auto", assetClass: "crypto" }, "1h", end - 24 * H, end);
    expect(s.source).toBe(`geckoterminal:${WIF_POOL}`);
    expect(s.candles).toHaveLength(24);
    expect(s.candles.at(-1)!.t).toBe(end - H);
  });
});
