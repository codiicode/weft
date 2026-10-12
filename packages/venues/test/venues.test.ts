import { describe, expect, it } from "vitest";
import { SIGNAL_KINDS, instrumentKey, type Instrument, type Signal, type SignalKind } from "@weft/strategy";
import { createVenues } from "../src/index.ts";
import { cleanSymbol, tokenListing, tokenSearchRank } from "../src/catalog.ts";
import { estimateDepth2pct, candleChanges } from "../src/signals/market.ts";
import { fixture, fixtureRouter, mockFetch, FRESH_MINT, JUP_MINT, NOW } from "./helpers.ts";

function venues() {
  const fetch = mockFetch(fixtureRouter);
  return { v: createVenues({ fetch, now: () => NOW, retries: 0 }), fetch };
}

const btc: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" };
const nvda: Instrument = { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" };
const hype: Instrument = { kind: "spot", venue: "hyperliquid", symbol: "HYPE/USDC", assetClass: "crypto" };
const jup: Instrument = { kind: "token", chain: "solana", mint: JUP_MINT, symbol: "JUP", quote: "USDC", route: "auto", assetClass: "crypto" };
const fedHold: Instrument = { kind: "outcome", venue: "hyperliquid", market: "3600", outcome: "YES" };
const lol: Instrument = { kind: "outcome", venue: "jupiter", market: "POLY-5430457-0", outcome: "YES" };
const ethPut: Instrument = { kind: "option", venue: "deribit", underlying: "ETH", expiry: "2026-10-16", strike: 2800, right: "put" };

describe("MarketData.getQuote", () => {
  it("perp: mid from allMids; size-aware from l2Book", async () => {
    const { v } = venues();
    const q = await v.marketData.getQuote(btc);
    expect(q).toMatchObject({ instrumentKey: "hl:perp:BTC", price: Number(fixture("hl_allMids.json").BTC), source: "hyperliquid:allMids" });
    const s = await v.marketData.getQuote(btc, { side: "buy", sizeUsd: 100_000 });
    expect(s).toMatchObject({ price: 82720.5, bid: 82720, ask: 82721, fillPrice: 82721, depthExhausted: false });
    expect(s.priceImpactBps).toBeCloseTo((0.5 / 82720.5) * 1e4, 6);
  });

  it("HIP-3 perp and spot resolve their coins", async () => {
    const { v, fetch } = venues();
    expect((await v.marketData.getQuote(nvda)).price).toBe(Number(fixture("hl_allMids_xyz.json")["xyz:NVDA"]));
    expect(fetch.calls.some((c) => c.body?.type === "allMids" && c.body.dex === "xyz")).toBe(true);
    const h = await v.marketData.getQuote(hype, { side: "sell", sizeUsd: 1_000 });
    expect(h.instrumentKey).toBe("hl:spot:HYPE/USDC");
    expect(fetch.calls.some((c) => c.body?.type === "l2Book" && c.body.coin === "@107")).toBe(true);
    expect(h.fillPrice).toBeLessThan(h.price);
  });

  it("token: Jupiter price v3, router quote for size", async () => {
    const { v } = venues();
    const q = await v.marketData.getQuote(jup);
    expect(q.price).toBe(0.35272529155082416);
    const s = await v.marketData.getQuote(jup, { side: "buy", sizeUsd: 1_000 });
    expect(s.fillPrice).toBeGreaterThan(q.price);
    expect(s.priceImpactBps).toBeGreaterThan(0);
    expect(s.source).toMatch(/^jupiter:swap\/v1\/quote/);
  });

  it("outcomes: HIP-4 mids and Jupiter prediction book", async () => {
    const { v } = venues();
    expect((await v.marketData.getQuote(fedHold)).price).toBe(0.834705);
    const j = await v.marketData.getQuote(lol, { side: "buy", sizeUsd: 10 });
    expect(j).toMatchObject({ price: 0.825, bid: 0.82, ask: 0.83, fillPrice: 0.82, source: "jupiter:prediction/orderbook" });
    await expect(v.marketData.getQuote({ ...fedHold, market: "elnino-djf-2026" })).rejects.toThrow(/cannot resolve/);
  });

  it("options: Deribit premium in USD (inverse × index) and book walk", async () => {
    const { v } = venues();
    const t = fixture("deribit_ticker.json").result;
    const q = await v.marketData.getQuote(ethPut);
    expect(q.price).toBeCloseTo(t.mark_price * t.index_price, 9);
    expect(q.bid).toBeCloseTo(t.best_bid_price * t.index_price, 9);
    const s = await v.marketData.getQuote(ethPut, { side: "buy", sizeUsd: 1_000 });
    expect(s.fillPrice).toBeCloseTo(0.1135 * fixture("deribit_book.json").result.index_price, 9);
    const d = await v.marketData.getQuote({ ...ethPut, venue: "derive" });
    expect(d.price).toBe(87.2);
    expect(d.source).toBe("derive:ETH-20261016-2800-P");
  });

  it("getQuotes batches one allMids per dex and one price call for tokens", async () => {
    const { v, fetch } = venues();
    const m = await v.marketData.getQuotes([btc, { ...btc, symbol: "ETH" }, nvda, jup]);
    expect([...m.keys()].sort()).toEqual(["hl:perp:BTC", "hl:perp:ETH", "hl:perp:xyz:NVDA", `sol:token:${JUP_MINT}`].sort());
    expect(fetch.calls.filter((c) => c.body?.type === "allMids")).toHaveLength(2);
    expect(fetch.calls.filter((c) => c.url.includes("/price/v3"))).toHaveLength(1);
  });
});

describe("Catalog", () => {
  it("perps: core, delisted excluded, sorted by volume", async () => {
    const { v } = venues();
    const rows = await v.catalog.list("perps");
    expect(rows.map((r) => r.label)).toEqual(["BTC", "ETH", "SOL"]);
    expect(rows[0]).toMatchObject({ product: "perps", venue: "hyperliquid", maxLeverage: 40, instrumentKey: "hl:perp:BTC" });
    expect(rows[0]!.fundingHourlyPct).toBeCloseTo(0.00098673, 9);
  });

  it("stocks: HIP-3 non-crypto across dexes + verified xStocks", async () => {
    const { v } = venues();
    const rows = await v.catalog.list("stocks", { limit: 100 });
    const keys = rows.map((r) => r.instrumentKey);
    expect(keys).toContain("hl:perp:xyz:NVDA");
    expect(keys).toContain("hl:perp:xyz:GOLD");
    expect(keys).not.toContain("hl:perp:hyna:GOLD"); // hyna markets are delisted in the fixture
    const x = rows.find((r) => r.instrument.kind === "token")!;
    expect(x.instrument).toMatchObject({ kind: "token", symbol: "NVDAx", assetClass: "equity", quote: "USDC" });
    const vols = rows.map((r) => r.volume24hUsd ?? 0);
    expect([...vols].sort((a, b) => b - a)).toEqual(vols);
    const nvidia = await v.catalog.list("stocks", { search: "nvidia" });
    expect(nvidia.map((r) => r.instrumentKey)).toEqual(expect.arrayContaining(["hl:perp:xyz:NVDA", "sol:token:Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"]));
  });

  it("predictions: HIP-4 + Jupiter, expired outcomes dropped", async () => {
    const { v } = venues();
    const rows = await v.catalog.list("predictions", { limit: 100 });
    const hl = rows.filter((r) => r.venue === "hyperliquid");
    const jp = rows.filter((r) => r.venue === "jupiter");
    expect(hl.length).toBeGreaterThan(5);
    expect(jp.length).toBe(7);
    const fed = hl.find((r) => r.instrumentKey === "hl:outcome:3600:YES")!;
    expect(fed.label).toBe("Federal Reserve's Open Market Committee October 2026 decision: no change? · YES");
    expect(fed.price).toBe(0.834705);
    const rams = hl.find((r) => r.instrumentKey === "hl:outcome:8565:LAR")!;
    expect(rams.meta?.otherSide).toBe("BUF");
    const single = jp.find((r) => r.instrumentKey === "jup:outcome:POLY-2589812:YES")!;
    expect(single.label).toBe("Fed Decision in October? · No change · YES");
    expect(single.price).toBeCloseTo(0.835, 12);
  });

  it("tokens: trending list, $ stripped from symbols, exact-symbol search first", async () => {
    const { v } = venues();
    const rows = await v.catalog.list("tokens");
    expect(rows[0]!.label).toBe("$PUMP");
    expect(rows.every((r) => r.instrument.kind === "token")).toBe(true);
    const base = fixture("jup_token_jup.json")[0];
    const wif = { ...base, symbol: "$WIF", id: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", liquidity: 6e6 };
    const cat = { ...base, symbol: "$swordcat", liquidity: 9e6 };
    const l = tokenListing(wif, "tokens");
    expect(l.label).toBe("$WIF");
    expect(l.instrument).toMatchObject({ symbol: "WIF" });
    expect(cleanSymbol("$$X")).toBe("X");
    expect(tokenSearchRank(wif, "WIF")).toBeGreaterThan(tokenSearchRank(cat, "WIF"));
    expect(tokenSearchRank(wif, "$wif")).toBeGreaterThan(tokenSearchRank(cat, "$wif"));
  });

  it("options: BTC/ETH/SOL, near-the-money, labelled", async () => {
    const { v } = venues();
    const rows = await v.catalog.list("options");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.venue === "deribit" && r.instrument.kind === "option")).toBe(true);
    const put = rows.find((r) => r.label === "ETH 2026-10-16 2800P")!;
    expect(put.instrumentKey).toBe(instrumentKey(ethPut));
    expect(rows.some((r) => r.label.startsWith("SOL "))).toBe(true);
    expect(rows.some((r) => r.label === "SOL 2026-11-27 154P")).toBe(false); // 39% from spot: filtered
  });
});

