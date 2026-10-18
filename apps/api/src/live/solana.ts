import { createPrivateKey, createPublicKey } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  DEFAULT_ALLOWED_PROGRAMS,
  JupiterExecutor,
  DlmmExecutor,
  LP_ALLOWED_PROGRAMS,
  JupiterSwapBuilder,
  USDC_MINT,
  WSOL_MINT,
  associatedTokenAddress,
  type ExecutionResult,
  type Executor,
  type JupiterRpc,
  type OrderRequest,
  type Signer,
} from "@weft/execution";
import type { Strategy } from "@weft/strategy";
import type { Accounts } from "../lib/accounts.ts";
import type { HolderDiscount, HolderStatus } from "./holders.ts";
import { capFromEnv } from "./service.ts";

/**
 * Live trading of Solana tokens, non-custodially.
 *
 * The user's Solana wallet is a Privy embedded wallet that THEY own (they can export it or move
 * funds out at any time). They add Weft as a limited signer: a Privy key quorum whose policy only
 * allows signing transactions that call the swap programs (Jupiter, SPL Token, ATA, Compute
 * Budget, System). On top of that, every transaction Weft builds is inspected before signing
 * (`inspectSwapTransaction`): the user must be the only authority, outputs land in the user's own
 * accounts, the only other recipient is Weft's fee account. Weft's authorization key lives only
 * in the server's environment.
 */

export const SOLANA_POLICY_NAME = "weft-solana-swaps-v1";

export interface SolanaLiveConfig {
  enabled: boolean;
  rpcUrl: string;
  /** Optional ceiling per run, USD. Null: none. */
  maxAllocationUsd: number | null;
  /** Weft's platform fee, bps (charged only when fee accounts are configured). */
  platformFeeBps: number;
  /** Weft's fee wallet; its WSOL and USDC token accounts receive the platform fee. */
  feeWallet: PublicKey | null;
  /** Privy authorization private key (base64 PKCS8), the key behind Weft's signer. */
  authorizationKey: string | null;
  /** Users who may trade before it's switched on for everyone (Privy DIDs or sign-in emails). */
  testers: string[];
  /** Jupiter API key (portal.jup.ag): api.jup.ag with higher limits instead of the throttled lite-api. */
  jupiterApiKey?: string | null;
  /** Liquidity in Meteora DLMM pools with real money (needs Weft's signer policy to allow DLMM). */
  lpEnabled?: boolean;
}

