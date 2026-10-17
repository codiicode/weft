import { z } from "zod";
import { Id } from "./signals.ts";
import { SolanaMint } from "./instruments.ts";
import { Instrument, OptionInstrument, TradableInstrument } from "./instruments.ts";

/**
 * Actions: what happens when a trigger fires. Every action names the
 * trigger(s) it listens to in `on`, which is also how graph edges are derived.
 */

/** How big a position is. `native` is in the instrument's quote asset (e.g. SOL for Solana tokens) or contracts. */
export const Size = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("pct_equity"), value: z.number().positive().max(100) }),
  z.object({ unit: z.literal("usd"), value: z.number().positive() }),
  z.object({ unit: z.literal("native"), value: z.number().positive() }),
]);
export type Size = z.infer<typeof Size>;

/**
 * A take-profit / stop-loss level.
 * - `pct`: move from entry in the position's favour (TP) or against it (SL), always positive.
 * - `price`: absolute price.
 * - `prob`: absolute probability, for outcome shares (0–1).
 */
export const Level = z.union([
  /** Price move from entry, in percent. */
  z.object({ pct: z.number().positive().max(1000) }),
  /**
   * Gain or loss on the position, as a percent of the money put in (margin). With leverage L a
   * 1% price move is L% of the position, so { positionPct: 20 } at 20× is a 1% price move.
   * Without leverage it is the same as { pct }.
   */
  z.object({ positionPct: z.number().positive().max(1000) }),
  z.object({ price: z.number().positive() }),
  z.object({ prob: z.number().gt(0).lt(1) }),
]);
export type Level = z.infer<typeof Level>;

export const Exits = z.object({
  takeProfit: Level.optional(),
  stopLoss: Level.optional(),
  trailingStopPct: z.number().positive().max(100).optional(),
  timeExitHours: z.number().positive().optional(),
});
export type Exits = z.infer<typeof Exits>;

export const OrderSpec = z.object({
  type: z.enum(["market", "limit"]).default("market"),
  limitPrice: z.number().positive().optional(),
  maxSlippageBps: z.number().int().positive().max(5_000).optional().describe("Defaults to the risk policy"),
  maxPriceImpactBps: z.number().int().positive().max(5_000).optional(),
});
export type OrderSpec = z.infer<typeof OrderSpec>;

const base = {
  id: Id,
  label: z.string().max(60).optional(),
  on: z.array(Id).min(1).describe("Trigger ids; the action runs when any of them fires"),
};

/** Open a position in a perp, spot pair, Solana token or prediction outcome. */
export const OpenAction = z.object({
  ...base,
  type: z.literal("open"),
  instrument: TradableInstrument,
  side: z.enum(["long", "short"]).describe("Spot, tokens and outcomes are long-only (buy)"),
  size: Size,
  leverage: z.number().min(1).max(50).default(1).describe("Perps only"),
  order: OrderSpec.prefault({}),
  exits: Exits.prefault({}),
  reentry: z
    .enum(["never", "after_close"])
    .default("never")
    .describe("never: fire at most once; after_close: may reopen once the previous position is closed"),
});
export type OpenAction = z.infer<typeof OpenAction>;

export const OptionLeg = z.object({
  instrument: OptionInstrument,
  side: z.enum(["buy", "sell"]),
  ratio: z.number().int().min(1).max(10).default(1),
});
export type OptionLeg = z.infer<typeof OptionLeg>;

/** Multi-leg options position. Must be defined-risk: every sold leg is covered by a bought one. */
export const OptionsAction = z.object({
  ...base,
  type: z.literal("options"),
  legs: z.array(OptionLeg).min(1).max(4),
  size: Size.describe("Premium budget (debit) or max-loss budget (credit)"),
  order: OrderSpec.prefault({}),
  exits: Exits.prefault({}),
  reentry: z.enum(["never", "after_close"]).default("never"),
});
export type OptionsAction = z.infer<typeof OptionsAction>;

/** Close positions opened by this strategy: one instrument, or everything. */
export const CloseAction = z.object({
  ...base,
  type: z.literal("close"),
  target: z.union([z.literal("all"), z.object({ instrument: Instrument })]),
  fraction: z.number().gt(0).max(1).default(1),
});
export type CloseAction = z.infer<typeof CloseAction>;

/** Alert only: no trade. Powers alerts-only strategies. */
export const NotifyAction = z.object({
  ...base,
  type: z.literal("notify"),
  channel: z.enum(["push", "telegram", "email"]).default("push"),
  message: z.string().min(1).max(280),
});
export type NotifyAction = z.infer<typeof NotifyAction>;

/** Whose trades to copy: a Solana wallet (any token it buys) or a Hyperliquid account (any perp it opens). */
export const CopyLeader = z.discriminatedUnion("venue", [
  z.object({ venue: z.literal("solana"), wallet: SolanaMint }),
  z.object({ venue: z.literal("hyperliquid"), trader: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a Hyperliquid address (0x…)") }),
]);
export type CopyLeader = z.infer<typeof CopyLeader>;

/**
 * Copy trading: every new trade the leader makes is copied with this action's own size. Solana:
 * each token the wallet buys is bought (after the usual token checks and a liquidity floor), and
 * sold when the wallet sells it. Hyperliquid: each perp position the account opens is opened the
 * same way (long or short), and closed when it closes. Positions the leader already held when the
 * strategy started are not copied. With `on`, copying only happens while one of those triggers holds.
 */
export const CopyAction = z.object({
  id: Id,
  label: z.string().max(60).optional(),
  type: z.literal("copy"),
  on: z.array(Id).default([]).describe("Optional: copy only while one of these triggers is true"),
  leader: CopyLeader,
  size: Size.describe("Per copied trade: SOL (native) or USD for Solana, USD for Hyperliquid"),
  leverage: z.number().min(1).max(50).optional().describe("Hyperliquid: fixed leverage; omit to use the leader's (capped by risk.maxLeverage)"),
  only: z.array(z.string().min(1)).max(50).optional().describe("Only these coins (Hyperliquid, e.g. BTC) or token mints (Solana)"),
  minLiquidityUsd: z.number().nonnegative().default(100_000).describe("Solana: skip tokens with less liquidity than this"),
  mirrorExits: z.boolean().default(true).describe("Close the copy when the leader closes or sells"),
  maxOpen: z.number().int().min(1).max(50).default(5).describe("Most copied positions open at once"),
  order: OrderSpec.prefault({}),
  exits: Exits.prefault({}),
});
export type CopyAction = z.infer<typeof CopyAction>;

export const Action = z.discriminatedUnion("type", [OpenAction, OptionsAction, CloseAction, NotifyAction, CopyAction]);
export type Action = z.infer<typeof Action>;
