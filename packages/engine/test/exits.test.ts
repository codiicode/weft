import { describe, expect, it } from "vitest";
import type { Level } from "@weft/strategy";
import { exitReason, levelMovePct } from "../src/positions.ts";
import type { Position } from "../src/types.ts";
import { BTC, MIN, setup, simpleStrategy } from "./fakes.ts";

const pos = (side: "long" | "short", leverage: number, mark: number, exits: { stopLoss?: Level; takeProfit?: Level }): Position =>
  ({ side, leverage, entryPrice: 100, markPrice: mark, peakPrice: mark, openedAt: 0, exits }) as unknown as Position;

describe("position-based exits (percent of the money put in)", () => {
  it("a 20% stop at 20× fires at a 1% price move against the position, not before", () => {
    const sl = { stopLoss: { positionPct: 20 } };
    expect(exitReason(pos("long", 20, 99.1, sl), 1)).toBeNull();
    expect(exitReason(pos("long", 20, 99, sl), 1)).toBe("stop_loss");
    expect(exitReason(pos("short", 20, 100.9, sl), 1)).toBeNull();
    expect(exitReason(pos("short", 20, 101, sl), 1)).toBe("stop_loss");
  });

  it("a take-profit on the position scales the same way", () => {
    const tp = { takeProfit: { positionPct: 50 } };
    expect(exitReason(pos("long", 10, 104.9, tp), 1)).toBeNull();
    expect(exitReason(pos("long", 10, 105, tp), 1)).toBe("take_profit");
  });

  it("without leverage it is the same as a price move; price levels are untouched by leverage", () => {
    expect(levelMovePct({ positionPct: 20 }, 1)).toBe(20);
    expect(levelMovePct({ pct: 20 }, 20)).toBe(20);
    expect(levelMovePct({ price: 90 }, 20)).toBeNull();
    expect(exitReason(pos("long", 1, 80, { stopLoss: { positionPct: 20 } }), 1)).toBe("stop_loss");
    expect(exitReason(pos("long", 20, 99, { stopLoss: { pct: 20 } }), 1)).toBeNull();
  });
});

describe("a run with nothing left to do", () => {
  it("stops by itself once its one trade has closed", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 100 }, leverage: 1, exits: { stopLoss: { pct: 10 } } }), allocationUsd: 1_000 });
    await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.positions).toHaveLength(1);
    t.clock.t += MIN; t.market.set(BTC, 85); await t.engine.tick(d.id); // the stop
    const snap = (await t.engine.getSnapshot(d.id))!;
    expect(snap.positions).toHaveLength(0);
    expect(snap.deployment.status).toBe("stopped");
    expect((await t.engine.getEvents(d.id)).some((e) => /Finished: its trades are closed/.test(e.message))).toBe(true);
  });

  it("keeps running while a rule can open again", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 100 }, leverage: 1, reentry: "after_close", exits: { stopLoss: { pct: 10 } } }), allocationUsd: 1_000 });
    await t.engine.tick(d.id);
    t.clock.t += MIN; t.market.set(BTC, 85); await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.deployment.status).toBe("running");
  });

  it("keeps running before it has traded at all", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 0 });
    const d = await t.engine.createDeployment({ strategy: simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 100 } }), allocationUsd: 1_000 });
    await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.deployment.status).toBe("running");
  });
});
