import { describe, expect, it } from "vitest";
import { defineStrategy } from "@weft/strategy";
import { replay, type ReplayFrame } from "../src/index.ts";
import { MIN, T0, ZERO_SLIPPAGE } from "./fakes.ts";

const WALLET = "Wa11et1111111111111111111111111111111111111";
const A = "TokenA11111111111111111111111111111111111111";
const B = "TokenB11111111111111111111111111111111111111";
const TRADER = "0x1111111111111111111111111111111111111111";

const frame = (m: number, quotes: Record<string, number>): ReplayFrame => ({ now: T0 + m * MIN, signals: {}, quotes });

describe("copy trading", () => {
  it("Solana: copies new buys (not older ones), skips thin tokens, sells when the leader sells", async () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "copy-sol", name: "copy", thesis: "t", signals: [], triggers: [],
      actions: [{ id: "copy", type: "copy", leader: { venue: "solana", wallet: WALLET }, size: { unit: "usd", value: 100 }, minLiquidityUsd: 100_000 }],
    });
    let i = 0;
    const history = [
      [{ id: "old", at: T0 - 60 * MIN, side: "buy" as const, mint: A }],
      [{ id: "old", at: T0 - 60 * MIN, side: "buy" as const, mint: A }, { id: "b1", at: T0 + MIN, side: "buy" as const, mint: A }, { id: "b2", at: T0 + MIN, side: "buy" as const, mint: B }],
      [{ id: "s1", at: T0 + 2 * MIN, side: "sell" as const, mint: A }],
    ];
    const r = await replay(s, [frame(0, {}), frame(1, { [`sol:token:${A}`]: 2, [`sol:token:${B}`]: 1 }), frame(2, { [`sol:token:${A}`]: 3, [`sol:token:${B}`]: 1 })], {
      slippageBps: ZERO_SLIPPAGE,
      tokenFacts: {
        [A]: { liquidity_usd: 500_000, top10_holders_pct: 10, mint_authority_revoked: true, freeze_authority_revoked: true, age_minutes: 999, dev_sold_pct: 0 },
        [B]: { liquidity_usd: 20_000, top10_holders_pct: 10, mint_authority_revoked: true, freeze_authority_revoked: true, age_minutes: 999, dev_sold_pct: 0 },
      },
      copy: { solanaWallet: async () => history[Math.min(i++, history.length - 1)]! },
    });
    expect(r.fills.map((f) => [f.instrumentKey, f.side, f.reason])).toEqual([
      [`sol:token:${A}`, "buy", "entry"],
      [`sol:token:${A}`, "sell", "close_action"],
    ]);
    expect(r.fills[1]!.realizedPnlUsd).toBeGreaterThan(0);
    expect(r.events.some((e) => e.type === "rejected" && /liquidity/.test(e.message))).toBe(true);
  });

  it("Hyperliquid: ignores what the trader already held, copies new and flipped positions, closes with them", async () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "copy-hl", name: "copy", thesis: "t", signals: [], triggers: [], risk: { maxLeverage: 10 },
      actions: [{ id: "copy", type: "copy", leader: { venue: "hyperliquid", trader: TRADER }, size: { unit: "usd", value: 100 } }],
    });
    const books = [
      [{ coin: "ETH", side: "long" as const, leverage: 5 }],
      [{ coin: "ETH", side: "long" as const, leverage: 5 }, { coin: "BTC", side: "long" as const, leverage: 20 }],
      [{ coin: "ETH", side: "long" as const, leverage: 5 }, { coin: "BTC", side: "short" as const, leverage: 20 }],
      [{ coin: "ETH", side: "long" as const, leverage: 5 }],
    ];
    let i = 0;
    const q = { "hl:perp:BTC": 80_000, "hl:perp:ETH": 2_400 };
    const r = await replay(s, [frame(0, q), frame(1, q), frame(2, q), frame(3, q)], {
      slippageBps: ZERO_SLIPPAGE,
      copy: { hyperliquidTrader: async () => ({ positions: books[Math.min(i++, books.length - 1)]! }) },
    });
    expect(r.fills.map((f) => [f.instrumentKey, f.side, f.reason])).toEqual([
      ["hl:perp:BTC", "buy", "entry"],
      ["hl:perp:BTC", "sell", "close_action"],
      ["hl:perp:BTC", "sell", "entry"],
      ["hl:perp:BTC", "buy", "close_action"],
    ]);
    // The leader's 20× is capped by the strategy's 10× limit.
    expect(r.events.find((e) => e.type === "fill" && /BTC/.test(e.message))?.message).toMatch(/10×/);
    expect(r.snapshot.positions).toHaveLength(0);
  });

  it("Hyperliquid inverse: takes the other side of each new position, flips with it, closes with it", async () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "fade-hl", name: "fade", thesis: "t", signals: [], triggers: [], risk: { maxLeverage: 20 },
      actions: [{ id: "fade", type: "copy", leader: { venue: "hyperliquid", trader: TRADER }, size: { unit: "usd", value: 100 }, inverse: true }],
    });
    const books = [
      [],
      [{ coin: "BTC", side: "long" as const, leverage: 10 }],
      [{ coin: "BTC", side: "short" as const, leverage: 10 }],
      [],
    ];
    let i = 0;
    const q = { "hl:perp:BTC": 80_000 };
    const r = await replay(s, [frame(0, q), frame(1, q), frame(2, q), frame(3, q)], {
      slippageBps: ZERO_SLIPPAGE,
      copy: { hyperliquidTrader: async () => ({ positions: books[Math.min(i++, books.length - 1)]! }) },
    });
    expect(r.fills.map((f) => [f.instrumentKey, f.side, f.reason])).toEqual([
      ["hl:perp:BTC", "sell", "entry"], // they long, we short
      ["hl:perp:BTC", "buy", "close_action"],
      ["hl:perp:BTC", "buy", "entry"], // they flip short, we flip long
      ["hl:perp:BTC", "sell", "close_action"],
    ]);
    expect(r.events.find((e) => e.type === "fill" && /BTC/.test(e.message))?.message).toMatch(/10×/);
  });

  it("Hyperliquid: only their longs, faded (\"if they long BTC, short it\")", async () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "fade-longs", name: "fade longs", thesis: "t", signals: [], triggers: [], risk: { maxLeverage: 20 },
      actions: [{ id: "f", type: "copy", leader: { venue: "hyperliquid", trader: TRADER }, size: { unit: "usd", value: 100 }, inverse: true, leaderSide: "long", only: ["BTC"] }],
    });
    const books = [[], [{ coin: "BTC", side: "short" as const, leverage: 5 }], [], [{ coin: "BTC", side: "long" as const, leverage: 5 }]];
    let i = 0;
    const q = { "hl:perp:BTC": 80_000 };
    const r = await replay(s, [frame(0, q), frame(1, q), frame(2, q), frame(3, q)], {
      slippageBps: ZERO_SLIPPAGE,
      copy: { hyperliquidTrader: async () => ({ positions: books[Math.min(i++, books.length - 1)]! }) },
    });
    // their short is ignored; their long is faded with a short
    expect(r.fills.map((f) => [f.instrumentKey, f.side, f.reason])).toEqual([["hl:perp:BTC", "sell", "entry"]]);
  });

  it("X calls: buys each new token an account calls (not older ones), skips thin or unsafe ones, adds a stop and a time exit", async () => {
    const s = defineStrategy({
      schemaVersion: 1, id: "calls", name: "calls", thesis: "t", signals: [], triggers: [],
      actions: [{ id: "c", type: "copy", leader: { venue: "x", account: "@caller" }, size: { unit: "usd", value: 50 } }],
    });
    const C = "TokenC11111111111111111111111111111111111111";
    const feed = [
      [{ id: "old", at: T0 - 60 * MIN, mint: A, symbol: "AAA" }],
      [{ id: "old", at: T0 - 60 * MIN, mint: A, symbol: "AAA" }, { id: "p1", at: T0 + MIN, mint: A, symbol: "AAA" }, { id: "p2", at: T0 + MIN, mint: B, symbol: "BBB" }, { id: "p3", at: T0 + MIN, mint: C, symbol: "CCC" }],
    ];
    let i = 0;
    const safe = { top10_holders_pct: 10, mint_authority_revoked: true, freeze_authority_revoked: true, age_minutes: 999, dev_sold_pct: 0 };
    const r = await replay(s, [frame(0, {}), frame(1, { [`sol:token:${A}`]: 1, [`sol:token:${B}`]: 1, [`sol:token:${C}`]: 1 })], {
      slippageBps: ZERO_SLIPPAGE,
      tokenFacts: { [A]: { ...safe, liquidity_usd: 500_000 }, [B]: { ...safe, liquidity_usd: 5_000 }, [C]: { ...safe, liquidity_usd: 900_000, mint_authority_revoked: false } },
      copy: { xCalls: async () => feed[Math.min(i++, feed.length - 1)]! },
    });
    expect(r.fills.map((f) => [f.instrumentKey, f.side])).toEqual([[`sol:token:${A}`, "buy"]]);
    expect(r.events.filter((e) => e.type === "rejected").map((e) => e.message).join(" ")).toMatch(/liquidity[\s\S]*mint authority/);
    expect(r.snapshot.positions[0]!.exits).toMatchObject({ stopLoss: { pct: 30 }, timeExitHours: 24 });
  });

  it("refuses to fade a Solana wallet (spot tokens can't be shorted)", () => {
    expect(() =>
      defineStrategy({
        schemaVersion: 1, id: "fade-sol", name: "x", thesis: "t", signals: [], triggers: [],
        actions: [{ id: "c", type: "copy", leader: { venue: "solana", wallet: WALLET }, size: { unit: "usd", value: 10 }, inverse: true }],
      }),
    ).toThrow(/Hyperliquid traders only/);
  });
});
