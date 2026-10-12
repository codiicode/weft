import type { TokenFacts } from "@weft/strategy";
import type { TokenFactsProvider } from "./types.ts";
import type { VenueMarketData } from "./market-data.ts";
import type { RawToken } from "./jupiter/client.ts";
import { authorityRevoked, bondingCurvePct, migrated, tokenAgeMinutes } from "./jupiter/parse.ts";
import type { DexSummary, MintInfo } from "./solana.ts";
import type { Fields } from "./signals/common.ts";

/**
 * Solana token health: the `token_onchain` signal and TokenFacts for the risk engine.
 *
 * Sources, in order: Jupiter Tokens v2 (holders, audit, stats, launchpad) →
 * DexScreener (liquidity / mcap / age / txns when Jupiter lacks them) →
 * Solana RPC getAccountInfo (mint/freeze authority when Jupiter's audit is silent).
 *
 * Not derivable from free public APIs (null in the signal):
 *  - lp_locked            (needs per-pool LP lock/burn analysis: Birdeye / RugCheck / Helius)
 *  - dev_sold_pct         (needs the dev's initial allocation: an indexer such as Helius / Birdeye / GMGN)
 *  - smart_wallet_buys_1h (needs a labelled wallet set: Nansen / GMGN / Birdeye)
 */

export function tokenOnchainFields(t: RawToken | null, d: DexSummary | null, mint: MintInfo | null, now: number): Fields {
  const s1h = t?.stats1h;
  let bsr: number | null = null;
  if (s1h && s1h.sellVolume != null && s1h.sellVolume > 0 && s1h.buyVolume != null) bsr = s1h.buyVolume / s1h.sellVolume;
  else if (d?.buys1h != null && d.sells1h) bsr = d.buys1h / d.sells1h; // tx-count ratio fallback

  let age = t ? tokenAgeMinutes(t, now) : null;
  if (age == null && d?.firstPairAt != null) age = Math.max(0, (now - d.firstPairAt) / 60_000);

  const fromChain = (which: "mint" | "freeze") =>
    mint ? (which === "mint" ? mint.mintAuthority == null : mint.freezeAuthority == null) : null;

  return {
    market_cap_usd: t?.mcap ?? d?.marketCapUsd ?? null,
    liquidity_usd: t?.liquidity ?? d?.liquidityUsd ?? null,
    holders: t?.holderCount ?? null,
    holders_change_1h_pct: s1h?.holderChange ?? null,
    buy_sell_ratio_1h: bsr,
    top10_holders_pct: t?.audit?.topHoldersPercentage ?? null,
    age_minutes: age,
    bonding_curve_pct: t ? bondingCurvePct(t) : null,
    migrated: t ? migrated(t) : null,
    mint_authority_revoked: (t ? authorityRevoked(t, "mint") : null) ?? fromChain("mint"),
    freeze_authority_revoked: (t ? authorityRevoked(t, "freeze") : null) ?? fromChain("freeze"),
    lp_locked: null,
    dev_sold_pct: null,
    smart_wallet_buys_1h: null,
  };
}

/** Fetch everything needed for token_onchain, calling fallbacks only when needed. */
export async function fetchTokenOnchain(md: VenueMarketData, mintAddr: string, now: number): Promise<Fields | null> {
  const ctx = md.ctx;
  const t = await ctx.jup.token(mintAddr).catch(() => null);
  const needDex = !t || t.liquidity == null || t.mcap == null || (!t.firstPool && !t.createdAt);
  const d = needDex ? await ctx.dex.summary(mintAddr).catch(() => null) : null;
  if (!t && !d) return null;
  const needChain = !t || authorityRevoked(t, "mint") == null || authorityRevoked(t, "freeze") == null;
  const mi = needChain ? await ctx.rpc.mintInfo(mintAddr).catch(() => null) : null;
  return tokenOnchainFields(t, d, mi, now);
}

export interface VenueTokenFacts extends TokenFacts {
  /** TokenFacts fields that were unknown and filled with a conservative (or configured) value. */
  unknown: (keyof TokenFacts)[];
}

/**
 * Map token_onchain fields → TokenFacts. Unknowns fail closed (liquidity 0,
 * top-10 100%, authorities not revoked, age 0) except dev_sold_pct, which no
 * free source provides: it uses `devSoldPctWhenUnknown` (default 0).
 */
export function toTokenFacts(f: Fields, priceImpactBps: number | undefined, devSoldPctWhenUnknown = 0): VenueTokenFacts {
  const unknown: (keyof TokenFacts)[] = [];
  const n = (k: keyof TokenFacts, v: unknown, fallback: number): number => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    unknown.push(k);
    return fallback;
  };
  const b = (k: keyof TokenFacts, v: unknown): boolean => {
    if (typeof v === "boolean") return v;
    unknown.push(k);
    return false;
  };
  const facts: VenueTokenFacts = {
    liquidity_usd: n("liquidity_usd", f.liquidity_usd, 0),
    top10_holders_pct: n("top10_holders_pct", f.top10_holders_pct, 100),
    mint_authority_revoked: b("mint_authority_revoked", f.mint_authority_revoked),
    freeze_authority_revoked: b("freeze_authority_revoked", f.freeze_authority_revoked),
    age_minutes: n("age_minutes", f.age_minutes, 0),
    dev_sold_pct: n("dev_sold_pct", f.dev_sold_pct, devSoldPctWhenUnknown),
    unknown,
  };
  if (priceImpactBps != null) facts.price_impact_bps = Math.round(priceImpactBps * 100) / 100;
  return facts;
}

export class VenueTokenFactsProvider implements TokenFactsProvider {
  private readonly md: VenueMarketData;

  constructor(md: VenueMarketData) {
    this.md = md;
  }

  async getTokenFacts(mint: string, opts: { sizeUsd?: number } = {}): Promise<VenueTokenFacts | null> {
    const now = this.md.ctx.now();
    const [fields, quote] = await Promise.all([
      fetchTokenOnchain(this.md, mint, now).catch(() => null),
      opts.sizeUsd && opts.sizeUsd > 0
        ? this.md.getQuote({ kind: "token", chain: "solana", mint, quote: "USDC", route: "auto", assetClass: "crypto" }, { side: "buy", sizeUsd: opts.sizeUsd }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!fields) return null;
    return toTokenFacts(fields, quote?.priceImpactBps, this.md.ctx.opts.devSoldPctWhenUnknown ?? 0);
  }
}
