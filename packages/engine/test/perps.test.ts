import { describe, expect, it } from "vitest";
import { instrumentKey, type Instrument } from "@weft/strategy";
import { BTC, ETH, FakeMarket, HOUR, MIN, setup, simpleStrategy, T0 } from "./fakes.ts";
import { liquidationPrice, maintenanceMarginRate, MemoryStore, replay } from "../src/index.ts";

/** FakeMarket plus the optional MarketData perp methods. */
class PerpMarket extends FakeMarket {
  readonly funding = new Map<string, number>();
  readonly maxLev = new Map<string, number>();
  fundingCalls = 0;
  fundingError: Error | null = null;

  async getFundingRate(i: Instrument) {
    this.fundingCalls++;
    if (this.fundingError) throw this.fundingError;
    const r = this.funding.get(instrumentKey(i));
    return r == null ? null : { hourlyRate: r, ts: 0 };
  }
  async getMaxLeverage(i: Instrument) {
    return this.maxLev.get(instrumentKey(i)) ?? null;
  }
}

const FEE = 9.5e-4; // taker 4.5 + builder 5 bps
const TAKER = 4.5e-4;

const perp = (side: "long" | "short", leverage: number, stopPct = 60, instrument = BTC) =>
  simpleStrategy(
    { instrument, side, size: { unit: "usd", value: 1_000 }, leverage, exits: { stopLoss: { pct: stopPct } } },
    { risk: { maxLeverage: 20, maxTotalExposurePct: 500 } as never }
  );

async function opened(strategy: ReturnType<typeof perp>, opts: { price?: number; rate?: number; maxLev?: number; market?: PerpMarket } = {}) {
  const market = opts.market ?? new PerpMarket();
  const t = setup({ marketData: market, tickEventIntervalMs: 0 });
  // setup() made its own FakeMarket; drive the PerpMarket we passed in.
  const key = instrumentKey(strategy.actions[0]!.type === "open" ? strategy.actions[0]!.instrument : BTC);
  market.set(key, opts.price ?? 100);
  if (opts.rate != null) market.funding.set(key, opts.rate);
  if (opts.maxLev != null) market.maxLev.set(key, opts.maxLev);
  t.signals.set("go", { value: 1 });
  const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
  await t.engine.tick(d.id);
  const at = async (dt: number, px?: number) => {
    t.clock.t += dt;
    if (px != null) market.set(key, px);
    await t.engine.tick(d.id);
    return (await t.engine.getSnapshot(d.id))!;
  };
  return { ...t, market, key, d, at };
}

