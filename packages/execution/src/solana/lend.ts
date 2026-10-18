import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { ExecutionResult, Executor, OrderRequest } from "../types.ts";
import type { JupiterExecutor, JupiterRpc } from "./executor.ts";
import { inspectSwapTransaction } from "./inspect.ts";
import type { JupiterSwapBuilder } from "./jupiter.ts";
import { readReserve, type ReserveInfo } from "./kamino.ts";
import { associatedTokenAddress, KLEND_IX, LEND_ALLOWED_PROGRAMS, PROGRAMS, USDC_MINT, WSOL_MINT } from "./programs.ts";
import type { Signer } from "./signer.ts";

const disc = (name: string) => Buffer.from(Object.entries(KLEND_IX).find(([, l]) => l.name === name)![0], "hex");
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

/** SOL kept in the wallet for fees and rent when lending SOL. */
export const LEND_SOL_RESERVE_LAMPORTS = 10_000_000n;

export function lendingMarketAuthority(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], PROGRAMS.kaminoLend)[0];
}

/** klend refresh_reserve: brings the reserve's interest up to this slot (deposits and redeems require it). */
export function refreshReserveIx(r: ReserveInfo): TransactionInstruction {
  const opt = (k: PublicKey | null) => ro(k ?? PROGRAMS.kaminoLend); // an unused oracle slot is the program id
  return new TransactionInstruction({
    programId: PROGRAMS.kaminoLend,
    keys: [rw(r.reserve), ro(r.lendingMarket), opt(r.pyth), opt(r.switchboardPrice), opt(r.switchboardTwap), opt(r.scope)],
    data: disc("refresh_reserve"),
  });
}

function reserveIx(name: "deposit_reserve_liquidity" | "redeem_reserve_collateral", r: ReserveInfo, owner: PublicKey, amount: bigint): TransactionInstruction {
  const liquidityAta = associatedTokenAddress(owner, r.liquidityMint, r.liquidityTokenProgram);
  const kTokenAta = associatedTokenAddress(owner, r.collateralMint, PROGRAMS.token);
  const auth = lendingMarketAuthority(r.lendingMarket);
  const signer = { pubkey: owner, isSigner: true, isWritable: false };
  const tail = [ro(PROGRAMS.token), ro(r.liquidityTokenProgram), ro(SYSVAR_INSTRUCTIONS_PUBKEY)];
  const keys =
    name === "deposit_reserve_liquidity"
      ? [signer, rw(r.reserve), ro(r.lendingMarket), ro(auth), ro(r.liquidityMint), rw(r.liquiditySupply), rw(r.collateralMint), rw(liquidityAta), rw(kTokenAta), ...tail]
      : [signer, ro(r.lendingMarket), rw(r.reserve), ro(auth), ro(r.liquidityMint), rw(r.collateralMint), rw(r.liquiditySupply), rw(kTokenAta), rw(liquidityAta), ...tail];
  return new TransactionInstruction({ programId: PROGRAMS.kaminoLend, keys, data: Buffer.concat([disc(name), u64(amount)]) });
}

function createAtaIx(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAMS.associatedToken,
    keys: [{ pubkey: owner, isSigner: true, isWritable: true }, rw(associatedTokenAddress(owner, mint, tokenProgram)), ro(owner), ro(mint), ro(PROGRAMS.system), ro(tokenProgram)],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

function closeWsolIx(owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAMS.token,
    keys: [rw(associatedTokenAddress(owner, WSOL_MINT)), rw(owner), { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from([9]), // CloseAccount: the wrapped SOL and the rent go back to the wallet
  });
}

/**
 * The instructions of a deposit of `amount` (the token's raw units) into a reserve. SOL is wrapped
 * on the way in and the wrapped-SOL account closed again afterwards; kTokens land in the user's ATA.
 */
export function depositInstructions(r: ReserveInfo, owner: PublicKey, amount: bigint): TransactionInstruction[] {
  const sol = r.liquidityMint.equals(WSOL_MINT);
  const wsol = associatedTokenAddress(owner, WSOL_MINT);
  return [
    createAtaIx(owner, r.collateralMint, PROGRAMS.token),
    ...(sol
      ? [
          createAtaIx(owner, WSOL_MINT, PROGRAMS.token),
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: amount }),
          new TransactionInstruction({ programId: PROGRAMS.token, keys: [rw(wsol)], data: Buffer.from([17]) }), // SyncNative
        ]
      : []),
    refreshReserveIx(r),
    reserveIx("deposit_reserve_liquidity", r, owner, amount),
    ...(sol ? [closeWsolIx(owner)] : []),
  ];
}

