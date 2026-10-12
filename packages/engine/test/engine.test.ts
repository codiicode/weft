import { describe, expect, it } from "vitest";
import { defineStrategy } from "@weft/strategy";
import { BTC, ETH, FakeSignals, HEALTHY, HOUR, MIN, MINT, SOL_PERP, T0, TOKEN, YES, setup, simpleStrategy } from "./fakes.ts";

const perp = (side: "long" | "short", exits: Record<string, unknown>, leverage = 1, extra: Record<string, unknown> = {}) =>
  simpleStrategy({ instrument: BTC, side, size: { unit: "usd", value: 1_000 }, leverage, exits, ...extra });

async function opened(strategy: ReturnType<typeof simpleStrategy>, price = 100, over: Parameters<typeof setup>[0] = {}) {
  const t = setup(over);
  t.market.set(BTC, price);
  t.signals.set("go", { value: 1 });
  const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
  await t.engine.tick(d.id);
  const at = async (px: number, dt = MIN) => {
    t.clock.t += dt;
    t.market.set(BTC, px);
    await t.engine.tick(d.id);
    return t.engine.getSnapshot(d.id).then((s) => s!);
  };
  return { ...t, d, at };
}

describe("entries and fees", () => {
  it("fills a market order at mid + slippage and charges taker + builder fees", async () => {
    const t = setup({ slippageBps: undefined }); // default model: perps 2 bps
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }, 2), allocationUsd: 10_000 });
    await t.engine.tick(d.id);

    const [fill] = await t.engine.getFills(d.id);
    expect(fill).toMatchObject({ side: "buy", reason: "entry", instrumentKey: "hl:perp:BTC" });
    expect(fill!.price).toBeCloseTo(100.02, 8);
    expect(fill!.qty * fill!.price).toBeCloseTo(2_000, 6); // 1000 margin × 2
    expect(fill!.feeUsd).toBeCloseTo(2_000 * 9.5e-4, 8); // 4.5 taker + 5 builder bps

    const s = (await t.engine.getSnapshot(d.id))!;
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.sizeUsd).toBeCloseTo(1_000, 6);
    expect(s.cashUsd).toBeCloseTo(10_000 - 1_000 - 1.9, 6);
    expect(s.builderFeesUsd).toBeCloseTo(1.0, 8);
    expect(s.feesUsd).toBeCloseTo(1.9, 8);
    expect(s.unrealizedPnlUsd).toBeLessThan(0); // marked at mid, bought above it
    expect(s.equityUsd).toBeCloseTo(s.cashUsd + 1_000 + s.unrealizedPnlUsd, 8);
    expect(s.equityUsd).toBeCloseTo(10_000 + s.realizedPnlUsd + s.unrealizedPnlUsd, 8);
    expect(s.returnPct).toBeCloseTo(((s.equityUsd - 10_000) / 10_000) * 100, 8);
    expect(s.signalValues).toEqual({ "go.value": 1 });
    expect(s.triggers[0]).toMatchObject({ id: "entry", fired: true });
    expect(s.equityCurve.length).toBeGreaterThanOrEqual(2);

    const types = (await t.engine.getEvents(d.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["status", "trigger_met", "trigger_fired", "intent", "fill", "tick"]));
    expect(await t.engine.getEvents(d.id, { limit: 2 })).toHaveLength(2);
    expect(await t.engine.getEvents(d.id, { sinceTs: T0 })).toHaveLength(0);
  });

  it("uses the size-aware fillPrice and respects maxSlippageBps", async () => {
    const t = setup();
    t.market.set(BTC, { price: 100, fillPrice: 100.5 });
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    expect((await t.engine.getFills(d.id))[0]!.price).toBe(100.5);
    expect(t.market.requests.find((r) => r.key === "hl:perp:BTC" && r.req?.sizeUsd)?.req).toEqual({ side: "buy", sizeUsd: 1_000 });

    const t2 = setup();
    t2.market.set(BTC, { price: 100, fillPrice: 102 }); // 200 bps > default 100
    t2.signals.set("go", { value: 1 });
    const d2 = await t2.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 10_000 });
    await t2.engine.tick(d2.id);
    expect(await t2.engine.getFills(d2.id)).toHaveLength(0);
    const rej = (await t2.engine.getEvents(d2.id)).find((e) => e.type === "rejected");
    expect(rej?.message).toMatch(/slippage 200\.0 bps above max 100 bps/);
  });

  it("limit orders fill only at or through the limit", async () => {
    const strategy = perp("long", { stopLoss: { pct: 5 } }, 1, { order: { type: "limit", limitPrice: 99 } });
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    expect(await t.engine.getFills(d.id)).toHaveLength(0);
    const ev = (await t.engine.getEvents(d.id)).find((e) => e.type === "rejected");
    expect(ev?.data).toMatchObject({ pending: true });

    const t2 = setup();
    t2.market.set(BTC, 98.5);
    t2.signals.set("go", { value: 1 });
    const d2 = await t2.engine.createDeployment({ strategy, allocationUsd: 10_000 });
    await t2.engine.tick(d2.id);
    expect((await t2.engine.getFills(d2.id))[0]!.price).toBe(98.5);
  });

  it("charges HIP-4 outcomes only the builder fee", async () => {
    const t = setup();
    t.market.set(YES, 0.5);
    t.signals.set("go", { value: 1 });
    const strategy = simpleStrategy({ instrument: YES, side: "long", size: { unit: "usd", value: 500 }, exits: { takeProfit: { prob: 0.8 } } });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    const [f] = await t.engine.getFills(d.id);
    expect(f!.qty).toBeCloseTo(1_000, 8);
    expect(f!.feeUsd).toBeCloseTo(0.25, 8);
    expect((await t.engine.getSnapshot(d.id))!.builderFeesUsd).toBeCloseTo(0.25, 8);
  });
});

