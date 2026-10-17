import { describe, expect, it } from "vitest";
import { parsePolymarket, polymarketListings, polymarketOutcome } from "../src/polymarket.ts";
import { newsFields, parseFeed, relevance, tone } from "../src/signals/news.ts";
import { otherVenueFunding } from "../src/signals/market.ts";
import { weatherFields } from "../src/signals/external.ts";

describe("Polymarket", () => {
  const m = parsePolymarket({ id: "616902", question: "Fed cut in December?", slug: "fed-cut", outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', oneDayPriceChange: 0.04, volume24hr: 1000, endDate: "2026-12-10T00:00:00Z", active: true, closed: false });

  it("reads outcomes, prices and the 24h change for both sides", () => {
    expect(polymarketOutcome(m, "YES")).toEqual({ name: "Yes", price: 0.62, change24h: 0.04 });
    expect(polymarketOutcome(m, "no")).toEqual({ name: "No", price: 0.38, change24h: -0.04 });
  });

  it("lists open outcomes as watch-only, skipping settled-looking ones", () => {
    const rows = polymarketListings(m);
    expect(rows.map((r) => r.instrumentKey)).toEqual(["pm:outcome:616902:Yes", "pm:outcome:616902:No"]);
    expect(rows[0]!.meta?.watchOnly).toBe(true);
    const settled = parsePolymarket({ id: "1", question: "q", outcomes: '["Yes","No"]', outcomePrices: '["0.995","0.005"]' });
    expect(polymarketListings(settled)).toEqual([]);
  });
});

describe("news", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const xml = `<rss><channel>
    <item><title><![CDATA[Bitcoin ETF inflows surge to a record]]></title><pubDate>Sat, 17 Oct 2026 11:30:00 GMT</pubDate><description>Spot BTC funds</description></item>
    <item><title>SEC sues exchange over Solana listing</title><pubDate>Sat, 17 Oct 2026 08:00:00 GMT</pubDate></item>
    <item><title>Bitcoin slips as traders take profit</title><pubDate>Sat, 17 Oct 2026 01:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml);

  it("parses RSS items", () => {
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toBe("Bitcoin ETF inflows surge to a record");
  });

  it("scores relevance with aliases, tone from a word list", () => {
    expect(relevance(items[0]!, "BTC ETF")).toBe(1);
    expect(relevance(items[1]!, "bitcoin")).toBe(0);
    expect(tone("Bitcoin ETF inflows surge to a record")).toBe(1);
    expect(tone("SEC sues exchange")).toBe(-1);
  });

  it("counts the last hour, looks back six hours for tone and relevance", () => {
    expect(newsFields(items, "bitcoin ETF", now)).toEqual({ articles_1h: 1, sentiment: 1, max_relevance: 1 });
    expect(newsFields(items, "solana", now)).toEqual({ articles_1h: 0, sentiment: -1, max_relevance: 1 });
    expect(newsFields(items, "dogecoin", now)).toEqual({ articles_1h: 0, sentiment: null, max_relevance: 0 });
  });
});

describe("funding on other venues", () => {
  const rows: Parameters<typeof otherVenueFunding>[0] = [
    ["BTC", [["BinPerp", { fundingRate: "0.0001", fundingIntervalHours: 8 }], ["HlPerp", { fundingRate: "0.0000125", fundingIntervalHours: 1 }], ["BybitPerp", { fundingRate: "0.00004", fundingIntervalHours: 8 }]]],
  ];
  it("normalises to % per hour and measures Hyperliquid's gap", () => {
    expect(otherVenueFunding(rows, "BTC", 0.003)).toEqual({ binance_rate_1h_pct: 0.00125, bybit_rate_1h_pct: 0.0005, funding_gap_1h_pct: 0.00175 });
    expect(otherVenueFunding(rows, "DOGE", 0.001)).toEqual({ binance_rate_1h_pct: null, bybit_rate_1h_pct: null, funding_gap_1h_pct: null });
  });
});

describe("weather", () => {
  const daily = { temperature_2m_mean: [10, 10, 10, 10, 10, 10, 10, 4, 4, 4, 4, 4, 4, 4], precipitation_sum: [0, 0, 0, 0, 0, 0, 7, 1, 2, 3, 0, 0, 0, 4] };
  it("averages temperature and sums rain over the next 7 days, versus the past 7", () => {
    expect(weatherFields(daily, "temp", 7)).toEqual({ value: 4, change_7d: -6 });
    expect(weatherFields(daily, "precip", 7)).toEqual({ value: 10, change_7d: 3 });
  });
});
