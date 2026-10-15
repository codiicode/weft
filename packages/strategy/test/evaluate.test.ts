import { describe, expect, it } from "vitest";
import { defineStrategy, evaluate, initialState, type EvalInput, type EvalState, type Strategy } from "../src/index.ts";
import { crowdedFade, fedPivot, pumpMomentum } from "../src/examples/index.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

function runner(s: Strategy) {
  let state: EvalState = initialState(s);
  return (input: Partial<EvalInput> & { now: number; signals: EvalInput["signals"] }) => {
    const r = evaluate(s, { equityUsd: 10_000, positions: [], ...input }, state);
    state = r.state;
    return r;
  };
}

const snap = (now: number, fields: Record<string, number | boolean | null>) => ({ asOf: now, fields });

describe("evaluate", () => {
  it("is pure: does not mutate the previous state", () => {
    const s0 = initialState(crowdedFade);
    const frozen = JSON.stringify(s0);
    evaluate(crowdedFade, { now: T0, equityUsd: 1000, signals: { sol_funding: snap(T0, { rate_8h_pct: 0.2, oi_zscore_30d: 3 }) } }, s0);
    expect(JSON.stringify(s0)).toBe(frozen);
  });

  it("treats missing and stale data as unknown, never as true", () => {
    const tick = runner(crowdedFade);
    let r = tick({ now: T0, signals: {} });
    expect(r.triggers[0]).toMatchObject({ id: "crowded", value: null, met: false, fired: false });
    expect(r.triggers[0]!.unknown).toEqual(["sol_funding.rate_8h_pct", "sol_funding.oi_zscore_30d"]);

    // funding default max age is 15 minutes
    r = tick({ now: T0, signals: { sol_funding: { asOf: T0 - 16 * MIN, fields: { rate_8h_pct: 0.2, oi_zscore_30d: 3 } } } });
    expect(r.triggers[0]!.value).toBeNull();
  });

  it("three-valued logic: AND with a false clause is false even if another is unknown", () => {
    const tick = runner(crowdedFade);
    const r = tick({ now: T0, signals: { sol_funding: snap(T0, { rate_8h_pct: 0.01, oi_zscore_30d: null }) } });
    expect(r.triggers.find((t) => t.id === "crowded")!.value).toBe(false);
  });

  it("forMinutes: only met after holding continuously, and a gap resets it", () => {
    const tick = runner(crowdedFade);
    const hot = (t: number) => ({ sol_funding: snap(t, { rate_8h_pct: 0.15, oi_zscore_30d: 2.5 }) });
    expect(tick({ now: T0, signals: hot(T0) }).triggers[0]!.met).toBe(false);
    expect(tick({ now: T0 + 30 * MIN, signals: hot(T0 + 30 * MIN) }).triggers[0]!.met).toBe(false);
    // gap: condition false
    tick({ now: T0 + 40 * MIN, signals: { sol_funding: snap(T0 + 40 * MIN, { rate_8h_pct: 0.05, oi_zscore_30d: 2.5 }) } });
    expect(tick({ now: T0 + 90 * MIN, signals: hot(T0 + 90 * MIN) }).triggers[0]!.met).toBe(false);
    const r = tick({ now: T0 + 151 * MIN, signals: hot(T0 + 151 * MIN) });
    expect(r.triggers[0]).toMatchObject({ met: true, fired: true });
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]).toMatchObject({ type: "open", side: "short", leverage: 2, size: { usd: 800 }, instrumentKey: "hl:perp:SOL" });
  });

  it("fires on the edge, not every tick while true; re-arms after going false", () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "edge", name: "edge", thesis: "t",
      signals: [{ id: "px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" } } }],
      triggers: [{ id: "up", when: { op: "gt", left: { ref: "px.price" }, right: { value: 100 } } }],
      actions: [{ id: "ping", type: "notify", on: ["up"], message: "up" }],
    });
    const tick = runner(s);
    const px = (t: number, price: number) => ({ px: snap(t, { price }) });
    expect(tick({ now: T0, signals: px(T0, 101) }).intents).toHaveLength(1);
    const held = tick({ now: T0 + MIN, signals: px(T0 + MIN, 105) });
    expect(held.intents).toHaveLength(0);
    expect(held.triggers[0]!.held).toBe("already_fired");
    tick({ now: T0 + 2 * MIN, signals: px(T0 + 2 * MIN, 99) });
    const again = tick({ now: T0 + 3 * MIN, signals: px(T0 + 3 * MIN, 102) });
    expect(again.intents).toHaveLength(1);
    expect(again.intents[0]!.key).toBe("edge:ping:up:2");
  });

  it("cooldown delays a re-fire until it expires, while still met", () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "cool", name: "cool", thesis: "t",
      signals: [{ id: "px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" } } }],
      triggers: [{ id: "up", when: { op: "gt", left: { ref: "px.price" }, right: { value: 100 } }, cooldownMinutes: 10 }],
      actions: [{ id: "ping", type: "notify", on: ["up"], message: "up" }],
    });
    const tick = runner(s);
    const px = (t: number, price: number) => ({ px: snap(t, { price }) });
    tick({ now: T0, signals: px(T0, 101) });
    tick({ now: T0 + MIN, signals: px(T0 + MIN, 99) }); // re-arm
    const blocked = tick({ now: T0 + 2 * MIN, signals: px(T0 + 2 * MIN, 101) });
    expect(blocked.triggers[0]!.held).toBe("cooldown");
    const later = tick({ now: T0 + 11 * MIN, signals: px(T0 + 11 * MIN, 101) });
    expect(later.triggers[0]!.fired).toBe(true);
  });

  it("crosses_above needs a prior observation below the line", () => {
    const tick = runner(fedPivot);
    const sig = (t: number, prob: number) => ({ cut_odds: snap(t, { prob }), us2y: snap(t, { change_5d: -0.14 }) });
    expect(tick({ now: T0, signals: sig(T0, 0.7) }).triggers[0]!.fired).toBe(false); // first look: no cross
    tick({ now: T0 + MIN, signals: sig(T0 + MIN, 0.6) });
    const r = tick({ now: T0 + 2 * MIN, signals: sig(T0 + 2 * MIN, 0.68) });
    expect(r.triggers[0]!.fired).toBe(true);
    expect(r.intents.map((i) => i.actionId)).toEqual(["buy_cut", "long_btc", "long_gold"]);
  });

  it("reentry: never fires once; after_close waits for the position to close", () => {
    const tick = runner(crowdedFade);
    const hot = (t: number) => ({ sol_funding: snap(t, { rate_8h_pct: 0.15, oi_zscore_30d: 2.5 }) });
    const cold = (t: number) => ({ sol_funding: snap(t, { rate_8h_pct: 0.01, oi_zscore_30d: 0 }) });
    tick({ now: T0, signals: hot(T0) });
    expect(tick({ now: T0 + 61 * MIN, signals: hot(T0 + 61 * MIN) }).intents.map((i) => i.type)).toEqual(["open"]);
    const pos = [{ actionId: "short_sol", instrumentKey: "hl:perp:SOL", sizeUsd: 800 }];
    tick({ now: T0 + 62 * MIN, signals: cold(T0 + 62 * MIN), positions: pos });
    // a day later (cooldown passed), condition holds again, but position still open → no new open
    const d = T0 + 1_600 * MIN;
    tick({ now: d, signals: hot(d), positions: pos });
    expect(tick({ now: d + 61 * MIN, signals: hot(d + 61 * MIN), positions: pos }).intents).toHaveLength(0);
  });

  it("orders exits before entries in the same tick", () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "flip", name: "flip", thesis: "t",
      signals: [{ id: "px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" } } }],
      triggers: [{ id: "go", when: { op: "gt", left: { ref: "px.price" }, right: { value: 1 } } }],
      actions: [
        { id: "buy", type: "open", on: ["go"], instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" }, side: "long", size: { unit: "usd", value: 100 }, exits: { stopLoss: { pct: 5 } } },
        { id: "out", type: "close", on: ["go"], target: "all" },
      ],
    });
    const r = evaluate(s, { now: T0, equityUsd: 1000, signals: { px: snap(T0, { price: 2 }) } });
    expect(r.intents.map((i) => i.type)).toEqual(["close", "open"]);
  });

  it("memecoin entry: price level + bullish social + on-chain flow + LP locked, held 5 min", () => {
    const tick = runner(pumpMomentum);
    const signals = (t: number, lpLocked: boolean) => ({
      pump_px: snap(t, { price: 0.0038 }),
      pump_social: snap(t, { sentiment: 0.55, mentions_change_1h_pct: 240 }),
      pump_chain: snap(t, { buy_sell_ratio_1h: 1.6, lp_locked: lpLocked, dev_sold_pct: 0 }),
    });
    expect(tick({ now: T0, signals: signals(T0, false) }).triggers[0]!.value).toBe(false);
    tick({ now: T0 + MIN, signals: signals(T0 + MIN, true) });
    const r = tick({ now: T0 + 6 * MIN, signals: signals(T0 + 6 * MIN, true) });
    expect(r.intents.map((i) => `${i.type}:${i.actionId}`)).toEqual(["open:buy_pump", "notify:alert_entry"]);
    const open = r.intents[0]!;
    expect(open.type === "open" && open.size).toEqual({ native: 0.5, fixed: true });
    expect(open.type === "open" && open.order.maxSlippageBps).toBe(100); // policy default filled in
  });
});
