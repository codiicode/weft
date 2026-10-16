import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import type { ExecutionResult, Executor, OrderRequest } from "../types.ts";
import { inspectSwapTransaction, type InspectReport, type InspectRpc } from "./inspect.ts";
import { JupiterSwapBuilder, quoteMint, type BuiltSwap, type QuoteResponse } from "./jupiter.ts";
import { DEFAULT_ALLOWED_PROGRAMS, USDC_MINT, WSOL_MINT } from "./programs.ts";
import type { Signer } from "./signer.ts";

export interface JupiterRpc extends InspectRpc {
  getAccountInfo(key: PublicKey): Promise<AccountInfo<Buffer> | null>;
  sendRawTransaction?(raw: Uint8Array, opts?: { skipPreflight?: boolean; maxRetries?: number }): Promise<string>;
  confirmTransaction?(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment?: "confirmed" | "finalized"
  ): Promise<{ value: { err: unknown } }>;
  /** The user's balance of `mint` in atomic units (all token accounts). Sells are clamped to it. */
  tokenBalance?(owner: PublicKey, mint: PublicKey): Promise<bigint>;
  /** The owner's token accounts for `mint` that hold nothing (with their token program). */
  emptyTokenAccounts?(owner: PublicKey, mint: PublicKey): Promise<{ address: PublicKey; programId: PublicKey }[]>;
  getLatestBlockhash?(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

export interface JupiterExecutorConfig {
  builder: JupiterSwapBuilder;
  /** The user's policy-controlled signer (Turnkey in production). */
  signer: Signer;
  rpc: JupiterRpc;
  defaultSlippageBps?: number;
  closeSlippageBps?: number;
  maxPriorityFeeLamports?: number;
  /** Build + inspect only; never sign or send. */
  dryRun?: boolean;
  onBuilt?: (b: { clientId: string; quote: QuoteResponse; swap: BuiltSwap; report: InspectReport }) => void;
  /** After a sell that empties the wallet of a token, its account was closed and the rent returned. */
  onAccountsClosed?: (r: { mint: string; accounts: number; signature: string } | { mint: string; error: string }) => void;
  /** Wait between looks for the emptied account (RPC indexes lag the confirmed sell). Default 2500 ms. */
  closeRetryMs?: number;
  /**
   * Durable record of sent swaps by clientId, so a restart can never send the same order twice
   * (the in-memory map alone forgets on restart).
   */
  sentStore?: { get(clientId: string): string | null; set(clientId: string, signature: string): void };
}

/**
 * Engine `Executor` for Solana tokens through Jupiter: quote → build (user's key) → inspect
 * (fail closed) → policy signer → send → confirm. The reported fill uses the quoted amounts;
 * TODO: reconcile against the confirmed transaction's token balance changes.
 *
 * Idempotency: Jupiter transactions carry no client id, so duplicates are blocked by `clientId`
 * (in memory, and in `sentStore` across restarts), and a blockhash-bound transaction can never
 * land twice.
 */
export class JupiterExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly sent = new Map<string, string>();
  private readonly decimalsCache = new Map<string, number>();

  private readonly cfg: JupiterExecutorConfig;
  constructor(cfg: JupiterExecutorConfig) {
    this.cfg = cfg;
  }

  private async decimals(mint: PublicKey): Promise<number> {
    const k = mint.toBase58();
    if (mint.equals(WSOL_MINT)) return 9;
    if (mint.equals(USDC_MINT)) return 6;
    const hit = this.decimalsCache.get(k);
    if (hit != null) return hit;
    const info = await this.cfg.rpc.getAccountInfo(mint);
    if (!info || info.data.length < 45) throw new Error(`mint ${k} not found`);
    const d = info.data[44]!; // SPL Mint layout: decimals at byte 44 (same base layout for Token-2022)
    this.decimalsCache.set(k, d);
    return d;
  }

  /** USD per 1 SOL, from a Jupiter quote (1 SOL → USDC). */
  private async solUsd(): Promise<number> {
    const q = await this.cfg.builder.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 0 });
    return Number(q.outAmount) / 1e6;
  }

  async execute(req: OrderRequest, _now: number): Promise<ExecutionResult> {
    try {
      const i = req.instrument;
      if (i.kind !== "token") return { status: "rejected", reason: `JupiterExecutor cannot trade ${i.kind}` };
      if (req.order?.type === "limit") return { status: "rejected", reason: "limit orders on Solana tokens are not supported (TODO: Jupiter Trigger API)" };
      const already = this.sent.get(req.clientId) ?? this.cfg.sentStore?.get(req.clientId) ?? null;
      if (already) return { status: "rejected", reason: `duplicate: ${req.clientId} already sent as ${already}` };
      const token = new PublicKey(i.mint);
      const quoteAsset = quoteMint(i.quote);
      const buy = req.side === "buy";
      const usdPerQuote = i.quote === "USDC" ? 1 : await this.solUsd();
      const [tokenDec, quoteDec] = await Promise.all([this.decimals(token), this.decimals(quoteAsset)]);

      let amount: bigint;
      let sellsEverything = false;
      if (buy) {
        if (req.notionalUsd == null && req.qty == null) return { status: "rejected", reason: "buy needs notionalUsd" };
        if (req.notionalUsd == null) return { status: "rejected", reason: "token buys are sized in USD (ExactIn); qty buys are not supported" };
        amount = BigInt(Math.floor((req.notionalUsd / usdPerQuote) * 10 ** quoteDec));
      } else {
        if (req.qty == null) return { status: "rejected", reason: "sell needs qty" };
        amount = BigInt(Math.floor(req.qty * 10 ** tokenDec));
        // The fill we recorded is the quote; what landed can differ slightly. Never sell more than is there,
        // and when the sell is (nearly) everything, take the dust too so nothing is stranded.
        if (this.cfg.rpc.tokenBalance) {
          const held = await this.cfg.rpc.tokenBalance(this.cfg.signer.publicKey, token);
          if (held <= 0n) return { status: "rejected", reason: "nothing left to sell in the wallet" };
          if (amount > held || (req.phase === "close" && amount * 100n >= held * 98n)) amount = held;
          sellsEverything = amount === held;
        }
      }
      if (amount <= 0n) return { status: "rejected", reason: "amount rounds to zero" };

      const slippageBps = req.phase === "close" ? (this.cfg.closeSlippageBps ?? 300) : (req.order?.maxSlippageBps ?? this.cfg.defaultSlippageBps ?? 100);
      const quote = await this.cfg.builder.quote({
        inputMint: buy ? quoteAsset : token,
        outputMint: buy ? token : quoteAsset,
        amount,
        slippageBps,
      });
      const impactBps = Number(quote.priceImpactPct) * 10_000;
      if (req.phase === "open" && req.order?.maxPriceImpactBps != null && impactBps > req.order.maxPriceImpactBps)
        return { status: "rejected", reason: `price impact ${impactBps.toFixed(1)} bps above max ${req.order.maxPriceImpactBps} bps` };

      const swap = await this.cfg.builder.buildSwap({
        quote,
        userPublicKey: this.cfg.signer.publicKey,
        maxPriorityFeeLamports: this.cfg.maxPriorityFeeLamports,
      });
      const report = await inspectSwapTransaction(swap.transaction, {
        user: this.cfg.signer.publicKey,
        allowedPrograms: DEFAULT_ALLOWED_PROGRAMS,
        rpc: this.cfg.rpc,
        platformFeeAccount: swap.feeAccount,
        maxPriorityFeeLamports: this.cfg.maxPriorityFeeLamports ?? 1_000_000,
        maxWrapLamports: buy && i.quote === "SOL" ? BigInt(quote.inAmount) : 0n,
      });
      this.cfg.onBuilt?.({ clientId: req.clientId, quote, swap, report });
      if (!report.ok) return { status: "rejected", reason: `swap transaction failed inspection: ${report.violations.join("; ")}` };
      if (this.cfg.dryRun) return { status: "pending", reason: "dry run: swap built and inspected, not signed" };

      await this.signAndSend(swap.transaction, swap.lastValidBlockHeight, req.clientId);
      // The token account is empty now: close it so its rent (~0.002 SOL) goes back to the user.
      if (sellsEverything) void this.closeEmptyAccounts(token);
      const tokenQty = Number(buy ? quote.outAmount : quote.inAmount) / 10 ** tokenDec;
      const quoteQty = Number(buy ? quote.inAmount : quote.outAmount) / 10 ** quoteDec;
      const price = (quoteQty * usdPerQuote) / tokenQty;
      const platformFeeUsd = quote.platformFee
        ? (Number(quote.platformFee.amount) / 10 ** (buy ? tokenDec : quoteDec)) * (buy ? price : usdPerQuote)
        : 0;
      const networkFeeUsd = ((5000 + (swap.prioritizationFeeLamports ?? 0)) / 1e9) * (i.quote === "SOL" ? usdPerQuote : await this.solUsd());
      // Mid ≈ quote price before impact.
      const mid = price / (1 + ((buy ? 1 : -1) * impactBps) / 10_000);
      return {
        status: "filled",
        qty: tokenQty,
        price,
        markPrice: mid,
        feeUsd: platformFeeUsd + networkFeeUsd,
        builderFeeUsd: platformFeeUsd,
        slippageBps: impactBps,
      };
    } catch (e) {
      return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Closes the user's empty token accounts for `mint`, returning their rent to the user. Best effort
   * and separate from the swap, so a failure here never touches the trade. The transaction goes
   * through the same inspection as swaps (close only, rent to the user).
   */
  async closeEmptyAccounts(mint: PublicKey): Promise<string | null> {
    const rpc = this.cfg.rpc;
    if (!rpc.emptyTokenAccounts || !rpc.getLatestBlockhash || this.cfg.dryRun) return null;
    const user = this.cfg.signer.publicKey;
    try {
      // Right after the sell the RPC can still list the account with its old balance: look again a few times.
      let empty: Awaited<ReturnType<NonNullable<JupiterRpc["emptyTokenAccounts"]>>> = [];
      for (let attempt = 0; attempt < 4 && !empty.length; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, this.cfg.closeRetryMs ?? 2500));
        empty = await rpc.emptyTokenAccounts(user, mint);
      }
      if (!empty.length) throw new Error("no empty token account found after the sell");
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const ixs = empty.map(
        (a) =>
          new TransactionInstruction({
            programId: a.programId,
            keys: [
              { pubkey: a.address, isSigner: false, isWritable: true },
              { pubkey: user, isSigner: false, isWritable: true },
              { pubkey: user, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([9]), // CloseAccount
          }),
      );
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
      const report = await inspectSwapTransaction(tx, { user, allowedPrograms: DEFAULT_ALLOWED_PROGRAMS, rpc, maxPriorityFeeLamports: 0, maxWrapLamports: 0n });
      if (!report.ok) throw new Error(`close failed inspection: ${report.violations.join("; ")}`);
      const sig = await this.signAndSend(tx, lastValidBlockHeight, `close:${mint.toBase58()}:${blockhash}`);
      this.cfg.onAccountsClosed?.({ mint: mint.toBase58(), accounts: empty.length, signature: sig });
      return sig;
    } catch (e) {
      this.cfg.onAccountsClosed?.({ mint: mint.toBase58(), error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private async signAndSend(tx: VersionedTransaction, lastValidBlockHeight: number, clientId: string): Promise<string> {
    if (!this.cfg.rpc.sendRawTransaction || !this.cfg.rpc.confirmTransaction) throw new Error("rpc cannot send transactions");
    const blockhash = tx.message.recentBlockhash;
    const signed = await this.cfg.signer.signTransaction(tx);
    const sig = await this.cfg.rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    this.sent.set(clientId, sig);
    this.cfg.sentStore?.set(clientId, sig);
    const conf = await this.cfg.rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`swap ${sig} failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }
}
