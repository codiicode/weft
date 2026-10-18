import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_SYNTH_LIMITS, decodeTradingState, synthBustPrice, synthSettlement } from "../src/papertrade.ts";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

describe("Papertrade settlement", () => {
  it("pays winning closes exactly what Papertrade paid (15 real settlements)", () => {
    const rows = fixture("papertrade-settled.json").rows as { instrument: "BTC" | "ETH"; instrumentPriceScale: string; side: "long" | "short"; leverage: number; margin: string; entryPrice: string; exitPrice: string; pnl: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      const sc = Number(r.instrumentPriceScale), margin = Number(BigInt(r.margin)) / 1e18;
      const s = synthSettlement(r.side, Number(r.entryPrice) / sc, Number(r.exitPrice) / sc, margin * r.leverage, DEFAULT_SYNTH_LIMITS.markets[r.instrument]);
      expect(s.pnl).toBeCloseTo(Number(BigInt(r.pnl)) / 1e18, 2);
      expect(s.keptByVenue).toBeGreaterThan(0);
    }
  });

  it("charges nothing extra on losses and keeps almost everything of a tiny win", () => {
    const m = DEFAULT_SYNTH_LIMITS.markets.BTC;
    expect(synthSettlement("long", 100_000, 99_000, 100_000, m)).toEqual({ pnl: -1_000, rawPnl: -1_000, keptByVenue: 0 });
    const tiny = synthSettlement("long", 100_000, 100_010, 100_000, m); // +0.01%
    expect(tiny.rawPnl).toBeCloseTo(10, 6);
    expect(tiny.pnl).toBeLessThan(tiny.rawPnl * 0.5);
  });

  it("busts a 1000× long about 0.05% below entry, before equity reaches zero", () => {
    const m = DEFAULT_SYNTH_LIMITS.markets.BTC;
    const bust = synthBustPrice("long", 100_000, 1000, m);
    expect(bust).toBeLessThan(100_000);
    expect(bust).toBeGreaterThan(100_000 * (1 - 1 / 1000)); // above the zero-equity price
    expect(synthBustPrice("short", 100_000, 1000, m)).toBeGreaterThan(100_000);
  });

  it("reads limits and market parameters from /state/trading", () => {
    const l = decodeTradingState(fixture("papertrade-trading.json"));
    expect(l.minMarginUsd).toBe(10);
    expect(l.minNotionalUsd).toBeGreaterThanOrEqual(100);
    expect(l.markets.BTC).toMatchObject({ instrumentId: 0, priceScale: 10, maxLeverage: 1000 });
    expect(l.markets.ETH).toMatchObject({ instrumentId: 1, priceScale: 100 });
    expect(l.markets.BTC.bustBuffer).toBeGreaterThan(0.0003);
  });
});