describe("exit monitoring", () => {
  it("long take-profit with leveraged P&L on margin", async () => {
    const t = await opened(perp("long", { takeProfit: { pct: 10 }, stopLoss: { pct: 5 } }, 3));
    let s = await t.at(105);
    expect(s.positions[0]!.qty).toBeCloseTo(30, 8);
    expect(s.positions[0]!.unrealizedPnlUsd).toBeCloseTo(150, 8);
    expect(s.positions[0]!.unrealizedPnlPct).toBeCloseTo(15, 8); // 5% move × 3
    s = await t.at(111);
    expect(s.positions).toHaveLength(0);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit).toMatchObject({ reason: "take_profit", side: "sell", price: 111 });
    const fee = 30 * 111 * 9.5e-4;
    expect(exit.realizedPnlUsd).toBeCloseTo(330 - fee, 6);
    expect(s.equityUsd).toBeCloseTo(10_000 + 330 - fee - 30 * 100 * 9.5e-4, 6);
    expect(s.cashUsd).toBeCloseTo(s.equityUsd, 8);
  });

  it("long stop-loss", async () => {
    const t = await opened(perp("long", { stopLoss: { pct: 5 } }, 2));
    await t.at(96);
    expect((await t.engine.getFills(t.d.id))).toHaveLength(1);
    await t.at(94.9);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit.reason).toBe("stop_loss");
    expect(exit.realizedPnlUsd!).toBeCloseTo(20 * -5.1 - 20 * 94.9 * 9.5e-4, 6);
  });

  it("short take-profit and stop-loss mirror the long side", async () => {
    const tp = await opened(perp("short", { takeProfit: { pct: 10 }, stopLoss: { pct: 5 } }, 3));
    expect((await tp.engine.getFills(tp.d.id))[0]!.side).toBe("sell");
    let s = await tp.at(95);
    expect(s.positions[0]!.unrealizedPnlUsd).toBeCloseTo(150, 8);
    await tp.at(89);
    expect((await tp.engine.getFills(tp.d.id))[1]).toMatchObject({ reason: "take_profit", side: "buy" });

    const sl = await opened(perp("short", { takeProfit: { pct: 10 }, stopLoss: { pct: 5 } }, 3));
    s = await sl.at(104);
    expect(s.positions).toHaveLength(1);
    await sl.at(106);
    const exit = (await sl.engine.getFills(sl.d.id))[1]!;
    expect(exit.reason).toBe("stop_loss");
    expect(exit.realizedPnlUsd! + exit.feeUsd).toBeCloseTo(-30 * 6, 6);
  });

  it("absolute price levels", async () => {
    const t = await opened(perp("short", { takeProfit: { price: 90 }, stopLoss: { price: 110 } }));
    await t.at(91);
    await t.at(90);
    expect((await t.engine.getFills(t.d.id))[1]!.reason).toBe("take_profit");
  });

  it("trailing stop for longs follows the peak", async () => {
    const t = await opened(perp("long", { stopLoss: { pct: 50 }, trailingStopPct: 5 }));
    let s = await t.at(120);
    expect(s.positions[0]!.peakPrice).toBe(120);
    s = await t.at(115);
    expect(s.positions).toHaveLength(1);
    s = await t.at(113.9);
    expect(s.positions).toHaveLength(0);
    expect((await t.engine.getFills(t.d.id))[1]).toMatchObject({ reason: "trailing_stop", price: 113.9 });
  });

  it("trailing stop for shorts follows the trough", async () => {
    const t = await opened(perp("short", { stopLoss: { pct: 50 }, trailingStopPct: 5 }));
    let s = await t.at(80);
    expect(s.positions[0]!.peakPrice).toBe(80);
    s = await t.at(83.9);
    expect(s.positions).toHaveLength(1);
    await t.at(84.1);
    const exit = (await t.engine.getFills(t.d.id))[1]!;
    expect(exit).toMatchObject({ reason: "trailing_stop", side: "buy" });
    expect(exit.realizedPnlUsd! + exit.feeUsd).toBeCloseTo(10 * (100 - 84.1), 6);
  });

  it("time exit, long and short", async () => {
    for (const side of ["long", "short"] as const) {
      const t = await opened(perp(side, { stopLoss: { pct: 50 }, timeExitHours: 2 }));
      let s = await t.at(100, HOUR);
      expect(s.positions).toHaveLength(1);
      s = await t.at(101, HOUR);
      expect(s.positions).toHaveLength(0);
      expect((await t.engine.getFills(t.d.id))[1]!.reason).toBe("time_exit");
      // reentry "never": the still-true trigger does not reopen
      await t.at(101, HOUR);
      expect(await t.engine.getFills(t.d.id)).toHaveLength(2);
    }
  });

  it("outcome shares exit on absolute probability levels", async () => {
    const strategy = simpleStrategy({ instrument: YES, side: "long", size: { unit: "usd", value: 500 }, exits: { takeProfit: { prob: 0.8 }, stopLoss: { prob: 0.3 } } });
    for (const [px, reason, pnl] of [
      [0.82, "take_profit", 320],
      [0.28, "stop_loss", -220],
    ] as const) {
      const t = setup();
      t.market.set(YES, 0.5);
      t.signals.set("go", { value: 1 });
      const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
      await t.engine.tick(d.id);
      t.clock.t += MIN;
      t.market.set(YES, 0.6);
      await t.engine.tick(d.id);
      expect((await t.engine.getSnapshot(d.id))!.positions).toHaveLength(1);
      t.clock.t += MIN;
      t.market.set(YES, px);
      await t.engine.tick(d.id);
      const exit = (await t.engine.getFills(d.id))[1]!;
      expect(exit.reason).toBe(reason);
      expect(exit.realizedPnlUsd! + exit.feeUsd).toBeCloseTo(pnl, 6);
    }
  });

  it("position signals drive closes (pnl_pct)", async () => {
    const strategy = defineStrategy({
      schemaVersion: 1,
      id: "pos-test",
      name: "Pos",
      thesis: "close if down 3%",
      signals: [
        { id: "go", kind: "macro", params: { series: "GO" } },
        { id: "pos", kind: "position", params: { instrument: BTC } },
      ],
      triggers: [
        { id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } },
        { id: "drawdown", when: { op: "lt", left: { ref: "pos.pnl_pct" }, right: { value: -3 } } },
      ],
      actions: [
        { id: "buy", type: "open", on: ["entry"], instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, exits: { stopLoss: { pct: 50 } } },
        { id: "cut", type: "close", on: ["drawdown"], target: { instrument: BTC } },
      ],
    });
    const t = await opened(strategy as never);
    let s = await t.at(98);
    expect(s.signalValues["pos.pnl_pct"]).toBeCloseTo(-2, 8);
    s = await t.at(96);
    expect(s.positions).toHaveLength(0);
    expect((await t.engine.getFills(t.d.id))[1]!.reason).toBe("close_action");
  });
});

