import { Connection, PublicKey } from "@solana/web3.js";
import { associatedTokenAddress, USDC_MINT, WSOL_MINT, type FetchLike } from "@weft/execution";
import type { Engine } from "@weft/engine";

/**
 * What Weft has earned, for the owner's earnings page: Hyperliquid builder fees (accrued on the
 * venue as builder rewards, claimable by the builder wallet) and Solana platform fees (sitting in
 * the fee wallet's WSOL/USDC accounts). Split as decided: half buys back $WEFT, half is Weft's.
 */

export const BUYBACK_SHARE = 0.5;

/** One buyback, as the buyback job records it (spent fees → bought tokens → burned some or all). */
export interface BuybackEvent {
  at: number;
  /** Swap transaction (Solana). */
  tx: string;
  spentUsd: number;
  boughtTokens: number;
  /** Burn transaction, when the bought tokens were burned. */
  burnTx?: string | null;
  burnedTokens?: number;
}

export interface Buybacks {
  /** The token's mint; null before launch. */
  mint: string | null;
  boughtTokens: number;
  spentUsd: number;
  /** From the chain: initial supply − current supply. */
  burnedTokens: number;
  supply: number | null;
  initialSupply: number | null;
  /** Half of revenue, minus what has been spent on buybacks. */
  setAsideUsd: number;
  events: BuybackEvent[];
}

export interface Earnings {
  hyperliquid: { builder: string; earnedUsd: number; unclaimedUsd: number; claimedUsd: number; accountValueUsd: number } | null;
  solana: { feeWallet: string; wsol: number; usdc: number; sol: number; solUsd: number | null; usd: number } | null;
  /** Fees Weft's own records say live runs paid it (engine bookkeeping, both venues). */
  recordedUsd: number;
  totalUsd: number;
  buybackUsd: number;
  weftUsd: number;
  buybacks: Buybacks;
}

export async function earnings(o: {
  engine: Engine;
  hlBaseUrl: string | null;
  builder: string | null;
  solana: { conn: Connection; feeWallet: PublicKey } | null;
  /** The token, once launched: its mint and supply at launch (burns are measured against it). */
  token?: { mint: PublicKey; initialSupply: number; conn: Connection } | null;
  /** Buybacks recorded by the buyback job. */
  buybackLog?: () => BuybackEvent[];
  fetch?: FetchLike;
}): Promise<Earnings> {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const info = async <T>(body: unknown): Promise<T> => {
    const r = await f(`${o.hlBaseUrl}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return JSON.parse(await r.text()) as T;
  };

  let hyperliquid: Earnings["hyperliquid"] = null;
  if (o.hlBaseUrl && o.builder) {
    const [ref, st] = await Promise.all([
      info<{ builderRewards?: string; unclaimedRewards?: string; claimedRewards?: string }>({ type: "referral", user: o.builder }).catch(() => ({}) as Record<string, never>),
      info<{ marginSummary?: { accountValue?: string } }>({ type: "clearinghouseState", user: o.builder }).catch(() => ({}) as Record<string, never>),
    ]);
    hyperliquid = {
      builder: o.builder,
      earnedUsd: Number(ref.builderRewards ?? 0),
      unclaimedUsd: Number(ref.unclaimedRewards ?? 0),
      claimedUsd: Number(ref.claimedRewards ?? 0),
      accountValueUsd: Number(st.marginSummary?.accountValue ?? 0),
    };
  }

  let solana: Earnings["solana"] = null;
  if (o.solana) {
    const { conn, feeWallet } = o.solana;
    const bal = async (mint: PublicKey) => {
      const r = await conn.getTokenAccountBalance(associatedTokenAddress(feeWallet, mint)).catch(() => null);
      return Number(r?.value.uiAmountString ?? 0);
    };
    const [wsol, usdc, lamports, solUsd] = await Promise.all([
      bal(WSOL_MINT),
      bal(USDC_MINT),
      conn.getBalance(feeWallet).catch(() => 0),
      f(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT.toBase58()}`, { method: "GET" } as never)
        .then(async (r) => (JSON.parse(await r.text()) as Record<string, { usdPrice?: number }>)[WSOL_MINT.toBase58()]?.usdPrice ?? null)
        .catch(() => null),
    ]);
    // Fees arrive as WSOL and USDC; the wallet's own SOL is just its gas float, not earnings.
    solana = { feeWallet: feeWallet.toBase58(), wsol, usdc, sol: lamports / 1e9, solUsd, usd: usdc + (solUsd != null ? wsol * solUsd : 0) };
  }

  let recordedUsd = 0;
  for (const d of await o.engine.listDeployments()) {
    if (d.mode !== "live") continue;
    recordedUsd += (await o.engine.getSnapshot(d.id))?.builderFeesUsd ?? 0;
  }

  const totalUsd = (hyperliquid?.earnedUsd ?? 0) + (solana?.usd ?? 0);
  const buybackUsd = totalUsd * BUYBACK_SHARE;

  const events = o.buybackLog?.() ?? [];
  const spentUsd = events.reduce((n, e) => n + e.spentUsd, 0);
  let supply: number | null = null;
  if (o.token) {
    const s = await o.token.conn.getTokenSupply(o.token.mint).catch(() => null);
    supply = s ? Number(s.value.uiAmountString ?? 0) : null;
  }
  const buybacks: Buybacks = {
    mint: o.token?.mint.toBase58() ?? null,
    boughtTokens: events.reduce((n, e) => n + e.boughtTokens, 0),
    spentUsd,
    // The chain is the source of truth for burns: whatever left the supply is gone for good.
    burnedTokens: o.token && supply != null ? Math.max(0, o.token.initialSupply - supply) : events.reduce((n, e) => n + (e.burnedTokens ?? 0), 0),
    supply,
    initialSupply: o.token?.initialSupply ?? null,
    setAsideUsd: Math.max(0, buybackUsd - spentUsd),
    events: [...events].sort((a, b) => b.at - a.at),
  };
  return { hyperliquid, solana, recordedUsd, totalUsd, buybackUsd, weftUsd: totalUsd * (1 - BUYBACK_SHARE), buybacks };
}
