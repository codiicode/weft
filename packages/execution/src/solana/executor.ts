import { PublicKey, type AccountInfo, type VersionedTransaction } from "@solana/web3.js";
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
}

/**
 * Engine `Executor` for Solana tokens through Jupiter: quote → build (user's key) → inspect
 * (fail closed) → policy signer → send → confirm. The reported fill uses the quoted amounts;
 * TODO: reconcile against the confirmed transaction's token balance changes.
 *
 * Idempotency: Jupiter transactions carry no client id, so duplicates are blocked in-process by
 * `clientId`, and a blockhash-bound transaction can never land twice. TODO: persist sent
 * signatures by clientId so a restart cannot re-send.
 */
export class JupiterExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly sent = new Map<string, string>();
  private readonly decimalsCache = new Map<string, number>();

  constructor(private readonly cfg: JupiterExecutorConfig) {}

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
      if (this.sent.has(req.clientId)) return { status: "rejected", reason: `duplicate: ${req.clientId} already sent as ${this.sent.get(req.clientId)}` };
      const token = new PublicKey(i.mint);
      const quoteAsset = quoteMint(i.quote);
      const buy = req.side === "buy";
      const usdPerQuote = i.quote === "USDC" ? 1 : await this.solUsd();
      const [tokenDec, quoteDec] = await Promise.all([this.decimals(token), this.decimals(quoteAsset)]);

      let amount: bigint;
      if (buy) {
        if (req.notionalUsd == null && req.qty == null) return { status: "rejected", reason: "buy needs notionalUsd" };
        if (req.notionalUsd == null) return { status: "rejected", reason: "token buys are sized in USD (ExactIn); qty buys are not supported" };
        amount = BigInt(Math.floor((req.notionalUsd / usdPerQuote) * 10 ** quoteDec));
      } else {
        if (req.qty == null) return { status: "rejected", reason: "sell needs qty" };
        amount = BigInt(Math.floor(req.qty * 10 ** tokenDec));
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

  private async signAndSend(tx: VersionedTransaction, lastValidBlockHeight: number, clientId: string): Promise<string> {
    if (!this.cfg.rpc.sendRawTransaction || !this.cfg.rpc.confirmTransaction) throw new Error("rpc cannot send transactions");
    const blockhash = tx.message.recentBlockhash;
    const signed = await this.cfg.signer.signTransaction(tx);
    const sig = await this.cfg.rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    this.sent.set(clientId, sig);
    const conf = await this.cfg.rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`swap ${sig} failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }
}
