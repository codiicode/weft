import { describe, expect, it } from "vitest";
import { coinOf, FastExits, wouldExit } from "../src/live/fast-exits.ts";

const pos = (o: Record<string, unknown> = {}) =>
  ({
    id: "p1", actionId: "a", instrumentKey: "papertrade:synth:BTC", instrument: { kind: "synth", venue: "papertrade", symbol: "BTC", assetClass: "crypto" },
    side: "long", qty: 0.1, entryPrice: 100_000, sizeUsd: 100, leverage: 100, exits: { stopLoss: { positionPct: 25 } },
    openedAt: 0, markPrice: 100_000, markedAt: 0, unrealizedPnlUsd: 0, unrealizedPnlPct: 0, peakPrice: 100_000, liquidationPrice: 99_047, ...o,
  }) as never;

describe("fast exits", () => {
  it("knows which prices close a position, using the engine's own rules", () => {
    expect(wouldExit(pos(), 99_900, 1)).toBe(false); // −10% on the position
    expect(wouldExit(pos(), 99_700, 1)).toBe(true); // −30%: past the 25% stop
    // past the bust but no stop: practice liquidates, live leaves it to the venue
    expect(wouldExit(pos({ exits: {} }), 99_000, 1, "paper")).toBe(true);
    expect(wouldExit(pos({ exits: {} }), 99_000, 1, "live")).toBe(false);
  });

  it("streams Papertrade in every mode and Hyperliquid perps only in practice", () => {
    expect(coinOf(pos(), "live")).toBe("BTC");
    const hl = pos({ instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" } });
    expect(coinOf(hl, "paper")).toBe("ETH");
    expect(coinOf(hl, "live")).toBeNull();
  });

  it("checks a run once when its stop is crossed, with the streamed price", async () => {
    const calls: unknown[] = [];
    const engine = { getSnapshot: async () => ({ positions: [pos()] }), checkExits: async (id: string, prices: unknown) => void calls.push([id, prices]) } as never;
    const fx = new FastExits({ engine, listRuns: async () => [{ id: "d1", mode: "live", status: "running" }] });
    await fx.refresh();
    fx.onMids({ BTC: "99950" }, 10_000);
    expect(calls).toHaveLength(0);
    fx.onMids({ BTC: "99700" }, 10_000);
    fx.onMids({ BTC: "99600" }, 10_200); // within a second: not again
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([["d1", { "papertrade:synth:BTC": 99_700 }]]);
  });
});