describe("risk", () => {
  it("rejects a position above maxPositionPct", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const strategy = simpleStrategy({ instrument: BTC, side: "long", size: { unit: "usd", value: 2_000 }, exits: { stopLoss: { pct: 5 } } });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    expect(await t.engine.getFills(d.id)).toHaveLength(0);
    expect((await t.engine.getEvents(d.id)).find((e) => e.type === "rejected")?.message).toMatch(/exceeds max position/);
  });

  it("user caps tighten the strategy (effectiveRisk)", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 10_000, caps: { maxPositionPct: 5 } });
    await t.engine.tick(d.id);
    expect(await t.engine.getFills(d.id)).toHaveLength(0);
  });

  it("enforces total exposure (size × leverage) across intents and open positions", async () => {
    const strategy = defineStrategy({
      schemaVersion: 1,
      id: "exposure-test",
      name: "Exposure",
      thesis: "two levered longs",
      signals: [{ id: "go", kind: "macro", params: { series: "GO" } }],
      triggers: [{ id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } }],
      actions: [
        { id: "a", type: "open", on: ["entry"], instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, leverage: 3, exits: { stopLoss: { pct: 5 } } },
        { id: "b", type: "open", on: ["entry"], instrument: ETH, side: "long", size: { unit: "usd", value: 1_000 }, leverage: 3, exits: { stopLoss: { pct: 5 } } },
      ],
    });
    const t = setup();
    t.market.set(BTC, 100).set(ETH, 10);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    expect((await t.engine.getFills(d.id)).map((f) => f.instrumentKey)).toEqual(["hl:perp:BTC"]);
    expect((await t.engine.getEvents(d.id)).find((e) => e.type === "rejected")?.message).toMatch(/exposure would be/);
  });

  it("blocks new opens after the daily loss limit (realized today + unrealized)", async () => {
    const strategy = defineStrategy({
      schemaVersion: 1,
      id: "daily-loss",
      name: "Daily loss",
      thesis: "second entry after a drawdown",
      signals: [
        { id: "go", kind: "macro", params: { series: "GO" } },
        { id: "go2", kind: "macro", params: { series: "GO2" } },
      ],
      triggers: [
        { id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } },
        { id: "entry2", when: { op: "gt", left: { ref: "go2.value" }, right: { value: 0 } } },
      ],
      actions: [
        { id: "a", type: "open", on: ["entry"], instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, leverage: 4, exits: { stopLoss: { pct: 50 } } },
        { id: "b", type: "open", on: ["entry2"], instrument: ETH, side: "long", size: { unit: "usd", value: 100 }, exits: { stopLoss: { pct: 10 } } },
      ],
    });
    const t = setup();
    t.market.set(BTC, 100).set(ETH, 10);
    t.signals.set("go", { value: 1 }).set("go2", { value: 0 });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000, caps: { maxDailyLossPct: 5 } });
    await t.engine.tick(d.id);
    t.clock.t += MIN;
    t.market.set(BTC, 85); // 40 × −15 = −600 unrealized
    t.signals.set("go2", { value: 1 });
    await t.engine.tick(d.id);
    expect(await t.engine.getFills(d.id)).toHaveLength(1);
    const rej = (await t.engine.getEvents(d.id)).find((e) => e.type === "rejected");
    expect(rej?.message).toMatch(/daily loss -6\.0% hit the 5% limit/);
  });
});

