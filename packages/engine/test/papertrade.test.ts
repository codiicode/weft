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

describe("exit checks between ticks", () => {
  it("closes on a stop with a streamed price, without a tick", async () => {
    const t = setup({ tickEventIntervalMs: 0 });
    const key = instrumentKey(PT_BTC);
    t.market.set(key, 100_000);
    t.signals.set("go", { value: 1 });
    const s = simpleStrategy({ instrument: PT_BTC, side: "long", size: { unit: "usd", value: 100 }, leverage: 100, exits: { stopLoss: { positionPct: 25 } } }, { risk: { maxLeverage: 1000, maxTotalExposurePct: 5000, maxPositionPct: 100 } as never });
    const d = await t.engine.createDeployment({ strategy: s, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.positions).toHaveLength(1);
    t.clock.t += 1_000;
    // the quote feed still says 100,000; the stream says 99,700 (−0.3% → −30% on the position)
    await t.engine.checkExits!(d.id, { [key]: 99_700 });
    const snap = (await t.engine.getSnapshot(d.id))!;
    expect(snap.positions).toHaveLength(0);
    expect((await t.engine.getFills(d.id)).at(-1)!.reason).toBe("stop_loss");
  });
});

describe("a Papertrade / Hyperliquid hedge", () => {
  it("closes the Hyperliquid leg as soon as the Papertrade leg is liquidated", async () => {
    const HL_BTC: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" };
    const t = setup({ tickEventIntervalMs: 0 });
    const kPt = instrumentKey(PT_BTC), kHl = instrumentKey(HL_BTC);
    const both = (px: number) => (t.market.set(kPt, px), t.market.set(kHl, px));
    both(100_000);
    t.signals.set("go", { value: 1 });
    const s = simpleStrategy(
      { instrument: PT_BTC, side: "long", size: { unit: "usd", value: 10 }, leverage: 100 },
      {
        signals: [
          { id: "go", kind: "macro", params: { series: "GO" } },
          { id: "pt", kind: "position", params: { instrument: PT_BTC } },
          { id: "hl", kind: "position", params: { instrument: HL_BTC } },
        ],
        triggers: [
          { id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } }, maxFires: 1 },
          { id: "pt_gone", when: { op: "and", args: [{ op: "is", ref: "pt.open", value: false }, { op: "is", ref: "hl.open", value: true }] } },
          { id: "hl_gone", when: { op: "and", args: [{ op: "is", ref: "hl.open", value: false }, { op: "is", ref: "pt.open", value: true }] } },
        ],
        actions: [
          { id: "open_it", on: ["entry"], type: "open", instrument: PT_BTC, side: "long", size: { unit: "usd", value: 10 }, leverage: 100 },
          { id: "short_hl", on: ["entry"], type: "open", instrument: HL_BTC, side: "short", size: { unit: "usd", value: 25 }, leverage: 40 },
          { id: "close_a", on: ["pt_gone"], type: "close", target: "all" },
          { id: "close_b", on: ["hl_gone"], type: "close", target: "all" },
        ],
        risk: { maxLeverage: 100, maxTotalExposurePct: 5000, maxPositionPct: 100 } as never,
      } as never,
    );
    const d = await t.engine.createDeployment({ strategy: s, allocationUsd: 1_000 });
    await t.engine.tick(d.id);
    let snap = (await t.engine.getSnapshot(d.id))!;
    expect(snap.positions.map((p) => p.instrument.kind).sort()).toEqual(["perp", "synth"]);
    expect(snap.positions.map((p) => p.qty * p.entryPrice).every((n) => Math.abs(n - 1_000) < 5)).toBe(true); // same position size
    // BTC drops 1.2%: the 100× long busts; the short is now alone, and gets closed.
    for (let k = 0; k < 3; k++) {
      t.clock.t += MIN;
      both(98_800);
      await t.engine.tick(d.id);
    }
    snap = (await t.engine.getSnapshot(d.id))!;
    expect(snap.positions).toHaveLength(0);
    const fills = await t.engine.getFills(d.id);
    expect(fills.map((f) => f.reason)).toEqual(expect.arrayContaining(["liquidation"]));
    expect(fills.filter((f) => f.instrumentKey === kHl)).toHaveLength(2); // opened, then closed
  });
});

