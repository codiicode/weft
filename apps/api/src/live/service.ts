import {
  buildApproveAgent,
  buildApproveBuilderFee,
  buildWithdraw,
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
import type { HolderDiscount, HolderStatus } from "./holders.ts";

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
  /** feeTenthsBps: perps and outcomes (max 100 = 0.1%); spotFeeTenthsBps: spot sells (max 1000 = 1%). */
  builder: { address: Hex; feeTenthsBps: number; spotFeeTenthsBps: number } | null;
  /** Optional ceiling per live run, USD. Null: none (people trade whatever amount they choose). */
  maxAllocationUsd: number | null;
  maxLeverage: number;
}

/** A USD cap from the environment: unset, empty, "0" or "none" mean no cap. */
export function capFromEnv(v: string | undefined): number | null {
  if (v == null || v.trim() === "" || /^(0|none|off)$/i.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const builder = env.WEFT_BUILDER_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(env.WEFT_BUILDER_ADDRESS)
    ? { address: env.WEFT_BUILDER_ADDRESS.toLowerCase() as Hex, feeTenthsBps: Number(env.WEFT_BUILDER_FEE_TENTHS_BPS ?? 100), spotFeeTenthsBps: Number(env.WEFT_BUILDER_SPOT_FEE_TENTHS_BPS ?? 1000) }
    : null;
  return {
    enabled: env.WEFT_LIVE_ENABLED === "1",
    network: env.WEFT_HL_NETWORK === "mainnet" ? "mainnet" : "testnet",
    builder,
    maxAllocationUsd: capFromEnv(env.WEFT_LIVE_MAX_ALLOCATION_USD),
    // Hyperliquid's own per-market maximum is enforced on every order; 50× is the highest it lists anywhere.
    maxLeverage: Number(env.WEFT_LIVE_MAX_LEVERAGE ?? 50),
  };
}

export const hlBaseUrl = (network: "testnet" | "mainnet") =>
  network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";

export interface LiveStatus {
  config: { enabled: boolean; network: "testnet" | "mainnet"; builder: string | null; builderFeeBps: number | null; builderSpotFeeBps: number | null; builderApproveBps: number | null; maxAllocationUsd: number | null; maxLeverage: number };
  account: LiveAccount | null;
  agentAddress: string | null;
  /** From Hyperliquid, when an account is linked. */
  venue: {
    accountValueUsd: number | null;
    withdrawableUsd: number | null;
    /** Margin held by open positions. */
    marginUsedUsd: number | null;
    /** What the open positions are worth (margin + unrealized P&L): accountValue − this is free to trade. */
    positionsWorthUsd: number | null;
    agentApprovedOnVenue: boolean | null;
    builderMaxFeeTenthsBps: number | null;
  } | null;
  ready: boolean;
  blockers: string[];
  /** $WEFT holder discount on Weft's builder fee, when the token is live. */
  holder?: HolderStatus | null;
}

type Pending = { kind: "agent" | "builder" | "withdraw"; req: UserSignRequest<Record<string, unknown> & { signatureChainId: string }>; hlAddress: Hex; expires: number };

export class LiveService {
  private readonly pending = new Map<string, Pending>();
  private readonly executors = new Map<string, HyperliquidExecutor>();
  readonly cfg: LiveConfig;
  private readonly accounts: Accounts;
  private readonly agents: AgentWallets | null;
  private readonly fetchFn: FetchLike;
  /** Set after construction (server wiring): the $WEFT holder discount. */
  holders: HolderDiscount | null = null;

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
      const ms = (state as { marginSummary?: { accountValue?: string; totalMarginUsed?: string } } | null)?.marginSummary;
      venue = {
        accountValueUsd: ms?.accountValue != null ? Number(ms.accountValue) : null,
        withdrawableUsd: (state as { withdrawable?: string } | null)?.withdrawable != null ? Number((state as { withdrawable: string }).withdrawable) : null,
        marginUsedUsd: ms?.totalMarginUsed != null ? Number(ms.totalMarginUsed) : null,
        positionsWorthUsd: state
          ? ((state as { assetPositions?: { position?: { marginUsed?: string; unrealizedPnl?: string } }[] }).assetPositions ?? []).reduce(
              (n, a) => n + Number(a.position?.marginUsed ?? 0) + Number(a.position?.unrealizedPnl ?? 0),
              0,
            )
          : null,
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
        builderSpotFeeBps: this.cfg.builder ? this.cfg.builder.spotFeeTenthsBps / 10 : null,
        /** What a full approval covers: accounts below it still trade, spot at the lower fee. */
        builderApproveBps: this.cfg.builder ? Math.max(this.cfg.builder.feeTenthsBps, this.cfg.builder.spotFeeTenthsBps) / 10 : null,
        maxAllocationUsd: this.cfg.maxAllocationUsd,
        maxLeverage: this.cfg.maxLeverage,
      },
      account: this.accounts.liveAccount(userId),
      agentAddress: agent?.address ?? null,
      venue,
      ready: blockers.length === 0,
      blockers,
      holder: this.holders?.enabled ? await this.holders.status(userId).catch(() => null) : null,
    };
  }

  linkAccount(userId: string, hlAddress: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(hlAddress)) throw new Error("not an EVM address");
    this.accounts.setLiveAccount(userId, this.cfg.network, hlAddress.toLowerCase());
    // A new account (or network) must never inherit the old executor.
    for (const k of [...this.executors.keys()]) if (k.startsWith(`${userId}|`)) this.executors.delete(k);
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
    // Only what's missing: Hyperliquid refuses to approve the same agent twice ("Extra agent already
    // used"), which would also stop the fee approval behind it.
    const info = new HttpHlInfo(this.base, this.fetchFn);
    const [agents, maxFee] = await Promise.all([
      postJson<{ address: string }[]>(this.fetchFn, `${this.base}/info`, { type: "extraAgents", user: account.hlAddress }).catch(() => null),
      this.cfg.builder ? info.maxBuilderFee(account.hlAddress, this.cfg.builder.address).catch(() => null) : Promise.resolve(null),
    ]);
    const agentDone = !!agents?.some((a) => a.address.toLowerCase() === agent.address.toLowerCase());
    // Ask for the highest fee Weft charges (spot sells); perps stay at their own, lower fee.
    const target = this.cfg.builder ? Math.max(this.cfg.builder.feeTenthsBps, this.cfg.builder.spotFeeTenthsBps) : 0;
    const builderDone = !this.cfg.builder || (typeof maxFee === "number" && maxFee >= target);
    if (agentDone) this.accounts.markApproved(userId, "agent");
    if (builderDone && this.cfg.builder) this.accounts.markApproved(userId, "builder");
    if (!agentDone) {
      const agentReq = buildApproveAgent({ isMainnet: this.isMainnet, agentAddress: agent.address, agentName: AGENT_NAME, signatureChainId, nonce: now });
      this.pending.set(`${userId}:agent`, { kind: "agent", req: agentReq, hlAddress: account.hlAddress, expires: now + 10 * 60_000 });
      out.push({ kind: "agent", typedData: withDomainType(agentReq.typedData) });
    }
    if (this.cfg.builder && !builderDone) {
      const b = buildApproveBuilderFee({ isMainnet: this.isMainnet, builder: this.cfg.builder.address, maxFeeTenthsBps: target, signatureChainId, nonce: now + 1 });
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
    if ((res as { status?: string }).status !== "ok") {
      const why = typeof (res as { response?: unknown }).response === "string" ? (res as { response: string }).response : JSON.stringify(res).slice(0, 300);
      console.warn(`[live] ${kind} approval rejected by Hyperliquid (${this.cfg.network}): ${why}`);
      throw new Error(`Hyperliquid rejected the ${kind} approval: ${why}`);
    }
    this.pending.delete(`${userId}:${kind}`);
    this.accounts.markApproved(userId, kind);
    return { ok: true as const, response: res };
  }

  /**
   * A withdrawal from the user's Hyperliquid account to an address on Arbitrum. Only the account
   * owner can sign it (Weft's agent can't withdraw); Hyperliquid takes a $1 fee from the amount.
   */
  async prepareWithdraw(userId: string, destination: string, amountUsd: number, signatureChainId: string) {
    const account = this.accounts.liveAccount(userId);
    if (!account || account.network !== this.cfg.network) throw new Error("set up your Hyperliquid account first");
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) throw new Error("that isn’t an Arbitrum (0x…) address");
    if (!(amountUsd > 1)) throw new Error("withdrawals must be more than $1 (Hyperliquid’s fee)");
    const st = (await new HttpHlInfo(this.base, this.fetchFn).clearinghouseState(account.hlAddress)) as { withdrawable?: string };
    const free = Number(st.withdrawable ?? 0);
    if (amountUsd > free + 1e-6) throw new Error(`you can withdraw up to $${Math.floor(free * 100) / 100} right now (money held by open positions stays until they close)`);
    const amount = Math.floor(amountUsd * 1e6) / 1e6;
    const req = buildWithdraw({ isMainnet: this.isMainnet, destination: destination as Hex, amountUsd: amount, signatureChainId, nonce: Date.now() });
    this.pending.set(`${userId}:withdraw`, { kind: "withdraw", req, hlAddress: account.hlAddress, expires: Date.now() + 10 * 60_000 });
    return { amountUsd: amount, receiveUsd: Math.max(0, amount - 1), destination, typedData: withDomainType(req.typedData) };
  }

  async submitWithdraw(userId: string, signature: Hex) {
    const p = this.pending.get(`${userId}:withdraw`);
    if (!p || p.expires < Date.now()) throw new Error("no pending withdrawal (start again)");
    const request = await p.req.toRequest(signature, p.hlAddress);
    const client = new HlExchangeClient({ baseUrl: this.base, isMainnet: this.isMainnet, fetch: this.fetchFn, allowMainnetSend: this.isMainnet } as never);
    const res = await client.post(request);
    this.pending.delete(`${userId}:withdraw`);
    if ((res as { status?: string }).status !== "ok") {
      const why = typeof (res as { response?: unknown }).response === "string" ? (res as { response: string }).response : JSON.stringify(res).slice(0, 300);
      throw new Error(`Hyperliquid refused the withdrawal: ${why}`);
    }
    return { ok: true as const };
  }

  /** Throws with a user-facing reason when a strategy can't go live as configured. */
  assertDeployable(userId: string, strategy: Strategy, allocationUsd: number, otherLiveInstruments: Set<string>) {
    if (!this.cfg.enabled) throw new Error("live trading is switched off on this server");
    const account = this.accounts.liveAccount(userId);
    if (!account || !account.agentApprovedAt) throw new Error("approve the Weft agent for your Hyperliquid account first");
    if (account.network !== this.cfg.network) throw new Error(`your linked account is on ${account.network}; this server trades on ${this.cfg.network}. Link it again.`);
    if (this.cfg.builder && !account.builderApprovedAt) throw new Error("approve the builder fee first");
    if (this.cfg.maxAllocationUsd != null && allocationUsd > this.cfg.maxAllocationUsd) throw new Error(`live allocation is capped at $${this.cfg.maxAllocationUsd} for now`);
    for (const a of strategy.actions) {
      if (a.type === "options") throw new Error("options can't trade live yet");
      if (a.type !== "open") continue;
      if (a.order.type === "limit") throw new Error("limit orders can't trade live yet; use market orders with a slippage limit");
      const k = a.instrument.kind;
      if (k === "outcome" && a.instrument.venue !== "hyperliquid") throw new Error("this prediction market can't trade live yet (Hyperliquid's own markets only)");
      if (k !== "perp" && k !== "spot" && k !== "outcome") throw new Error(`${k} instruments can't trade on Hyperliquid`);
      if (a.leverage > this.cfg.maxLeverage) throw new Error(`live leverage is capped at ${this.cfg.maxLeverage}×`);
      const key =
        a.instrument.kind === "perp"
          ? `hl:perp:${a.instrument.dex ? `${a.instrument.dex}:` : ""}${a.instrument.symbol}`
          : a.instrument.kind === "outcome"
            ? `hl:outcome:${a.instrument.market}:${a.instrument.outcome}`
            : `hl:spot:${(a.instrument as { symbol: string }).symbol}`;
      if (otherLiveInstruments.has(key)) throw new Error(`another live strategy already trades ${key.split(":").pop()} in this account (positions would net)`);
    }
  }

  /** Why this user can't trade live right now, re-checked on every order (null = fine). */
  blockReason(userId: string): string | null {
    if (!this.cfg.enabled) return "live trading is switched off";
    const account = this.accounts.liveAccount(userId);
    if (!account || !this.agents?.existing(userId)) return "no live account or agent for this user";
    if (account.network !== this.cfg.network) return `linked account is on ${account.network}, server trades on ${this.cfg.network}`;
    if (!account.agentApprovedAt) return "the Weft agent is not approved for this account";
    if (this.cfg.builder && !account.builderApprovedAt) return "the builder fee is not approved";
    return null;
  }

  /** The executor with the user's current fee (holders of $WEFT pay less). */
  async executorReady(userId: string): Promise<HyperliquidExecutor> {
    const mult = (await this.holders?.status(userId).catch(() => null))?.feeMultiplier ?? 1;
    return this.executorFor(userId, mult);
  }

  /** The executor for one user's live deployments (Privy-signed agent → their account). */
  executorFor(userId: string, feeMultiplier = 1): HyperliquidExecutor {
    const account = this.accounts.liveAccount(userId);
    const agent = this.agents?.existing(userId);
    if (!account || !agent || !this.agents) throw new Error("no live account or agent for this user");
    const key = `${userId}|${account.hlAddress}|${this.cfg.network}|${feeMultiplier}`;
    const cached = this.executors.get(key);
    if (cached) return cached;
    const ex = new HyperliquidExecutor({
      agentSigner: this.agents.signer(agent),
      userAddress: account.hlAddress,
      isMainnet: this.isMainnet,
      baseUrl: this.base,
      fetch: this.fetchFn,
      // HIP-4 prediction markets trade through the same agent and account as perps.
      outcomes: { enabled: true },
      builder:
        this.cfg.builder && feeMultiplier !== 1
          ? { ...this.cfg.builder, feeTenthsBps: Math.round(this.cfg.builder.feeTenthsBps * feeMultiplier), spotFeeTenthsBps: Math.round(this.cfg.builder.spotFeeTenthsBps * feeMultiplier) }
          : this.cfg.builder,
      allowMainnetSend: this.isMainnet,
    });
    this.executors.set(key, ex);
    return ex;
  }
}

/** Routes a live engine's orders to the right user's executor via the deployment owner. */
export class LiveRouterExecutor implements Executor {
  readonly mode = "live" as const;
  /** Called after any filled order (venue-side stops are re-synced right away). */
  onFilled: ((userId: string, req: OrderRequest) => void) | null = null;
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
    // Re-checked on every order: network, approvals and the switch can change while a run is live.
    const blocked = this.live.blockReason(owner);
    if (blocked) return { status: "rejected", reason: blocked };
    try {
      const res = await (await this.live.executorReady(owner)).execute(req, now);
      if (res.status === "filled") this.onFilled?.(owner, req);
      return res;
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
