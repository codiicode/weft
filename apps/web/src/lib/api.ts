import type { GraphView, Issue, Instrument, Strategy } from "@weft/strategy";
import type { DeploymentRecord, DeploymentSnapshot, EngineEvent, Fill } from "@weft/engine";
import type { MarketListing, Product, Quote } from "@weft/venues";

/**
 * Typed client for the Weft API (apps/api). Base URL from
 * NEXT_PUBLIC_API_URL, defaulting to the local dev server.
 */
export interface RiftQuote { id: string; from: string; to: string; fromAmount: string; estimatedOut: string; expiresAt: string }
export interface RiftOrder { id: string; kind: "in" | "out"; from: string; to: string; fromAmount: string; estimatedOut: string; depositAddress: string; depositDeadline: string | null; toAddress: string; status: string; createdAt: number; movedToPerps?: boolean }

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues?: Issue[]
  ) {
    super(message);
  }
}

/** Set by the auth provider: returns the signed-in user's access token (or null). */
let tokenGetter: (() => Promise<string | null>) | null = null;
/**
 * While sign-in is still loading, requests wait for it (up to a few seconds) instead of going out
 * without a token and showing "sign in required" or "private run" for a moment.
 */
let authSettled: Promise<void> = Promise.resolve();
let settleAuth: (() => void) | null = null;
export function authLoading() {
  if (settleAuth) return;
  authSettled = new Promise((r) => (settleAuth = r));
}
export function authLoaded() {
  settleAuth?.();
  settleAuth = null;
}
export function setTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn;
}
async function authHeader(): Promise<Record<string, string>> {
  await Promise.race([authSettled, new Promise((r) => setTimeout(r, 4000))]);
  const t = tokenGetter ? await tokenGetter().catch(() => null) : null;
  return t ? { authorization: `Bearer ${t}` } : {};
}

export type ChartRange = "1H" | "1D" | "1W" | "1M" | "1Y";
export type ChartInterval = "5s" | "15s" | "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";
export interface ChartData {
  range: ChartRange | null;
  interval: ChartInterval;
  intervalMs: number;
  source: string;
  /** Hyperliquid websocket coin for live updates; null means poll. */
  liveCoin: string | null;
  /** More (older) bars exist before the first one. */
  hasMore: boolean;
  /** Second charts: when the server began recording this market. */
  recordedSince?: number | null;
  /** [openTimeMs, open, high, low, close, volumeUsd | null] */
  candles: [number, number, number, number, number, number | null][];
  /** Perps, when asked: [timeMs, fundingRatePerHour] over the last 7 days. */
  funding?: [number, number][];
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...(await authHeader()), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data?.issues ?? data?.errors);
  return data as T;
}

export interface LibraryEntry {
  id: string;
  strategy: Strategy;
  author?: string;
  forkedFrom: string | null;
  forks: number;
  createdAt: number;
  updatedAt: number;
  graph?: GraphView;
}

export interface GenerateResult {
  strategy: Strategy;
  warnings: Issue[];
  rationale: string;
  source: "claude" | "template";
  notes: string[];
  graph: GraphView;
}

export interface GenerateProgress {
  type: "search" | "submit" | "invalid" | "thinking" | "fallback";
  message: string;
}

export type Snapshot = DeploymentSnapshot & { graph?: GraphView; builderFeesUsd?: number; shared?: boolean };

/** A Hyperliquid account worth copying (public leaderboard, last 30 days). */
export interface TopTrader {
  address: string;
  name: string | null;
  accountValueUsd: number;
  pnl30dUsd: number;
  roi30dPct: number;
  pnl7dUsd: number;
  pnlAllTimeUsd: number;
  volume30dUsd: number;
}

export interface LeaderRow {
  strategy?: Strategy;
  deploymentId: string;
  strategyId: string;
  name: string;
  author: string | null;
  tags: string[];
  status: string;
  mode: string;
  returnPct: number;
  openPositions: number;
  /** [timeMs, returnPct] */
  returnCurve: [number, number][];
  since: number;
}

export interface Stats {
  deployments: number;
  running: number;
  strategies: number;
  fills: number;
  volumeUsd: number;
  feesUsd: number;
  builderFeesUsd: number;
}

/* ---------------- Backtest (mirrors apps/api/src/backtest/run.ts) ---------------- */

export type BacktestInterval = "1h" | "15m";
export type CoverageStatus = "historical" | "partial" | "unknown" | "engine" | "unused";

