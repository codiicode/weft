import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, U64_MAX, deriveDammV2PoolAddress, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { JupiterSwapBuilder, USDC_MINT, WSOL_MINT } from "@weft/execution";
import { REWARDS, Rewards } from "../lib/rewards.ts";
import { MIGRATION_FEE_OPTION } from "./curve.ts";

/**
 * The treasury: the wallet Weft's server runs $WEFT's money flow from, about every ten minutes.
 *
 *  1. Fees on $WEFT trades: it is the pool's fee claimer. Whatever has built up (on the curve, or in
 *     the locked liquidity after graduation) is claimed in SOL and split on the spot: 2.0/2.4 to the
 *     revenue wallet, 0.4/2.4 buys $WEFT.
 *  2. Weft's strategy fees: each closed day's buyback is bought in 144 slices over the next day,
 *     from the USDC and SOL the treasury holds (Weft tops it up from its fee wallets).
 *  3. Of every buy, 30% is burned in the same run; the rest waits in the day's pots for claims.
 *
 * Small, frequent buys with a tight slippage limit leave nothing worth front-running. The treasury
 * only ever holds a few minutes of token fees, its buyback float and unclaimed rewards.
 */
export interface TreasuryConfig {
  conn: Connection;
  keypair: Keypair;
  mint: PublicKey;
  decimals: number;
  /** The DBC pool of $WEFT (WEFT_DBC_POOL). Absent: no token-fee claims. */
  dbcPool: PublicKey | null;
  /** Where Weft's 2% goes (the fee wallet). */
  revenueWallet: PublicKey;
  jupiter: JupiterSwapBuilder;
  /** Smallest claim worth sending (SOL). Default 0.01. */
  minClaimSol?: number;
  log?: (m: string) => void;
}

const SLIPPAGE_BPS = 100;
/** Don't claim less than this (SOL); the transactions would cost more than they move. */
const MIN_CLAIM_SOL = 0.01;
/** SOL the treasury keeps for transaction fees and token accounts. */
const GAS_RESERVE_SOL = 0.05;
const MIN_BUY_USD = 0.5;

export interface TickResult {
  claimedSol: number;
  protocolSol: number;
  boughtTokens: number;
  burnedTokens: number;
  spentUsd: number;
}

export class Treasury {
  private readonly c: TreasuryConfig;
  private readonly dbc: DynamicBondingCurveClient;
  private readonly damm: CpAmm;
  constructor(c: TreasuryConfig) {
    this.c = c;
    this.dbc = new DynamicBondingCurveClient(c.conn, "confirmed");
    this.damm = new CpAmm(c.conn);
  }

  get address(): PublicKey {
    return this.c.keypair.publicKey;
  }

  private get me() {
    return this.c.keypair.publicKey;
  }
  private ata(owner: PublicKey, mint = this.c.mint) {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }
  private async tokenBalance(account: PublicKey): Promise<bigint> {
    const b = await this.c.conn.getTokenAccountBalance(account).catch(() => null);
    return b ? BigInt(b.value.amount) : 0n;
  }
  private send(ixs: TransactionInstruction[] | Transaction): Promise<string> {
    const tx = ixs instanceof Transaction ? ixs : new Transaction().add(...ixs);
    return sendAndConfirmTransaction(this.c.conn, tx, [this.c.keypair], { commitment: "confirmed" });
  }

