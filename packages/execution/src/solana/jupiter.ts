import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { FetchLike } from "../hyperliquid/info.ts";
import { USDC_MINT, WSOL_MINT } from "./programs.ts";

export const JUPITER_LITE_SWAP_V1 = "https://lite-api.jup.ag/swap/v1";

export interface QuoteParams {
  inputMint: PublicKey | string;
  outputMint: PublicKey | string;
  /** Atomic units of the input (ExactIn) or output (ExactOut) mint. */
  amount: bigint | number | string;
  slippageBps: number;
  swapMode?: "ExactIn" | "ExactOut";
  /** Override the builder's default platform fee. 0 disables it for this quote. */
  platformFeeBps?: number;
  restrictIntermediateTokens?: boolean;
  onlyDirectRoutes?: boolean;
  maxAccounts?: number;
}

/** Subset of Jupiter's QuoteResponse we rely on; the full object is passed back to /swap untouched. */
export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  platformFee: { amount: string; feeBps: number } | null;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export interface BuildSwapParams {
  quote: QuoteResponse;
  userPublicKey: PublicKey;
  wrapAndUnwrapSol?: boolean;
  dynamicComputeUnitLimit?: boolean;
  /** Priority fee: Jupiter estimates at this level, capped at `maxPriorityFeeLamports`. */
  priorityLevel?: "medium" | "high" | "veryHigh";
  maxPriorityFeeLamports?: number;
  /** Override the fee account chosen for the pair. */
  feeAccount?: PublicKey | null;
}

export interface BuiltSwap {
  /** Unsigned. Inspect it (`inspectSwapTransaction`) before handing it to a signer. */
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError: unknown;
  feeAccount: PublicKey | null;
  raw: Record<string, unknown>;
}

export interface JupiterSwapBuilderOptions {
  baseUrl?: string;
  /** For api.jup.ag (paid tier); lite-api needs none. */
  apiKey?: string;
  fetch?: FetchLike;
  /** Weft's platform fee, bps. Only charged when a fee account exists for one of the pair's mints. */
  platformFeeBps?: number;
  /**
   * Weft's fee token accounts by mint (base58 mint → token account). For ExactIn, Jupiter takes the
   * fee in the input or output mint; for ExactOut only the input mint. Typically WSOL and USDC.
   */
  feeAccounts?: Record<string, PublicKey>;
  timeoutMs?: number;
}

const b58 = (k: PublicKey | string) => (typeof k === "string" ? k : k.toBase58());

/**
 * Non-custodial Jupiter swap building: quote → unsigned VersionedTransaction for the USER's key.
 * Weft never signs here; see `inspectSwapTransaction` and `Signer`.
 */
export class JupiterSwapBuilder {
  private readonly baseUrl: string;
  constructor(private readonly o: JupiterSwapBuilderOptions = {}) {
    this.baseUrl = (o.baseUrl ?? JUPITER_LITE_SWAP_V1).replace(/\/$/, "");
  }