export interface BacktestFill {
  ts: number;
  instrumentKey: string;
  label: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnlUsd: number | null;
  fundingUsd: number | null;
  reason: Fill["reason"];
}

export interface BacktestCoverage {
  quality: "full" | "partial" | "none";
  note: string;
  notes: string[];
  signals: { id: string; kind: string; label: string; status: CoverageStatus; fields: { field: string; availability: number }[]; note?: string }[];
  instruments: {
    key: string;
    label: string;
    role: "traded" | "signal" | "reference";
    status: "historical" | "unsupported" | "error" | "no_data";
    source?: string;
    bars?: number;
    firstBarAt?: number;
    lastBarAt?: number;
    reason?: string;
  }[];
  triggers: { id: string; label: string; fires: number; entry: boolean; unknownRefs: string[] }[];
}

export interface BacktestResult {
  strategyId: string;
  name: string;
  interval: BacktestInterval;
  period: { requestedStart: number; start: number; end: number; days: number; frames: number };
  allocationUsd: number;
  stats: {
    endEquityUsd: number;
    returnPct: number;
    maxDrawdownPct: number;
    trades: number;
    closedTrades: number;
    winRatePct: number | null;
    feesUsd: number;
    builderFeesUsd: number;
    fundingUsd: number;
    exposurePct: number;
    openPositions: number;
    rejectedOrders: number;
  };
  equityCurve: [number, number][];
  fills: BacktestFill[];
  fillsTruncated: boolean;
  triggerFires: Record<string, number>;
  rejections: { message: string; count: number }[];
  coverage: BacktestCoverage;
  timing: { historyMs: number; replayMs: number };
}

export interface BacktestRequest {
  strategy?: Strategy;
  strategyId?: string;
  days?: number;
  allocationUsd?: number;
  interval?: BacktestInterval;
}

export interface Me {
  authEnabled: boolean;
  user: { id: string; wallets?: string[]; displayName?: string | null } | null;
  ai: { usedToday: number; dailyLimit: number | null } | null;
  /** Weft's owners: they see the protocol revenue page. */
  isAdmin?: boolean;
}

/** Mirrors apps/api/src/lib/earnings.ts */
export interface RewardRow {
  day: string;
  kind: "trade" | "create";
  basisUsd: number;
  share: number;
  tokens: number;
  claimedAt: number | null;
  claimTx: string | null;
}
export interface RewardsProgram {
  /** Pots fill up, but nothing is shared out or claimable yet. */
  paused?: boolean;
  enabled: boolean;
  startDay: string | null;
  claims: boolean;
  config: { buybackShare: number; traderShare: number; creatorShare: number; burnShare: number; boost: readonly number[]; tokenFee: { protocolBps: number; buybackBps: number } };
  holders: { minAmount: number; bigAmount: number } | null;
  aiDailyLimit: { everyone: number; holders: number };
  stats: {
    buys: number;
    spentUsd: number;
    boughtTokens: number;
    burnedTokens: number;
    lastBuyAt: number | null;
    sharedTokens: number;
    daysClosed: number;
    todayPotTokens: number;
    budgetLeftUsd: number;
    tokenFees: { claims: number; claimedSol: number; protocolSol: number; buybackSol: number; lastClaimAt: number | null };
  } | null;
}
export interface MyRewards {
  enabled: boolean;
  claims: boolean;
  wallet: string | null;
  holder: { tier: 0 | 1 | 2; holds: number; minAmount: number; bigAmount: number; boost: number } | null;
  today: { day: string; feesPaidUsd: number; creatorFeesUsd: number; traderPotTokens: number; creatorPotTokens: number; estTradeTokens: number; estCreateTokens: number };
  priceUsd: number | null;
  claimableTokens: number;
  earnedTokens: number;
  history: RewardRow[];
}

export interface XPrefs {
  mode: "draft" | "practice" | "live";
  sizeUsd: number;
  maxPerTweetUsd: number;
  maxPerDayUsd: number;
}
export interface XView {
  enabled: boolean;
  account: { id: string; username: string; at: number } | null;
  prefs: XPrefs;
  liveUsedTodayUsd: number;
}

