import { describe, expect, it } from "vitest";
import { bookTop, depthWithin, walkBook } from "../src/book.ts";
import { parseL2Book } from "../src/hyperliquid/client.ts";
import { fixture } from "./helpers.ts";

const book = parseL2Book(fixture("hl_l2_btc.json"));

describe("order book math (Hyperliquid BTC l2Book fixture)", () => {
  it("parses levels best-first and computes top of book", () => {
    expect(book.bids[0]).toEqual({ px: 82720, sz: 1.25746 });
    expect(book.asks[0]).toEqual({ px: 82721, sz: 19.544 });
    const top = bookTop(book);
    expect(top.mid).toBe(82720.5);
    expect(top.spreadBps).toBeCloseTo((1 / 82720.5) * 1e4, 6);
  });

  it("fills a small buy at the best ask", () => {
    const f = walkBook(book, "buy", 100_000)!;
    expect(f.fillPrice).toBe(82721);
    expect(f.priceImpactBps).toBeCloseTo((0.5 / 82720.5) * 1e4, 6);
    expect(f.exhausted).toBe(false);
  });

  it("walks several levels for a large buy (VWAP)", () => {
    const size = 2_000_000;
    let rem = size;
    let qty = 0;
    for (const l of book.asks) {
      const take = Math.min(rem, l.px * l.sz);
      qty += take / l.px;
      rem -= take;
      if (rem <= 0) break;
    }
    const f = walkBook(book, "buy", size)!;
    expect(f.fillPrice).toBeCloseTo(size / qty, 6);
    expect(f.fillPrice).toBeGreaterThan(82721);
    expect(f.fillPrice).toBeLessThan(82724);
    expect(f.filledUsd).toBeCloseTo(size, 3);
  });

  it("flags exhaustion when the visible book is too thin", () => {
    const f = walkBook(book, "buy", 5_000_000)!;
    expect(f.exhausted).toBe(true);
    expect(f.filledUsd).toBeLessThan(5_000_000);
  });

  it("sells into bids with positive impact", () => {
    const f = walkBook(book, "sell", 50_000)!;
    expect(f.fillPrice).toBe(82720);
    expect(f.priceImpactBps).toBeGreaterThan(0);
  });

  it("sums depth within ±bps of mid", () => {
    const d = depthWithin(book, 200)!;
    const bidUsd = book.bids.reduce((s, l) => s + l.px * l.sz, 0);
    const askUsd = book.asks.reduce((s, l) => s + l.px * l.sz, 0);
    expect(d.bid).toBeCloseTo(bidUsd, 6);
    expect(d.ask).toBeCloseTo(askUsd, 6);
    expect(depthWithin(book, 0.01)!.total).toBe(0); // nothing within ±0.01 bps (~$0.08)
    expect(depthWithin(book, 0.1)!.total).toBeCloseTo(82720 * 1.25746 + 82721 * 19.544, 6);
  });

  it("returns null for empty books", () => {
    expect(walkBook({ bids: [], asks: [] }, "buy", 100)).toBeNull();
  });
});