export function solanaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SolanaLiveConfig {
  let feeWallet: PublicKey | null = null;
  try {
    feeWallet = env.WEFT_SOL_FEE_WALLET ? new PublicKey(env.WEFT_SOL_FEE_WALLET) : null;
  } catch {
    feeWallet = null;
  }
  return {
    enabled: env.WEFT_SOL_LIVE === "1",
    rpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    maxAllocationUsd: capFromEnv(env.WEFT_SOL_MAX_ALLOCATION_USD ?? env.WEFT_LIVE_MAX_ALLOCATION_USD),
    platformFeeBps: Number(env.WEFT_SOL_FEE_BPS ?? 100),
    feeWallet,
    authorizationKey: env.PRIVY_AUTHORIZATION_KEY || null,
    testers: (env.WEFT_SOL_TESTERS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    jupiterApiKey: env.JUPITER_API_KEY || null,
    lpEnabled: env.WEFT_SOL_LP === "1",
  };
}

export interface SolanaWalletInfo {
  walletId: string;
  address: string;
  /** Weft's signer is attached to the wallet. */
  delegated: boolean;
}

/** The slice of Privy we use (injectable for tests). */
export interface PrivySolanaApi {
  /** Weft's key quorum (signer) and swap policy, created once. */
  createSigner(publicKey: string): Promise<string>;
  createPolicy(): Promise<string>;
  /** Add programs to the policy's allow-list (true when it changed). */
  allowPrograms?(policyId: string, programs: string[]): Promise<boolean>;
  /** The user's embedded Solana wallets, with whether `signerId` is attached. */
  userWallets(userId: string, signerId: string): Promise<SolanaWalletInfo[]>;
  signTransaction(walletId: string, tx: Uint8Array): Promise<Uint8Array>;
  /** A Privy user id for a sign-in email (null when no such user). */
  userIdByEmail?(email: string): Promise<string | null>;
}

export function privySolanaApi(appId: string, appSecret: string, authorizationKey: string | null): PrivySolanaApi {
  const privy = new PrivyClient({ appId, appSecret });
  return {
    async createSigner(publicKey) {
      const q = await privy.keyQuorums().create({ public_keys: [publicKey], authorization_threshold: 1, display_name: "Weft trading" } as never);
      return (q as { id: string }).id;
    },
    async createPolicy() {
      const p = await privy.policies().create({
        name: SOLANA_POLICY_NAME,
        version: "1.0",
        chain_type: "solana",
        rules: [
          {
            name: "Swap programs only",
            method: "signTransaction",
            action: "ALLOW",
            conditions: [{ field_source: "solana_program_instruction", field: "programId", operator: "in", value: DEFAULT_ALLOWED_PROGRAMS.map((p) => p.toBase58()) }],
          },
        ],
      } as never);
      return (p as { id: string }).id;
    },
    async allowPrograms(policyId, programs) {
      type Cond = { field_source: string; field: string; operator: string; value: unknown };
      type Rule = { id: string; name: string; method: string; action: string; conditions: Cond[] };
      const policy = (await privy.policies().get(policyId)) as unknown as { rules: Rule[] };
      const rule = policy.rules.find((r) => r.method === "signTransaction" && r.conditions.some((c) => c.field === "programId"));
      if (!rule) throw new Error("the Solana policy has no program allow-list rule");
      const cond = rule.conditions.find((c) => c.field === "programId")!;
      const have = new Set(Array.isArray(cond.value) ? (cond.value as string[]) : [String(cond.value)]);
      const missing = programs.filter((p) => !have.has(p));
      if (!missing.length) return false;
      await privy.policies().updateRule(rule.id, {
        policy_id: policyId,
        name: rule.name,
        method: rule.method,
        action: rule.action,
        conditions: rule.conditions.map((c) => (c === cond ? { ...c, value: [...have, ...missing] } : c)),
      } as never);
      return true;
    },
    async userWallets(userId, signerId) {
      const out: SolanaWalletInfo[] = [];
      for await (const w of privy.wallets().list({ user_id: userId, chain_type: "solana" } as never) as AsyncIterable<{ id: string; address: string; additional_signers?: { signer_id: string }[] }>) {
        out.push({ walletId: w.id, address: w.address, delegated: (w.additional_signers ?? []).some((s) => s.signer_id === signerId) });
      }
      return out;
    },
    async userIdByEmail(email) {
      try {
        return ((await privy.users().getByEmailAddress({ address: email } as never)) as { id: string }).id;
      } catch {
        // Google (and other) sign-ins keep the email on a different linked account: look through users.
        const want = email.toLowerCase();
        for await (const u of privy.users().list() as AsyncIterable<{ id: string; linked_accounts?: { address?: string; email?: string }[] }>) {
          if ((u.linked_accounts ?? []).some((a) => [a.address, a.email].some((x) => typeof x === "string" && x.toLowerCase() === want))) return u.id;
        }
        return null;
      }
    },
    async signTransaction(walletId, tx) {
      if (!authorizationKey) throw new Error("PRIVY_AUTHORIZATION_KEY is not set on the server");
      const r = (await privy.wallets().solana().signTransaction(walletId, {
        transaction: tx,
        authorization_context: { authorization_private_keys: [authorizationKey] },
      } as never)) as { signed_transaction?: string; signedTransaction?: string };
      const b64 = r.signed_transaction ?? r.signedTransaction;
      if (!b64) throw new Error("Privy returned no signed transaction");
      return Buffer.from(b64, "base64");
    },
  };
}

/** A Signer for @weft/execution backed by the user's Privy wallet and Weft's limited signer. */
class PrivyWalletSigner implements Signer {
  readonly publicKey: PublicKey;
  private readonly walletId: string;
  private readonly api: PrivySolanaApi;
  constructor(api: PrivySolanaApi, walletId: string, address: string) {
    this.api = api;
    this.walletId = walletId;
    this.publicKey = new PublicKey(address);
  }
  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    const signed = VersionedTransaction.deserialize(await this.api.signTransaction(this.walletId, tx.serialize()));
    // The signed message must be byte-identical to what we inspected.
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(tx.message.serialize()))) throw new Error("Privy returned a different transaction than the one inspected");
    return signed;
  }
}