export interface Earnings {
  hyperliquid: { builder: string; earnedUsd: number; unclaimedUsd: number; claimedUsd: number; accountValueUsd: number } | null;
  solana: { feeWallet: string; wsol: number; usdc: number; sol: number; solUsd: number | null; usd: number } | null;
  token: { claims: number; claimedSol: number; protocolSol: number; buybackSol: number; lastClaimAt: number | null; treasury: string | null; claimedUsd: number; protocolUsd: number; buybackUsd: number } | null;
  productUsd: number;
  recordedUsd: number;
  totalUsd: number;
  buybackUsd: number;
  weftUsd: number;
  buybacks: {
    mint: string | null;
    boughtTokens: number;
    spentUsd: number;
    burnedTokens: number;
    supply: number | null;
    initialSupply: number | null;
    setAsideUsd: number;
    launchBurn: { at: number; tx: string; tokens: number } | null;
    events: { at: number; source?: "token" | "fees"; tx: string; spentUsd: number; boughtTokens: number; burnTx?: string | null; burnedTokens?: number }[];
  };
}

export interface LiveStatus {
  config: { enabled: boolean; network: "testnet" | "mainnet"; builder: string | null; builderFeeBps: number | null; builderSpotFeeBps?: number | null; builderApproveBps?: number | null; maxAllocationUsd: number | null; maxLeverage: number };
  account: { userId: string; network: string; hlAddress: string; agentApprovedAt: number | null; builderApprovedAt: number | null } | null;
  agentAddress: string | null;
  venue: { accountValueUsd: number | null; withdrawableUsd: number | null; marginUsedUsd?: number | null; positionsWorthUsd?: number | null; agentApprovedOnVenue: boolean | null; builderMaxFeeTenthsBps: number | null } | null;
  ready: boolean;
  blockers: string[];
}

export interface SolanaStatus {
  enabled: boolean;
  signerId: string | null;
  policyId: string | null;
  wallet: { address: string; delegated: boolean } | null;
  balances: { sol: number | null; usdc: number | null; usd: number | null } | null;
  solUsd: number | null;
  maxAllocationUsd: number | null;
  feeBps: number;
  holder: { active: boolean; holds: number; minAmount: number; discount: number; feeMultiplier: number } | null;
  ready: boolean;
  blockers: string[];
}

/** Mirrors apps/api/src/live/deposits.ts */
export interface DepositStatus {
  network: "testnet" | "mainnet";
  chain: string;
  walletUsdc: number;
  minUsdc: number;
  relayer: { ready: boolean; address: string | null };
  inFlight: { usdc: number; tx: string | null; since: number } | null;
}

export interface ApprovalRequests {
  agentAddress: string;
  network: "testnet" | "mainnet";
  requests: { kind: "agent" | "builder"; typedData: Record<string, unknown> }[];
}

async function streamResult(path: string, body: unknown, onProgress: (p: GenerateProgress) => void, signal?: AbortSignal): Promise<GenerateResult> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null);
    throw new ApiError(err?.error ?? `HTTP ${res.status}`, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "progress") onProgress(payload);
      else if (event === "result") return payload as GenerateResult;
      else if (event === "error") throw new ApiError(payload.error, 422);
    }
  }
  throw new ApiError("stream ended without a result", 500);
}

