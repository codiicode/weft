import type { RiskPolicy } from "./strategy.ts";
import type { Intent, OpenIntent, OptionsIntent } from "./evaluate.ts";

/**
 * Pre-trade risk checks. Runs on every intent *after* the evaluator and
 * *before* any venue adapter. Pure and fail-closed: if a check needs data
 * that is missing, the intent is rejected.
 *
 * Exits (close) and notifications are never blocked: you can always get out.
 */

/** On-chain facts about a Solana token, same field names as the token_onchain signal. */
export interface TokenFacts {
  liquidity_usd: number;
  top10_holders_pct: number;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  age_minutes: number;
  dev_sold_pct: number;
  /** Quoted price impact for this order size, in bps (from the router quote). */
  price_impact_bps?: number;
}

export interface RiskContext {
  risk: RiskPolicy;
  equityUsd: number;
  /** Current notional exposure of this deployment (size × leverage), USD. */
  exposureUsd: number;
  /** Today's realized + unrealized P&L, % of equity (negative = loss). */
  dailyPnlPct: number;
  /** Kill switch: when true, nothing opens. */
  halted?: boolean;
  /** USD prices of quote assets / instruments, to size-check `native` orders (e.g. { SOL: 180 }). */
  usdPrices?: Record<string, number>;
  /** Safety facts per mint, required for token buys. */
  tokenFacts?: Record<string, TokenFacts | undefined>;
}

export interface Rejection {
  intent: Intent;
  reasons: string[];
}

export interface RiskResult {
  approved: Intent[];
  rejected: Rejection[];
}

export function checkIntents(intents: Intent[], ctx: RiskContext): RiskResult {
  const approved: Intent[] = [];
  const rejected: Rejection[] = [];
  let exposure = ctx.exposureUsd;

  for (const intent of intents) {
    if (intent.type === "close" || intent.type === "notify") {
      approved.push(intent);
      continue;
    }
    const reasons: string[] = [];
    const r = ctx.risk;

    if (ctx.halted) reasons.push("kill switch is active");
    if (ctx.dailyPnlPct <= -r.maxDailyLossPct)
      reasons.push(`daily loss ${ctx.dailyPnlPct.toFixed(1)}% hit the ${r.maxDailyLossPct}% limit`);

    const usd = sizeUsd(intent, ctx);
    if (usd == null) {
      reasons.push("cannot size-check: no USD price for a native-sized order");
    } else {
      const maxPos = (ctx.equityUsd * r.maxPositionPct) / 100;
      if (usd > maxPos + 1e-9) reasons.push(`size $${usd.toFixed(2)} exceeds max position $${maxPos.toFixed(2)} (${r.maxPositionPct}%)`);
      const lev = intent.type === "open" ? intent.leverage : 1;
      const notional = usd * lev;
      const maxExp = (ctx.equityUsd * r.maxTotalExposurePct) / 100;
      if (exposure + notional > maxExp + 1e-9)
        reasons.push(`exposure would be $${(exposure + notional).toFixed(2)}, above max $${maxExp.toFixed(2)} (${r.maxTotalExposurePct}%)`);
      if (intent.type === "open" && intent.leverage > r.maxLeverage) reasons.push(`leverage ${intent.leverage}× above max ${r.maxLeverage}×`);
      if (!reasons.length) exposure += notional;
    }

    if (intent.type === "open" && intent.instrument.kind === "token") reasons.push(...tokenGateReasons(intent, ctx));

    if (reasons.length) rejected.push({ intent, reasons });
    else approved.push(intent);
  }
  return { approved, rejected };
}

function sizeUsd(intent: OpenIntent | OptionsIntent, ctx: RiskContext): number | null {
  if (intent.size.usd != null) return intent.size.usd;
  const native = intent.size.native!;
  const priceKey =
    intent.type === "open" && intent.instrument.kind === "token" ? intent.instrument.quote : intent.type === "open" ? intent.instrumentKey : null;
  const px = priceKey ? ctx.usdPrices?.[priceKey] : undefined;
  return px == null ? null : native * px;
}

export function tokenGateReasons(intent: OpenIntent, ctx: RiskContext): string[] {
  if (intent.instrument.kind !== "token") return [];
  const g = ctx.risk.token;
  const f = ctx.tokenFacts?.[intent.instrument.mint];
  if (!f) return ["no on-chain safety data for this token"];
  const out: string[] = [];
  if (f.liquidity_usd < g.minLiquidityUsd) out.push(`liquidity $${Math.round(f.liquidity_usd)} below $${g.minLiquidityUsd}`);
  if (f.top10_holders_pct > g.maxTop10HoldersPct) out.push(`top-10 holders own ${f.top10_holders_pct}% (max ${g.maxTop10HoldersPct}%)`);
  if (g.requireMintAuthorityRevoked && !f.mint_authority_revoked) out.push("mint authority not revoked");
  if (g.requireFreezeAuthorityRevoked && !f.freeze_authority_revoked) out.push("freeze authority not revoked");
  if (f.age_minutes < g.minAgeMinutes) out.push(`token is ${f.age_minutes} min old (min ${g.minAgeMinutes})`);
  if (f.dev_sold_pct > g.blockIfDevSoldPctAbove) out.push(`dev sold ${f.dev_sold_pct}% (max ${g.blockIfDevSoldPctAbove}%)`);
  const maxImpact = intent.order.maxPriceImpactBps ?? g.maxPriceImpactBps;
  if (f.price_impact_bps == null) out.push("no price-impact quote for this size");
  else if (f.price_impact_bps > maxImpact) out.push(`price impact ${f.price_impact_bps} bps above ${maxImpact} bps`);
  return out;
}
