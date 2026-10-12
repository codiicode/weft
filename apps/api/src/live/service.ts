import {
  buildApproveAgent,
  buildApproveBuilderFee,
  HlExchangeClient,
  HttpHlInfo,
  HyperliquidExecutor,
  postJson,
  type Executor,
  type ExecutionResult,
  type FetchLike,
  type OrderRequest,
  type UserSignRequest,
} from "@weft/execution";
import type { Strategy } from "@weft/strategy";
import type { Hex } from "viem";
import type { Accounts, LiveAccount } from "../lib/accounts.ts";
import type { AgentWallets } from "./agents.ts";

/**
 * Live trading on Hyperliquid, non-custodially:
 *  - the user links their own Hyperliquid account (their wallet address),
 *  - signs `approveAgent` (Weft's per-user agent wallet, held by Privy, can trade but never
 *    withdraw) and `approveBuilderFee` in their own wallet,
 *  - live deployments then trade through that agent, capped and opt-in.
 *
 * Defaults are deliberately conservative: testnet unless WEFT_HL_NETWORK=mainnet, small
 * allocation caps, Hyperliquid instruments only.
 */

export const AGENT_NAME = "weft";

export interface LiveConfig {
  enabled: boolean;
  network: "testnet" | "mainnet";
  /** Weft's builder address and fee (tenths of a bp). Null: no builder fee. */
  builder: { address: Hex; feeTenthsBps: number } | null;
  maxAllocationUsd: number;
  maxLeverage: number;
}

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const builder = env.WEFT_BUILDER_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(env.WEFT_BUILDER_ADDRESS)
    ? { address: env.WEFT_BUILDER_ADDRESS.toLowerCase() as Hex, feeTenthsBps: Number(env.WEFT_BUILDER_FEE_TENTHS_BPS ?? 50) }
    : null;
  return {
    enabled: env.WEFT_LIVE_ENABLED === "1",
    network: env.WEFT_HL_NETWORK === "mainnet" ? "mainnet" : "testnet",
    builder,
    maxAllocationUsd: Number(env.WEFT_LIVE_MAX_ALLOCATION_USD ?? 100),
    maxLeverage: Number(env.WEFT_LIVE_MAX_LEVERAGE ?? 3),
  };
}

export const hlBaseUrl = (network: "testnet" | "mainnet") =>
  network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";

export interface LiveStatus {
  config: { enabled: boolean; network: "testnet" | "mainnet"; builder: string | null; builderFeeBps: number | null; maxAllocationUsd: number; maxLeverage: number };
  account: LiveAccount | null;
  agentAddress: string | null;
  /** From Hyperliquid, when an account is linked. */
  venue: {
    accountValueUsd: number | null;
    withdrawableUsd: number | null;
    agentApprovedOnVenue: boolean | null;
    builderMaxFeeTenthsBps: number | null;
  } | null;
  ready: boolean;
  blockers: string[];
}

type Pending = { kind: "agent" | "builder"; req: UserSignRequest<Record<string, unknown> & { signatureChainId: string }>; hlAddress: Hex; expires: number };

export class LiveService {
  private readonly pending = new Map<string, Pending>();
  private readonly executors = new Map<string, HyperliquidExecutor>();
  readonly cfg: LiveConfig;
  private readonly accounts: Accounts;
  private readonly agents: AgentWallets | null;
  private readonly fetchFn: FetchLike;

  constructor(cfg: LiveConfig, accounts: Accounts, agents: AgentWallets | null, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.cfg = cfg;
    this.accounts = accounts;
    this.agents = agents;
    this.fetchFn = fetchFn;
  }

  private get base() {
    return hlBaseUrl(this.cfg.network);
  }
  private get isMainnet() {
    return this.cfg.network === "mainnet";
  }