  /** USD per SOL from a 1 SOL quote. */
  async solUsd(): Promise<number> {
    const q = (await this.c.jupiter.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: "1000000000", slippageBps: 50, platformFeeBps: 0 } as never)) as { outAmount: string };
    return Number(q.outAmount) / 1e6;
  }

  /* ---------------- 1. fees on $WEFT trades ---------------- */

  /** Claim built-up fees from the curve and, after graduation, from the locked liquidity (lamports each). */
  private async claimTokenFees(): Promise<{ lamports: bigint; stage: "curve" | "pool"; tx: string | null }[]> {
    const pool = this.c.dbcPool;
    if (!pool) return [];
    const min = BigInt(Math.round((this.c.minClaimSol ?? MIN_CLAIM_SOL) * LAMPORTS_PER_SOL));
    const out: { lamports: bigint; stage: "curve" | "pool"; tx: string | null }[] = [];
    // On the curve (and whatever was left there at graduation).
    const metrics = await this.dbc.state.getPoolFeeMetrics(pool).catch(() => null);
    const curveFee = metrics ? BigInt(metrics.current.partnerQuoteFee.toString()) : 0n;
    if (curveFee >= min) {
      // The claim pays out all of it in one transaction (in SOL; the first one also opens the
      // treasury's $WEFT account, which is why the balance change isn't the measure).
      const tx = await this.dbc.partner.claimPartnerTradingFee({ feeClaimer: this.me, payer: this.me, pool, maxBaseAmount: new BN(0), maxQuoteAmount: U64_MAX, receiver: this.me } as never);
      const sig = await this.send(tx);
      await this.unwrapSol();
      out.push({ lamports: curveFee, stage: "curve", tx: sig });
    }
    // After graduation: the treasury's position in the locked DAMM v2 pool.
    const vp = await this.dbc.state.getPool(pool).catch(() => null);
    if (vp?.poolState.isMigrated) {
      const dammPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION]!, this.c.mint, NATIVE_MINT);
      const state = await this.damm.fetchPoolState(dammPool).catch(() => null);
      if (state) {
        for (const p of await this.damm.getUserPositionByPool(dammPool, this.me).catch(() => [])) {
          const fee = getUnClaimLpFee(state, p.positionState);
          const solFee = BigInt((state.tokenBMint.equals(NATIVE_MINT) ? fee.feeTokenB : fee.feeTokenA).toString());
          if (solFee < min) continue;
          const tx = await this.damm.claimPositionFee({
            owner: this.me,
            position: p.position,
            pool: dammPool,
            positionNftAccount: p.positionNftAccount,
            tokenAMint: state.tokenAMint,
            tokenBMint: state.tokenBMint,
            tokenAVault: state.tokenAVault,
            tokenBVault: state.tokenBVault,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            // no receiver: fees go to the owner (the treasury), SOL unwrapped by the same transaction
            feePayer: this.me,
          });
          const sig = await this.send(tx);
          await this.unwrapSol();
          out.push({ lamports: solFee, stage: "pool", tx: sig });
        }
      }
    }
    return out;
  }

  /** Claims may arrive as wrapped SOL: unwrap it so all the treasury's SOL is in one place. */
  private async unwrapSol() {
    const wsol = this.ata(this.me, NATIVE_MINT);
    const info = await this.c.conn.getAccountInfo(wsol).catch(() => null);
    if (info) await this.send([createCloseAccountInstruction(wsol, this.me, this.me)]).catch(() => null);
  }

  /* ---------------- buying ---------------- */

  /** Swap SOL (lamports) or USDC (base units) into $WEFT: through Jupiter, or straight on the curve if Jupiter can't route it yet. */
  private async buy(input: "SOL" | "USDC", amount: bigint): Promise<{ got: bigint; tx: string }> {
    const out = this.ata(this.me);
    const before = await this.tokenBalance(out);
    let sig: string;
    try {
      const quote = await this.c.jupiter.quote({ inputMint: input === "SOL" ? WSOL_MINT : USDC_MINT, outputMint: this.c.mint, amount: amount.toString(), slippageBps: SLIPPAGE_BPS, platformFeeBps: 0 } as never);
      const built = await this.c.jupiter.buildSwap({ quote, userPublicKey: this.me, wrapAndUnwrapSol: true, feeAccount: null } as never);
      built.transaction.sign([this.c.keypair]);
      sig = await this.c.conn.sendRawTransaction(built.transaction.serialize(), { maxRetries: 3 });
      await this.c.conn.confirmTransaction({ signature: sig, blockhash: built.transaction.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
    } catch (e) {
      const vp = input === "SOL" && this.c.dbcPool ? await this.dbc.state.getPool(this.c.dbcPool).catch(() => null) : null;
      if (!vp || vp.poolState.isMigrated) throw e;
      const cfg = (await this.dbc.state.getPoolConfig(vp.poolState.config))!;
      const amountIn = new BN(amount.toString());
      const q = this.dbc.pool.swapQuote({ virtualPool: vp, config: cfg, swapBaseForQuote: false, amountIn, slippageBps: SLIPPAGE_BPS, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: await getCurrentPoint(this.c.conn, cfg.activationType) } as never) as unknown as { minimumAmountOut: BN };
      const tx = await this.dbc.pool.swap2({ owner: this.me, pool: this.c.dbcPool!, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn, minimumAmountOut: q.minimumAmountOut } as never);
      sig = await this.send(tx);
    }
    return { got: (await this.tokenBalance(out)) - before, tx: sig };
  }

  private async burn(raw: bigint): Promise<string | null> {
    if (raw <= 0n) return null;
    return this.send([createBurnCheckedInstruction(this.ata(this.me), this.c.mint, this.me, raw, this.c.decimals)]);
  }

  private async buyAndBurn(rewards: Rewards, input: "SOL" | "USDC", amount: bigint, spentUsd: number, source: "token" | "fees", now: number, r: TickResult) {
    const unit = 10 ** this.c.decimals;
    const { got, tx } = await this.buy(input, amount);
    const bought = Number(got) / unit;
    const burnRaw = BigInt(Math.floor(Rewards.split(bought).burn * unit));
    const burnTx = await this.burn(burnRaw);
    rewards.addBuy({ at: now, source, spentUsd, boughtTokens: bought, burnedTokens: Number(burnRaw) / unit, swapTx: tx, burnTx });
    r.boughtTokens += bought;
    r.burnedTokens += Number(burnRaw) / unit;
    r.spentUsd += spentUsd;
  }

  /* ---------------- one run ---------------- */

  async tick(rewards: Rewards, now = Date.now()): Promise<TickResult> {
    const r: TickResult = { claimedSol: 0, protocolSol: 0, boughtTokens: 0, burnedTokens: 0, spentUsd: 0 };
    const { protocolBps, buybackBps } = REWARDS.tokenFee;
    let px: number | null = null;
    const solUsd = async () => (px ??= await this.solUsd());

    // 1. fees on $WEFT trades: claim, split, buy (plus any buyback a failed run left owed)
    let owed = rewards.owedTokenBuyback();
    for (const claim of await this.claimTokenFees()) {
      const protocol = (claim.lamports * BigInt(protocolBps)) / BigInt(protocolBps + buybackBps);
      const buyback = claim.lamports - protocol;
      const transferTx = protocol > 0n ? await this.send([SystemProgram.transfer({ fromPubkey: this.me, toPubkey: this.c.revenueWallet, lamports: protocol })]) : null;
      rewards.recordTokenFeeClaim({ at: now, stage: claim.stage, claimedSol: Number(claim.lamports) / LAMPORTS_PER_SOL, protocolSol: Number(protocol) / LAMPORTS_PER_SOL, buybackSol: Number(buyback) / LAMPORTS_PER_SOL, claimTx: claim.tx, transferTx });
      r.claimedSol += Number(claim.lamports) / LAMPORTS_PER_SOL;
      r.protocolSol += Number(protocol) / LAMPORTS_PER_SOL;
      owed += buyback;
      rewards.setOwedTokenBuyback(owed);
    }
    if (owed > 0n) {
      try {
        await this.buyAndBurn(rewards, "SOL", owed, (Number(owed) / LAMPORTS_PER_SOL) * (await solUsd()), "token", now, r);
        rewards.setOwedTokenBuyback(0n);
      } catch (e) {
        this.c.log?.(`treasury: token-fee buyback of ${(Number(owed) / LAMPORTS_PER_SOL).toFixed(4)} SOL failed, retrying next run (${(e as Error).message.slice(0, 120)})`);
      }
    }

    // 2. this run's slice of the strategy-fee buyback: USDC first, then SOL above the gas reserve
    let slice = rewards.budgetSlice();
    if (slice >= MIN_BUY_USD) {
      const usdc = await this.tokenBalance(this.ata(this.me, USDC_MINT));
      const useUsdc = BigInt(Math.min(Number(usdc), Math.floor(slice * 1e6)));
      if (Number(useUsdc) / 1e6 >= MIN_BUY_USD) {
        const spent = Number(useUsdc) / 1e6;
        await this.buyAndBurn(rewards, "USDC", useUsdc, spent, "fees", now, r);
        rewards.spendBudget(spent);
        slice -= spent;
      }
      if (slice >= MIN_BUY_USD) {
        const p = await solUsd();
        // never the SOL owed to token-fee buybacks
        const spare = (await this.c.conn.getBalance(this.me)) - GAS_RESERVE_SOL * LAMPORTS_PER_SOL - Number(rewards.owedTokenBuyback());
        const useSol = BigInt(Math.max(0, Math.min(spare, Math.floor((slice / p) * LAMPORTS_PER_SOL))));
        const spent = (Number(useSol) / LAMPORTS_PER_SOL) * p;
        if (spent >= MIN_BUY_USD) {
          await this.buyAndBurn(rewards, "SOL", useSol, spent, "fees", now, r);
          rewards.spendBudget(spent);
          slice -= spent;
        }
      }
      if (slice >= MIN_BUY_USD) this.c.log?.(`treasury: short $${slice.toFixed(2)} for this slice of the buyback (top up USDC or SOL)`);
    }
    return r;
  }

  /** Send claimed $WEFT to a user's wallet (creating their token account if needed). */
  async pay(to: PublicKey, tokens: number): Promise<string> {
    const dest = this.ata(to);
    const raw = BigInt(Math.floor(tokens * 10 ** this.c.decimals));
    if (raw <= 0n) throw new Error("nothing to send");
    return this.send([
      createAssociatedTokenAccountIdempotentInstruction(this.me, dest, to, this.c.mint),
      createTransferCheckedInstruction(this.ata(this.me), this.c.mint, dest, this.me, raw, this.c.decimals),
    ]);
  }
}
