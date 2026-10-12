import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "@weft/strategy";
import { SqliteStore } from "../src/index.ts";
import { BTC, MIN, setup, simpleStrategy } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-engine-"));
  dirs.push(dir);
  return join(dir, "engine.db");
};

const strategy = simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, leverage: 2, exits: { stopLoss: { pct: 5 }, takeProfit: { pct: 10 } } });

describe("SqliteStore", () => {
  it("engine state survives a restart and intents never execute twice", async () => {
    const path = tempDb();

    // Process 1: deploy and open a position.
    const store1 = new SqliteStore(path);
    const a = setup({ store: store1 });
    a.market.set(BTC, 100);
    a.signals.set("go", { value: 1 });
    const d = await a.engine.createDeployment({ strategy, allocationUsd: 10_000, intervalSec: 60 });
    await a.engine.tick(d.id);
    const before = (await a.engine.getSnapshot(d.id))!;
    expect(before.positions).toHaveLength(1);
    await a.engine.shutdown();
    await store1.close();

    // Process 2: same file, fresh engine.
    const store2 = new SqliteStore(path);
    const b = setup({ store: store2 });
    b.clock.t = a.clock.t + MIN;
    b.market.set(BTC, 101);
    b.signals.set("go", { value: 1 });
    const restored = (await b.engine.getSnapshot(d.id))!;
    expect(restored.deployment).toEqual(before.deployment);
    expect(restored.positions).toEqual(before.positions);
    expect(restored.cashUsd).toBe(before.cashUsd);
    expect(restored.builderFeesUsd).toBe(before.builderFeesUsd);
    expect(restored.triggers).toEqual(before.triggers);
    expect(restored.equityCurve).toEqual(before.equityCurve);
    expect(await b.engine.getFills(d.id)).toHaveLength(1);
    expect((await b.engine.getEvents(d.id)).length).toBeGreaterThan(3);

    // The trigger stays disarmed across the restart: no second entry.
    await b.engine.tick(d.id);
    expect(await b.engine.getFills(d.id)).toHaveLength(1);
    expect((await b.engine.getSnapshot(d.id))!.positions[0]!.markPrice).toBe(101);

    // Simulate a crash that lost the evaluator state but not the executed keys:
    // the trigger refires with the same intent key and the engine refuses to execute it.
    const rt = (await store2.getRuntime(d.id))!;
    await store2.commit({ deploymentId: d.id, runtime: { ...rt, evalState: initialState(strategy), triggers: [] } });
    b.clock.t += MIN;
    await b.engine.tick(d.id);
    expect(await b.engine.getFills(d.id)).toHaveLength(1);
    const dup = (await b.engine.getEvents(d.id)).find((e) => e.type === "warning" && /already executed/.test(e.message));
    expect(dup?.data).toMatchObject({ intentKey: "test-strategy:open_it:entry:1" });

    // Exits still work after restart.
    b.clock.t += MIN;
    b.market.set(BTC, 111);
    await b.engine.tick(d.id);
    expect((await b.engine.getFills(d.id)).map((f) => f.reason)).toEqual(["entry", "take_profit"]);
    await store2.close();

    // Process 3: the closed state is durable too.
    const store3 = new SqliteStore(path);
    const s = await setup({ store: store3 }).engine.getSnapshot(d.id);
    expect(s!.positions).toHaveLength(0);
    expect(s!.realizedPnlUsd).toBeGreaterThan(190);
    await store3.close();
  });

  it("bounds events and equity samples", async () => {
    const store = new SqliteStore(tempDb(), { maxEvents: 5, maxEquitySamples: 3 });
    const t = setup({ store, equitySampleIntervalMs: 0, tickEventIntervalMs: 0 });
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 0 });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 1_000 });
    for (let i = 0; i < 10; i++) {
      t.clock.t += MIN;
      await t.engine.tick(d.id);
    }
    const ev = await t.engine.getEvents(d.id, { limit: 100 });
    expect(ev).toHaveLength(5);
    expect(ev.at(-1)!.ts).toBe(t.clock.t);
    expect(await t.engine.getEvents(d.id, { sinceTs: t.clock.t - MIN - 1, limit: 100 })).toHaveLength(2);
    const curve = (await t.engine.getSnapshot(d.id))!.equityCurve;
    expect(curve).toHaveLength(3);
    expect(curve.at(-1)![0]).toBe(t.clock.t);
    await store.close();
  });
});
