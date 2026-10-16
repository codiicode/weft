import { createPublicClient, createWalletClient, http, parseAbi, parseSignature, verifyTypedData, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia } from "viem/chains";

/**
 * Deposits into Hyperliquid without the user paying gas. The user sends USDC on Arbitrum to their
 * own Weft wallet, signs an EIP-2612 permit for Hyperliquid's bridge (free, no transaction), and
 * Weft's relayer submits `batchedDepositWithPermit`: the bridge pulls the USDC from the user's
 * wallet and credits the same address on Hyperliquid. The relayer only pays gas; it never holds
 * or routes the user's money, and the permit can only move USDC into the bridge for that user.
 */

const NETWORKS = {
  mainnet: {
    chain: arbitrum,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDomain: { name: "USD Coin", version: "2" },
  },
  testnet: {
    chain: arbitrumSepolia,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    usdcDomain: { name: "USDC2", version: "1" },
  },
} as const;

/** Hyperliquid ignores (and keeps) deposits below this. */
export const MIN_DEPOSIT_USDC = 5;

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
]);
const BRIDGE_ABI = parseAbi([
  "struct Signature { uint256 r; uint256 s; uint8 v; }",
  "struct DepositWithPermit { address user; uint64 usd; uint64 deadline; Signature signature; }",
  "function batchedDepositWithPermit(DepositWithPermit[] deposits)",
]);

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface DepositConfig {
  network: "testnet" | "mainnet";
  /** The relayer's private key (pays Arbitrum gas). Null: deposits must be made by the user. */
  relayerKey: Hex | null;
  rpcUrl?: string;
}

export function depositConfigFromEnv(network: "testnet" | "mainnet", env: NodeJS.ProcessEnv = process.env): DepositConfig {
  const key = env.WEFT_RELAYER_KEY?.trim();
  return {
    network,
    relayerKey: key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null,
    rpcUrl: env.ARBITRUM_RPC_URL || undefined,
  };
}

export interface DepositStatus {
  network: "testnet" | "mainnet";
  chain: string;
  /** USDC sitting in the user's wallet on Arbitrum, waiting to be moved to Hyperliquid. */
  walletUsdc: number;
  minUsdc: number;
  relayer: { ready: boolean; address: string | null };
  /** The deposit Weft is moving right now, if any. */
  inFlight: { usdc: number; tx: string | null; since: number } | null;
}

type Pending = { owner: Hex; value: bigint; nonce: bigint; deadline: bigint; expires: number };

export class HlDeposits {
  readonly cfg: DepositConfig;
  private readonly net: (typeof NETWORKS)["mainnet" | "testnet"];
  private readonly client: PublicClient;
  private readonly relayer: PrivateKeyAccount | null;
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Map<string, NonNullable<DepositStatus["inFlight"]>>();
  /** One relayer transaction at a time keeps its nonces in order. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Sends the simulated bridge call (injectable for tests). */
  private readonly write: (request: unknown) => Promise<Hex>;

  constructor(cfg: DepositConfig, io: { client?: PublicClient; write?: (request: unknown) => Promise<Hex> } = {}) {
    this.cfg = cfg;
    this.net = NETWORKS[cfg.network];
    this.client = io.client ?? (createPublicClient({ chain: this.net.chain, transport: http(cfg.rpcUrl ?? this.net.rpcUrl) }) as PublicClient);
    this.relayer = cfg.relayerKey ? privateKeyToAccount(cfg.relayerKey) : null;
    const relayer = this.relayer;
    this.write =
      io.write ??
      ((request) =>
        createWalletClient({ account: relayer!, chain: this.net.chain, transport: http(cfg.rpcUrl ?? this.net.rpcUrl) }).writeContract(request as never));
  }

  get relayerAddress(): string | null {
    return this.relayer?.address ?? null;
  }

  async relayerEth(): Promise<number | null> {
    if (!this.relayer) return null;
    return Number(await this.client.getBalance({ address: this.relayer.address })) / 1e18;
  }

