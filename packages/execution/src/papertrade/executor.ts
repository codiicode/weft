import type { Hex } from "viem";
import type { ExecutionResult, Executor, OrderRequest } from "../types.ts";
import { signIntent, type PtSigner } from "./intents.ts";

/**
 * Engine `Executor` for Papertrade (synthetic BTC/ETH perps on HyperEVM), from the user's own
 * Papertrade account.
 *
 *  open   OpenPosition (margin in wad, integer leverage) signed by the account's session key, posted
 *         to the relayer; filled once the position shows in the wallet's live state (matched by
 *         intent id), at its entry price. Papertrade charges nothing on an open.
 *  close  Close (the position's id) signed the same way; filled from the account's settled trade,
 *         so the fee is exactly what Papertrade kept of the gain (haircut and win fee) and a bust
 *         shows as the margin lost.
 *
 * The session key can only open and close: Papertrade refuses withdrawals, staking and key changes
 * signed by it. Registering it (a wallet signature) and funding the account happen outside.
 */

export interface PapertradeAccount {
  /** The Papertrade account: the user's EVM wallet. */
  wallet: Hex;
  /** Its registered session key. */
  session: PtSigner;
}

export interface PapertradeExecutorConfig {
  account: (deploymentId: string) => Promise<PapertradeAccount | null>;
  api?: string;
  fetch?: typeof fetch;
  /** Durable record of sent intents by clientId (never sent twice, even across restarts). */
  sentStore?: { get(clientId: string): string | null; set(clientId: string, intentId: string): void };
  /** How long to wait for an open or close to show (default 60 s), and how often to look. */
  timeoutMs?: number;
  pollMs?: number;
  log?: (m: string) => void;
}

const INSTRUMENT: Record<string, { id: number; scale: number }> = { BTC: { id: 0, scale: 10 }, ETH: { id: 1, scale: 100 } };
const wadToUsd = (s: string) => Number(BigInt(s)) / 1e18;
const usdToWad = (usd: number) => BigInt(Math.floor(usd * 1e6)) * 10n ** 12n;

/** Position tuple from the live wallet state. */
type LivePosition = [string, number, boolean, boolean, string, string, number, string, number, string];
interface TradeRow { positionId: string; kind: "PositionClosed" | "Liquidated"; isLong: boolean; entryPriceRaw: string; exitPriceRaw: string | null; priceScaleRaw: string; marginRaw: string; leverage: number; adjustedPnlRaw: string; userPaidFeeRaw: string }

export class PapertradeError extends Error {
  readonly code: string;
  /** Papertrade's own reason ("openInterest", "marketPaused", …). */
  readonly reason: string | null;
  constructor(code: string, message: string, reason: string | null = null) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/** Refusals that pass on their own: a full open-interest side frees up as others close; a pause ends. */
const PASSES = new Set(["openInterest", "tradingPaused", "marketPaused"]);

const REASONS: Record<string, string> = {
  tradingPaused: "Papertrade has paused trading",
  marketPaused: "Papertrade has paused this market",
  belowMinimum: "the margin is under Papertrade's minimum",
  belowMinimumNotional: "the position (margin × leverage) is under Papertrade's minimum",
  leverageTooHigh: "the leverage is above Papertrade's maximum",
  positionTooLarge: "the position is above Papertrade's maximum",
  openInterest: "Papertrade is full on this side right now (its open-interest cap). Weft tries again as positions close",
  funding: "there isn't enough free balance in the Papertrade account",
  noOpenPositions: "that position is already closed",
  noDeposit: "the Papertrade account has no deposit yet",
};

export class PapertradeExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly cfg: PapertradeExecutorConfig;
  private readonly sent = new Map<string, string>();
  private nonceSeq = 0;
  constructor(cfg: PapertradeExecutorConfig) {
    this.cfg = cfg;
  }

