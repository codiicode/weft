import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "../src/http.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixtureText(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

export function fixture<T = any>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export type RouteResult = { status?: number; body: unknown; headers?: Record<string, string> } | string | object | undefined;
export type Router = (url: string, body: any) => RouteResult;

/** A fetch that never touches the network: routes by URL (and JSON body) to fixtures. */
export function mockFetch(router: Router): FetchFn & { calls: { url: string; body: any }[] } {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const r = router(url, body);
    if (r === undefined) return new Response(`no fixture for ${url} ${JSON.stringify(body ?? "")}`, { status: 404 });
    if (typeof r === "object" && r !== null && "body" in r && ("status" in r || "headers" in r)) {
      const rr = r as { status?: number; body: unknown; headers?: Record<string, string> };
      return new Response(typeof rr.body === "string" ? rr.body : JSON.stringify(rr.body), { status: rr.status ?? 200, headers: rr.headers });
    }
    return new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200 });
  }) as FetchFn & { calls: { url: string; body: any }[] };
  fn.calls = calls;
  return fn;
}

export const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
export const FRESH_MINT = "EMfPZndupU56AimQhnvPoKSXX8fHDgHi6psL6xfNpump";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Fixed clock: the moment the candle fixture was recorded. */
export const NOW: number = fixture("hl_candles_btc_1m.json").now;

/** A simple synthetic book for coins without a recorded l2Book fixture. */
export function syntheticBook(coin: string, mid: number, step: number, sz: number) {
  const lv = (k: number) => ({ px: String(mid + k * step), sz: String(sz), n: 1 });
  return { coin, time: NOW, levels: [[1, 2, 3, 4, 5].map((k) => lv(-k)), [1, 2, 3, 4, 5].map((k) => lv(k))] };
}

/** Routes every venue the package talks to onto the recorded fixtures. */
export const fixtureRouter: Router = (url, body) => {
  const u = new URL(url);
  if (u.host === "api.hyperliquid.xyz") {
    switch (body?.type) {
      case "perpDexs":
        return fixture("hl_perpDexs.json");
      case "metaAndAssetCtxs":
        return fixture(body.dex ? `hl_meta_${body.dex}.json` : "hl_meta_core.json");
      case "allMids":
        return fixture(body.dex ? `hl_allMids_${body.dex}.json` : "hl_allMids.json");
      case "spotMetaAndAssetCtxs":
        return fixture("hl_spot.json");
      case "outcomeMeta":
        return fixture("hl_outcomeMeta.json");
      case "candleSnapshot":
        return body.req.coin === "BTC" ? fixture("hl_candles_btc_1m.json").candles : [];
      case "l2Book":
        if (body.coin === "BTC") return fixture("hl_l2_btc.json");
        if (body.coin === "xyz:NVDA") return syntheticBook("xyz:NVDA", 228.4, 0.01, 50);
        if (body.coin === "@107") return syntheticBook("@107", 85.36, 0.01, 100);
        if (String(body.coin).startsWith("#")) return syntheticBook(body.coin, 0.5, 0.01, 1000);
        return undefined;
    }
    return undefined;
  }
  if (u.host === "lite-api.jup.ag") {
    const p = u.pathname;
    if (p === "/price/v3") return fixture("jup_price.json");
    if (p === "/swap/v1/quote") return fixture(u.searchParams.get("inputMint") === USDC ? "jup_quote_buy.json" : "jup_quote_sell.json");
    if (p === "/tokens/v2/search") {
      const q = u.searchParams.get("query");
      if (q === JUP_MINT || q === "JUP") return fixture("jup_token_jup.json");
      if (q === FRESH_MINT) return fixture("jup_token_fresh.json");
      if (q === "xStock" || q === NVDAX_MINT) return fixture("jup_trending.json");
      return [];
    }
    if (p.startsWith("/tokens/v2/toptrending")) return fixture("jup_trending.json");
    if (p === "/prediction/v1/events") return fixture("jup_pred_events.json");
    if (p.startsWith("/prediction/v1/events/")) return fixture("jup_pred_events.json").data.find((e: any) => p.endsWith(e.eventId));
    if (p.startsWith("/prediction/v1/markets/")) return fixture("jup_pred_market.json");
    if (p.startsWith("/prediction/v1/orderbook/")) return fixture("jup_pred_orderbook.json");
    return undefined;
  }
  if (u.host === "api.dexscreener.com") return fixture("dexscreener_jup.json");
  if (u.host === "api.mainnet-beta.solana.com") return fixture(body?.params?.[0] === NVDAX_MINT ? "solana_mint_xstock.json" : "solana_mint_jup.json");
  if (u.host === "www.deribit.com") {
    const p = u.pathname;
    const cur = u.searchParams.get("currency");
    if (p.endsWith("/get_book_summary_by_currency")) {
      if (cur === "ETH") return fixture("deribit_summary_eth.json");
      if (cur === "USDC") return fixture("deribit_summary_usdc.json");
      return { result: [] };
    }
    if (p.endsWith("/get_instruments")) return cur === "ETH" ? fixture("deribit_instruments_eth.json") : { result: [] };
    if (p.endsWith("/ticker")) return fixture("deribit_ticker.json");
    if (p.endsWith("/get_order_book")) return fixture("deribit_book.json");
    return undefined;
  }
  if (u.host === "api.lyra.finance") return fixture("derive_ticker.json");
  if (u.host === "www.cpc.ncep.noaa.gov") return fixtureText("noaa_wksst9120.for");
  if (u.host === "fred.stlouisfed.org") return fixtureText("fred_dgs2.csv");
  if (u.host === "api.frankfurter.dev") return fixture("frankfurter_usdbrl.json");
  if (u.host === "cointelegraph.com")
    return `<rss><channel><item><title>Bitcoin ETF inflows climb</title><pubDate>${new Date(Date.now() - 600_000).toUTCString()}</pubDate></item></channel></rss>`;
  if (u.host === "api.alternative.me")
    return { data: [{ value: "55", timestamp: "1792195200" }, { value: "63", timestamp: "1792108800" }, { value: "53", timestamp: "1792022400" }, { value: "40", timestamp: "1791936000" }, { value: "35", timestamp: "1791849600" }, { value: "30", timestamp: "1791763200" }] };
  if (u.host === "api.coingecko.com") return { data: { market_cap_percentage: { btc: 59.2979, eth: 10.7245 }, total_market_cap: { usd: 2_759_339_430_723 }, market_cap_change_percentage_24h_usd: -3.4174 } };
  if (u.host === "stablecoins.llama.fi") return [1, 2, 3, 4, 5, 6].map((i) => ({ date: String(1792000000 + i * 86400), totalCirculatingUSD: { peggedUSD: (300 + i) * 1e9 } }));
  if (u.host === "api.llama.fi" && u.pathname.startsWith("/v2/historicalChainTvl/Solana")) return [1, 2, 3, 4, 5, 6].map((i) => ({ date: 1792000000 + i * 86400, tvl: (5.9 + i / 10) * 1e9 }));
  if (u.host === "api.llama.fi" && u.pathname === "/summary/fees/hyperliquid")
    return { totalDataChart: [3.0, 3.2, 3.4, 3.1, 4.4, 3.1].map((v, i) => [1792000000 + i * 86400, (u.searchParams.get("dataType") === "dailyRevenue" ? 0.8 : 1) * v * 1e6]) };
  return undefined;
};