  async status(userId: string): Promise<LiveStatus> {
    const account = this.accounts.liveAccount(userId);
    const agent = this.agents?.existing(userId) ?? null;
    const blockers: string[] = [];
    if (!this.cfg.enabled) blockers.push("Live trading is switched off on this server (WEFT_LIVE_ENABLED).");
    if (!this.agents) blockers.push("Agent wallets need PRIVY_APP_SECRET on the server.");
    if (!account) blockers.push("Link your Hyperliquid account.");
    let venue: LiveStatus["venue"] = null;
    if (account && account.network === this.cfg.network) {
      const info = new HttpHlInfo(this.base, this.fetchFn);
      const [state, agents, maxFee] = await Promise.all([
        info.clearinghouseState(account.hlAddress).catch(() => null),
        postJson<{ address: string; name: string }[]>(this.fetchFn, `${this.base}/info`, { type: "extraAgents", user: account.hlAddress }).catch(() => null),
        this.cfg.builder ? info.maxBuilderFee(account.hlAddress, this.cfg.builder.address).catch(() => null) : Promise.resolve(null),
      ]);
      const ms = (state as { marginSummary?: { accountValue?: string } } | null)?.marginSummary;
      venue = {
        accountValueUsd: ms?.accountValue != null ? Number(ms.accountValue) : null,
        withdrawableUsd: (state as { withdrawable?: string } | null)?.withdrawable != null ? Number((state as { withdrawable: string }).withdrawable) : null,
        agentApprovedOnVenue: agents && agent ? agents.some((a) => a.address.toLowerCase() === agent.address.toLowerCase()) : agents ? false : null,
        builderMaxFeeTenthsBps: typeof maxFee === "number" ? maxFee : null,
      };
      // Trust the venue over our records: re-sync approvals.
      if (venue.agentApprovedOnVenue && !account.agentApprovedAt) this.accounts.markApproved(userId, "agent");
      if (this.cfg.builder && venue.builderMaxFeeTenthsBps != null && venue.builderMaxFeeTenthsBps >= this.cfg.builder.feeTenthsBps && !account.builderApprovedAt)
        this.accounts.markApproved(userId, "builder");
      if (venue.agentApprovedOnVenue === false) blockers.push("Approve the Weft agent in your wallet.");
      if (this.cfg.builder && (venue.builderMaxFeeTenthsBps ?? 0) < this.cfg.builder.feeTenthsBps) blockers.push("Approve the builder fee in your wallet.");
      if ((venue.accountValueUsd ?? 0) <= 0) blockers.push(`Deposit USDC to your Hyperliquid ${this.cfg.network} account.`);
    } else if (account) {
      blockers.push(`Your linked account is on ${account.network}; this server trades on ${this.cfg.network}. Re-link it.`);
    }
    return {
      config: {
        enabled: this.cfg.enabled,
        network: this.cfg.network,
        builder: this.cfg.builder?.address ?? null,
        builderFeeBps: this.cfg.builder ? this.cfg.builder.feeTenthsBps / 10 : null,
        maxAllocationUsd: this.cfg.maxAllocationUsd,
        maxLeverage: this.cfg.maxLeverage,
      },
      account: this.accounts.liveAccount(userId),
      agentAddress: agent?.address ?? null,
      venue,
      ready: blockers.length === 0,
      blockers,
    };
  }