/** The instructions of redeeming `kTokens` (raw units) for the token, unwrapping SOL afterwards. */
export function withdrawInstructions(r: ReserveInfo, owner: PublicKey, kTokens: bigint): TransactionInstruction[] {
  const sol = r.liquidityMint.equals(WSOL_MINT);
  return [
    createAtaIx(owner, r.liquidityMint, r.liquidityTokenProgram),
    refreshReserveIx(r),
    reserveIx("redeem_reserve_collateral", r, owner, kTokens),
    ...(sol ? [closeWsolIx(owner)] : []),
  ];
}

export interface KaminoExecutorConfig {
  conn: Connection;
  signer: Signer;
  /** The user's token executor: buys the token being lent with SOL when the wallet doesn't hold enough of it. */
  swaps: JupiterExecutor;
  /** For SOL's USD price. */
  jupiter: JupiterSwapBuilder;
  rpc: JupiterRpc;
  /** Reads a reserve (tests swap in a fake). Default: from the chain. */
  reserve?: (reserve: PublicKey) => Promise<ReserveInfo>;
  /** µlamports per compute unit. */
  priorityMicroLamports?: number;
  sentStore?: { get(clientId: string): string | null; set(clientId: string, signature: string): void };
  /** Wait between looks for the kTokens or tokens to show up after a transaction. Default 1500 ms. */
  pollMs?: number;
  log?: (m: string) => void;
}

const CU_LIMIT = 300_000;

/**
 * Engine `Executor` for lending a token on Kamino from the user's own Solana wallet.
 *
 * Opening (`phase: "open"`, `notionalUsd`): deposit that much of the token into the reserve. The
 * wallet's own balance of the token goes first; a shortfall is bought with SOL through the token
 * executor (inspected and policy-signed like any swap). SOL is lent as is, keeping
 * LEND_SOL_RESERVE_LAMPORTS for fees. The fill is the kTokens that landed, at the deposit's USD
 * value per kToken.
 * Closing (`phase: "close"`, `qty` in kTokens): redeem them for the token, which stays in the wallet
 * (SOL unwrapped). When the reserve is lent out too far to pay it all, nothing is sent and the
 * close is rejected with the reason, so the engine tries again on a later tick.
 *
 * Every transaction is inspected before the user's signer sees it (see inspectSwapTransaction).
 */