  private get base() {
    return (this.cfg.api ?? "https://exchange.papertrade.xyz").replace(/\/$/, "");
  }
  private get f() {
    return this.cfg.fetch ?? fetch;
  }
  /** Unique per wallet and lane is all Papertrade needs. */
  private nonce(): bigint {
    return BigInt(Date.now()) * 1000n + BigInt(this.nonceSeq++ % 1000);
  }

  async execute(req: OrderRequest): Promise<ExecutionResult> {
    try {
      const i = req.instrument;
      if (i.kind !== "synth") return { status: "rejected", reason: `PapertradeExecutor cannot trade ${i.kind}` };
      if (!req.deploymentId) return { status: "rejected", reason: "a Papertrade order needs its run" };
      const acct = await this.cfg.account(req.deploymentId);
      if (!acct) return { status: "rejected", reason: "this account has no Papertrade session set up" };
      return req.phase === "open" ? await this.open(req, i.symbol, acct) : await this.close(req, acct);
    } catch (e) {
      // An open refused for a reason that passes (its side is full, a pause): nothing was placed, so the
      // rule may try again later instead of giving up on the trade.
      const passes = req.phase === "open" && e instanceof PapertradeError && e.reason != null && PASSES.has(e.reason);
      return { status: "rejected", reason: e instanceof Error ? e.message : String(e), ...(passes ? { retry: true } : {}) };
    }
  }

