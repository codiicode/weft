import { describe, expect, it } from "vitest";
import { defineStrategy } from "@weft/strategy";
import { replay, type ReplayFrame } from "../src/index.ts";
import { MIN, T0, ZERO_SLIPPAGE } from "./fakes.ts";

const RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
const lend = { kind: "lend" as const, venue: "kamino" as const, market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF", reserve: RESERVE, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 };
const key = `kamino:lend:${RESERVE}`;
const frame = (m: number, price: number): ReplayFrame => ({ now: T0 + m * MIN, signals: { go: { asOf: T0 + m * MIN, fields: { value: 1 } } }, quotes: { [key]: price } });

describe("Kamino lending (practice)", () => {
  it("deposits, earns as the kToken's price rises, and withdraws with no fee", async () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "lend", name: "lend", thesis: "t",
      signals: [{ id: "go", kind: "macro", params: { series: "GO" } }],
      triggers: [{ id: "now", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } }, maxFires: 1 }],
      actions: [{ id: "dep", type: "open", on: ["now"], instrument: lend, side: "long", size: { unit: "usd", value: 1_000 }, exits: { timeExitHours: 0.05 } }],
    });
    const r = await replay(s, [frame(0, 1.2), frame(1, 1.2), frame(2, 1.2006), frame(4, 1.2012)], { slippageBps: ZERO_SLIPPAGE });
    expect(r.fills.map((f) => [f.side, f.reason])).toEqual([["buy", "entry"], ["sell", "time_exit"]]);
    expect(r.fills[0]!.qty).toBeCloseTo(1_000 / 1.2, 6);
    expect(r.fills.reduce((n, f) => n + (f.feeUsd ?? 0), 0)).toBe(0);
    expect(r.fills[1]!.realizedPnlUsd).toBeCloseTo(1_000 * (1.2012 / 1.2 - 1), 4); // the interest
  });

  it("sizes '2 SOL' in SOL, not in kTokens", async () => {
    const solLend = { ...lend, reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 };
    const s = defineStrategy({
      schemaVersion: 1, id: "lend-sol", name: "lend", thesis: "t",
      signals: [{ id: "go", kind: "macro", params: { series: "GO" } }],
      triggers: [{ id: "now", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } }, maxFires: 1 }],
      actions: [{ id: "dep", type: "open", on: ["now"], instrument: solLend, side: "long", size: { unit: "native", value: 2 } }],
    });
    const k = "kamino:lend:d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";
    const f = (m: number): ReplayFrame => ({ now: T0 + m * MIN, signals: { go: { asOf: T0 + m * MIN, fields: { value: 1 } } }, quotes: { [k]: 115.7, "sol:token:So11111111111111111111111111111111111111112": 100 } });
    const r = await replay(s, [f(0), f(1)], { slippageBps: ZERO_SLIPPAGE });
    // 2 SOL at $100 = $200, which buys $200 / $115.70 of kTokens
    expect(r.fills[0]!.qty * r.fills[0]!.price).toBeCloseTo(200, 6);
  });

  it("can't be shorted or levered", () => {
    expect(() => defineStrategy({ schemaVersion: 1, id: "short-lend", name: "x", thesis: "t", signals: [{ id: "go", kind: "macro", params: { series: "GO" } }], triggers: [{ id: "now", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } }], actions: [{ id: "a", type: "open", on: ["now"], instrument: lend, side: "short", size: { unit: "usd", value: 10 } }] })).toThrow(/long/i);
  });
});