  /** Fee account for a pair: prefer the output mint (ExactIn), else the input mint. */
  feeAccountFor(inputMint: PublicKey | string, outputMint: PublicKey | string, swapMode: "ExactIn" | "ExactOut" = "ExactIn"): PublicKey | null {
    const fa = this.o.feeAccounts ?? {};
    if (swapMode === "ExactIn" && fa[b58(outputMint)]) return fa[b58(outputMint)]!;
    return fa[b58(inputMint)] ?? null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.o.apiKey) h["x-api-key"] = this.o.apiKey;
    return h;
  }

  private async call<T>(url: string, init: { method: string; body?: string }): Promise<T> {
    const fetchFn = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const res = await Promise.race([
      fetchFn(url, { method: init.method, headers: this.headers(), body: init.body ?? (undefined as unknown as string) }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`jupiter ${url} timed out`)), this.o.timeoutMs ?? 15_000).unref?.()),
    ]);
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`jupiter ${res.status}: ${text.slice(0, 300)}`);
    }
    const err = (json as { error?: string; errorCode?: string }).error;
    if (!res.ok || err) throw new Error(`jupiter ${res.status}: ${err ?? text.slice(0, 300)}`);
    return json as T;
  }

  /** Build the /quote URL (exported for tests and audit logs). */
  quoteUrl(p: QuoteParams): string {
    const swapMode = p.swapMode ?? "ExactIn";
    const q = new URLSearchParams({
      inputMint: b58(p.inputMint),
      outputMint: b58(p.outputMint),
      amount: String(p.amount),
      slippageBps: String(p.slippageBps),
      swapMode,
    });
    const fee = p.platformFeeBps ?? this.o.platformFeeBps ?? 0;
    if (fee > 0) {
      if (!this.feeAccountFor(p.inputMint, p.outputMint, swapMode))
        throw new Error(`platform fee requested but no fee account for ${b58(p.inputMint)} / ${b58(p.outputMint)}`);
      q.set("platformFeeBps", String(fee));
    }
    if (p.restrictIntermediateTokens ?? true) q.set("restrictIntermediateTokens", "true");
    if (p.onlyDirectRoutes) q.set("onlyDirectRoutes", "true");
    if (p.maxAccounts) q.set("maxAccounts", String(p.maxAccounts));
    return `${this.baseUrl}/quote?${q}`;
  }

  /**
   * Quote. When no fee account exists for the pair, the platform fee is silently dropped
   * (Jupiter rejects a fee without an account).
   */
  async quote(p: QuoteParams): Promise<QuoteResponse> {
    const swapMode = p.swapMode ?? "ExactIn";
    const hasFeeAcct = !!this.feeAccountFor(p.inputMint, p.outputMint, swapMode);
    const fee = hasFeeAcct ? (p.platformFeeBps ?? this.o.platformFeeBps ?? 0) : 0;
    return this.call<QuoteResponse>(this.quoteUrl({ ...p, platformFeeBps: fee }), { method: "GET" });
  }

  swapBody(p: BuildSwapParams): Record<string, unknown> {
    const feeAccount =
      p.feeAccount !== undefined ? p.feeAccount : p.quote.platformFee?.feeBps ? this.feeAccountFor(p.quote.inputMint, p.quote.outputMint, p.quote.swapMode) : null;
    if (p.quote.platformFee?.feeBps && !feeAccount) throw new Error("quote carries a platform fee but no fee account is configured");
    const body: Record<string, unknown> = {
      quoteResponse: p.quote,
      userPublicKey: p.userPublicKey.toBase58(),
      wrapAndUnwrapSol: p.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: p.dynamicComputeUnitLimit ?? true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: p.maxPriorityFeeLamports ?? 1_000_000, priorityLevel: p.priorityLevel ?? "high" },
      },
    };
    if (feeAccount) body.feeAccount = feeAccount.toBase58();
    return body;
  }

  async buildSwap(p: BuildSwapParams): Promise<BuiltSwap> {
    const body = this.swapBody(p);
    const raw = await this.call<Record<string, unknown>>(`${this.baseUrl}/swap`, { method: "POST", body: JSON.stringify(body) });
    const b64 = raw.swapTransaction;
    if (typeof b64 !== "string") throw new Error("jupiter /swap returned no swapTransaction");
    return {
      transaction: VersionedTransaction.deserialize(Buffer.from(b64, "base64")),
      lastValidBlockHeight: Number(raw.lastValidBlockHeight),
      prioritizationFeeLamports: raw.prioritizationFeeLamports as number | undefined,
      computeUnitLimit: raw.computeUnitLimit as number | undefined,
      simulationError: raw.simulationError ?? null,
      feeAccount: body.feeAccount ? new PublicKey(body.feeAccount as string) : null,
      raw,
    };
  }
}

/** Quote-asset mint for a strategy token instrument's `quote`. */
export function quoteMint(quote: "SOL" | "USDC"): PublicKey {
  return quote === "SOL" ? WSOL_MINT : USDC_MINT;
}
