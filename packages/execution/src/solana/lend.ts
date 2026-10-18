import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { ExecutionResult, Executor, OrderRequest } from "../types.ts";
import type { JupiterExecutor, JupiterRpc } from "./executor.ts";
import { inspectSwapTransaction } from "./inspect.ts";
import type { JupiterSwapBuilder } from "./jupiter.ts";
import { readReserve, type ReserveInfo } from "./kamino.ts";
import { associatedTokenAddress, JLEND_IX, KLEND_IX, LEND_ALLOWED_PROGRAMS, PROGRAMS, USDC_MINT, WSOL_MINT } from "./programs.ts";
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
 * One place a token can be lent, as the executor sees it: the token, the receipt token the protocol
 * mints for it (Kamino kToken, Jupiter jlToken; both classic SPL tokens with the token's decimals),
 * what one receipt token is worth, what can be withdrawn now, and the protocol's own instructions.
 */
export interface LendMarket {
  venue: "kamino" | "jupiter";
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  decimals: number;
  shareMint: PublicKey;
  /** Tokens per receipt token. */
  rate: number;
  /** Tokens (raw units) that can be withdrawn right now. */
  availableRaw: bigint;
  deposit(owner: PublicKey, amount: bigint): Promise<TransactionInstruction[]>;
  withdraw(owner: PublicKey, shares: bigint): Promise<TransactionInstruction[]>;
}

export function kaminoMarket(r: ReserveInfo): LendMarket {
  return {
    venue: "kamino",
    liquidityMint: r.liquidityMint,
    liquidityTokenProgram: r.liquidityTokenProgram,
    decimals: r.liquidityDecimals,
    shareMint: r.collateralMint,
    rate: r.exchangeRate,
    availableRaw: r.availableRaw,
    deposit: async (owner, amount) => [refreshReserveIx(r), reserveIx("deposit_reserve_liquidity", r, owner, amount)],
    withdraw: async (owner, shares) => [refreshReserveIx(r), reserveIx("redeem_reserve_collateral", r, owner, shares)],
  };
}

/** A deposit around the protocol's instructions: the receipt-token account, and SOL wrapped in and the wrapped-SOL account closed after. */
export function wrapDeposit(m: Pick<LendMarket, "liquidityMint" | "shareMint">, owner: PublicKey, amount: bigint, protocol: TransactionInstruction[]): TransactionInstruction[] {
  const sol = m.liquidityMint.equals(WSOL_MINT);
  const wsol = associatedTokenAddress(owner, WSOL_MINT);
  return [
    createAtaIx(owner, m.shareMint, PROGRAMS.token),
    ...(sol
      ? [
          createAtaIx(owner, WSOL_MINT, PROGRAMS.token),
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: amount }),
          new TransactionInstruction({ programId: PROGRAMS.token, keys: [rw(wsol)], data: Buffer.from([17]) }), // SyncNative
        ]
      : []),
    ...protocol,
    ...(sol ? [closeWsolIx(owner)] : []),
  ];
}

/** A withdrawal around the protocol's instructions: the token account it pays into, and SOL unwrapped after. */
export function wrapWithdraw(m: Pick<LendMarket, "liquidityMint" | "liquidityTokenProgram">, owner: PublicKey, protocol: TransactionInstruction[]): TransactionInstruction[] {
  return [createAtaIx(owner, m.liquidityMint, m.liquidityTokenProgram), ...protocol, ...(m.liquidityMint.equals(WSOL_MINT) ? [closeWsolIx(owner)] : [])];
}

/** A Kamino deposit of `amount` (the token's raw units); kTokens land in the user's ATA. */
export function depositInstructions(r: ReserveInfo, owner: PublicKey, amount: bigint): TransactionInstruction[] {
  return wrapDeposit({ liquidityMint: r.liquidityMint, shareMint: r.collateralMint }, owner, amount, [refreshReserveIx(r), reserveIx("deposit_reserve_liquidity", r, owner, amount)]);
}

/** Redeeming `kTokens` (raw units) from a Kamino reserve for the token. */
export function withdrawInstructions(r: ReserveInfo, owner: PublicKey, kTokens: bigint): TransactionInstruction[] {
  return wrapWithdraw(r, owner, [refreshReserveIx(r), reserveIx("redeem_reserve_collateral", r, owner, kTokens)]);
}

/**
 * Jupiter Lend (Earn) through Jupiter's Lend API: vault state from /earn/tokens and the deposit and
 * redeem instructions from /earn/*-instructions. Every instruction it hands back is checked here
 * (program, instruction, signer, token, jlToken, amount) before it goes anywhere near a transaction,
 * and the transaction is inspected again before signing.
 */
