import { createPrivateKey, createPublicKey } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  DEFAULT_ALLOWED_PROGRAMS,
  JupiterExecutor,
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
  maxAllocationUsd: number;
  /** Weft's platform fee, bps (charged only when fee accounts are configured). */
  platformFeeBps: number;
  /** Weft's fee wallet; its WSOL and USDC token accounts receive the platform fee. */
  feeWallet: PublicKey | null;
  /** Privy authorization private key (base64 PKCS8), the key behind Weft's signer. */
  authorizationKey: string | null;
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
    maxAllocationUsd: Number(env.WEFT_SOL_MAX_ALLOCATION_USD ?? env.WEFT_LIVE_MAX_ALLOCATION_USD ?? 100),
    platformFeeBps: Number(env.WEFT_SOL_FEE_BPS ?? 50),
    feeWallet,
    authorizationKey: env.PRIVY_AUTHORIZATION_KEY || null,
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
  /** The user's embedded Solana wallets, with whether `signerId` is attached. */
  userWallets(userId: string, signerId: string): Promise<SolanaWalletInfo[]>;
  signTransaction(walletId: string, tx: Uint8Array): Promise<Uint8Array>;
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
    async userWallets(userId, signerId) {
      const out: SolanaWalletInfo[] = [];
      for await (const w of privy.wallets().list({ user_id: userId, chain_type: "solana" } as never) as AsyncIterable<{ id: string; address: string; additional_signers?: { signer_id: string }[] }>) {
        out.push({ walletId: w.id, address: w.address, delegated: (w.additional_signers ?? []).some((s) => s.signer_id === signerId) });
      }
      return out;
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
  balances: { sol: number | null; usdc: number | null } | null;
  maxAllocationUsd: number;
  feeBps: number;
  ready: boolean;
  blockers: string[];
}

export class SolanaLive {
  readonly cfg: SolanaLiveConfig;
  private readonly api: PrivySolanaApi | null;
  private readonly accounts: Accounts;
  private readonly conn: Connection;
  private builder: JupiterSwapBuilder;
  /** Fee token accounts that exist on chain (checked every 10 minutes). Missing ones are skipped. */
  private feeChecked = 0;
  private readonly executors = new Map<string, JupiterExecutor>();
  private ids: Promise<{ signerId: string; policyId: string }> | null = null;

  constructor(cfg: SolanaLiveConfig, accounts: Accounts, api: PrivySolanaApi | null, conn?: Connection) {
    this.cfg = cfg;
    this.accounts = accounts;
    this.api = api;
    this.conn = conn ?? new Connection(cfg.rpcUrl, "confirmed");
    this.builder = new JupiterSwapBuilder({ platformFeeBps: 0 });
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
    const on = Object.keys(feeAccounts).length > 0;
    this.builder = new JupiterSwapBuilder({ platformFeeBps: on ? this.cfg.platformFeeBps : 0, feeAccounts });
    this.executors.clear();
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

  private async balances(address: string): Promise<SolanaStatus["balances"]> {
    const owner = new PublicKey(address);
    const [lamports, usdc] = await Promise.all([
      this.conn.getBalance(owner).catch(() => null),
      this.conn
        .getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT })
        .then((r) => r.value.reduce((n, a) => n + Number((a.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }).parsed?.info?.tokenAmount?.uiAmount ?? 0), 0))
        .catch(() => null),
    ]);
    return { sol: lamports == null ? null : lamports / 1e9, usdc };
  }

  async status(userId: string): Promise<SolanaStatus> {
    const blockers: string[] = [];
    if (!this.cfg.enabled) blockers.push("Solana trading isn’t switched on yet.");
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
    if (balances && (balances.sol ?? 0) < 0.01) blockers.push("Add some SOL to your trading wallet (a little covers network fees).");
    return {
      enabled: this.cfg.enabled,
      signerId: ids?.signerId ?? null,
      policyId: ids?.policyId ?? null,
      wallet,
      balances,
      maxAllocationUsd: this.cfg.maxAllocationUsd,
      feeBps: this.cfg.feeWallet ? this.cfg.platformFeeBps : 0,
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
    this.executors.delete(userId);
    return this.status(userId);
  }

  assertDeployable(userId: string, strategy: Strategy, allocationUsd: number, otherMints: Set<string> = new Set()) {
    if (!this.cfg.enabled) throw new Error("Solana trading isn’t switched on yet");
    if (!this.accounts.solanaAccount(userId)) throw new Error("set up your Solana trading wallet first");
    if (allocationUsd > this.cfg.maxAllocationUsd) throw new Error(`Solana runs are capped at $${this.cfg.maxAllocationUsd} for now`);
    for (const a of strategy.actions) {
      if (a.type === "options") throw new Error("options can't trade live yet");
      if (a.type !== "open") continue;
      if (a.instrument.kind !== "token") throw new Error("a strategy can trade Solana tokens or Hyperliquid markets, not both in one run");
      if (a.order.type === "limit") throw new Error("limit orders on Solana tokens aren’t supported; use a market order with a slippage limit");
      // One wallet: two runs holding the same token would sell each other's coins.
      if (otherMints.has(a.instrument.mint)) throw new Error(`another live strategy already trades ${a.instrument.symbol ?? "this token"} from your wallet`);
    }
  }

  blockReason(userId: string): string | null {
    if (!this.cfg.enabled) return "Solana trading is switched off";
    if (!this.accounts.solanaAccount(userId)) return "no Solana trading wallet for this user";
    return null;
  }

  /** The executor, after making sure the fee setup is current. */
  async executorReady(userId: string): Promise<JupiterExecutor> {
    await this.refreshFees().catch(() => {});
    return this.executorFor(userId);
  }

  executorFor(userId: string): JupiterExecutor {
    const acct = this.accounts.solanaAccount(userId);
    if (!acct || !this.api) throw new Error("no Solana trading wallet for this user");
    const cached = this.executors.get(userId);
    if (cached) return cached;
    const conn = this.conn;
    const rpc: JupiterRpc = {
      getAccountInfo: (k) => conn.getAccountInfo(k),
      getAddressLookupTable: (k) => conn.getAddressLookupTable(k),
      sendRawTransaction: (raw, o) => conn.sendRawTransaction(raw, o),
      confirmTransaction: (s, c) => conn.confirmTransaction(s, c),
      tokenBalance: async (owner, mint) => {
        const r = await conn.getParsedTokenAccountsByOwner(owner, { mint });
        return r.value.reduce((n, a) => n + BigInt((a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
      },
    } as JupiterRpc;
    const ex = new JupiterExecutor({
      builder: this.builder,
      signer: new PrivyWalletSigner(this.api, acct.walletId, acct.address),
      rpc,
      maxPriorityFeeLamports: 1_000_000,
    });
    this.executors.set(userId, ex);
    return ex;
  }
}

/** True when a strategy opens positions in Solana tokens. */
export function tradesSolana(s: Strategy): boolean {
  return s.actions.some((a) => a.type === "open" && a.instrument.kind === "token");
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
    if (req.instrument.kind !== "token") return { status: "rejected", reason: "the Solana engine only trades Solana tokens" };
    const blocked = this.solana.blockReason(owner);
    if (blocked) return { status: "rejected", reason: blocked };
    try {
      return await (await this.solana.executorReady(owner)).execute(req, now);
    } catch (e) {
      return { status: "rejected", reason: (e as Error).message };
    }
  }
}
