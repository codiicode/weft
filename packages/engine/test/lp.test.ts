import { describe, expect, it } from "vitest";
import { defineStrategy } from "@weft/strategy";
import { lpBaseShare, lpValueRatio, resolveRange } from "../src/lp.ts";
import { HOUR, MIN, setup } from "./fakes.ts";

const POOL = { kind: "lp", venue: "meteora", pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", symbol: "SOL-USDC", baseMint: "So11111111111111111111111111111111111111112", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", quoteSymbol: "USDC" } as const;

describe("liquidity math", () => {
  it("is worth what went in at the opening price, half in each token at the middle", () => {
    expect(lpValueRatio(100, 100, 90, 110)).toBeCloseTo(1, 12);
    expect(lpBaseShare(Math.sqrt(90 * 110), 90, 110)).toBeCloseTo(0.5, 2);
  });

  it("is all base below the range and all quote above it", () => {
    expect(lpBaseShare(80, 90, 110)).toBe(1);
    expect(lpBaseShare(120, 90, 110)).toBe(0);
    // above the range it's all quote: the value stops growing
    expect(lpValueRatio(100, 120, 90, 110)).toBeCloseTo(lpValueRatio(100, 150, 90, 110), 12);
  });

  it("loses to holding when the price moves either way (impermanent loss)", () => {
    const hold = (p: number) => 0.5 * (p / 100) + 0.5; // half base, half quote at the start (close enough for a symmetric range)
    for (const p of [92, 108]) expect(lpValueRatio(100, p, 90, 110)).toBeLessThan(hold(p) + 1e-9);
  });

  it("turns percentages into prices around the opening price", () => {
    expect(resolveRange({ lowerPct: 5, upperPct: 10 }, 100)).toEqual({ lower: 95, upper: 110.00000000000001 });
    expect(resolveRange({ lower: 90, upper: 120 }, 100)).toEqual({ lower: 90, upper: 120 });
  });
});

function lpStrategy(extra: Record<string, unknown> = {}) {
  return defineStrategy({
    schemaVersion: 1,
    id: "lp-test",
    name: "SOL-USDC range",
    thesis: "provide liquidity",
    signals: [{ id: "go", kind: "macro", params: { series: "GO" } }],
    triggers: [{ id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } }],
    actions: [{ id: "lp", type: "liquidity", on: ["entry"], pool: POOL, size: { unit: "usd", value: 1_000 }, range: { lowerPct: 10, upperPct: 10 }, ...extra } as never],
  });
}

async function opened(extra: Record<string, unknown> = {}) {
  const t = setup();
  const quote = (price: number, feePerDay = 0.01) => ({ price, lp: { quoteUsd: 1, feePerDay, tvlUsd: 1_000_000 } });
  t.market.set(POOL, quote(100));
  t.signals.set("go", { value: 1 });
  const d = await t.engine.createDeployment({ strategy: lpStrategy(extra), allocationUsd: 2_000 });
  await t.engine.tick(d.id);
  const at = async (price: number, dt = MIN) => {
    t.clock.t += dt;
    t.market.set(POOL, quote(price));
    await t.engine.tick(d.id);
    return (await t.engine.getSnapshot(d.id))!;
  };
  return { ...t, d, at };
}

describe("liquidity positions (practice)", () => {
  it("deposits on the trigger with the range fixed around the price", async () => {
    const { engine, d } = await opened();
    const s = (await engine.getSnapshot(d.id))!;
    expect(s.positions).toHaveLength(1);
    const p = s.positions[0]!;
    expect(p).toMatchObject({ qty: 1_000, entryPrice: 1, sizeUsd: 1_000, instrumentKey: `meteora:lp:${POOL.pool}` });
    expect(p.lp).toMatchObject({ entryPoolPrice: 100, lower: 90, outSince: null });
    expect(p.lp!.upper).toBeCloseTo(110, 9);
    expect(s.cashUsd).toBeCloseTo(1_000, 9);
    const events = await engine.getEvents(d.id);
    expect(events.some((e) => e.type === "fill" && /Added \$1000\.00 of liquidity to the SOL-USDC pool between 90 and 110/.test(e.message))).toBe(true);
  });

  it("earns fees while in range and is marked at its value", async () => {
    const { at } = await opened();
    const s = await at(100, 24 * HOUR); // a day at the same price: 1% fees, no price change
    const p = s.positions[0]!;
    expect(p.lp!.feesUsd).toBeCloseTo(10, 6);
    expect(p.unrealizedPnlUsd).toBeCloseTo(10, 6);
  });

  it("earns no fees out of range and closes after outOfRangeMinutes", async () => {
    const { at, engine, d } = await opened({ outOfRangeMinutes: 30 });
    let s = await at(120, 10 * MIN);
    expect(s.positions[0]!.lp!.outSince).not.toBeNull();
    expect(s.positions[0]!.lp!.feesUsd).toBe(0);
    s = await at(120, 25 * MIN);
    expect(s.positions).toHaveLength(1); // out since the 10-minute check: 25 minutes so far
    s = await at(120, 6 * MIN);
    expect(s.positions).toHaveLength(0);
    const fills = await engine.getFills(d.id);
    const exit = fills.find((f) => f.reason === "out_of_range")!;
    // all in USDC above the range: worth its value at the top of the range
    expect(exit.qty * exit.price).toBeCloseTo(1_000 * lpValueRatio(100, 110, 90, 110), 6);
  });

  it("stops out on the position's value, not the price", async () => {
    const { at, engine, d } = await opened({ exits: { stopLoss: { pct: 3 } } });
    await at(97); // the pool price fell 3%; the position fell less (half was in USDC)
    expect((await engine.getSnapshot(d.id))!.positions).toHaveLength(1);
    const s = await at(90);
    expect(s.positions).toHaveLength(0);
    expect((await engine.getFills(d.id)).some((f) => f.reason === "stop_loss")).toBe(true);
  });
});
