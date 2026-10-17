import type { GraphView, Issue, Instrument, Strategy } from "@weft/strategy";
import type { DeploymentRecord, DeploymentSnapshot, EngineEvent, Fill } from "@weft/engine";
import type { MarketListing, Product, Quote } from "@weft/venues";

/**
 * Typed client for the Weft API (apps/api). Base URL from
 * NEXT_PUBLIC_API_URL, defaulting to the local dev server.
 */
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
  usd: number;
  tokens: number | null;
  claimedAt: number | null;
  claimTx: string | null;
}
export interface RewardDay {
  day: string;
  feesUsd: number;
  buybackUsd: number;
  traderPoolUsd: number;
  creatorPoolUsd: number;
  burnUsd: number;
  traders: number;
  creators: number;
  fundedAt: number | null;
  traderTokens: number | null;
  creatorTokens: number | null;
  burnedTokens: number | null;
  buyTx: string | null;
  burnTx: string | null;
}
export interface RewardsProgram {
  enabled: boolean;
  startDay: string | null;
  claims: boolean;
  config: { buybackShare: number; traderShare: number; creatorShare: number; burnShare: number; boost: readonly number[] };
  holders: { minAmount: number; bigAmount: number } | null;
  aiDailyLimit: { everyone: number; holders: number };
  stats: { daysClosed: number; feesUsd: number; rewardsUsd: number; rewardTokens: number; burnedTokens: number; days: RewardDay[] } | null;
}
export interface MyRewards {
  enabled: boolean;
  claims: boolean;
  wallet: string | null;
  holder: { tier: 0 | 1 | 2; holds: number; minAmount: number; bigAmount: number; boost: number } | null;
  today: { day: string; feesPaidUsd: number; creatorFeesUsd: number; estTradeUsd: number; estCreateUsd: number };
  claimableTokens: number;
  earnedTokens: number;
  earnedUsd: number;
  history: RewardRow[];
}

export interface Earnings {
  hyperliquid: { builder: string; earnedUsd: number; unclaimedUsd: number; claimedUsd: number; accountValueUsd: number } | null;
  solana: { feeWallet: string; wsol: number; usdc: number; sol: number; solUsd: number | null; usd: number } | null;
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
    events: { at: number; tx: string; spentUsd: number; boughtTokens: number; burnTx?: string | null; burnedTokens?: number }[];
  };
}

export interface LiveStatus {
  config: { enabled: boolean; network: "testnet" | "mainnet"; builder: string | null; builderFeeBps: number | null; maxAllocationUsd: number | null; maxLeverage: number };
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
    req<{ ok: boolean; ts: number; signals: Record<string, "live" | "simulated">; trading?: { hyperliquid: boolean; solana: boolean; network: "testnet" | "mainnet" | null } }>("/health"),

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
  stats: () => req<Stats>("/stats"),

  alertsMe: () => req<{ available: boolean; telegram: { username: string | null; linkedAt: number } | null }>("/alerts/me"),
  linkTelegram: () => req<{ url: string }>("/alerts/telegram/link", { method: "POST", json: {} }),
  unlinkTelegram: () => req<{ ok: true }>("/alerts/telegram", { method: "DELETE" }),
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
