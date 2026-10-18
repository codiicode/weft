import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { associatedTokenAddress, USDC_MINT, WSOL_MINT, type FetchLike } from "@weft/execution";
import type { Engine } from "@weft/engine";

/**
 * What Weft has earned, for the public revenue page:
 *  - product fees: Hyperliquid builder fees (accrued on the venue as builder rewards, claimable by
 *    the builder wallet) and Solana platform fees: what users' swaps paid into the fee wallet's
 *    WSOL/USDC accounts, counted from the chain. Not the accounts' balances: the fee wallet is also
 *    where Weft's share of the $WEFT fees lands, and money Weft moves or swaps there itself isn't new
 *    revenue. Half buys back $WEFT, half is Weft's.
 *  - fees on $WEFT trades: 2.4% of each trade claimed by the treasury (Meteora keeps 0.6%), split
 *    2.0 to Weft and 0.4 to buybacks on every claim. Counted in SOL at today's price.
 */

export const BUYBACK_SHARE = 0.5;

/** One buyback, as the buyback job records it (spent fees → bought tokens → burned some or all). */
export interface BuybackEvent {
  at: number;
  /** "token": from fees on $WEFT trades; "fees": from Weft's strategy fees (the default). */
  source?: "token" | "fees";
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
  /**
   * Owed to buybacks and not bought yet: the token-fee share waiting in the treasury, plus the half
   * of product fees not spent on buybacks so far.
   */
  setAsideUsd: number;
  /** Tokens burned outside the buyback job, e.g. Weft's dev buy at launch. */
  launchBurn: LaunchBurn | null;
  events: BuybackEvent[];
}

/** A burn that isn't a buyback: Weft's dev buy at launch, burned in full. */
export interface LaunchBurn {
  at: number;
  tx: string;
  tokens: number;
}

/** Fees on $WEFT trades, as the treasury claimed and split them (Rewards.stats().tokenFees). */
export interface TokenFees {
  claims: number;
  claimedSol: number;
  protocolSol: number;
  buybackSol: number;
  lastClaimAt: number | null;
}

export interface Earnings {
  hyperliquid: { builder: string; earnedUsd: number; unclaimedUsd: number; claimedUsd: number; accountValueUsd: number } | null;
  solana: { feeWallet: string; wsol: number; usdc: number; sol: number; solUsd: number | null; usd: number } | null;
  /** Fees on $WEFT trades; null before launch. USD at today's SOL price. */
  token: (TokenFees & { treasury: string | null; claimedUsd: number; protocolUsd: number; buybackUsd: number }) | null;
  /** Hyperliquid + Solana product fees, before the split. */
  productUsd: number;
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
  /** Fees on $WEFT trades claimed so far, and the treasury that claims them. */
  tokenFees?: (() => TokenFees) | null;
  treasury?: PublicKey | null;
  /** SOL the treasury holds for token-fee buybacks it hasn't made yet. */
  owedBuybackSol?: () => number;
  launchBurn?: LaunchBurn | null;
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

  const tf = o.tokenFees?.() ?? null;
  const solUsd = o.solana || tf
    ? await f(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT.toBase58()}`, { method: "GET" } as never)
        .then(async (r) => (JSON.parse(await r.text()) as Record<string, { usdPrice?: number }>)[WSOL_MINT.toBase58()]?.usdPrice ?? null)
        .catch(() => null)
    : null;

  let solana: Earnings["solana"] = null;
  if (o.solana) {
    const { conn, feeWallet } = o.solana;
    // Product fees arrive as WSOL and USDC from users' swaps; transactions the fee wallet or the
    // treasury sent themselves (moving or swapping Weft's own money) don't count.
    const own = [feeWallet.toBase58(), ...(o.treasury ? [o.treasury.toBase58()] : [])];
    const [wsol, usdc, lamports] = await Promise.all([
      feesInto(conn, feeWallet, WSOL_MINT, own),
      feesInto(conn, feeWallet, USDC_MINT, own),
      conn.getBalance(feeWallet).catch(() => 0),
    ]);
    solana = { feeWallet: feeWallet.toBase58(), wsol, usdc, sol: lamports / 1e9, solUsd, usd: usdc + (solUsd != null ? wsol * solUsd : 0) };
  }

  let recordedUsd = 0;
  for (const d of await o.engine.listDeployments()) {
    if (d.mode !== "live") continue;
    recordedUsd += (await o.engine.getSnapshot(d.id))?.builderFeesUsd ?? 0;
  }

  const px = solUsd ?? 0;
  const token: Earnings["token"] = tf
    ? { ...tf, treasury: o.treasury?.toBase58() ?? null, claimedUsd: tf.claimedSol * px, protocolUsd: tf.protocolSol * px, buybackUsd: tf.buybackSol * px }
    : null;
  const productUsd = (hyperliquid?.earnedUsd ?? 0) + (solana?.usd ?? 0);
  const totalUsd = productUsd + (token?.claimedUsd ?? 0);
  const buybackUsd = productUsd * BUYBACK_SHARE + (token?.buybackUsd ?? 0);
  const weftUsd = productUsd * (1 - BUYBACK_SHARE) + (token?.protocolUsd ?? 0);

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
    setAsideUsd:
      (o.owedBuybackSol?.() ?? 0) * px + Math.max(0, productUsd * BUYBACK_SHARE - events.filter((e) => (e.source ?? "fees") === "fees").reduce((n, e) => n + e.spentUsd, 0)),
    launchBurn: o.launchBurn ?? null,
    events: [...events].sort((a, b) => b.at - a.at),
  };
  return { hyperliquid, solana, token, productUsd, recordedUsd, totalUsd, buybackUsd, weftUsd, buybacks };
}

/**
 * Everything users' transactions have paid into `owner`'s token account for `mint`: the sum of its
 * increases, skipping transactions paid for by `exclude` (Weft's own wallets). Read from the chain
 * once, then only the new transactions on each call.
 */
const feeScans = new Map<string, { newest: string | null; total: number }>();
async function feesInto(conn: Connection, owner: PublicKey, mint: PublicKey, exclude: string[]): Promise<number> {
  const ata = associatedTokenAddress(owner, mint);
  const key = ata.toBase58();
  const scan = feeScans.get(key) ?? { newest: null, total: 0 };
  const fresh: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(ata, { before, until: scan.newest ?? undefined, limit: 1000 });
    fresh.push(...page.filter((x) => !x.err).map((x) => x.signature));
    if (page.length < 1000) break;
    before = page.at(-1)!.signature;
  }
  if (!fresh.length) return scan.total;
  let total = scan.total;
  for (let i = 0; i < fresh.length; i += 100) {
    const txs = await conn.getParsedTransactions(fresh.slice(i, i + 100), { maxSupportedTransactionVersion: 1 });
    for (const tx of txs) total += received(tx, owner.toBase58(), mint.toBase58(), exclude);
  }
  feeScans.set(key, { newest: fresh[0]!, total });
  return total;
}

/** What one transaction added to `owner`'s `mint` balance, unless one of `exclude` paid for it. */
export function received(tx: ParsedTransactionWithMeta | null, owner: string, mint: string, exclude: string[]): number {
  if (!tx?.meta || exclude.includes(tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? "")) return 0;
  const amt = (list: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]) =>
    Number(list?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.uiAmountString ?? 0);
  return Math.max(0, amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances));
}
