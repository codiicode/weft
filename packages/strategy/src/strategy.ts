import { z } from "zod";
import { Id, Signal } from "./signals.ts";
import { Expr } from "./expr.ts";
import { Action } from "./actions.ts";

/* ------------------------------------------------------------------ */
/* Risk policy                                                          */
/* ------------------------------------------------------------------ */

/**
 * Safety checks on Solana tokens. Advisory by default: a failed check is shown as a heads-up and the
 * buy goes ahead, because the user chose the token. `enforce: true` (the user asked for it) blocks.
 */
export const TokenGates = z.object({
  enforce: z.boolean().default(false),
  minLiquidityUsd: z.number().nonnegative().default(50_000),
  maxTop10HoldersPct: z.number().min(0).max(100).default(35),
  requireMintAuthorityRevoked: z.boolean().default(true),
  requireFreezeAuthorityRevoked: z.boolean().default(true),
  maxPriceImpactBps: z.number().int().positive().default(300),
  minAgeMinutes: z.number().nonnegative().default(0),
  blockIfDevSoldPctAbove: z.number().min(0).max(100).default(50),
});
export type TokenGates = z.infer<typeof TokenGates>;

export const RiskPolicy = z.object({
  maxPositionPct: z.number().positive().max(100).default(10).describe("Max size of one position, % of allocated equity"),
  maxTotalExposurePct: z.number().positive().max(500).default(50),
  maxLeverage: z.number().min(1).max(50).default(5),
  maxDailyLossPct: z.number().positive().max(100).default(10).describe("Opens are blocked for the day after this loss"),
  /** Off by default: stops are added when the user asks for them (or set this to require one everywhere). */
  requireStopLoss: z.boolean().default(false),
  defaultMaxSlippageBps: z.number().int().positive().default(100),
  /**
   * Prediction markets: only buy when the position could be sold straight back for at most this
   * much less (spread + book depth), so a thin market can't trap it.
   */
  maxExitLossPct: z.number().positive().max(100).default(10),
  token: TokenGates.prefault({}),
});
export type RiskPolicy = z.infer<typeof RiskPolicy>;

/* ------------------------------------------------------------------ */
/* Triggers                                                             */
/* ------------------------------------------------------------------ */

export const Trigger = z.object({
  id: Id,
  label: z.string().max(60).optional(),
  when: Expr,
  forMinutes: z.number().nonnegative().optional().describe("Condition must hold continuously this long before it counts as met"),
  cooldownMinutes: z.number().nonnegative().default(0).describe("Minimum time between fires"),
  maxFires: z.number().int().positive().optional().describe("Stop firing after this many times"),
});
export type Trigger = z.infer<typeof Trigger>;

/* ------------------------------------------------------------------ */
/* Strategy document                                                    */
/* ------------------------------------------------------------------ */

export const SCHEMA_VERSION = 1 as const;

/**
 * A strategy is a public, forkable document: signals → triggers → actions,
 * plus the risk policy its author proposes. It carries no wallet, balance or
 * personal sizing; that lives in a Deployment.
 */
export const Strategy = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "slug: lowercase letters, digits and dashes"),
  name: z.string().min(1).max(80),
  thesis: z.string().min(1).max(2_000).describe("The user's thesis in their own words"),
  signals: z.array(Signal).min(1).max(24),
  triggers: z.array(Trigger).min(1).max(24),
  actions: z.array(Action).min(1).max(32),
  risk: RiskPolicy.prefault({}),
  tags: z.array(z.string().min(1).max(24)).max(8).default([]),
  forkedFrom: z.string().optional(),
});
export type Strategy = z.infer<typeof Strategy>;
/** What authors and the LLM write; defaults are filled in on parse. */
export type StrategyInput = z.input<typeof Strategy>;

/* ------------------------------------------------------------------ */
/* Deployment                                                           */
/* ------------------------------------------------------------------ */

/** User-level caps. No defaults on purpose: an absent cap means "no extra restriction". */
export const RiskCaps = z.object({
  maxPositionPct: z.number().positive().max(100).optional(),
  maxTotalExposurePct: z.number().positive().max(500).optional(),
  maxLeverage: z.number().min(1).max(50).optional(),
  maxDailyLossPct: z.number().positive().max(100).optional(),
  requireStopLoss: z.boolean().optional(),
  defaultMaxSlippageBps: z.number().int().positive().optional(),
  token: z
    .object({
      minLiquidityUsd: z.number().nonnegative().optional(),
      maxTop10HoldersPct: z.number().min(0).max(100).optional(),
      requireMintAuthorityRevoked: z.boolean().optional(),
      requireFreezeAuthorityRevoked: z.boolean().optional(),
      maxPriceImpactBps: z.number().int().positive().optional(),
      minAgeMinutes: z.number().nonnegative().optional(),
      blockIfDevSoldPctAbove: z.number().min(0).max(100).optional(),
    })
    .optional(),
});
export type RiskCaps = z.infer<typeof RiskCaps>;

/** A user running a strategy: their mode, capital and personal caps. */
export const Deployment = z.object({
  strategyId: z.string(),
  mode: z.enum(["paper", "live"]).default("paper"),
  allocationUsd: z.number().positive(),
  caps: RiskCaps.default({}).describe("User caps; the stricter of strategy and user wins"),
  approvedAt: z.iso.datetime().optional().describe("Required before live mode"),
});
export type Deployment = z.infer<typeof Deployment>;

/** Strategy risk tightened by the user's caps: the stricter value always wins. */
export function effectiveRisk(strategy: RiskPolicy, caps: RiskCaps = {}): RiskPolicy {
  const min = (a: number, b?: number) => (b == null ? a : Math.min(a, b));
  const max = (a: number, b?: number) => (b == null ? a : Math.max(a, b));
  const t = strategy.token;
  const u = caps.token;
  return {
    maxPositionPct: min(strategy.maxPositionPct, caps.maxPositionPct),
    maxTotalExposurePct: min(strategy.maxTotalExposurePct, caps.maxTotalExposurePct),
    maxLeverage: min(strategy.maxLeverage, caps.maxLeverage),
    maxDailyLossPct: min(strategy.maxDailyLossPct, caps.maxDailyLossPct),
    requireStopLoss: strategy.requireStopLoss || !!caps.requireStopLoss,
    defaultMaxSlippageBps: min(strategy.defaultMaxSlippageBps, caps.defaultMaxSlippageBps),
    maxExitLossPct: strategy.maxExitLossPct ?? 10,
    token: {
      enforce: t.enforce || Boolean((u as { enforce?: boolean } | undefined)?.enforce),
      minLiquidityUsd: max(t.minLiquidityUsd, u?.minLiquidityUsd),
      maxTop10HoldersPct: min(t.maxTop10HoldersPct, u?.maxTop10HoldersPct),
      requireMintAuthorityRevoked: t.requireMintAuthorityRevoked || !!u?.requireMintAuthorityRevoked,
      requireFreezeAuthorityRevoked: t.requireFreezeAuthorityRevoked || !!u?.requireFreezeAuthorityRevoked,
      maxPriceImpactBps: min(t.maxPriceImpactBps, u?.maxPriceImpactBps),
      minAgeMinutes: max(t.minAgeMinutes, u?.minAgeMinutes),
      blockIfDevSoldPctAbove: min(t.blockIfDevSoldPctAbove, u?.blockIfDevSoldPctAbove),
    },
  };
}
