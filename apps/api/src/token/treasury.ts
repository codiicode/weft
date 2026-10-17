import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { JupiterSwapBuilder, USDC_MINT, WSOL_MINT } from "@weft/execution";
import type { RewardDay, Rewards } from "../lib/rewards.ts";

/**
 * The treasury buys each closed day's $WEFT with Weft's Solana fees (the fee wallet's USDC first,
 * then WSOL), burns the burn share, keeps the rest for claims, and pays claims to users' wallets.
 * Hyperliquid builder fees accrue on Hyperliquid in USDC: until they're moved to the fee wallet, a
 * day buys what the wallet holds and the shortfall is reported, never borrowed.
 */
export interface TreasuryConfig {
  conn: Connection;
  /** The fee wallet's key (WEFT_TREASURY_KEY): Solana platform fees land in its token accounts. */
  keypair: Keypair;
  mint: PublicKey;
  decimals: number;
  jupiter: JupiterSwapBuilder;
  log?: (m: string) => void;
}

const SLIPPAGE_BPS = 300;

export class Treasury {
  private readonly c: TreasuryConfig;
  constructor(c: TreasuryConfig) {
    this.c = c;
  }

  get address(): PublicKey {
    return this.c.keypair.publicKey;
  }

  private ata(owner: PublicKey, mint = this.c.mint) {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }

  private async balance(account: PublicKey): Promise<bigint> {
    const b = await this.c.conn.getTokenAccountBalance(account).catch(() => null);
    return b ? BigInt(b.value.amount) : 0n;
  }

  /** Swap `amount` (base units) of `input` into $WEFT; returns the tokens received (base units). */
  private async buy(input: PublicKey, amount: bigint): Promise<{ got: bigint; tx: string }> {
    const me = this.c.keypair.publicKey, out = this.ata(me);
    const before = await this.balance(out);
    const quote = await this.c.jupiter.quote({ inputMint: input, outputMint: this.c.mint, amount: amount.toString(), slippageBps: SLIPPAGE_BPS, platformFeeBps: 0 } as never);
    const built = await this.c.jupiter.buildSwap({ quote, userPublicKey: me, wrapAndUnwrapSol: false, feeAccount: null } as never);
    built.transaction.sign([this.c.keypair]);
    const sig = await this.c.conn.sendRawTransaction(built.transaction.serialize(), { maxRetries: 3 });
    await this.c.conn.confirmTransaction({ signature: sig, blockhash: built.transaction.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
    return { got: (await this.balance(out)) - before, tx: sig };
  }

  /** USD per SOL from a 1 SOL quote. */
  private async solUsd(): Promise<number> {
    const q = (await this.c.jupiter.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: "1000000000", slippageBps: 50, platformFeeBps: 0 } as never)) as { outAmount: string };
    return Number(q.outAmount) / 1e6;
  }

  /** Buy one day's $WEFT, burn the burn share (plus any pool nobody qualified for), record it. */
  async fund(rewards: Rewards, day: RewardDay): Promise<void> {
    const me = this.c.keypair.publicKey, unit = 10 ** this.c.decimals;
    let budget = day.buybackUsd, spent = 0, got = 0n;
    const txs: string[] = [];
    if (budget >= 0.5) {
      const usdc = await this.balance(this.ata(me, USDC_MINT));
      const useUsdc = BigInt(Math.min(Number(usdc), Math.floor(budget * 1e6)));
      if (useUsdc > 10_000n) {
        const r = await this.buy(USDC_MINT, useUsdc);
        got += r.got; txs.push(r.tx); spent += Number(useUsdc) / 1e6; budget -= Number(useUsdc) / 1e6;
      }
      if (budget >= 0.5) {
        const px = await this.solUsd();
        const wsol = await this.balance(this.ata(me, WSOL_MINT));
        const useSol = BigInt(Math.min(Number(wsol), Math.floor((budget / px) * 1e9)));
        if (useSol > 1_000_000n) {
          const r = await this.buy(WSOL_MINT, useSol);
          got += r.got; txs.push(r.tx); spent += (Number(useSol) / 1e9) * px; budget -= (Number(useSol) / 1e9) * px;
        }
      }
      if (budget >= 0.5) this.c.log?.(`rewards ${day.day}: fee wallet short by $${budget.toFixed(2)} (move Hyperliquid builder fees to the fee wallet)`);
    }
    const bought = Number(got) / unit;
    const pools = day.traderPoolUsd + day.creatorPoolUsd + day.burnUsd || 1;
    const traderTokens = (bought * day.traderPoolUsd) / pools, creatorTokens = (bought * day.creatorPoolUsd) / pools;
    const burnRaw = got - BigInt(Math.floor(traderTokens * unit)) - BigInt(Math.floor(creatorTokens * unit));
    let burnTx: string | null = null;
    if (burnRaw > 0n) {
      const tx = new Transaction().add(createBurnCheckedInstruction(this.ata(me), this.c.mint, me, burnRaw, this.c.decimals));
      burnTx = await sendAndConfirmTransaction(this.c.conn, tx, [this.c.keypair], { commitment: "confirmed" });
    }
    rewards.fundDay(day.day, { spentUsd: spent, priceUsd: bought ? spent / bought : null, traderTokens, creatorTokens, burnedTokens: Number(burnRaw > 0n ? burnRaw : 0n) / unit, buyTx: txs.join(",") || null, burnTx });
    this.c.log?.(`rewards ${day.day}: spent $${spent.toFixed(2)}, bought ${bought.toFixed(0)} WEFT, burned ${(Number(burnRaw > 0n ? burnRaw : 0n) / unit).toFixed(0)}`);
  }

  /** Send claimed $WEFT to a user's wallet (creating their token account if needed). */
  async pay(to: PublicKey, tokens: number): Promise<string> {
    const me = this.c.keypair.publicKey, dest = this.ata(to);
    const raw = BigInt(Math.floor(tokens * 10 ** this.c.decimals));
    if (raw <= 0n) throw new Error("nothing to send");
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(me, dest, to, this.c.mint))
      .add(createTransferCheckedInstruction(this.ata(me), this.c.mint, dest, me, raw, this.c.decimals));
    return sendAndConfirmTransaction(this.c.conn, tx, [this.c.keypair], { commitment: "confirmed" });
  }
}