export class JupiterLendApi {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private cache: { at: number; v: Promise<JupiterEarnToken[]> } | null = null;
  constructor(o: { baseUrl?: string; apiKey?: string | null; fetch?: typeof fetch } = {}) {
    this.base = (o.baseUrl ?? (o.apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag")).replace(/\/$/, "");
    this.headers = { "content-type": "application/json", ...(o.apiKey ? { "x-api-key": o.apiKey } : {}) };
    this.fetchFn = o.fetch ?? fetch;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const r = await this.fetchFn(`${this.base}/lend/v1/earn/${path}`, body ? { method: "POST", headers: this.headers, body: JSON.stringify(body) } : { headers: this.headers });
    const t = await r.text();
    if (!r.ok) throw new Error(`Jupiter Lend ${path}: ${r.status} ${t.slice(0, 200)}`);
    return JSON.parse(t) as T;
  }

  tokens(): Promise<JupiterEarnToken[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.v;
    const v = this.call<JupiterEarnToken[]>("tokens");
    this.cache = { at: Date.now(), v };
    v.catch(() => (this.cache = null));
    return v;
  }

  async market(jlMint: PublicKey): Promise<LendMarket> {
    const t = (await this.tokens()).find((x) => x.address === jlMint.toBase58());
    if (!t) throw new Error(`no Jupiter Lend vault with jlToken ${jlMint.toBase58()}`);
    const mint = new PublicKey(t.assetAddress);
    const one = async (path: string, body: Record<string, string>, layout: string, mintAt: number, amount: bigint, owner: PublicKey) => {
      const r = await this.call<{ instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[] }>(path, { ...body, signer: owner.toBase58() });
      if (r.instructions?.length !== 1) throw new Error(`Jupiter Lend sent ${r.instructions?.length ?? 0} instructions for a ${layout}`);
      const raw = r.instructions[0]!;
      const ix = new TransactionInstruction({
        programId: new PublicKey(raw.programId),
        keys: raw.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(raw.data, "base64"),
      });
      const name = JLEND_NAMES.get(ix.data.subarray(0, 8).toString("hex"));
      if (!ix.programId.equals(PROGRAMS.jupiterLend) || name !== layout) throw new Error(`Jupiter Lend sent a ${name ?? "different"} instruction, not a ${layout}`);
      if (!ix.keys[0]?.pubkey.equals(owner) || !ix.keys[0].isSigner) throw new Error("Jupiter Lend's instruction isn't signed by the wallet");
      if (ix.keys.slice(1).some((k) => k.isSigner)) throw new Error("Jupiter Lend's instruction asks for another signer");
      if (!ix.keys[mintAt]?.pubkey.equals(mint) || !ix.keys[6]?.pubkey.equals(jlMint)) throw new Error("Jupiter Lend's instruction is for a different vault");
      if (ix.data.length < 16 || ix.data.readBigUInt64LE(8) !== amount) throw new Error("Jupiter Lend's instruction is for a different amount");
      return [ix];
    };
    const ownProgram = (await this.tokenProgramOf?.(mint)) ?? PROGRAMS.token;
    return {
      venue: "jupiter",
      liquidityMint: mint,
      liquidityTokenProgram: ownProgram,
      decimals: t.asset?.decimals ?? t.decimals,
      shareMint: jlMint,
      rate: Number(t.convertToAssets) / 10 ** t.decimals,
      availableRaw: BigInt(t.liquiditySupplyData?.withdrawable ?? "0"),
      deposit: (owner, amount) => one("deposit-instructions", { asset: mint.toBase58(), amount: amount.toString() }, "deposit", 3, amount, owner),
      withdraw: (owner, shares) => one("redeem-instructions", { asset: mint.toBase58(), shares: shares.toString() }, "redeem", 5, shares, owner),
    };
  }

  /** The token program of a mint (Token-2022 mints need theirs for the ATA). Set by the caller that has an RPC. */
  tokenProgramOf?: (mint: PublicKey) => Promise<PublicKey>;
}

export interface JupiterEarnToken {
  address: string;
  decimals: number;
  assetAddress: string;
  asset?: { decimals?: number; symbol?: string };
  convertToAssets: string;
  liquiditySupplyData?: { withdrawable?: string };
}

const JLEND_NAMES = new Map(Object.entries(JLEND_IX).map(([d, l]) => [d, l.name]));

export interface LendExecutorConfig {
  conn: Connection;
  signer: Signer;
  /** The user's token executor: buys the token being lent with SOL when the wallet doesn't hold enough of it. */
  swaps: JupiterExecutor;
  /** For SOL's USD price. */
  jupiter: JupiterSwapBuilder;
  rpc: JupiterRpc;
  /** Reads a Kamino reserve (tests swap in a fake). Default: from the chain. */
  reserve?: (reserve: PublicKey) => Promise<ReserveInfo>;
  /** Jupiter Lend; without it, Jupiter Lend orders are rejected. */
  jupiterLend?: JupiterLendApi;
  /** µlamports per compute unit. */
  priorityMicroLamports?: number;
  sentStore?: { get(clientId: string): string | null; set(clientId: string, signature: string): void };
  /** Wait between looks for the receipt tokens or tokens to show up after a transaction. Default 1500 ms. */
  pollMs?: number;
  log?: (m: string) => void;
}

const CU_LIMIT = 300_000;
const VENUE_NAME = { kamino: "Kamino", jupiter: "Jupiter Lend" } as const;

/**
 * Engine `Executor` for lending a token from the user's own Solana wallet, on Kamino or Jupiter Lend.
 *
 * Opening (`phase: "open"`, `notionalUsd`): deposit that much of the token. The wallet's own balance
 * of the token goes first; a shortfall is bought with SOL through the token executor (inspected and
 * policy-signed like any swap). SOL is lent as is, keeping LEND_SOL_RESERVE_LAMPORTS for fees. The
 * fill is the receipt tokens (kTokens, jlTokens) that landed, at the deposit's USD value per token.
 * Closing (`phase: "close"`, `qty` in receipt tokens): redeem them for the token, which stays in the
 * wallet (SOL unwrapped). When the protocol can't pay it all out right now, nothing is sent and the
 * close is rejected with the reason, so the engine tries again on a later tick.
 *
 * Every transaction is inspected before the user's signer sees it (see inspectSwapTransaction).
 */
export class LendExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly cfg: LendExecutorConfig;
  private readonly sent = new Map<string, string>();
  constructor(cfg: LendExecutorConfig) {
    this.cfg = cfg;
  }

  private get user(): PublicKey {
    return this.cfg.signer.publicKey;
  }

  async execute(req: OrderRequest): Promise<ExecutionResult> {
    try {
      const i = req.instrument;
      if (i.kind !== "lend") return { status: "rejected", reason: `LendExecutor cannot trade ${i.kind}` };
      const already = this.sent.get(req.clientId) ?? this.cfg.sentStore?.get(req.clientId) ?? null;
      if (already) return { status: "rejected", reason: `duplicate: ${req.clientId} already sent as ${already}` };
      let m: LendMarket;
      if (i.venue === "jupiter") {
        if (!this.cfg.jupiterLend) return { status: "rejected", reason: "Jupiter Lend isn't set up on this server" };
        if (i.market !== PROGRAMS.jupiterLend.toBase58()) return { status: "rejected", reason: "that isn't a Jupiter Lend vault" };
        m = await this.cfg.jupiterLend.market(new PublicKey(i.reserve));
      } else {
        const r = await (this.cfg.reserve ?? ((k) => readReserve(this.cfg.conn, k)))(new PublicKey(i.reserve));
        if (!r.lendingMarket.equals(new PublicKey(i.market))) return { status: "rejected", reason: "that reserve belongs to a different Kamino market" };
        m = kaminoMarket(r);
      }
      if (!m.liquidityMint.equals(new PublicKey(i.mint))) return { status: "rejected", reason: `that ${VENUE_NAME[m.venue]} market lends ${m.liquidityMint.toBase58().slice(0, 6)}…, not ${i.symbol}` };
      return req.phase === "open" ? await this.open(req, m, i.symbol) : await this.close(req, m, i.symbol);
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

  /** USD per token, from a Jupiter quote of 1 SOL worth of it. */
  private async tokenUsd(mint: PublicKey, decimals: number, solUsd: number): Promise<number> {
    if (mint.equals(WSOL_MINT)) return solUsd;
    if (mint.equals(USDC_MINT)) return 1;
    const q = await this.cfg.jupiter.quote({ inputMint: WSOL_MINT, outputMint: mint, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 0 });
    return solUsd / (Number(q.outAmount) / 10 ** decimals);
  }

  /* ---------------- deposit ---------------- */

  private async open(req: OrderRequest, m: LendMarket, symbol: string): Promise<ExecutionResult> {
    const usd = req.notionalUsd;
    if (!(usd! > 0)) return { status: "rejected", reason: "a deposit needs an amount" };
    const solUsd = await this.solUsd();
    const sol = m.liquidityMint.equals(WSOL_MINT);
    const dec = m.decimals;
    const fees = { usd: 0, builder: 0 };
    const tokenUsd = await this.tokenUsd(m.liquidityMint, dec, solUsd);
    let amount: bigint;
    if (sol) {
      amount = BigInt(Math.floor((usd! / solUsd) * 1e9));
      const have = BigInt(await this.cfg.conn.getBalance(this.user, "confirmed"));
      if (have < amount + LEND_SOL_RESERVE_LAMPORTS)
        return { status: "rejected", reason: `the wallet has ${(Number(have) / 1e9).toFixed(4)} SOL; lending ${(Number(amount) / 1e9).toFixed(4)} SOL needs ${(Number(LEND_SOL_RESERVE_LAMPORTS) / 1e9).toFixed(2)} more for fees` };
    } else {
      const held = await this.balance(m.liquidityMint);
      const want = BigInt(Math.floor((usd! / tokenUsd) * 10 ** dec));
      if (held >= want) amount = want;
      else {
        const shortUsd = (Number(want - held) / 10 ** dec) * tokenUsd;
        const s = await this.cfg.swaps.execute(
          { clientId: `${req.clientId}:buy`, instrument: { kind: "token", chain: "solana", mint: m.liquidityMint.toBase58(), quote: "SOL", route: "auto", assetClass: "crypto" }, instrumentKey: `sol:token:${m.liquidityMint.toBase58()}`, side: "buy", phase: "open", notionalUsd: shortUsd },
          Date.now(),
        );
        if (s.status !== "filled") return { status: "rejected", reason: `couldn't get ${symbol} to lend: ${s.reason}` };
        fees.usd += s.feeUsd;
        fees.builder += s.builderFeeUsd;
        const now = await this.changed(m.liquidityMint, held, true);
        amount = now < want ? now : want; // what the swap actually brought, never more than asked
      }
    }
    if (amount <= 0n) return { status: "rejected", reason: "the deposit rounds to zero" };

    const before = await this.balance(m.shareMint);
    const sig = await this.send(wrapDeposit(m, this.user, amount, await m.deposit(this.user, amount)), req.clientId, sol ? amount : 0n);
    const after = await this.changed(m.shareMint, before, true);
    const shares = Number(after - before) / 10 ** dec;
    const depositedUsd = (Number(amount) / 10 ** dec) * tokenUsd;
    fees.usd += this.networkUsd(1, solUsd);
    const price = depositedUsd / shares;
    this.cfg.log?.(`lent ${(Number(amount) / 10 ** dec).toFixed(6)} ${symbol} on ${VENUE_NAME[m.venue]} for ${shares.toFixed(6)} receipt tokens: ${sig}`);
    return { status: "filled", qty: shares, price, markPrice: price, feeUsd: fees.usd, builderFeeUsd: fees.builder, slippageBps: 0 };
  }

  /* ---------------- withdrawal ---------------- */

  private async close(req: OrderRequest, m: LendMarket, symbol: string): Promise<ExecutionResult> {
    if (!(req.qty! > 0)) return { status: "rejected", reason: "a withdrawal needs the receipt tokens to redeem" };
    const dec = m.decimals;
    const held = await this.balance(m.shareMint);
    if (held <= 0n) return { status: "rejected", reason: `no ${symbol} receipt tokens left in the wallet` };
    let raw = BigInt(Math.floor(req.qty! * 10 ** dec));
    // What landed can differ from what was booked by a hair: never redeem more than is there, and
    // take the dust too when this is (nearly) all of it.
    if (raw > held || raw * 100n >= held * 98n) raw = held;
    const out = BigInt(Math.floor(Number(raw) * m.rate));
    if (out > m.availableRaw)
      return {
        status: "rejected",
        reason: `${VENUE_NAME[m.venue]}'s ${symbol} can't pay this back right now (${(Number(m.availableRaw) / 10 ** dec).toFixed(2)} ${symbol} free, ${(Number(out) / 10 ** dec).toFixed(2)} needed). Weft tries again as borrowers repay`,
      };
    const solUsd = await this.solUsd();
    const tokenUsd = await this.tokenUsd(m.liquidityMint, dec, solUsd);
    const sig = await this.send(wrapWithdraw(m, this.user, await m.withdraw(this.user, raw)), req.clientId, 0n);
    await this.changed(m.shareMint, held, false);
    const shares = Number(raw) / 10 ** dec;
    const price = ((Number(out) / 10 ** dec) * tokenUsd) / shares;
    this.cfg.log?.(`withdrew ${(Number(out) / 10 ** dec).toFixed(6)} ${symbol} from ${VENUE_NAME[m.venue]}: ${sig}`);
    return { status: "filled", qty: Math.min(shares, req.qty!), price, markPrice: price, feeUsd: this.networkUsd(1, solUsd), builderFeeUsd: 0, slippageBps: 0 };
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