describe("Farm PAPER (the example)", () => {
  it("runs in rounds with both legs on Papertrade: one busts either way, the other closes, a new round opens", async () => {
    const { farmPaper } = await import("@weft/strategy/examples");
    const t = setup({ tickEventIntervalMs: 0 });
    const k = instrumentKey(PT_BTC);
    t.market.set(k, 100_000);
    const d = await t.engine.createDeployment({ strategy: farmPaper, allocationUsd: 100 });
    const step = async (px: number) => {
      t.clock.t += MIN;
      t.market.set(k, px);
      await t.engine.tick(d.id);
      return (await t.engine.getSnapshot(d.id))!.positions;
    };
    await t.engine.tick(d.id);
    let pos = (await t.engine.getSnapshot(d.id))!.positions;
    expect(pos.map((p) => p.side).sort()).toEqual(["long", "short"]); // round 1, both on Papertrade
    expect((await step(98_800)).length).toBeLessThan(2); // down: the long busts…
    expect(await step(98_800)).toHaveLength(0); // …and the short is closed, in profit
    pos = await step(98_800); // round 2
    expect(pos.map((p) => p.side).sort()).toEqual(["long", "short"]);
    expect((await step(100_100)).length).toBeLessThan(2); // up this time: the short busts
    expect(await step(100_100)).toHaveLength(0);
    const fills = await t.engine.getFills(d.id);
    expect(fills.filter((f) => f.reason === "liquidation").map((f) => f.side).sort()).toEqual(["buy", "sell"]); // a long and a short busted
    const won = fills.filter((f) => f.reason !== "liquidation" && f.reason !== "entry" && (f.realizedPnlUsd ?? 0) > 0);
    expect(won.length).toBe(2); // each round's survivor closed in profit
  });
});

describe("a full Papertrade side", () => {
  it("doesn't make Earn PAPER churn: the round waits out its cooldown before trying again", async () => {
    const { farmPaper } = await import("@weft/strategy/examples");
    let shortsTried = 0;
    const executor = {
      mode: "paper" as const,
      async execute(req: { side: string; phase: string; notionalUsd?: number; qty?: number }) {
        if (req.phase === "open" && req.side === "sell") {
          shortsTried++;
          return { status: "rejected" as const, reason: "Papertrade is full on this side right now", retry: true };
        }
        const qty = req.phase === "open" ? (req.notionalUsd ?? 0) / 100_000 : req.qty!;
        return { status: "filled" as const, qty, price: 100_000, markPrice: 100_000, feeUsd: 0, builderFeeUsd: 0, slippageBps: 0 };
      },
    };
    const t = setup({ tickEventIntervalMs: 0, executor: executor as never });
    t.market.set(instrumentKey(PT_BTC), 100_000);
    const d = await t.engine.createDeployment({ strategy: farmPaper, allocationUsd: 100 });
    const at = async (mins: number) => {
      t.clock.t += mins * MIN;
      await t.engine.tick(d.id);
      return (await t.engine.getSnapshot(d.id))!.positions.length;
    };
    await t.engine.tick(d.id); // round 1: the long opens, the short is refused
    expect(shortsTried).toBe(1);
    expect(await at(1)).toBe(0); // the lone long is closed
    expect(await at(1)).toBe(0); // still inside the 3-minute cooldown: no new round
    expect(shortsTried).toBe(1);
    await at(2); // past it: tries again
    expect(shortsTried).toBe(2);
  });
});

describe("a Papertrade open that is still pending", () => {
  it("is asked about again under the same id until it shows up, never sent twice", async () => {
    const ids: string[] = [];
    let calls = 0;
    const executor = {
      mode: "paper" as const,
      async execute(req: { clientId: string; notionalUsd?: number }) {
        ids.push(req.clientId);
        calls++;
        if (calls === 1) return { status: "pending" as const, reason: "sent to Papertrade (0xabc…), not open yet" };
        return { status: "filled" as const, qty: (req.notionalUsd ?? 0) / 100_000, price: 100_000, markPrice: 100_000, feeUsd: 0, builderFeeUsd: 0, slippageBps: 0, venueId: "1" };
      },
    };
    const t = setup({ tickEventIntervalMs: 0, executor: executor as never });
    t.market.set(instrumentKey(PT_BTC), 100_000);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: strategy(100, 10), allocationUsd: 100 });
    await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.positions).toHaveLength(0);
    t.clock.t += MIN;
    await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.positions).toHaveLength(1);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]); // the same order, looked up again
  });
});
