import { describe, expect, it } from "vitest";
import { validateStrategy, type StrategyInput, nakedLegs } from "../src/index.ts";
import { crowdedFade, PUMP_MINT } from "../src/examples/index.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const errorsOf = (s: unknown) => {
  const r = validateStrategy(s);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

const minimal = (): StrategyInput => ({
  schemaVersion: 1,
  id: "test",
  name: "test",
  thesis: "t",
  signals: [{ id: "px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" } } }],
  triggers: [{ id: "up", when: { op: "gt", left: { ref: "px.price" }, right: { value: 100 } } }],
  actions: [
    {
      id: "buy",
      type: "open",
      on: ["up"],
      instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" },
      side: "long",
      size: { unit: "pct_equity", value: 5 },
      exits: { stopLoss: { pct: 5 } },
    },
  ],
});

describe("validateStrategy", () => {
  it("accepts a minimal strategy and fills defaults", () => {
    const r = validateStrategy(minimal());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy.risk.maxLeverage).toBe(5);
      expect(r.strategy.risk.token.minLiquidityUsd).toBe(50_000);
      const a = r.strategy.actions[0]!;
      expect(a.type === "open" && a.leverage).toBe(1);
    }
  });

  it("rejects refs to unknown signals and fields", () => {
    const s = minimal();
    s.triggers[0]!.when = { op: "and", args: [
      { op: "gt", left: { ref: "nope.price" }, right: { value: 1 } },
      { op: "gt", left: { ref: "px.sentiment" }, right: { value: 1 } },
    ] };
    const e = errorsOf(s);
    expect(e.some((m) => m.includes('no signal with id "nope"'))).toBe(true);
    expect(e.some((m) => m.includes('no field "sentiment"'))).toBe(true);
  });

  it("rejects boolean fields used as numbers and vice versa", () => {
    const s = minimal();
    s.signals.push({ id: "chain", kind: "token_onchain", params: { mint: PUMP_MINT } });
    s.triggers[0]!.when = { op: "and", args: [
      { op: "gt", left: { ref: "chain.lp_locked" }, right: { value: 0 } },
      { op: "is", ref: "chain.holders", value: true },
    ] };
    const e = errorsOf(s);
    expect(e.filter((m) => m.includes("is a boolean field but is used as a number"))).toHaveLength(1);
    expect(e.filter((m) => m.includes("is a number field but is used as a boolean"))).toHaveLength(1);
  });

  it("holds without a stop by default; requireStopLoss demands one, except on bounded-loss outcome buys", () => {
    const plain = minimal();
    const p = plain.actions[0]!;
    if (p.type === "open") p.exits = {};
    expect(errorsOf(plain)).toEqual([]);

    const s = minimal();
    s.risk = { ...s.risk, requireStopLoss: true };
    const a = s.actions[0]!;
    if (a.type === "open") a.exits = {};
    expect(errorsOf(s).some((m) => m.includes("stop-loss is required"))).toBe(true);

    const o = minimal();
    o.risk = { ...o.risk, requireStopLoss: true };
    o.actions[0] = { id: "yes", type: "open", on: ["up"], instrument: { kind: "outcome", venue: "hyperliquid", market: "m", outcome: "YES" }, side: "long", size: { unit: "usd", value: 10 } };
    expect(errorsOf(o)).toEqual([]);
  });

  it("rejects shorting long-only instruments and leverage outside perps", () => {
    const s = minimal();
    s.actions[0] = { id: "x", type: "open", on: ["up"], instrument: { kind: "token", chain: "solana", mint: PUMP_MINT }, side: "short", size: { unit: "native", value: 1 }, leverage: 2, exits: { stopLoss: { pct: 10 } } };
    const e = errorsOf(s);
    expect(e.some((m) => m.includes("can only be bought"))).toBe(true);
    expect(e.some((m) => m.includes("leverage only applies to perps"))).toBe(true);
  });

  it("enforces strategy caps on leverage and size", () => {
    const s = minimal();
    const a = s.actions[0]!;
    if (a.type === "open") { a.leverage = 20; a.size = { unit: "pct_equity", value: 40 }; }
    const e = errorsOf(s);
    expect(e.some((m) => m.includes("exceeds the strategy max"))).toBe(true);
    expect(e.some((m) => m.includes("exceeds maxPositionPct"))).toBe(true);
  });

  it("rejects ticker-only tokens: a mint address is required", () => {
    const s = minimal();
    s.signals.push({ id: "t", kind: "token_onchain", params: { mint: "PUMP" } });
    expect(errorsOf(s).some((m) => m.includes("base58 Solana mint"))).toBe(true);
  });

  it("rejects duplicate ids and dangling `on`", () => {
    const s = clone(crowdedFade) as StrategyInput;
    s.actions[1]!.id = "crowded";
    s.actions[0]!.on = ["ghost"];
    const e = errorsOf(s);
    expect(e.some((m) => m.includes('duplicate id "crowded"'))).toBe(true);
    expect(e.some((m) => m.includes('no trigger with id "ghost"'))).toBe(true);
  });

  it("rejects naked option shorts but allows spreads", () => {
    const leg = (strike: number, side: "buy" | "sell", expiry = "2026-12-25") => ({
      instrument: { kind: "option" as const, venue: "derive" as const, underlying: "ETH", expiry, strike, right: "call" as const },
      side,
      ratio: 1,
    });
    expect(nakedLegs([leg(4800, "buy"), leg(5400, "sell")])).toEqual([]);
    expect(nakedLegs([leg(5400, "sell")])).toHaveLength(1);
    // long leg expiring before the short one does not cover it
    expect(nakedLegs([leg(4800, "buy", "2026-11-27"), leg(5400, "sell", "2026-12-25")])).toHaveLength(1);
  });

  it("returns zod issues with readable paths", () => {
    const s = minimal() as Record<string, unknown>;
    s.schemaVersion = 2;
    const e = errorsOf(s);
    expect(e[0]).toMatch(/^schemaVersion: /);
  });
});