describe("Solana tokens", () => {
  const strategy = simpleStrategy({
    instrument: TOKEN,
    side: "long",
    size: { unit: "native", value: 0.5 },
    order: { maxPriceImpactBps: 200 },
    exits: { stopLoss: { pct: 20 } },
  });

  async function run(facts: typeof HEALTHY | null, solPrice: number | null = 180) {
    const t = setup();
    t.market.set(TOKEN, 0.004);
    if (solPrice != null) t.market.set(SOL_PERP, solPrice);
    t.tokenFacts.facts = facts;
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    return { ...t, d, fills: await t.engine.getFills(d.id), events: await t.engine.getEvents(d.id) };
  }

  it("buys when the token is healthy, sizing native SOL via usdPrices", async () => {
    const r = await run(HEALTHY);
    expect(r.tokenFacts.calls).toEqual([{ mint: MINT, sizeUsd: 90 }]);
    expect(r.fills).toHaveLength(1);
    const f = r.fills[0]!;
    expect(f.qty * f.price).toBeCloseTo(90, 8); // 0.5 SOL × $180
    expect(f.feeUsd).toBeCloseTo(90 * 0.005 + 0.002, 8); // 50 bps platform + network
    expect((await r.engine.getSnapshot(r.d.id))!.builderFeesUsd).toBeCloseTo(0.45, 8);
  });

  it("blocks the buy when token gates fail", async () => {
    const r = await run({ ...HEALTHY, mint_authority_revoked: false, top10_holders_pct: 60 });
    expect(r.fills).toHaveLength(0);
    const rej = r.events.find((e) => e.type === "rejected")!;
    expect(rej.message).toMatch(/mint authority not revoked/);
    expect(rej.message).toMatch(/top-10 holders own 60%/);
  });

  it("fails closed without on-chain facts or a SOL price", async () => {
    expect((await run(null)).events.find((e) => e.type === "rejected")?.message).toMatch(/no on-chain safety data/);
    expect((await run(HEALTHY, null)).events.find((e) => e.type === "rejected")?.message).toMatch(/no USD price for a native-sized order/);
  });
});

