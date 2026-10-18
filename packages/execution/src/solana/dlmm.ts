import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { createRequire } from "node:module";
import type DLMMClass from "@meteora-ag/dlmm";

// The SDK's ESM build has a broken directory import (anchor/utils/bytes); its CommonJS build works.
const dlmmLib = createRequire(import.meta.url)("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm");
// module.exports is the DLMM class itself (with the helpers as properties); ESM interop puts it on `default`.
const DLMM = ((dlmmLib as { default?: unknown }).default ?? dlmmLib) as typeof DLMMClass;
const { StrategyType } = dlmmLib;
import type { ExecutionResult, Executor, OrderRequest } from "../types.ts";
import { inspectSwapTransaction } from "./inspect.ts";
import type { JupiterExecutor, JupiterRpc } from "./executor.ts";
import type { JupiterSwapBuilder } from "./jupiter.ts";
import { LP_ALLOWED_PROGRAMS, USDC_MINT, WSOL_MINT } from "./programs.ts";
import type { Signer } from "./signer.ts";

/**
 * Engine `Executor` for liquidity in Meteora DLMM pools, from the user's own Solana wallet.
 *
 * Opening (`phase: "open"`, `notionalUsd`, `lp.lower/upper`):
 *  1. read the pool and turn the price range into bins (at most `maxBins`, one position);
 *  2. split the deposit between the two tokens the way the range and shape need at the current
 *     price, and get each token that isn't SOL by swapping SOL through Jupiter (the same
 *     inspected, policy-signed swaps as token trades). A one-sided range needs only one token: a
 *     range below the price in a TOKEN-SOL pool takes SOL alone, with no swap at all;
 *  3. one transaction: create the position (a fresh account Weft generates, owned by the user)
 *     and add the liquidity, inspected before the user's signer signs it.
 * Closing (`phase: "close"`, `lp.position`): withdraw everything, claim the fees and close the
 * position (its rent goes back to the user), then swap what came out back to SOL.
 *
 * The fill is booked in $1 units like practice: an open fills `qty` = USD that went in at 1, a
 * close at what came out per unit. Weft's fee is the platform fee on those swaps.
 */

/** A DLMM position created with one transaction holds this many bins. */
export const DLMM_MAX_BINS = 69;

export interface DlmmExecutorConfig {
  conn: Connection;
  signer: Signer;
  /** The user's token executor: SOL → token before depositing, token → SOL after withdrawing. */
  swaps: JupiterExecutor;
  /** For SOL's USD price. */
  jupiter: JupiterSwapBuilder;
  rpc: JupiterRpc;
  maxPriorityFeeLamports?: number;
  /** Durable record of sent orders by clientId (no order is sent twice, even across restarts). */
  sentStore?: { get(clientId: string): string | null; set(clientId: string, signature: string): void };
  log?: (m: string) => void;
}

/**
 * Share of a new position's value that goes in as the base token at price p: an even
 * (constant-liquidity) spread for "spot", or bins weighted by their distance from p for "bid_ask".
 * A range entirely below p is all quote token (0), entirely above it all base (1).
 */
export function baseShareAt(p: number, lower: number, upper: number, shape: "spot" | "bid_ask" = "spot"): number {
  if (p <= lower) return 1;
  if (p >= upper) return 0;
  if (shape === "bid_ask") {
    let above = 0, total = 0;
    for (let k = 0; k < 64; k++) {
      const q = lower * Math.pow(upper / lower, (k + 0.5) / 64), w = Math.abs(Math.log(q / p));
      total += w;
      if (q > p) above += w;
    }
    return total > 0 ? above / total : 0.5;
  }
  const sa = Math.sqrt(lower), sb = Math.sqrt(upper), sp = Math.sqrt(p);
  const x = (1 / sp - 1 / sb) * p, y = sp - sa;
  return x / (x + y);
}