describe("liquidity ranges", () => {
  it("allows one-sided ranges and refuses ones that end below where they start", async () => {
    const { LpRange, describePctRange } = await import("../src/actions.ts");
    expect(LpRange.safeParse({ lowerPct: 50, upperPct: 0 }).success).toBe(true);
    expect(LpRange.safeParse({ lowerPct: 50, upperPct: -10 }).success).toBe(true);
    expect(LpRange.safeParse({ lowerPct: -5, upperPct: 20 }).success).toBe(true);
    expect(LpRange.safeParse({ lowerPct: -5, upperPct: 3 }).success).toBe(false);
    expect(LpRange.safeParse({ lower: 10, upper: 5 }).success).toBe(false);
    expect(describePctRange({ lowerPct: 20, upperPct: 5 })).toBe("from 20% below to 5% above the price");
    expect(describePctRange({ lowerPct: 50, upperPct: 0 })).toBe("from 50% below to the price");
    expect(describePctRange({ lowerPct: 50, upperPct: -10 })).toBe("from 50% below to 10% below the price");
  });
});

describe("Papertrade warnings", () => {
  const pt = (leverage: number, stop?: number) =>
    validateStrategy({
      schemaVersion: 1, id: "pt", name: "pt", thesis: "pt",
      signals: [{ id: "go", kind: "macro", params: { series: "GO" } }],
      triggers: [{ id: "t", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } }],
      actions: [{ id: "a", type: "open", on: ["t"], instrument: { kind: "synth", venue: "papertrade", symbol: "BTC" }, side: "long", size: { unit: "usd", value: 10 }, leverage, ...(stop ? { exits: { stopLoss: { positionPct: stop } } } : {}) }],
      risk: { maxLeverage: 1000 },
    } as never);
  const msgs = (r: ReturnType<typeof pt>) => (r.ok ? r.warnings.map((w) => w.message).join(" | ") : "invalid");
  it("says plainly that no stop protects at 500× and up", () => {
    expect(msgs(pt(1000, 20))).toMatch(/faster than any stop can close it/);
  });
  it("flags a stop too close to the bust price, and leaves a sensible one alone", () => {
    expect(msgs(pt(100, 90))).toMatch(/too close to the bust price/);
    expect(msgs(pt(100, 25))).not.toMatch(/too close/);
  });
});