describe("Signal providers", () => {
  const sig = (kind: SignalKind, params: unknown) => ({ id: `s_${kind}`, kind, params }) as Signal;
  const cases: [SignalKind, unknown][] = [
    ["price", { instrument: btc }],
    ["funding", { instrument: { ...btc, symbol: "SOL" } }],
    ["liquidity", { instrument: btc }],
    ["odds", { instrument: fedHold }],
    ["token_onchain", { mint: JUP_MINT }],
    ["forecast", { source: "noaa_cpc", series: "nino34_anomaly" }],
    ["macro", { series: "USDBRL" }],
    ["calendar", { event: "fomc" }],
    ["social", { platform: "x", cashtags: ["PUMP"], keywords: [], accounts: [] }],
    ["post_match", { accounts: ["@fed"], claim: "rates will be cut" }],
    ["news", { query: "wheat" }],
    ["model", { question: "Will the Fed hold in October?", instrument: fedHold }],
  ];

  it.each(cases)("%s produces exactly the declared fields", async (kind, params) => {
    const { v } = venues();
    const snap = await v.signals.fetch(sig(kind, params), NOW);
    expect(snap, kind).not.toBeNull();
    expect(snap!.asOf).toBe(NOW);
    expect(Object.keys(snap!.fields).sort()).toEqual(Object.keys(SIGNAL_KINDS[kind].fields).sort());
    for (const [f, t] of Object.entries(SIGNAL_KINDS[kind].fields)) {
      const val = snap!.fields[f];
      if (val != null) expect(typeof val, `${kind}.${f}`).toBe(t);
    }
  });

  it("modes: market data live, social/news/post_match/model simulated, position not handled", async () => {
    const { v } = venues();
    expect(v.signals.modeOf("price")).toBe("live");
    expect(v.signals.modeOf("calendar")).toBe("live");
    for (const k of ["social", "news", "post_match", "model"] as const) expect(v.signals.modeOf(k)).toBe("simulated");
    expect(v.signals.providerFor("position")).toBeUndefined();
    expect(await v.signals.fetch(sig("position", {}), NOW)).toBeNull();
  });

  it("values: price candles, funding math, odds, forecast, macro", async () => {
    const { v } = venues();
    const p = (await v.signals.fetch(sig("price", { instrument: btc }), NOW))!.fields;
    expect(p.price).toBe(Number(fixture("hl_allMids.json").BTC));
    expect(p.change_1h_pct).not.toBeNull();
    expect(p.volume_24h_usd).toBeCloseTo(2068230100.570289, 3);
    const f = (await v.signals.fetch(sig("funding", { instrument: { ...btc, symbol: "SOL" } }), NOW))!.fields;
    expect(f.rate_1h_pct).toBeCloseTo(0.00125, 12);
    expect(f.rate_8h_pct).toBeCloseTo(0.01, 12);
    expect(f.apr_pct).toBeCloseTo(10.95, 9);
    expect(f.oi_zscore_30d).toBeNull();
    const o = (await v.signals.fetch(sig("odds", { instrument: fedHold }), NOW))!.fields;
    expect(o.prob).toBe(0.834705);
    expect(o.change_24h_pp).toBeCloseTo(-0.7465, 9);
    const n = (await v.signals.fetch(sig("forecast", { source: "noaa_cpc", series: "nino34_anomaly" }), NOW))!.fields;
    expect(n).toEqual({ value: 3.3, change_7d: 0.1 });
    expect(await v.signals.fetch(sig("forecast", { source: "ecmwf", series: "x" }), NOW)).toBeNull();
    const fx = (await v.signals.fetch(sig("macro", { series: "USDBRL" }), NOW))!.fields;
    expect(fx.value).toBe(5.005);
    expect(fx.change_1d).toBeCloseTo(5.005 - 5.0168, 9);
    expect(fx.change_5d).toBeCloseTo(5.005 - 5.2214, 9);
    const us2y = (await v.signals.fetch(sig("macro", { series: "US2Y" }), NOW))!.fields;
    expect(us2y.value).toBe(4.75);
    const jo = (await v.signals.fetch(sig("odds", { instrument: lol }), NOW))!.fields;
    expect(jo.prob).toBe(0.825);
  });

  it("never throws: unknown instruments give null", async () => {
    const { v } = venues();
    expect(await v.signals.fetch(sig("price", { instrument: { ...btc, symbol: "NOPE" } }), NOW)).toBeNull();
    expect(await v.signals.fetch(sig("odds", { instrument: { ...fedHold, market: "fomc-dec-2026-cut" } }), NOW)).toBeNull();
  });

  it("candle changes and token depth estimate", () => {
    const { now, candles } = fixture("hl_candles_btc_1m.json");
    const last = Number(candles.at(-1).c);
    const ch = candleChanges(candles, last, now);
    expect(ch.change_5m_pct).not.toBeNull();
    expect(estimateDepth2pct(10, 10, 5e6)).toBe(5e6); // flat impact → capped at pool liquidity
    expect(estimateDepth2pct(10, 34, null)).toBeCloseTo((200 - 9) / 0.001, 6); // a=9, b=0.001/$
    expect(estimateDepth2pct(400, null, 1e6)).toBe(500);
    expect(estimateDepth2pct(null, null, null)).toBeNull();
  });
});

describe("TokenFacts", () => {
  it("JUP: facts + price impact for the order size", async () => {
    const { v } = venues();
    const f = (await v.tokenFacts.getTokenFacts(JUP_MINT, { sizeUsd: 1_000 }))!;
    expect(f.mint_authority_revoked).toBe(true);
    expect(f.freeze_authority_revoked).toBe(true);
    expect(f.top10_holders_pct).toBeCloseTo(15.4485, 3);
    expect(f.price_impact_bps).toBeGreaterThan(0);
    expect(f.unknown).toEqual(["dev_sold_pct"]);
  });

  it("fresh token without liquidity data falls back to DexScreener, never throws", async () => {
    const { v } = venues();
    const f = await v.tokenFacts.getTokenFacts(FRESH_MINT);
    expect(f).not.toBeNull();
    expect(f!.price_impact_bps).toBeUndefined();
  });

  it("returns null when no source knows the token", async () => {
    const fetch = mockFetch((url, body) => (url.includes("dexscreener") ? [] : fixtureRouter(url, body)));
    const v = createVenues({ fetch, now: () => NOW, retries: 0 });
    expect(await v.tokenFacts.getTokenFacts("11111111111111111111111111111111")).toBeNull();
  });
});