describe("signals", () => {
  it("stale data does not fire", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { asOf: T0 - 2 * HOUR, fields: { value: 1 } }); // macro budget is 1h
    const d = await t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    const s = (await t.engine.getSnapshot(d.id))!;
    expect(s.triggers[0]).toMatchObject({ value: null, fired: false, unknown: ["go.value"] });
    expect(await t.engine.getFills(d.id)).toHaveLength(0);
  });

  it("provider failures become warnings and unknowns, never crashes or fires", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", new Error("feed down"));
    const d = await t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    t.clock.t += MIN;
    await t.engine.tick(d.id);
    const ev = await t.engine.getEvents(d.id);
    expect(ev.filter((e) => e.type === "warning" && /feed down/.test(e.message))).toHaveLength(1); // rate-limited
    expect(await t.engine.getFills(d.id)).toHaveLength(0);
  });

  it("times out slow providers and warns about kinds with no provider", async () => {
    const strategy = defineStrategy({
      schemaVersion: 1,
      id: "missing-provider",
      name: "Missing",
      thesis: "news has no provider",
      signals: [
        { id: "go", kind: "macro", params: { series: "GO" } },
        { id: "headlines", kind: "news", params: { query: "btc etf" } },
      ],
      triggers: [{ id: "entry", when: { op: "and", args: [{ op: "gt", left: { ref: "go.value" }, right: { value: 0 } }, { op: "gt", left: { ref: "headlines.sentiment" }, right: { value: 0 } }] } }],
      actions: [{ id: "n", type: "notify", on: ["entry"], message: "hi" }],
    });
    const macroOnly = new FakeSignals(["macro"]).set("go", () => new Promise(() => {}));
    const t2 = setup({ signalProviders: [macroOnly], signalTimeoutMs: 20 });
    const d = await t2.engine.createDeployment({ strategy, allocationUsd: 1_000 });
    await t2.engine.tick(d.id);
    const msgs = (await t2.engine.getEvents(d.id)).filter((e) => e.type === "warning").map((e) => e.message);
    expect(msgs.some((m) => /No provider for news/.test(m))).toBe(true);
    expect(msgs.some((m) => /timed out/.test(m))).toBe(true);
    expect((await t2.engine.getEvents(d.id)).some((e) => e.type === "notify")).toBe(false);
  });
});

