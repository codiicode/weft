import { describe, expect, it } from "vitest";
import { deribitBookUsd, deribitCurrency, deriveName, parseDeribitName, parseDeriveTicker, summaryToRow } from "../src/options.ts";
import { fixture } from "./helpers.ts";

describe("Deribit", () => {
  it("parses inverse and linear instrument names", () => {
    expect(parseDeribitName("ETH-16OCT26-2800-P")).toEqual({ underlying: "ETH", expiry: "2026-10-16", strike: 2800, right: "put", linear: false });
    expect(parseDeribitName("SOL_USDC-27NOV26-154-P")).toEqual({ underlying: "SOL", expiry: "2026-11-27", strike: 154, right: "put", linear: true });
    expect(parseDeribitName("XRP_USDC-3NOV26-1d75-C")).toEqual({ underlying: "XRP", expiry: "2026-11-03", strike: 1.75, right: "call", linear: true });
    expect(parseDeribitName("BTC-PERPETUAL")).toBeNull();
    expect(deribitCurrency("sol")).toBe("USDC");
    expect(deribitCurrency("BTC")).toBe("BTC");
  });

  it("converts inverse premiums to USD and leaves linear ones", () => {
    const eth = fixture("deribit_summary_eth.json").result[0];
    const row = summaryToRow(eth)!;
    expect(row.markUsd).toBeCloseTo(eth.mark_price * eth.underlying_price, 9);
    expect(row.bidUsd).toBeCloseTo(eth.bid_price * eth.underlying_price, 9);
    expect(row.openInterestUsd).toBeCloseTo(eth.open_interest * eth.underlying_price, 6);
    const sol = fixture("deribit_summary_usdc.json").result[0];
    expect(summaryToRow(sol)!.markUsd).toBe(sol.mark_price);
  });

  it("builds a USD book from get_order_book", () => {
    const raw = fixture("deribit_book.json").result;
    const b = deribitBookUsd(raw, false);
    expect(b.bids[0]!.px).toBeCloseTo(0.1055 * raw.index_price, 9);
    expect(b.asks[0]!.sz).toBe(702);
  });
});

describe("Derive", () => {
  it("names instruments and parses tickers (USD)", () => {
    expect(deriveName({ underlying: "eth", expiry: "2026-12-25", strike: 4800, right: "call" })).toBe("ETH-20261225-4800-C");
    const t = parseDeriveTicker(fixture("derive_ticker.json").result);
    expect(t.mark).toBe(87.2);
    expect(t.ask).toBe(350);
    expect(t.bid).toBeNull(); // best_bid_price "0" = no bid
  });
});