export class DlmmExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly cfg: DlmmExecutorConfig;
  private readonly sent = new Map<string, string>();
  constructor(cfg: DlmmExecutorConfig) {
    this.cfg = cfg;
  }

  private get user(): PublicKey {
    return this.cfg.signer.publicKey;
  }

  async execute(req: OrderRequest): Promise<ExecutionResult> {
    try {
      const i = req.instrument;
      if (i.kind !== "lp") return { status: "rejected", reason: `DlmmExecutor cannot trade ${i.kind}` };
      if (!req.lp) return { status: "rejected", reason: "liquidity orders need their range and prices" };
      const already = this.sent.get(req.clientId) ?? this.cfg.sentStore?.get(req.clientId) ?? null;
      if (already) return { status: "rejected", reason: `duplicate: ${req.clientId} already sent as ${already}` };
      return req.phase === "open" ? await this.open(req, new PublicKey(i.pool)) : await this.close(req, new PublicKey(i.pool));
    } catch (e) {
      return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async solUsd(): Promise<number> {
    const q = await this.cfg.jupiter.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 0 });
    return Number(q.outAmount) / 1e6;
  }

  /* ---------------- open ---------------- */

  private async open(req: OrderRequest, pool: PublicKey): Promise<ExecutionResult> {
    const lp = req.lp!;
    const usd = req.notionalUsd;
    if (!(usd! > 0)) return { status: "rejected", reason: "a deposit needs a USD amount" };
    const dlmm = await DLMM.create(this.cfg.conn, pool);
    const xMint = dlmm.lbPair.tokenXMint, yMint = dlmm.lbPair.tokenYMint;
    const xDec = dlmm.tokenX.mint.decimals, yDec = dlmm.tokenY.mint.decimals;
    const minBinId = dlmm.getBinIdFromPrice(Number(DLMM.getPricePerLamport(xDec, yDec, lp.lower)), true);
    const maxBinId = dlmm.getBinIdFromPrice(Number(DLMM.getPricePerLamport(xDec, yDec, lp.upper)), false);
    const bins = maxBinId - minBinId + 1;
    if (bins > DLMM_MAX_BINS)
      return { status: "rejected", reason: `this range spans ${bins} price steps in this pool (bin step ${dlmm.lbPair.binStep}); a position holds up to ${DLMM_MAX_BINS}. Narrow the range, or use the pair's pool with a bigger bin step` };

    // What each side is worth, and how much of each the range needs at the pool's current price.
    const active = await dlmm.getActiveBin();
    const price = Number(dlmm.fromPricePerLamport(Number(active.price)));
    const shape = lp.shape ?? "spot";
    const share = baseShareAt(price, lp.lower, lp.upper, shape);
    const solUsd = await this.solUsd();
    const quoteUsd = yMint.equals(WSOL_MINT) ? solUsd : yMint.equals(USDC_MINT) ? 1 : lp.quoteUsd;
    const baseUsd = price * quoteUsd;
    const fees = { usd: 0, builder: 0 };
    const x = await this.acquire(xMint, xDec, usd! * share, baseUsd, solUsd, `${req.clientId}:x`, fees);
    const y = await this.acquire(yMint, yDec, usd! * (1 - share), quoteUsd, solUsd, `${req.clientId}:y`, fees);
    if (x === 0n && y === 0n) return { status: "rejected", reason: "nothing to deposit" };

    // One token only: keep to the bins on its side of the price (the active bin takes it too).
    const lo = y === 0n ? Math.max(minBinId, active.binId) : minBinId;
    const hi = x === 0n ? Math.min(maxBinId, active.binId) : maxBinId;
    if (lo > hi) return { status: "rejected", reason: "the range has no bins on the side of the price this deposit is in" };
    const position = Keypair.generate();
    const built = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      user: this.user,
      totalXAmount: new BN(x.toString()),
      totalYAmount: new BN(y.toString()),
      strategy: { minBinId: lo, maxBinId: hi, strategyType: shape === "bid_ask" ? StrategyType.BidAsk : StrategyType.Spot, ...(y === 0n ? { singleSidedX: true } : {}) },
      slippage: 1,
    });
    const wrap = (xMint.equals(WSOL_MINT) ? x : 0n) + (yMint.equals(WSOL_MINT) ? y : 0n);
    const sig = await this.send(built, req.clientId, { extraSigners: [position], maxWrapLamports: wrap + 10_000n });
    const depositedUsd = (Number(x) / 10 ** xDec) * baseUsd + (Number(y) / 10 ** yDec) * quoteUsd;
    fees.usd += this.networkUsd(2, solUsd);
    this.cfg.log?.(`added ${depositedUsd.toFixed(2)} USD of liquidity to ${pool.toBase58().slice(0, 6)} in bins ${lo}–${hi} (${shape}), position ${position.publicKey.toBase58()}: ${sig}`);
    return { status: "filled", qty: depositedUsd, price: 1, markPrice: 1, feeUsd: fees.usd, builderFeeUsd: fees.builder, slippageBps: 0, lp: { position: position.publicKey.toBase58() } };
  }

  /**
   * Have `usd` worth of `mint` ready to deposit, in atomic units. SOL is deposited as is (the
   * liquidity transaction wraps it); any other token is bought with SOL through the swap executor,
   * and what landed in the wallet (never more than the swap brought) is what goes in.
   */
  private async acquire(mint: PublicKey, decimals: number, usd: number, unitUsd: number, solUsd: number, clientId: string, fees: { usd: number; builder: number }): Promise<bigint> {
    if (usd < 0.01) return 0n;
    if (mint.equals(WSOL_MINT)) return BigInt(Math.floor((usd / solUsd) * 1e9));
    const before = this.cfg.rpc.tokenBalance ? await this.cfg.rpc.tokenBalance(this.user, mint) : 0n;
    const r = await this.cfg.swaps.execute(
      { clientId, instrument: { kind: "token", chain: "solana", mint: mint.toBase58(), quote: "SOL", route: "auto", assetClass: "crypto" }, instrumentKey: `sol:token:${mint.toBase58()}`, side: "buy", phase: "open", notionalUsd: usd },
      Date.now(),
    );
    if (r.status !== "filled") throw new Error(`couldn't get ${mint.toBase58().slice(0, 6)} for the deposit: ${r.reason}`);
    fees.usd += r.feeUsd;
    fees.builder += r.builderFeeUsd;
    const bought = BigInt(Math.floor(r.qty * 10 ** decimals));
    if (!this.cfg.rpc.tokenBalance) return bought;
    // The quote and what landed can differ a little: deposit what's there from this swap.
    for (let k = 0; k < 6; k++) {
      const now = await this.cfg.rpc.tokenBalance(this.user, mint);
      if (now > before) return now - before < bought ? now - before : bought;
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`the ${mint.toBase58().slice(0, 6)} bought for the deposit didn't show up in the wallet`);
  }

  /* ---------------- close ---------------- */

  private async close(req: OrderRequest, pool: PublicKey): Promise<ExecutionResult> {
    const lp = req.lp!;
    if (!lp.position) return { status: "rejected", reason: "no position to withdraw from" };
    const dlmm = await DLMM.create(this.cfg.conn, pool);
    const positionKey = new PublicKey(lp.position);
    const pos = await dlmm.getPosition(positionKey);
    if (!pos.positionData.owner.equals(this.user)) return { status: "rejected", reason: "that position isn't the user's" };
    const xMint = dlmm.lbPair.tokenXMint, yMint = dlmm.lbPair.tokenYMint;
    const xDec = dlmm.tokenX.mint.decimals, yDec = dlmm.tokenY.mint.decimals;
    const d = pos.positionData;
    const xOut = BigInt(d.totalXAmountExcludeTransferFee.add(d.feeXExcludeTransferFee).toString());
    const yOut = BigInt(d.totalYAmountExcludeTransferFee.add(d.feeYExcludeTransferFee).toString());

    const txs = await dlmm.removeLiquidity({ user: this.user, position: positionKey, fromBinId: d.lowerBinId, toBinId: d.upperBinId, bps: new BN(10_000), shouldClaimAndClose: true });
    const list = Array.isArray(txs) ? txs : [txs];
    for (const [k, tx] of list.entries()) await this.send(tx, `${req.clientId}:${k}`, { extraSigners: [], maxWrapLamports: 0n });

    // Everything that came out goes back to SOL.
    const solUsd = await this.solUsd();
    const active = await dlmm.getActiveBin();
    const price = Number(dlmm.fromPricePerLamport(Number(active.price)));
    const quoteUsd = yMint.equals(WSOL_MINT) ? solUsd : yMint.equals(USDC_MINT) ? 1 : lp.quoteUsd;
    const baseUsd = price * quoteUsd;
    const fees = { usd: this.networkUsd(list.length, solUsd), builder: 0 };
    for (const [mint, dec, amount, side] of [[xMint, xDec, xOut, "x"], [yMint, yDec, yOut, "y"]] as const) {
      if (mint.equals(WSOL_MINT) || amount === 0n) continue;
      const r = await this.cfg.swaps.execute(
        { clientId: `${req.clientId}:settle-${side}`, instrument: { kind: "token", chain: "solana", mint: mint.toBase58(), quote: "SOL", route: "auto", assetClass: "crypto" }, instrumentKey: `sol:token:${mint.toBase58()}`, side: "sell", phase: "open", qty: Number(amount) / 10 ** dec },
        Date.now(),
      );
      if (r.status === "filled") {
        fees.usd += r.feeUsd;
        fees.builder += r.builderFeeUsd;
      } else this.cfg.log?.(`withdrew from ${lp.position.slice(0, 6)}, but swapping ${side} back to SOL failed (it stays in the wallet): ${r.reason}`);
    }
    const outUsd = (Number(xOut) / 10 ** xDec) * baseUsd + (Number(yOut) / 10 ** yDec) * quoteUsd;
    const qty = req.qty ?? 0;
    if (!(qty > 0)) return { status: "rejected", reason: "a withdrawal needs the position's units" };
    return { status: "filled", qty, price: outUsd / qty, markPrice: outUsd / qty, feeUsd: fees.usd, builderFeeUsd: fees.builder, slippageBps: 0 };
  }

  /* ---------------- sending ---------------- */

  private networkUsd(transactions: number, solUsd: number) {
    return ((transactions * 5_000 + (this.cfg.maxPriorityFeeLamports ?? 0)) / 1e9) * solUsd;
  }

  /** Inspect, sign (the user's signer, then any new position account), send and confirm. */
  private async send(tx: Transaction, clientId: string, o: { extraSigners: Keypair[]; maxWrapLamports: bigint }): Promise<string> {
    const rpc = this.cfg.rpc;
    if (!rpc.sendRawTransaction || !rpc.confirmTransaction || !rpc.getLatestBlockhash) throw new Error("rpc cannot send transactions");
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: this.user, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message());
    const report = await inspectSwapTransaction(vtx, {
      user: this.user,
      allowedPrograms: LP_ALLOWED_PROGRAMS,
      rpc,
      maxPriorityFeeLamports: this.cfg.maxPriorityFeeLamports ?? 1_000_000,
      maxWrapLamports: o.maxWrapLamports,
      extraSigners: o.extraSigners.map((k) => k.publicKey),
    });
    if (!report.ok) throw new Error(`liquidity transaction failed inspection: ${report.violations.join("; ")}`);
    const signed = await this.cfg.signer.signTransaction(vtx);
    if (o.extraSigners.length) signed.sign(o.extraSigners);
    const sig = await rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    this.sent.set(clientId, sig);
    this.cfg.sentStore?.set(clientId, sig);
    const conf = await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`liquidity transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }
}