  linkAccount(userId: string, hlAddress: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(hlAddress)) throw new Error("not an EVM address");
    this.accounts.setLiveAccount(userId, this.cfg.network, hlAddress.toLowerCase());
    return this.accounts.liveAccount(userId)!;
  }

  /**
   * Builds the EIP-712 payloads the user signs in their own wallet. `signatureChainId` should be
   * the wallet's current chain (hex), since browser wallets refuse typed data for other chains.
   */
  async prepareApprovals(userId: string, signatureChainId: string) {
    if (!this.agents) throw new Error("agent wallets are not configured (PRIVY_APP_SECRET)");
    const account = this.accounts.liveAccount(userId);
    if (!account) throw new Error("link your Hyperliquid account first");
    const agent = await this.agents.forUser(userId);
    const out: { kind: "agent" | "builder"; typedData: unknown }[] = [];
    const now = Date.now();
    const agentReq = buildApproveAgent({ isMainnet: this.isMainnet, agentAddress: agent.address, agentName: AGENT_NAME, signatureChainId, nonce: now });
    this.pending.set(`${userId}:agent`, { kind: "agent", req: agentReq, hlAddress: account.hlAddress, expires: now + 10 * 60_000 });
    out.push({ kind: "agent", typedData: withDomainType(agentReq.typedData) });
    if (this.cfg.builder) {
      const b = buildApproveBuilderFee({ isMainnet: this.isMainnet, builder: this.cfg.builder.address, maxFeeTenthsBps: this.cfg.builder.feeTenthsBps, signatureChainId, nonce: now + 1 });
      this.pending.set(`${userId}:builder`, { kind: "builder", req: b, hlAddress: account.hlAddress, expires: now + 10 * 60_000 });
      out.push({ kind: "builder", typedData: withDomainType(b.typedData) });
    }
    return { agentAddress: agent.address, network: this.cfg.network, requests: out };
  }

  /** Verifies the signature is from the linked account, then submits it to Hyperliquid. */
  async submitApproval(userId: string, kind: "agent" | "builder", signature: Hex) {
    const p = this.pending.get(`${userId}:${kind}`);
    if (!p || p.expires < Date.now()) throw new Error("no pending approval (prepare it again)");
    const request = await p.req.toRequest(signature, p.hlAddress);
    const client = new HlExchangeClient({ baseUrl: this.base, isMainnet: this.isMainnet, fetch: this.fetchFn, allowMainnetSend: this.isMainnet } as never);
    const res = await client.post(request);
    if ((res as { status?: string }).status !== "ok") throw new Error(`Hyperliquid rejected the ${kind} approval: ${JSON.stringify(res).slice(0, 300)}`);
    this.pending.delete(`${userId}:${kind}`);
    this.accounts.markApproved(userId, kind);
    return { ok: true as const, response: res };
  }

  /** Throws with a user-facing reason when a strategy can't go live as configured. */
  assertDeployable(userId: string, strategy: Strategy, allocationUsd: number, otherLiveInstruments: Set<string>) {
    if (!this.cfg.enabled) throw new Error("live trading is switched off on this server");
    const account = this.accounts.liveAccount(userId);
    if (!account || !account.agentApprovedAt) throw new Error("approve the Weft agent for your Hyperliquid account first");
    if (this.cfg.builder && !account.builderApprovedAt) throw new Error("approve the builder fee first");
    if (allocationUsd > this.cfg.maxAllocationUsd) throw new Error(`live allocation is capped at $${this.cfg.maxAllocationUsd} for now`);
    for (const a of strategy.actions) {
      if (a.type === "options") throw new Error("options can't trade live yet");
      if (a.type !== "open") continue;
      const k = a.instrument.kind;
      if (k !== "perp" && k !== "spot") throw new Error(`${k} instruments can't trade live yet (Hyperliquid perps and spot only)`);
      if (a.leverage > this.cfg.maxLeverage) throw new Error(`live leverage is capped at ${this.cfg.maxLeverage}×`);
      const key = k === "perp" ? `hl:perp:${a.instrument.dex ? `${a.instrument.dex}:` : ""}${a.instrument.symbol}` : `hl:spot:${a.instrument.symbol}`;
      if (otherLiveInstruments.has(key)) throw new Error(`another live strategy already trades ${key.split(":").pop()} in this account (positions would net)`);
    }
  }

  /** The executor for one user's live deployments (Privy-signed agent → their account). */
  executorFor(userId: string): HyperliquidExecutor {
    const cached = this.executors.get(userId);
    if (cached) return cached;
    const account = this.accounts.liveAccount(userId);
    const agent = this.agents?.existing(userId);
    if (!account || !agent || !this.agents) throw new Error("no live account or agent for this user");
    const ex = new HyperliquidExecutor({
      agentSigner: this.agents.signer(agent),
      userAddress: account.hlAddress,
      isMainnet: this.isMainnet,
      baseUrl: this.base,
      fetch: this.fetchFn,
      builder: this.cfg.builder,
      allowMainnetSend: this.isMainnet,
    });
    this.executors.set(userId, ex);
    return ex;
  }
}

/** Routes a live engine's orders to the right user's executor via the deployment owner. */
export class LiveRouterExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly live: LiveService;
  private readonly ownerOf: (deploymentId: string) => string | null;
  constructor(live: LiveService, ownerOf: (deploymentId: string) => string | null) {
    this.live = live;
    this.ownerOf = ownerOf;
  }
  async execute(req: OrderRequest, now: number): Promise<ExecutionResult> {
    if (!this.live.cfg.enabled) return { status: "rejected", reason: "live trading is switched off" };
    const owner = req.deploymentId ? this.ownerOf(req.deploymentId) : null;
    if (!owner) return { status: "rejected", reason: "live order without an owning user" };
    try {
      return await this.live.executorFor(owner).execute(req, now);
    } catch (e) {
      return { status: "rejected", reason: (e as Error).message };
    }
  }
}

/** eth_signTypedData_v4 wants EIP712Domain listed in types. */
function withDomainType(td: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }) {
  if (td.types.EIP712Domain) return td;
  return {
    ...td,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...td.types,
    },
  };
}