export const api = {
  liveStatus: () => req<LiveStatus>("/live/status"),
  solanaStatus: () => req<SolanaStatus>("/live/solana"),
  linkSolana: (address: string) => req<SolanaStatus>("/live/solana/link", { method: "POST", json: { address } }),
  prepareSolanaWithdraw: (body: { asset: string; amount: number | "max"; destination: string }) =>
    req<{ transaction: string; asset: string; amount: number; destination: string }>("/live/solana/withdraw/prepare", { method: "POST", json: body }),
  submitSolanaWithdraw: (transaction: string) => req<{ signature: string }>("/live/solana/withdraw/submit", { method: "POST", json: { transaction } }),
  prepareWithdraw: (body: { destination: string; amountUsd: number; signatureChainId: string }) =>
    req<{ amountUsd: number; receiveUsd: number; destination: string; typedData: Record<string, unknown> }>("/live/withdraw/prepare", { method: "POST", json: body }),
  submitWithdraw: (signature: string) => req<{ ok: true }>("/live/withdraw/submit", { method: "POST", json: { signature } }),
  linkLive: (hlAddress: string) => req<LiveStatus>("/live/account", { method: "POST", json: { hlAddress } }),
  prepareApprovals: (signatureChainId: string) => req<ApprovalRequests>("/live/approvals/prepare", { method: "POST", json: { signatureChainId } }),
  submitApproval: (kind: "agent" | "builder", signature: string) => req<{ ok: true }>("/live/approvals/submit", { method: "POST", json: { kind, signature } }),
  depositStatus: () => req<DepositStatus>("/live/deposit"),
  prepareDeposit: () => req<{ usdc: number; typedData: Record<string, unknown> }>("/live/deposit/prepare", { method: "POST", json: {} }),
  submitDeposit: (signature: string) => req<{ tx: string; usdc: number }>("/live/deposit/submit", { method: "POST", json: { signature } }),

  me: () => req<Me>("/me"),
  revenue: () => req<Earnings>("/revenue"),
  rewards: () => req<RewardsProgram>("/rewards"),
  myRewards: () => req<MyRewards>("/me/rewards"),
  claimRewards: () => req<{ ok: true; tokens: number; tx: string; wallet: string }>("/rewards/claim", { method: "POST", json: {} }),
  reportProfile: (body: { wallets?: string[]; displayName?: string | null }) => req<Me["user"]>("/me", { method: "POST", json: body }),

  health: () =>
    req<{ ok: boolean; ts: number; signals: Record<string, "live" | "simulated">; trading?: { hyperliquid: boolean; solana: boolean; liquidity?: boolean; papertrade?: boolean; network: "testnet" | "mainnet" | null } }>("/health"),

  markets: (product: Product, opts: { search?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.search) q.set("search", opts.search);
    if (opts.limit) q.set("limit", String(opts.limit));
    return req<{ product: Product; rows: MarketListing[] }>(`/markets/${product}?${q}`);
  },
  market: (key: string) => req<MarketListing>(`/market?key=${encodeURIComponent(key)}`),
  chart: (instrument: Instrument, range: ChartRange, opts: { funding?: boolean } = {}) =>
    req<ChartData>("/chart", { method: "POST", json: { instrument, range, ...opts } }),
  /** `bars` bars of `interval` that open before `end` (default: now). */
  chartBars: (instrument: Instrument, interval: ChartInterval, opts: { end?: number; bars?: number; funding?: boolean } = {}) =>
    req<ChartData>("/chart", { method: "POST", json: { instrument, interval, ...opts } }),
  quote: (instrument: Instrument, opts: { side?: "buy" | "sell"; sizeUsd?: number } = {}) =>
    req<Quote>("/quote", { method: "POST", json: { instrument, ...opts } }),

  strategies: () => req<{ strategies: LibraryEntry[] }>("/strategies"),
  strategy: (id: string) => req<LibraryEntry>(`/strategies/${encodeURIComponent(id)}`),
  examples: () => req<{ strategies: Strategy[] }>("/strategies/examples"),
  validate: (strategy: unknown) =>
    req<{ ok: true; strategy: Strategy; warnings: Issue[]; graph: GraphView }>("/strategies/validate", { method: "POST", json: { strategy } }),
  saveStrategy: (strategy: Strategy, author = "@you") => req<LibraryEntry>("/strategies", { method: "POST", json: { strategy, author } }),
  updateStrategy: (id: string, strategy: Strategy) => req<LibraryEntry>(`/strategies/${encodeURIComponent(id)}`, { method: "PUT", json: { strategy } }),
  fork: (id: string, author = "@you") => req<LibraryEntry>(`/strategies/${encodeURIComponent(id)}/fork`, { method: "POST", json: { author } }),
  deleteStrategy: (id: string) => req<{ ok: true }>(`/strategies/${encodeURIComponent(id)}`, { method: "DELETE" }),

  generate: (thesis: string) => req<GenerateResult>("/ai/generate", { method: "POST", json: { thesis } }),

  /** Streams progress events while the strategy is generated. */
  generateStream(thesis: string, onProgress: (p: GenerateProgress) => void, signal?: AbortSignal): Promise<GenerateResult> {
    return streamResult("/ai/generate/stream", { thesis }, onProgress, signal);
  },
  /** Change a strategy with a plain-language instruction ("stop at 5%", "add an exit if…"). */
  refineStream(strategy: Strategy, instruction: string, onProgress: (p: GenerateProgress) => void, signal?: AbortSignal): Promise<GenerateResult> {
    return streamResult("/ai/refine/stream", { strategy, instruction }, onProgress, signal);
  },

  deployments: () => req<{ deployments: Snapshot[] }>("/deployments"),
  /** Your practice money (pretend dollars, real prices). */
  practice: () => req<{ enabled: boolean; budgetUsd: number; usedUsd: number; leftUsd: number; running: number; maxRuns: number }>("/practice"),
  deploy: (body: { strategy?: Strategy; strategyId?: string; allocationUsd: number; intervalSec?: number; mode?: "paper" | "live"; confirm?: string; alertsOnly?: boolean }) =>
    req<DeploymentRecord>("/deployments", { method: "POST", json: body }),
  deployment: (id: string) => req<Snapshot>(`/deployments/${encodeURIComponent(id)}`),
  events: (id: string, since?: number) => req<{ events: EngineEvent[] }>(`/deployments/${encodeURIComponent(id)}/events${since ? `?since=${since}` : ""}`),
  fills: (id: string) => req<{ fills: Fill[] }>(`/deployments/${encodeURIComponent(id)}/fills`),
  control: (id: string, action: "pause" | "resume" | "stop" | "kill" | "tick") =>
    req<Snapshot>(`/deployments/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
  /** Sell `fraction` of one open position at market, now. */
  sellPosition: (id: string, positionId: string, fraction: number) =>
    req<{ ok: boolean; snapshot: Snapshot }>(`/deployments/${encodeURIComponent(id)}/positions/${encodeURIComponent(positionId)}/close`, { method: "POST", json: { fraction } }),
  /** Turn a plain instruction into steps to review (nothing happens yet). */
  instruct: (id: string, text: string) =>
    req<{ planId: string; steps: { kind: "sell" | "exits" | "rules"; label: string }[]; rationale: string }>(`/deployments/${encodeURIComponent(id)}/instruct`, { method: "POST", json: { text } }),
  applyPlan: (id: string, planId: string) =>
    req<{ done: string[]; snapshot: Snapshot }>(`/deployments/${encodeURIComponent(id)}/instruct/${encodeURIComponent(planId)}/apply`, { method: "POST", json: {} }),

  /** Replay a strategy over the last N days of history through the real engine. */
  backtest: (body: BacktestRequest, signal?: AbortSignal) => req<BacktestResult>("/backtest", { method: "POST", json: body, signal }),

  alerts: () =>
    req<{ sinks: string[]; configured: boolean; recent: { strategyName: string; text: string; ts: number; kind: string }[]; help: string }>("/alerts"),
  testAlert: () => req<{ ok: true }>("/alerts/test", { method: "POST" }),
  leaderboard: () => req<{ rows: LeaderRow[] }>("/leaderboard"),
  traders: () => req<{ traders: TopTrader[] }>("/traders"),
  shareRun: (id: string, shared: boolean) => req<{ shared: boolean }>(`/deployments/${encodeURIComponent(id)}/share`, { method: "POST", json: { shared } }),
  /** Owner: freeze the run's result (percent only) into a card with its own share link. */
  resultCard: (id: string) => req<{ id: string; url: string; image: string; returnPct: number; practice: boolean }>(`/deployments/${encodeURIComponent(id)}/card`, { method: "POST" }),
  /** Keys that let an AI assistant (over MCP) read your runs. The key itself comes back once, on create. */
  aiKeys: () => req<{ keys: { id: string; label: string; createdAt: number }[] }>("/me/ai-keys"),
  createAiKey: (label: string) => req<{ key: string; id: string; label: string; createdAt: number }>("/me/ai-keys", { method: "POST", json: { label } }),
  deleteAiKey: (id: string) => req<{ ok: true }>(`/me/ai-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Papertrade: account status, the registration to sign, and the signed registration. */
  papertradeAccount: () =>
    req<{ enabled: boolean; live?: boolean; wallet?: string | null; sessionKey?: string | null; registered?: boolean; sessionExpiresAt?: number | null; depositAddress?: string | null; availableUsd?: number | null; openPositions?: number }>("/papertrade/account"),
  papertradePaper: (runId: string) => req<{ paper: number | null; atStart: number | null; earned: number | null }>(`/papertrade/paper/${encodeURIComponent(runId)}`),
  papertradeRegistration: () => req<{ domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, string> }>("/papertrade/registration", { method: "POST" }),
  papertradeRegister: (signed: Record<string, unknown>) => req<{ intentId: string }>("/papertrade/register", { method: "POST", json: { signed } }),
  papertradeDepositPrepare: (amountUsd: number, signatureChainId: string) =>
    req<{ amountUsd: number; feeUsd: number; feeRate: number; toPapertradeUsd: number; depositAddress: string; typedData: Record<string, unknown>[] }>("/papertrade/deposit/prepare", { method: "POST", json: { amountUsd, signatureChainId } }),
  papertradeDepositSubmit: (signatures: string[]) => req<{ ok: true; summary: string }>("/papertrade/deposit/submit", { method: "POST", json: { signatures } }),
  papertradeWithdrawPrepare: (amountUsd: number) => req<{ domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, string> }>("/papertrade/withdraw/prepare", { method: "POST", json: { amountUsd } }),
  papertradeWithdrawSubmit: (signed: Record<string, unknown>) => req<{ ok: true }>("/papertrade/withdraw/submit", { method: "POST", json: { signed } }),
  /** Rift: money in and out of the Hyperliquid account from any chain. */
  riftAssets: () => req<{ assets: { id: string; label: string; symbol: string; chain: string }[] }>("/rift/assets"),
  riftQuote: (kind: "in" | "out", asset: string, amount: number) => req<RiftQuote>("/rift/quote", { method: "POST", json: { kind, asset, amount } }),
  riftDeposit: (quoteId: string) => req<RiftOrder>("/rift/deposit", { method: "POST", json: { quoteId } }),
  riftWithdraw: (quoteId: string, toAddress: string, signatureChainId: string) =>
    req<{ order: RiftOrder; typedData: Record<string, unknown>[] }>("/rift/withdraw", { method: "POST", json: { quoteId, toAddress, signatureChainId } }),
  riftWithdrawSubmit: (signatures: string[]) => req<{ ok: true }>("/rift/withdraw/submit", { method: "POST", json: { signatures } }),
  riftToPerps: (orderId: string, signatureChainId: string) => req<{ amountUsd?: number; typedData: Record<string, unknown>[] }>("/rift/to-perps/prepare", { method: "POST", json: { orderId, signatureChainId } }),
  riftToPerpsSubmit: (signatures: string[]) => req<{ ok: true }>("/rift/to-perps/submit", { method: "POST", json: { signatures } }),
  riftOrders: () => req<{ orders: RiftOrder[] }>("/rift/orders"),
  /** A strategy the X bot drafted for someone who tagged @weftfinance. */
  draft: (id: string) => req<{ id: string; thesis: string; strategy: Strategy }>(`/drafts/${encodeURIComponent(id)}`),
  /** A shared result's strategy, to run it yourself. */
  result: (id: string) => req<{ id: string; name: string; practice: boolean; returnPct: number; strategy: Strategy }>(`/results/${encodeURIComponent(id)}`),
  stats: () => req<Stats>("/stats"),

  alertsMe: () => req<{ available: boolean; telegram: { username: string | null; linkedAt: number } | null }>("/alerts/me"),
  linkTelegram: () => req<{ url: string }>("/alerts/telegram/link", { method: "POST", json: {} }),
  unlinkTelegram: () => req<{ ok: true }>("/alerts/telegram", { method: "DELETE" }),
  /** Tweet a trade: the connected X account and what its tweets do. */
  xMe: () => req<XView>("/me/x"),
  xSync: () => req<XView>("/me/x/sync", { method: "POST", json: {} }),
  xPrefs: (prefs: XPrefs & { confirm?: string }) => req<XView>("/me/x/prefs", { method: "PUT", json: prefs }),
  xUnlink: () => req<XView>("/me/x", { method: "DELETE" }),
  testMyAlert: () => req<{ ok: true }>("/alerts/me/test", { method: "POST", json: {} }),
  /** Events from the signed-in user's own runs (token in the query: EventSource can't send headers). */
  subscribeMine(onEvent: (e: EngineEvent) => void): () => void {
    let es: EventSource | null = null;
    let closed = false;
    (async () => {
      const t = tokenGetter ? await tokenGetter().catch(() => null) : null;
      if (closed) return;
      es = new EventSource(`${API_URL}/events/stream${t ? `?token=${encodeURIComponent(t)}` : ""}`);
      const handler = (m: MessageEvent) => {
        try {
          onEvent(JSON.parse(m.data));
        } catch {}
      };
      for (const ty of ["fill", "rejected", "notify", "status", "error", "warning"]) es.addEventListener(ty, handler as EventListener);
    })();
    return () => {
      closed = true;
      es?.close();
    };
  },
  /** Subscribe to live engine events (SSE). Returns an unsubscribe function. */
  subscribe(onEvent: (e: EngineEvent) => void, deploymentId?: string): () => void {
    const es = new EventSource(`${API_URL}/events/stream${deploymentId ? `?deploymentId=${encodeURIComponent(deploymentId)}` : ""}`);
    const handler = (m: MessageEvent) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {}
    };
    for (const t of ["status", "tick", "trigger_met", "trigger_fired", "intent", "rejected", "fill", "notify", "warning", "error"])
      es.addEventListener(t, handler as EventListener);
    return () => es.close();
  },
};
