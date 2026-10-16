import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTC, setup, simpleStrategy } from "../../../packages/engine/test/fakes.ts";
import { StrategyLibrary } from "../src/lib/library.ts";
import { createApp } from "../src/app.ts";

async function running() {
  const t = setup();
  t.market.set(BTC, 100);
  t.signals.set("go", { value: 1 });
  const d = await t.engine.createDeployment({ strategy: simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, leverage: 1, exits: {}, reentry: "never" }), allocationUsd: 10_000 });
  await t.engine.tick(d.id);
  const app = createApp({
    catalog: { async list() { return []; } },
    marketData: t.market,
    engine: t.engine,
    library: new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-ins-")), "lib.db")),
    signalModes: {},
  });
  const call = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { t, d, call };
}

describe("instructing a running strategy over the API", () => {
  it("previews a plan, changes nothing until applied, then applies it once", async () => {
    const { t, d, call } = await running();
    const prev = (await (await call(`/deployments/${d.id}/instruct`, { text: "set a stop at 10% and sell half" })).json()) as { planId: string; steps: { label: string }[] };
    expect(prev.steps.map((x) => x.label)).toEqual(["Sell 50% of BTC at market, now", "Set a stop at −10% on BTC"]); // it buys once: no later buys to mention
    expect((await t.engine.getSnapshot(d.id))!.positions[0]!.qty).toBeCloseTo(10, 9);

    const stop = (await (await call(`/deployments/${d.id}/instruct`, { text: "stop at 10%" })).json()) as { planId: string; steps: { label: string }[] };
    expect(stop.steps[0]!.label).toMatch(/stop at −10% on BTC/);
    const done = (await (await call(`/deployments/${d.id}/instruct/${stop.planId}/apply`)).json()) as { done: string[] };
    expect(done.done).toHaveLength(1);
    const s = (await t.engine.getSnapshot(d.id))!;
    expect(s.positions[0]!.exits.stopLoss).toEqual({ positionPct: 10 });
    expect(s.deployment.strategy.actions[0]).toMatchObject({ exits: { stopLoss: { positionPct: 10 } } }); // future buys too
    expect((await call(`/deployments/${d.id}/instruct/${stop.planId}/apply`)).status).toBe(410); // only once
  });

  it("sells a position with the button route", async () => {
    const { t, d, call } = await running();
    const p = (await t.engine.getSnapshot(d.id))!.positions[0]!;
    const r = await call(`/deployments/${d.id}/positions/${p.id}/close`, { fraction: 0.25 });
    expect(r.status).toBe(200);
    expect((await t.engine.getSnapshot(d.id))!.positions[0]!.qty).toBeCloseTo(7.5, 9);
    await t.engine.kill(d.id);
    expect((await call(`/deployments/${d.id}/positions/${p.id}/close`, { fraction: 1 })).status).toBe(409);
  });
});

describe("simulated data never trades real money", () => {
  it("refuses a live start on a simulated signal, and allows it as alerts", async () => {
    const t = setup();
    const app = createApp({
      catalog: { async list() { return []; } },
      marketData: t.market,
      engine: t.engine,
      library: new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-sim-")), "lib.db")),
      signalModes: { macro: "simulated" },
    });
    const strategy = simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 100 }, leverage: 1, exits: {} });
    const post = (body: unknown) => app.request("/deployments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const live = await post({ strategy, allocationUsd: 100, mode: "live", confirm: "GO LIVE" });
    expect(live.status).toBe(409);
    expect(((await live.json()) as { error: string }).error).toMatch(/doesn’t have live data/);
    expect((await post({ strategy, allocationUsd: 100, mode: "paper", alertsOnly: true })).status).toBeLessThan(300);
  });
});