describe("actions and controls", () => {
  const twoLegs = defineStrategy({
    schemaVersion: 1,
    id: "close-test",
    name: "Close",
    thesis: "open two, trim one, close all",
    signals: [
      { id: "go", kind: "macro", params: { series: "GO" } },
      { id: "trim", kind: "macro", params: { series: "TRIM" } },
      { id: "out", kind: "macro", params: { series: "OUT" } },
    ],
    triggers: [
      { id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } },
      { id: "trim_now", when: { op: "gt", left: { ref: "trim.value" }, right: { value: 0 } } },
      { id: "exit", when: { op: "gt", left: { ref: "out.value" }, right: { value: 0 } } },
    ],
    actions: [
      { id: "a", type: "open", on: ["entry"], instrument: BTC, side: "long", size: { unit: "usd", value: 1_000 }, exits: { stopLoss: { pct: 50 } } },
      { id: "b", type: "open", on: ["entry"], instrument: ETH, side: "short", size: { unit: "usd", value: 500 }, exits: { stopLoss: { pct: 50 } } },
      { id: "half", type: "close", on: ["trim_now"], target: { instrument: BTC }, fraction: 0.5 },
      { id: "flat", type: "close", on: ["exit"], target: "all" },
      { id: "ping", type: "notify", on: ["exit"], message: "flat" },
    ],
  });

  it("partial close by instrument, then close-all, then notify", async () => {
    const t = setup();
    t.market.set(BTC, 100).set(ETH, 10);
    t.signals.set("go", { value: 1 }).set("trim", { value: 0 }).set("out", { value: 0 });
    const d = await t.engine.createDeployment({ strategy: twoLegs, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    expect((await t.engine.getSnapshot(d.id))!.positions).toHaveLength(2);

    t.clock.t += MIN;
    t.market.set(BTC, 110);
    t.signals.set("trim", { value: 1 });
    await t.engine.tick(d.id);
    let s = (await t.engine.getSnapshot(d.id))!;
    const btc = s.positions.find((p) => p.instrumentKey === "hl:perp:BTC")!;
    expect(btc.qty).toBeCloseTo(5, 8);
    expect(btc.sizeUsd).toBeCloseTo(500, 8);
    const trimFill = (await t.engine.getFills(d.id))[2]!;
    expect(trimFill).toMatchObject({ reason: "close_action", qty: 5 });
    expect(trimFill.realizedPnlUsd! + trimFill.feeUsd).toBeCloseTo(50, 8);

    t.clock.t += MIN;
    t.signals.set("out", { value: 1 });
    await t.engine.tick(d.id);
    s = (await t.engine.getSnapshot(d.id))!;
    expect(s.positions).toHaveLength(0);
    expect((await t.engine.getFills(d.id)).slice(3).map((f) => f.reason)).toEqual(["close_action", "close_action"]);
    const notify = (await t.engine.getEvents(d.id)).find((e) => e.type === "notify");
    expect(notify).toMatchObject({ message: "flat", data: { channel: "push" } });
    expect(s.equityUsd).toBeCloseTo(s.cashUsd, 8);
  });

  it("kill switch closes everything at market and stops the deployment", async () => {
    const t = setup();
    t.market.set(BTC, 100).set(ETH, 10);
    t.signals.set("go", { value: 1 }).set("trim", { value: 0 }).set("out", { value: 0 });
    const events: string[] = [];
    const unsub = t.engine.subscribe((e) => events.push(e.type));
    const d = await t.engine.createDeployment({ strategy: twoLegs, allocationUsd: 10_000 });
    await t.engine.tick(d.id);
    t.clock.t += MIN;
    t.market.set(BTC, 95);
    await t.engine.kill(d.id);
    const s = (await t.engine.getSnapshot(d.id))!;
    expect(s.deployment.status).toBe("killed");
    expect(s.positions).toHaveLength(0);
    expect((await t.engine.getFills(d.id)).slice(2).map((f) => f.reason)).toEqual(["kill", "kill"]);
    expect(events).toContain("status");
    unsub();

    const before = (await t.engine.getEvents(d.id, { limit: 1000 })).length;
    t.clock.t += MIN;
    await t.engine.tick(d.id);
    expect((await t.engine.getEvents(d.id, { limit: 1000 })).length).toBe(before);
    await expect(t.engine.resume(d.id)).rejects.toThrow(/cannot go from killed/);
  });

  it("pause stops ticking, resume restarts it", async () => {
    const t = setup();
    t.market.set(BTC, 100);
    t.signals.set("go", { value: 1 });
    const d = await t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 10_000 });
    await t.engine.pause(d.id);
    await t.engine.tick(d.id);
    expect(await t.engine.getFills(d.id)).toHaveLength(0);
    await t.engine.resume(d.id);
    await t.engine.tick(d.id);
    expect(await t.engine.getFills(d.id)).toHaveLength(1);
    await t.engine.stop(d.id);
    expect((await t.engine.listDeployments())[0]!.status).toBe("stopped");
  });

  it("rejects invalid strategies and non-paper modes", async () => {
    const t = setup();
    await expect(t.engine.createDeployment({ strategy: { id: "x" } as never, allocationUsd: 1 })).rejects.toThrow(/invalid strategy/);
    await expect(
      t.engine.createDeployment({ strategy: perp("long", { stopLoss: { pct: 5 } }), allocationUsd: 1, mode: "live" as never })
    ).rejects.toThrow(/paper/);
  });
});