  private async post(action: string, signed: unknown): Promise<{ intentId?: string }> {
    const r = await this.f(`${this.base}/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, signed }), signal: AbortSignal.timeout(20_000) });
    const body = (await r.json().catch(() => ({}))) as { code?: string; reason?: string; message?: string; intentId?: string; action?: string };
    if (!r.ok) throw new PapertradeError(body.code ?? `http_${r.status}`, `Papertrade refused it: ${(body.reason && REASONS[body.reason]) ?? body.message ?? body.reason ?? body.code ?? `HTTP ${r.status}`}`, body.reason ?? null);
    return body;
  }

  /** The wallet's first live-state snapshot (Server-Sent Events: the first `wallet` event). */
  async walletState(wallet: string): Promise<{ openPositions: LivePosition[] }> {
    const r = await this.f(`${this.base}/state/user/live?wallet=${wallet.toLowerCase()}`, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !r.body) throw new Error(`Papertrade live state: HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const block of buf.split("\n\n").slice(0, -1)) {
          if (!/^event: wallet$/m.test(block)) continue;
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          return JSON.parse(data) as { openPositions: LivePosition[] };
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    throw new Error("Papertrade live state ended without a snapshot");
  }

  private async waitFor<T>(what: string, look: () => Promise<T | null>): Promise<T | null> {
    const until = Date.now() + (this.cfg.timeoutMs ?? 60_000);
    for (;;) {
      const v = await look().catch((e) => (this.cfg.log?.(`papertrade: ${what}: ${(e as Error).message}`), null));
      if (v) return v;
      if (Date.now() > until) return null;
      await new Promise((res) => setTimeout(res, this.cfg.pollMs ?? 2_000));
    }
  }

  /** Position ids that have settled on Papertrade (closed or busted), for a run's account. */
  async settledIds(deploymentId: string): Promise<Set<string>> {
    const acct = await this.cfg.account(deploymentId);
    if (!acct) return new Set();
    const r = await this.f(`${this.base}/query/accounts/${acct.wallet.toLowerCase()}/trades`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`trades: HTTP ${r.status}`);
    return new Set((((await r.json()) as { items?: TradeRow[] }).items ?? []).map((t) => t.positionId));
  }

  private async open(req: OrderRequest, symbol: string, acct: PapertradeAccount): Promise<ExecutionResult> {
    const m = INSTRUMENT[symbol];
    if (!m) return { status: "rejected", reason: `Papertrade doesn't list ${symbol}` };
    const leverage = Math.round(req.leverage ?? 1);
    const notional = req.notionalUsd ?? 0;
    const margin = notional / leverage;
    if (!(margin > 0)) return { status: "rejected", reason: "a Papertrade open needs a USD amount" };
    let intentId = this.sent.get(req.clientId) ?? this.cfg.sentStore?.get(req.clientId) ?? null;
    if (!intentId) {
      const message = { user: acct.wallet, instrumentId: m.id, isLong: req.side === "buy", size: usdToWad(margin), leverage, useDebt: false, nonce: this.nonce(), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
      const s = await signIntent(acct.session, "OpenPosition", message);
      const receipt = await this.post("openPosition", s.signed);
      if (receipt.intentId && receipt.intentId.toLowerCase() !== s.intentId.toLowerCase()) throw new Error(`Papertrade recorded a different intent (${receipt.intentId})`);
      intentId = s.intentId.toLowerCase();
      this.sent.set(req.clientId, intentId);
      this.cfg.sentStore?.set(req.clientId, intentId);
      this.cfg.log?.(`papertrade: open ${symbol} ${leverage}× ${req.side} $${margin.toFixed(2)} margin sent (${intentId})`);
    }
    const id = intentId;
    const pos = await this.waitFor("open", async () => (await this.walletState(acct.wallet)).openPositions.find((p) => String(p[9]).toLowerCase() === id) ?? null);
    if (!pos) return { status: "pending", reason: `sent to Papertrade (${id.slice(0, 10)}…), not open yet` };
    const entry = Number(pos[4]) / m.scale;
    const posMargin = wadToUsd(pos[5]);
    return { status: "filled", qty: (posMargin * pos[6]) / entry, price: entry, markPrice: entry, feeUsd: 0, builderFeeUsd: 0, slippageBps: 0, venueId: String(pos[0]) };
  }

  private async close(req: OrderRequest, acct: PapertradeAccount): Promise<ExecutionResult> {
    const posId = req.position?.venueId;
    if (!posId) return { status: "rejected", reason: "no Papertrade position id to close" };
    const settled = async () => {
      const r = await this.f(`${this.base}/query/accounts/${acct.wallet.toLowerCase()}/trades`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`trades: HTTP ${r.status}`);
      return ((await r.json()) as { items?: TradeRow[] }).items?.find((t) => t.positionId === posId) ?? null;
    };
    // Already settled (closed earlier, or busted on chain): book that.
    let row = await settled().catch(() => null);
    if (!row && !(this.sent.get(req.clientId) ?? this.cfg.sentStore?.get(req.clientId))) {
      const s = await signIntent(acct.session, "Close", { user: acct.wallet, positionIds: [BigInt(posId)], nonce: this.nonce(), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
      await this.post("closePositions", s.signed);
      this.sent.set(req.clientId, s.intentId);
      this.cfg.sentStore?.set(req.clientId, s.intentId);
      this.cfg.log?.(`papertrade: close of ${posId} sent (${s.intentId})`);
    }
    row ??= await this.waitFor("close", settled);
    if (!row) return { status: "pending", reason: `close of Papertrade position ${posId} sent, not settled yet` };
    const scale = Number(row.priceScaleRaw);
    const entry = Number(row.entryPriceRaw) / scale;
    const margin = wadToUsd(row.marginRaw);
    const notional = margin * row.leverage;
    const qty = req.qty ?? notional / entry;
    // A bust has no exit price: it lost the margin. Otherwise the gain Papertrade paid, after its 2%.
    const net = row.kind === "Liquidated" ? -margin : wadToUsd(row.adjustedPnlRaw) - wadToUsd(row.userPaidFeeRaw);
    const dir = row.isLong ? 1 : -1;
    const exit = row.exitPriceRaw != null ? Number(row.exitPriceRaw) / scale : entry * (1 + (dir * net) / notional);
    const raw = (notional * (exit - entry) * dir) / entry;
    return { status: "filled", qty, price: exit, markPrice: exit, feeUsd: Math.max(0, raw - net), builderFeeUsd: 0, slippageBps: 0 };
  }
}