  private async usdcBalance(owner: Hex): Promise<bigint> {
    return this.client.readContract({ address: this.net.usdc, abi: USDC_ABI, functionName: "balanceOf", args: [owner] });
  }

  async status(userId: string, owner: string): Promise<DepositStatus> {
    const bal = await this.usdcBalance(owner as Hex).catch(() => 0n);
    const flight = this.inFlight.get(userId) ?? null;
    // Hyperliquid credits a deposit about a minute after the Arbitrum transaction lands.
    if (flight && Date.now() - flight.since > (flight.tx ? 3 : 15) * 60_000) this.inFlight.delete(userId);
    return {
      network: this.cfg.network,
      chain: this.net.chain.name,
      walletUsdc: Number(bal) / 1e6,
      minUsdc: MIN_DEPOSIT_USDC,
      relayer: { ready: !!this.relayer, address: this.relayer?.address ?? null },
      inFlight: this.inFlight.get(userId) ?? null,
    };
  }

  /** The permit the user signs: all the USDC in their wallet, into the bridge, for one hour. */
  async prepare(userId: string, owner: string) {
    if (!this.relayer) throw new Error("deposits through Weft aren't set up on this server yet");
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("not an EVM address");
    const o = owner as Hex;
    const [value, nonce] = await Promise.all([
      this.usdcBalance(o),
      this.client.readContract({ address: this.net.usdc, abi: USDC_ABI, functionName: "nonces", args: [o] }),
    ]);
    if (Number(value) / 1e6 < MIN_DEPOSIT_USDC) throw new Error(`Send at least ${MIN_DEPOSIT_USDC} USDC on ${this.net.chain.name} first.`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    this.pending.set(userId, { owner: o, value, nonce, deadline, expires: Date.now() + 10 * 60_000 });
    return {
      usdc: Number(value) / 1e6,
      typedData: {
        domain: { ...this.net.usdcDomain, chainId: this.net.chain.id, verifyingContract: this.net.usdc },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...PERMIT_TYPES,
        },
        primaryType: "Permit",
        message: { owner: o, spender: this.net.bridge, value: value.toString(), nonce: nonce.toString(), deadline: deadline.toString() },
      },
    };
  }

  /** Checks the permit is the user's, then has the relayer submit the deposit and waits for it. */
  async submit(userId: string, signature: Hex): Promise<{ tx: string; usdc: number }> {
    const p = this.pending.get(userId);
    if (!p || p.expires < Date.now()) throw new Error("no pending deposit (start again)");
    const relayer = this.relayer;
    if (!relayer) throw new Error("deposits through Weft aren't set up on this server yet");
    const ok = await verifyTypedData({
      address: p.owner,
      domain: { ...this.net.usdcDomain, chainId: this.net.chain.id, verifyingContract: this.net.usdc },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: { owner: p.owner, spender: this.net.bridge, value: p.value, nonce: p.nonce, deadline: p.deadline },
      signature,
    });
    if (!ok) throw new Error("the signature isn't from your wallet");
    this.pending.delete(userId);
    const sig = parseSignature(signature);
    const v = sig.v != null ? Number(sig.v) : 27 + (sig.yParity ?? 0);
    const usdc = Number(p.value) / 1e6;
    this.inFlight.set(userId, { usdc, tx: null, since: Date.now() });

    const send = async () => {
      const args = [[{ user: p.owner, usd: p.value, deadline: p.deadline, signature: { r: BigInt(sig.r), s: BigInt(sig.s), v } }]] as const;
      // Simulate first: a bad permit or an empty wallet fails here, before any gas is spent.
      const { request } = await this.client.simulateContract({ account: relayer, address: this.net.bridge, abi: BRIDGE_ABI, functionName: "batchedDepositWithPermit", args });
      const hash = await this.write(request);
      this.inFlight.set(userId, { usdc, tx: hash, since: Date.now() });
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`deposit transaction ${hash} failed`);
      return hash;
    };
    const job = this.queue.then(send, send);
    this.queue = job.catch(() => {});
    try {
      const tx = await job;
      return { tx, usdc };
    } catch (e) {
      this.inFlight.delete(userId);
      throw e;
    }
  }
}