describe("perp funding (paper)", () => {
  it("longs pay a positive rate: notional × rate × hours, booked to cash and realized P&L", async () => {
    const t = await opened(perp("long", 2), { rate: 0.0001 }); // 0.01 %/h
    let s = (await t.engine.getSnapshot(t.d.id))!;
    expect(s.positions[0]).toMatchObject({ fundingPaidUsd: 0, qty: 20 });
    const cash0 = s.cashUsd;
    const realized0 = s.realizedPnlUsd;

    s = await t.at(30 * MIN);
    const notional = 20 * 100;
    expect(s.positions[0]!.fundingPaidUsd).toBeCloseTo(notional * 0.0001 * 0.5, 9);
    expect(s.cashUsd).toBeCloseTo(cash0 - 0.1, 9);
    expect(s.realizedPnlUsd).toBeCloseTo(realized0 - 0.1, 9);
    expect(s.fundingUsd).toBeCloseTo(0.1, 9);
    expect(s.equityUsd).toBeCloseTo(10_000 + s.realizedPnlUsd + s.unrealizedPnlUsd, 9);
  });

  it("shorts receive a positive rate and pay a negative one", async () => {
    const recv = await opened(perp("short", 2), { rate: 0.0001 });
    let s = await recv.at(HOUR);
    expect(s.positions[0]!.fundingPaidUsd).toBeCloseTo(-0.2, 9);
    expect(s.fundingUsd).toBeCloseTo(-0.2, 9);

    const pay = await opened(perp("short", 2), { rate: -0.0001 });
    s = await pay.at(HOUR);
    expect(s.positions[0]!.fundingPaidUsd).toBeCloseTo(0.2, 9);

    const longRecv = await opened(perp("long", 2), { rate: -0.0001 });
    s = await longRecv.at(HOUR);
    expect(s.positions[0]!.fundingPaidUsd).toBeCloseTo(-0.2, 9);
  });

  it("settles over many ticks at the current rate and mark, with at most one event per hour", async () => {
    const t = await opened(perp("long", 2), { rate: 0.0001 });
    // 6 ticks of 20 min = 2 h; the price and the rate change along the way.
    let expected = 0;
    for (let k = 0; k < 6; k++) {
      const px = 100 + k;
      if (k === 3) t.market.funding.set(t.key, 0.0002);
      expected += 20 * px * (k >= 3 ? 0.0002 : 0.0001) * (1 / 3);
      await t.at(20 * MIN, px);
    }
    const s = (await t.engine.getSnapshot(t.d.id))!;
    expect(s.positions[0]!.fundingPaidUsd).toBeCloseTo(expected, 9);
    expect(s.fundingUsd).toBeCloseTo(expected, 9);

    const ev = (await t.engine.getEvents(t.d.id)).filter((e) => e.data?.funding);
    expect(ev).toHaveLength(2); // T0 is on the hour: events at 13:00 and 14:00
    expect(ev.every((e) => e.type === "notify")).toBe(true);
    const sum = ev.reduce((a, e) => a + (e.data!.funding as { amountUsd: number }).amountUsd, 0);
    expect(sum).toBeCloseTo(expected, 9);
    expect(ev[0]!.message).toMatch(/Funding paid on BTC/);
  });

  it("reports the position's funding on the closing fill without double counting", async () => {
    const t = await opened(simpleStrategy(
      { instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, leverage: 2, exits: { stopLoss: { pct: 50 }, takeProfit: { pct: 10 } } },
      { risk: { maxLeverage: 20, maxTotalExposurePct: 500 } as never }
    ), { rate: 0.0001 });
    await t.at(HOUR, 100); // pays 0.2
    const s = await t.at(HOUR, 111); // pays 20 × 111 × 1e-4 = 0.222, then take-profit
    expect(s.positions).toHaveLength(0);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit.reason).toBe("take_profit");
    expect(exit.fundingUsd).toBeCloseTo(0.2 + 0.222, 9);
    expect(exit.realizedPnlUsd).toBeCloseTo(20 * 11 - 20 * 111 * FEE, 9); // price P&L − fee only
    const entryFee = 20 * 100 * FEE;
    expect(s.realizedPnlUsd).toBeCloseTo(20 * 11 - 20 * 111 * FEE - entryFee - 0.422, 9);
    expect(s.equityUsd).toBeCloseTo(10_000 + s.realizedPnlUsd, 9);
    expect(s.cashUsd).toBeCloseTo(s.equityUsd, 9);
  });

  it("tolerates MarketData without getFundingRate and a failing feed (accrues the gap later)", async () => {
    const plain = setup();
    plain.market.set(BTC, 100);
    plain.signals.set("go", { value: 1 });
    const d = await plain.engine.createDeployment({ strategy: perp("long", 2), allocationUsd: 10_000 });
    await plain.engine.tick(d.id);
    plain.clock.t += HOUR;
    await plain.engine.tick(d.id);
    expect((await plain.engine.getSnapshot(d.id))!.fundingUsd).toBe(0);

    const t = await opened(perp("long", 2), { rate: 0.0001 });
    t.market.fundingError = new Error("feed down");
    let s = await t.at(HOUR);
    expect(s.fundingUsd).toBe(0);
    expect((await t.engine.getEvents(t.d.id)).some((e) => e.type === "warning" && /No funding rate/.test(e.message))).toBe(true);
    t.market.fundingError = null;
    s = await t.at(HOUR);
    expect(s.fundingUsd).toBeCloseTo(20 * 100 * 0.0001 * 2, 9);
  });

  it("the kill switch reports accrued funding on the closing fill", async () => {
    const t = await opened(perp("long", 2), { rate: 0.0001 });
    await t.at(HOUR);
    const store = t.engine.store as MemoryStore;
    const [p] = await store.listPositions(t.d.id);
    expect(p!.fundingPaidUsd).toBeCloseTo(0.2, 9);
    await t.engine.kill(t.d.id);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit).toMatchObject({ reason: "kill" });
    expect(exit.fundingUsd).toBeCloseTo(0.2, 9);
  });
});