export interface SolanaStatus {
  enabled: boolean;
  /** What the browser needs to add Weft as a signer. */
  signerId: string | null;
  policyId: string | null;
  wallet: { address: string; delegated: boolean } | null;
  balances: { sol: number | null; usdc: number | null; usd: number | null } | null;
  /** USD per SOL (Jupiter), for sizing in the UI. */
  solUsd: number | null;
  /** Optional ceiling per run, USD. Null: none. */
  maxAllocationUsd: number | null;
  feeBps: number;
  /** $WEFT holder discount, when the token is live. */
  holder: HolderStatus | null;
  ready: boolean;
  blockers: string[];
}

export class SolanaLive {
  readonly cfg: SolanaLiveConfig;
  private readonly api: PrivySolanaApi | null;
  private readonly accounts: Accounts;
  private readonly conn: Connection;
  private builder: JupiterSwapBuilder;
  private feeAccountsNow: Record<string, PublicKey> = {};
  /** Set after construction (server wiring): the $WEFT holder discount. */
  holders: HolderDiscount | null = null;
  /** Fee token accounts that exist on chain (checked every 10 minutes). Missing ones are skipped. */
  private feeChecked = 0;
  private readonly executors = new Map<string, JupiterExecutor>();
  private ids: Promise<{ signerId: string; policyId: string }> | null = null;
  private testerIds = new Set<string>();
  private testersTriedAt = 0;

  constructor(cfg: SolanaLiveConfig, accounts: Accounts, api: PrivySolanaApi | null, conn?: Connection) {
    this.cfg = cfg;
    this.accounts = accounts;
    this.api = api;
    this.conn = conn ?? new Connection(cfg.rpcUrl, "confirmed");
    this.builder = this.swapBuilder({ platformFeeBps: 0 });
  }

  private swapBuilder(o: ConstructorParameters<typeof JupiterSwapBuilder>[0]): JupiterSwapBuilder {
    const key = this.cfg.jupiterApiKey;
    return new JupiterSwapBuilder(key ? { ...o, apiKey: key, baseUrl: "https://api.jup.ag/swap/v1" } : o);
  }

  /** The fee wallet's WSOL and USDC token accounts, when they exist (Jupiter fails on a missing one). */
  async feeAccounts(): Promise<Record<string, PublicKey>> {
    const out: Record<string, PublicKey> = {};
    if (!this.cfg.feeWallet) return out;
    for (const mint of [WSOL_MINT, USDC_MINT]) {
      const ata = associatedTokenAddress(this.cfg.feeWallet, mint);
      if (await this.conn.getAccountInfo(ata).catch(() => null)) out[mint.toBase58()] = ata;
    }
    return out;
  }

  private async refreshFees() {
    if (!this.cfg.feeWallet || Date.now() - this.feeChecked < 10 * 60_000) return;
    this.feeChecked = Date.now();
    const feeAccounts = await this.feeAccounts();
    this.feeAccountsNow = feeAccounts;
    const on = Object.keys(feeAccounts).length > 0;
    this.builder = this.swapBuilder({ platformFeeBps: on ? this.cfg.platformFeeBps : 0, feeAccounts });
    this.executors.clear();
  }

  /** Resolve WEFT_SOL_TESTERS to Privy user ids (emails are looked up with Privy, never trusted from the client). */
  async resolveTesters(): Promise<{ resolved: number; missing: string[] }> {
    this.testersTriedAt = Date.now();
    const missing: string[] = [];
    for (const t of this.cfg.testers) {
      if (t.startsWith("did:privy:")) this.testerIds.add(t);
      else {
        const id = (await this.api?.userIdByEmail?.(t)) ?? null;
        if (id) this.testerIds.add(id);
        else missing.push(t.replace(/(.{2}).*(@.*)/, "$1…$2"));
      }
    }
    return { resolved: this.testerIds.size, missing };
  }

  /** Open to this user: switched on for everyone, or they're a tester. */
  /** One of the configured testers (also Weft's owners: they see the earnings page). */
  isTester(userId: string): boolean {
    return this.testerIds.has(userId);
  }

  openFor(userId: string): boolean {
    return this.cfg.enabled || this.testerIds.has(userId);
  }

