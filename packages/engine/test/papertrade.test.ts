import { describe, expect, it } from "vitest";
import { instrumentKey, type Instrument } from "@weft/strategy";
import { DEFAULT_SYNTH_LIMITS, synthBustPrice, synthSettlement } from "@weft/venues";
import { MIN, setup, simpleStrategy } from "./fakes.ts";

const PT_BTC: Instrument = { kind: "synth", venue: "papertrade", symbol: "BTC", assetClass: "crypto" };
const strategy = (leverage: number, margin: number, side: "long" | "short" = "long") =>
  simpleStrategy({ instrument: PT_BTC, side, size: { unit: "usd", value: margin }, leverage }, { risk: { maxLeverage: 1000, maxTotalExposurePct: 5000, maxPositionPct: 100 } as never });

async function opened(leverage: number, margin: number, side: "long" | "short" = "long", price = 100_000) {
  const t = setup({ tickEventIntervalMs: 0 });
  const key = instrumentKey(PT_BTC);
  t.market.set(key, price);
  t.signals.set("go", { value: 1 });
  const d = await t.engine.createDeployment({ strategy: strategy(leverage, margin, side), allocationUsd: 10_000 });
  await t.engine.tick(d.id);
  const at = async (px: number) => {
    t.clock.t += MIN;
    t.market.set(key, px);
    await t.engine.tick(d.id);
    return (await t.engine.getSnapshot(d.id))!;
  };
  return { ...t, d, at };
}

describe("Papertrade (practice)", () => {
  it("opens 1000× at the mid with no fee, and sets the bust price", async () => {
    const { engine, d } = await opened(1000, 10);
    const s = (await engine.getSnapshot(d.id))!;
    const p = s.positions[0]!;
    expect(p).toMatchObject({ leverage: 1000, entryPrice: 100_000, sizeUsd: 10 });
    expect(p.qty * p.entryPrice).toBeCloseTo(10_000, 6);
    expect(p.liquidationPrice).toBeCloseTo(synthBustPrice("long", 100_000, 1000, DEFAULT_SYNTH_LIMITS.markets.BTC), 6);
    expect((await engine.getFills(d.id))[0]!.feeUsd).toBe(0);
  });

  it("refuses positions under Papertrade's minimums", async () => {
    const { engine, d } = await opened(10, 50); // $500 notional
    expect((await engine.getSnapshot(d.id))!.positions).toHaveLength(0);
    const ev = (await engine.getEvents(d.id)).find((e) => /at least \$1,000/.test(e.message));
    expect(ev).toBeDefined();
  });

  it("busts and forfeits the whole margin", async () => {
    const { at, engine, d } = await opened(1000, 10);
    const s = await at(99_900);
    expect(s.positions).toHaveLength(0);
    const exit = (await engine.getFills(d.id)).find((f) => f.reason === "liquidation")!;
    expect(exit.realizedPnlUsd).toBeCloseTo(-10, 6);
  });

  it("a winning close keeps what Papertrade would pay", async () => {
    const { engine, d, clock, market } = await opened(100, 100); // $10,000 at 100×
    clock.t += MIN;
    market.set(instrumentKey(PT_BTC), 101_000); // +1%
    await engine.tick(d.id);
    await engine.kill(d.id);
    const exit = (await engine.getFills(d.id)).at(-1)!;
    const want = synthSettlement("long", 100_000, 101_000, 10_000, DEFAULT_SYNTH_LIMITS.markets.BTC);
    expect(exit.realizedPnlUsd).toBeCloseTo(want.pnl, 6);
    expect(exit.feeUsd).toBeCloseTo(want.keptByVenue, 6);
  });

  it("has no leverage above 50× outside Papertrade", () => {
    expect(() => simpleStrategy({ instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" }, side: "long", size: { unit: "usd", value: 10 }, leverage: 100 }, { risk: { maxLeverage: 1000 } as never })).toThrow(/Papertrade/);
  });
});