describe("perp liquidation (paper)", () => {
  it("maintenance = 1 / (2 × max leverage), 3 % when unknown; liquidation price formula", () => {
    expect(maintenanceMarginRate(50)).toBeCloseTo(0.01, 12);
    expect(maintenanceMarginRate(null)).toBe(0.03);
    expect(liquidationPrice("long", 100, 10, 0.01)).toBeCloseTo((100 * 0.9) / 0.99, 9);
    expect(liquidationPrice("short", 100, 10, 0.01)).toBeCloseTo((100 * 1.1) / 1.01, 9);
    expect(liquidationPrice("long", 100, 1, 0.01)).toBeNull();
  });

  it("exposes liquidationPrice on leveraged perps (venue max leverage, or the 3 % default)", async () => {
    const t = await opened(perp("long", 10), { maxLev: 50 });
    let s = (await t.engine.getSnapshot(t.d.id))!;
    expect(s.positions[0]!.liquidationPrice).toBeCloseTo((100 * 0.9) / 0.99, 9);

    const d = await opened(perp("short", 5, 60, ETH), { maxLev: undefined });
    s = (await d.engine.getSnapshot(d.d.id))!;
    expect(s.positions[0]!.liquidationPrice).toBeCloseTo((100 * 1.2) / 1.03, 9);

    const one = await opened(perp("long", 1));
    s = (await one.engine.getSnapshot(one.d.id))!;
    expect(s.positions[0]!.liquidationPrice).toBeUndefined();
  });

  it("long: closes at the liquidation price when the mark crosses it, with a clear event", async () => {
    const t = await opened(perp("long", 10), { maxLev: 50 });
    const liq = (100 * 0.9) / 0.99; // 90.909…
    let s = await t.at(MIN, 91);
    expect(s.positions).toHaveLength(1); // above liq: still open (stop at 60 % not hit)
    s = await t.at(MIN, 85); // gaps through liq
    expect(s.positions).toHaveLength(0);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit).toMatchObject({ reason: "liquidation", side: "sell", qty: 100 });
    expect(exit.price).toBeCloseTo(liq, 9); // at the liquidation price, not the 85 mark
    const fee = 100 * liq * TAKER; // no builder fee on liquidations
    expect(exit.feeUsd).toBeCloseTo(fee, 9);
    expect(exit.realizedPnlUsd).toBeCloseTo(100 * (liq - 100) - fee, 9);
    // What's left of the $1 000 margin is the maintenance margin (1 % of notional at liq) minus the fee.
    expect(1_000 + exit.realizedPnlUsd!).toBeCloseTo(0.01 * 100 * liq - fee, 9);
    expect(s.equityUsd).toBeCloseTo(10_000 + s.realizedPnlUsd, 9);
    const warn = (await t.engine.getEvents(t.d.id)).find((e) => e.type === "warning" && e.data?.liquidation);
    expect(warn?.message).toMatch(/BTC-PERP 10× long liquidated/);
    const fillEv = (await t.engine.getEvents(t.d.id)).find((e) => e.type === "fill" && /Liquidated/.test(e.message));
    expect(fillEv).toBeDefined();
  });

  it("short: liquidated when the mark rises through the liquidation price", async () => {
    const t = await opened(perp("short", 5), { maxLev: 20 }); // mm 2.5 %
    const liq = (100 * 1.2) / 1.025;
    let s = await t.at(MIN, 116);
    expect(s.positions).toHaveLength(1);
    s = await t.at(MIN, 118);
    expect(s.positions).toHaveLength(0);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit).toMatchObject({ reason: "liquidation", side: "buy" });
    expect(exit.price).toBeCloseTo(liq, 9);
    expect(exit.realizedPnlUsd).toBeCloseTo(50 * (100 - liq) - 50 * liq * TAKER, 9);
  });

  it("liquidation wins over a stop-loss that is further away, and is off for live executors", async () => {
    const t = await opened(perp("long", 10, 15), { maxLev: 50 }); // stop at −15 %, liq at −9.1 %
    await t.at(MIN, 80);
    expect((await t.engine.getFills(t.d.id))[1]!.reason).toBe("liquidation");

    const market = new PerpMarket();
    const live = setup({ marketData: market, perpRealism: false });
    market.set(BTC, 100).funding.set("hl:perp:BTC", 0.001);
    live.signals.set("go", { value: 1 });
    const d = await live.engine.createDeployment({ strategy: perp("long", 10), allocationUsd: 10_000 });
    await live.engine.tick(d.id);
    live.clock.t += HOUR;
    market.set(BTC, 85);
    await live.engine.tick(d.id);
    const s = (await live.engine.getSnapshot(d.id))!;
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.liquidationPrice).toBeUndefined();
    expect(s.fundingUsd).toBe(0);
    expect(market.fundingCalls).toBe(0);
  });

  it("positions persisted before the model get a liquidation price and start accruing funding", async () => {
    const t = await opened(perp("long", 10), { maxLev: 50, rate: 0.0001 });
    const store = t.engine.store as MemoryStore;
    const [p] = await store.listPositions(t.d.id);
    const legacy = { ...p! };
    delete legacy.liquidationPrice;
    delete legacy.fundingPaidUsd;
    delete legacy.fundingState;
    await store.commit({ deploymentId: t.d.id, upsertPositions: [legacy] });
    let s = await t.at(HOUR, 100);
    expect(s.positions[0]!.liquidationPrice).toBeCloseTo((100 * 0.9) / 0.99, 9);
    expect(s.positions[0]!.fundingPaidUsd).toBe(0); // no back-charge
    s = await t.at(HOUR, 100);
    expect(s.positions[0]!.fundingPaidUsd).toBeCloseTo(100 * 100 * 0.0001, 9);
  });
});

describe("replay with funding", () => {
  it("accrues recorded funding rates", async () => {
    const strategy = perp("short", 2);
    const sig = (now: number) => ({ go: { asOf: now, fields: { value: 1 } } });
    const r = await replay(strategy, [
      { now: T0, signals: sig(T0), quotes: { "hl:perp:BTC": 100 }, funding: { "hl:perp:BTC": 0.0001 } },
      { now: T0 + HOUR, signals: sig(T0 + HOUR), quotes: {} },
      { now: T0 + 2 * HOUR, signals: sig(T0 + 2 * HOUR), quotes: {} },
    ], { slippageBps: { perp: 0 } });
    expect(r.snapshot.fundingUsd).toBeCloseTo(-0.4, 9); // short receives 20 × 100 × 1e-4 × 2 h
  });
});