  /** Weft's signer and policy ids (created on first use, then remembered). */
  async signer(): Promise<{ signerId: string; policyId: string }> {
    if (!this.api) throw new Error("Solana trading needs PRIVY_APP_SECRET on the server");
    if (!this.cfg.authorizationKey) throw new Error("Solana trading needs PRIVY_AUTHORIZATION_KEY on the server");
    this.ids ??= (async () => {
      let signerId = this.accounts.kvGet("privy_sol_signer_id");
      let policyId = this.accounts.kvGet("privy_sol_policy_id");
      if (!signerId) {
        signerId = await this.api!.createSigner(publicKeyFromPkcs8(this.cfg.authorizationKey!));
        this.accounts.kvSet("privy_sol_signer_id", signerId);
      }
      if (!policyId) {
        policyId = await this.api!.createPolicy();
        this.accounts.kvSet("privy_sol_policy_id", policyId);
      }
      return { signerId, policyId };
    })().catch((e) => {
      this.ids = null;
      throw e;
    });
    return this.ids;
  }

  private price: { at: number; usd: number } | null = null;
  /** USD per SOL from a Jupiter quote, cached for a minute. */
  async solUsd(): Promise<number | null> {
    if (this.price && Date.now() - this.price.at < 60_000) return this.price.usd;
    try {
      const q = await this.builder.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 0 });
      const usd = Number(q.outAmount) / 1e6;
      if (usd > 0) this.price = { at: Date.now(), usd };
      return usd > 0 ? usd : null;
    } catch {
      return this.price?.usd ?? null;
    }
  }

  private async balances(address: string): Promise<SolanaStatus["balances"]> {
    const owner = new PublicKey(address);
    const [lamports, usdc] = await Promise.all([
      this.conn.getBalance(owner).catch(() => null),
      this.conn
        .getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT })
        .then((r) => r.value.reduce((n, a) => n + Number((a.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }).parsed?.info?.tokenAmount?.uiAmount ?? 0), 0))
        .catch(() => null),
    ]);
    const sol = lamports == null ? null : lamports / 1e9;
    const px = await this.solUsd();
    return { sol, usdc, usd: sol != null && px != null ? sol * px + (usdc ?? 0) : null };
  }

  async status(userId: string): Promise<SolanaStatus> {
    // Testers who hadn't signed up when the server started: try again, at most once a minute.
    if (!this.cfg.enabled && !this.openFor(userId) && this.cfg.testers.length > this.testerIds.size && Date.now() - this.testersTriedAt > 60_000)
      await this.resolveTesters().catch(() => {});
    const blockers: string[] = [];
    if (!this.openFor(userId)) blockers.push("Solana trading isn’t switched on yet.");
    let ids: { signerId: string; policyId: string } | null = null;
    try {
      ids = await this.signer();
    } catch (e) {
      blockers.push((e as Error).message);
    }
    const linked = this.accounts.solanaAccount(userId);
    let wallet: SolanaStatus["wallet"] = null;
    if (linked && ids && this.api) {
      const w = (await this.api.userWallets(userId, ids.signerId).catch(() => [])).find((x) => x.address === linked.address);
      wallet = { address: linked.address, delegated: Boolean(w?.delegated) };
      if (!w) blockers.push("That wallet no longer belongs to your account. Set it up again.");
      else if (!w.delegated) blockers.push("Let Weft trade from your Solana wallet.");
    } else if (!linked) blockers.push("Set up your Solana trading wallet.");
    const balances = wallet ? await this.balances(wallet.address) : null;
    const holder = this.holders?.enabled ? await this.holders.status(userId).catch(() => null) : null;
    if (balances && (balances.sol ?? 0) < 0.01) blockers.push("Add some SOL to your trading wallet (a little covers network fees).");
    return {
      enabled: this.openFor(userId),
      signerId: ids?.signerId ?? null,
      policyId: ids?.policyId ?? null,
      wallet,
      balances,
      solUsd: await this.solUsd(),
      maxAllocationUsd: this.cfg.maxAllocationUsd,
      feeBps: this.cfg.feeWallet ? Math.round(this.cfg.platformFeeBps * (holder?.feeMultiplier ?? 1)) : 0,
      holder,
      ready: blockers.length === 0,
      blockers,
    };
  }

  /** Remember which of the user's own Privy Solana wallets Weft trades from (after they added the signer). */
  async link(userId: string, address: string) {
    const { signerId } = await this.signer();
    const w = (await this.api!.userWallets(userId, signerId)).find((x) => x.address === address);
    if (!w) throw new Error("that Solana wallet isn’t one of your Weft wallets");
    if (!w.delegated) throw new Error("add Weft as a signer on that wallet first");
    this.accounts.setSolanaAccount(userId, w.address, w.walletId);
    for (const k of [...this.executors.keys()]) if (k.startsWith(`${userId}|`)) this.executors.delete(k);
    return this.status(userId);
  }

  /**
   * Live liquidity needs Weft's signer to sign Meteora DLMM transactions: once WEFT_SOL_LP is on, add
   * the DLMM and Memo programs to the policy's allow-list (every transaction is still inspected
   * first, see inspectSwapTransaction). Says what it did.
   */
  async ensureLpPolicy(): Promise<string> {
    if (!this.cfg.lpEnabled || !this.api?.allowPrograms) return "off";
    const { policyId } = await this.signer();
    const changed = await this.api.allowPrograms(policyId, LP_ALLOWED_PROGRAMS.map((p) => p.toBase58()));
    return changed ? "Meteora DLMM added to Weft's Solana signing policy" : "signing policy already allows Meteora DLMM";
  }

  assertDeployable(userId: string, strategy: Strategy, allocationUsd: number, otherMints: Set<string> = new Set()) {
    if (!this.openFor(userId)) throw new Error("Solana trading isn’t switched on yet");
    if (!this.accounts.solanaAccount(userId)) throw new Error("set up your Solana trading wallet first");
    if (this.cfg.maxAllocationUsd != null && allocationUsd > this.cfg.maxAllocationUsd) throw new Error(`Solana runs are capped at $${this.cfg.maxAllocationUsd} for now`);
    for (const a of strategy.actions) {
      if (a.type === "options") throw new Error("options can't trade live yet");
      if (a.type === "liquidity") {
        if (!this.cfg.lpEnabled) throw new Error("Liquidity strategies run as practice for now. Live deposits to Meteora are coming.");
        // One wallet: a run holding one of the pool's tokens would have it swapped away on withdrawal.
        for (const m of [a.pool.baseMint, a.pool.quoteMint]) if (m !== "So11111111111111111111111111111111111111112" && otherMints.has(m)) throw new Error(`another live strategy trades ${a.pool.symbol}'s tokens from your wallet`);
        continue;
      }
      if (a.type === "copy" && a.leader.venue !== "solana") throw new Error("a strategy can trade Solana tokens or Hyperliquid markets, not both in one run");
      if (a.type !== "open") continue;
      if (a.instrument.kind !== "token") throw new Error("a strategy can trade Solana tokens or Hyperliquid markets, not both in one run");
      if (a.order.type === "limit") throw new Error("limit orders on Solana tokens aren’t supported; use a market order with a slippage limit");
      // One wallet: two runs holding the same token would sell each other's coins.
      if (otherMints.has(a.instrument.mint)) throw new Error(`another live strategy already trades ${a.instrument.symbol ?? "this token"} from your wallet`);
    }
  }

  blockReason(userId: string): string | null {
    if (!this.openFor(userId)) return "Solana trading is switched off";
    if (!this.accounts.solanaAccount(userId)) return "no Solana trading wallet for this user";
    return null;
  }

  /** The executor, after making sure the fee setup is current. */
  async executorReady(userId: string): Promise<JupiterExecutor> {
    await this.refreshFees().catch(() => {});
    const mult = (await this.holders?.status(userId).catch(() => null))?.feeMultiplier ?? 1;
    return this.executorFor(userId, mult);
  }

  executorFor(userId: string, feeMultiplier = 1): JupiterExecutor {
    const acct = this.accounts.solanaAccount(userId);
    if (!acct || !this.api) throw new Error("no Solana trading wallet for this user");
    const key = `${userId}|${feeMultiplier}`;
    const cached = this.executors.get(key);
    if (cached) return cached;
    // $WEFT holders pay a reduced platform fee: their own builder with the discounted rate.
    const builder =
      feeMultiplier === 1 || !Object.keys(this.feeAccountsNow).length
        ? this.builder
        : this.swapBuilder({ platformFeeBps: Math.round(this.cfg.platformFeeBps * feeMultiplier), feeAccounts: this.feeAccountsNow });
    const rpc = this.rpc();
    const ex = new JupiterExecutor({
      builder,
      signer: new PrivyWalletSigner(this.api, acct.walletId, acct.address),
      rpc,
      maxPriorityFeeLamports: 1_000_000,
      sentStore: {
        get: (id) => this.accounts.kvGet(`solsent:${id}`) || null,
        set: (id, sig) => this.accounts.kvSet(`solsent:${id}`, sig),
      },
      onAccountsClosed: (r) =>
        console.log(
          "error" in r
            ? `[solana ${acct.address.slice(0, 6)}] could not close empty ${r.mint.slice(0, 6)} account: ${r.error}`
            : `[solana ${acct.address.slice(0, 6)}] closed ${r.accounts} empty ${r.mint.slice(0, 6)} account(s), rent back to the user: ${r.signature}`,
        ),
    });
    this.executors.set(key, ex);
    return ex;
  }

  /** The user's liquidity executor (Meteora DLMM), swapping through their token executor. */
  async lpExecutorReady(userId: string): Promise<DlmmExecutor> {
    const swaps = await this.executorReady(userId);
    const acct = this.accounts.solanaAccount(userId);
    if (!acct || !this.api) throw new Error("no Solana trading wallet for this user");
    return new DlmmExecutor({
      conn: this.conn,
      signer: new PrivyWalletSigner(this.api, acct.walletId, acct.address),
      swaps,
      jupiter: this.builder,
      rpc: this.rpc(),
      maxPriorityFeeLamports: 1_000_000,
      sentStore: {
        get: (id) => this.accounts.kvGet(`solsent:${id}`) || null,
        set: (id, sig) => this.accounts.kvSet(`solsent:${id}`, sig),
      },
      log: (m) => console.log(`[solana ${acct.address.slice(0, 6)}] ${m}`),
    });
  }

  private rpc(): JupiterRpc {
    const conn = this.conn;
    return {
      getAccountInfo: (k) => conn.getAccountInfo(k),
      getAddressLookupTable: (k) => conn.getAddressLookupTable(k),
      sendRawTransaction: (raw, o) => conn.sendRawTransaction(raw, o),
      confirmTransaction: (s, c) => conn.confirmTransaction(s, c),
      tokenBalance: async (owner, mint) => {
        const r = await conn.getParsedTokenAccountsByOwner(owner, { mint });
        return r.value.reduce((n, a) => n + BigInt((a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
      },
      emptyTokenAccounts: async (owner, mint) => {
        const r = await conn.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
        return r.value
          .filter((a) => (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount === "0")
          .map((a) => ({ address: a.pubkey, programId: a.account.owner }));
      },
      getLatestBlockhash: () => conn.getLatestBlockhash("confirmed"),
    } as JupiterRpc;
  }
}

/** True when a strategy opens positions in Solana tokens. */
export function tradesSolana(s: Strategy): boolean {
  return s.actions.some((a) => (a.type === "open" && a.instrument.kind === "token") || (a.type === "copy" && a.leader.venue === "solana") || a.type === "liquidity");
}

/** The base64 SPKI public key for a base64 PKCS8 P-256 private key. */
export function publicKeyFromPkcs8(pkcs8: string): string {
  const pub = createPublicKey(createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" }));
  return pub.export({ format: "der", type: "spki" }).toString("base64");
}

/** Routes the Solana engine's orders to the owning user's wallet, re-checking access on every order. */
export class SolanaRouterExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly solana: SolanaLive;
  private readonly ownerOf: (deploymentId: string) => string | null;
  constructor(solana: SolanaLive, ownerOf: (deploymentId: string) => string | null) {
    this.solana = solana;
    this.ownerOf = ownerOf;
  }
  async execute(req: OrderRequest, now: number): Promise<ExecutionResult> {
    const owner = req.deploymentId ? this.ownerOf(req.deploymentId) : null;
    if (!owner) return { status: "rejected", reason: "live order without an owning user" };
    if (req.instrument.kind !== "token" && req.instrument.kind !== "lp") return { status: "rejected", reason: "the Solana engine only trades Solana tokens and liquidity" };
    const blocked = this.solana.blockReason(owner);
    if (blocked) return { status: "rejected", reason: blocked };
    try {
      if (req.instrument.kind === "lp") {
        if (!this.solana.cfg.lpEnabled) return { status: "rejected", reason: "live liquidity is switched off" };
        return await (await this.solana.lpExecutorReady(owner)).execute(req);
      }
      return await (await this.solana.executorReady(owner)).execute(req, now);
    } catch (e) {
      return { status: "rejected", reason: (e as Error).message };
    }
  }
}