export class KaminoExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly cfg: KaminoExecutorConfig;
  private readonly sent = new Map<string, string>();
  constructor(cfg: KaminoExecutorConfig) {
    this.cfg = cfg;
  }

  private get user(): PublicKey {
    return this.cfg.signer.publicKey;
  }

  async execute(req: OrderRequest): Promise<ExecutionResult> {
    try {
      const i = req.instrument;
      if (i.kind !== "lend") return { status: "rejected", reason: `KaminoExecutor cannot trade ${i.kind}` };
      const already = this.sent.get(req.clientId) ?? this.cfg.sentStore?.get(req.clientId) ?? null;
      if (already) return { status: "rejected", reason: `duplicate: ${req.clientId} already sent as ${already}` };
      const r = await (this.cfg.reserve ?? ((k) => readReserve(this.cfg.conn, k)))(new PublicKey(i.reserve));
      if (!r.liquidityMint.equals(new PublicKey(i.mint))) return { status: "rejected", reason: `that Kamino reserve lends ${r.liquidityMint.toBase58().slice(0, 6)}…, not ${i.symbol}` };
      if (!r.lendingMarket.equals(new PublicKey(i.market))) return { status: "rejected", reason: "that reserve belongs to a different Kamino market" };
      return req.phase === "open" ? await this.open(req, r, i.symbol) : await this.close(req, r, i.symbol);
    } catch (e) {
      return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async solUsd(): Promise<number> {
    const q = await this.cfg.jupiter.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 0 });
    return Number(q.outAmount) / 1e6;
  }

  private balance(mint: PublicKey): Promise<bigint> {
    if (!this.cfg.rpc.tokenBalance) throw new Error("rpc cannot read token balances");
    return this.cfg.rpc.tokenBalance(this.user, mint);
  }

  /** Waits for a balance to move off `before` (RPC indexes lag a confirmed transaction). */
  private async changed(mint: PublicKey, before: bigint, up: boolean): Promise<bigint> {
    for (let k = 0; k < 8; k++) {
      const now = await this.balance(mint);
      if (up ? now > before : now < before) return now;
      await new Promise((res) => setTimeout(res, this.cfg.pollMs ?? 1500));
    }
    throw new Error(`the ${mint.toBase58().slice(0, 6)} balance didn't change after the transaction`);
  }

  private networkUsd(transactions: number, solUsd: number) {
    return ((transactions * 5_000 + ((this.cfg.priorityMicroLamports ?? 50_000) * CU_LIMIT) / 1e6) / 1e9) * solUsd;
  }

  /* ---------------- deposit ---------------- */

  private async open(req: OrderRequest, r: ReserveInfo, symbol: string): Promise<ExecutionResult> {
    const usd = req.notionalUsd;
    if (!(usd! > 0)) return { status: "rejected", reason: "a deposit needs an amount" };
    const solUsd = await this.solUsd();
    const sol = r.liquidityMint.equals(WSOL_MINT);
    const fees = { usd: 0, builder: 0 };
    let amount: bigint;
    let tokenUsd: number;
    if (sol) {
      tokenUsd = solUsd;
      amount = BigInt(Math.floor((usd! / solUsd) * 1e9));
      const have = BigInt(await this.cfg.conn.getBalance(this.user, "confirmed"));
      if (have < amount + LEND_SOL_RESERVE_LAMPORTS)
        return { status: "rejected", reason: `the wallet has ${(Number(have) / 1e9).toFixed(4)} SOL; lending ${(Number(amount) / 1e9).toFixed(4)} SOL needs ${(Number(LEND_SOL_RESERVE_LAMPORTS) / 1e9).toFixed(2)} more for fees` };
    } else {
      const dec = r.liquidityDecimals;
      const held = await this.balance(r.liquidityMint);
      // Price the token from a small swap quote unless it's USDC.
      tokenUsd = r.liquidityMint.equals(USDC_MINT) ? 1 : await this.tokenUsd(r.liquidityMint, dec, solUsd);
      const want = BigInt(Math.floor((usd! / tokenUsd) * 10 ** dec));
      if (held >= want) amount = want;
      else {
        const shortUsd = (Number(want - held) / 10 ** dec) * tokenUsd;
        const s = await this.cfg.swaps.execute(
          { clientId: `${req.clientId}:buy`, instrument: { kind: "token", chain: "solana", mint: r.liquidityMint.toBase58(), quote: "SOL", route: "auto", assetClass: "crypto" }, instrumentKey: `sol:token:${r.liquidityMint.toBase58()}`, side: "buy", phase: "open", notionalUsd: shortUsd },
          Date.now(),
        );
        if (s.status !== "filled") return { status: "rejected", reason: `couldn't get ${symbol} to lend: ${s.reason}` };
        fees.usd += s.feeUsd;
        fees.builder += s.builderFeeUsd;
        const now = await this.changed(r.liquidityMint, held, true);
        amount = now < want ? now : want; // what the swap actually brought, never more than asked
      }
    }
    if (amount <= 0n) return { status: "rejected", reason: "the deposit rounds to zero" };

    const kBefore = await this.balance(r.collateralMint);
    const sig = await this.send(depositInstructions(r, this.user, amount), req.clientId, sol ? amount : 0n);
    const kAfter = await this.changed(r.collateralMint, kBefore, true);
    const kTokens = Number(kAfter - kBefore) / 10 ** r.liquidityDecimals;
    const depositedUsd = (Number(amount) / 10 ** r.liquidityDecimals) * tokenUsd;
    fees.usd += this.networkUsd(1, solUsd);
    const price = depositedUsd / kTokens;
    this.cfg.log?.(`lent ${(Number(amount) / 10 ** r.liquidityDecimals).toFixed(6)} ${symbol} on Kamino for ${kTokens.toFixed(6)} kTokens: ${sig}`);
    return { status: "filled", qty: kTokens, price, markPrice: price, feeUsd: fees.usd, builderFeeUsd: fees.builder, slippageBps: 0 };
  }

  /** USD per token, from a Jupiter quote of 1 SOL worth of it. */
  private async tokenUsd(mint: PublicKey, decimals: number, solUsd: number): Promise<number> {
    const q = await this.cfg.jupiter.quote({ inputMint: WSOL_MINT, outputMint: mint, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 0 });
    return solUsd / (Number(q.outAmount) / 10 ** decimals);
  }

  /* ---------------- withdrawal ---------------- */

  private async close(req: OrderRequest, r: ReserveInfo, symbol: string): Promise<ExecutionResult> {
    if (!(req.qty! > 0)) return { status: "rejected", reason: "a withdrawal needs the kTokens to redeem" };
    const dec = r.liquidityDecimals;
    const held = await this.balance(r.collateralMint);
    if (held <= 0n) return { status: "rejected", reason: `no ${symbol} kTokens left in the wallet` };
    let kRaw = BigInt(Math.floor(req.qty! * 10 ** dec));
    // What landed can differ from what was booked by a hair: never redeem more than is there, and
    // take the dust too when this is (nearly) all of it.
    if (kRaw > held || kRaw * 100n >= held * 98n) kRaw = held;
    const out = BigInt(Math.floor(Number(kRaw) * r.exchangeRate));
    if (out > r.availableRaw)
      return {
        status: "rejected",
        reason: `Kamino's ${symbol} reserve is lent out too far to pay this back right now (${(Number(r.availableRaw) / 10 ** dec).toFixed(2)} ${symbol} free, ${(Number(out) / 10 ** dec).toFixed(2)} needed). Weft tries again as borrowers repay`,
      };
    const solUsd = await this.solUsd();
    const tokenUsd = r.liquidityMint.equals(WSOL_MINT) ? solUsd : r.liquidityMint.equals(USDC_MINT) ? 1 : await this.tokenUsd(r.liquidityMint, dec, solUsd);
    const sig = await this.send(withdrawInstructions(r, this.user, kRaw), req.clientId, 0n);
    await this.changed(r.collateralMint, held, false);
    const kTokens = Number(kRaw) / 10 ** dec;
    const outUsd = (Number(out) / 10 ** dec) * tokenUsd;
    const price = outUsd / kTokens;
    this.cfg.log?.(`withdrew ${(Number(out) / 10 ** dec).toFixed(6)} ${symbol} from Kamino: ${sig}`);
    return { status: "filled", qty: Math.min(kTokens, req.qty!), price, markPrice: price, feeUsd: this.networkUsd(1, solUsd), builderFeeUsd: 0, slippageBps: 0 };
  }

  /* ---------------- sending ---------------- */

  private async send(ixs: TransactionInstruction[], clientId: string, wrapLamports: bigint): Promise<string> {
    const rpc = this.cfg.rpc;
    if (!rpc.sendRawTransaction || !rpc.confirmTransaction || !rpc.getLatestBlockhash) throw new Error("rpc cannot send transactions");
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports ?? 50_000 })];
    const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: this.user, recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message());
    const report = await inspectSwapTransaction(vtx, { user: this.user, allowedPrograms: LEND_ALLOWED_PROGRAMS, rpc, maxPriorityFeeLamports: 1_000_000, maxWrapLamports: wrapLamports });
    if (!report.ok) throw new Error(`lending transaction failed inspection: ${report.violations.join("; ")}`);
    const signed = await this.cfg.signer.signTransaction(vtx);
    const sig = await rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    this.sent.set(clientId, sig);
    this.cfg.sentStore?.set(clientId, sig);
    const conf = await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`lending transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }
}
