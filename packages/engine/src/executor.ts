import type { Instrument, OrderSpec } from "@weft/strategy";
import { DEFAULT_SYNTH_LIMITS, synthSettlement, type MarketData, type Quote, type SynthLimits } from "@weft/venues";
import { computeFee, resolveFees, type FeeOverrides, type FeeSchedule } from "./fees.ts";

/**
 * Executor: the only place an order touches a venue. The engine core decides
 * *what* to trade and does the bookkeeping; an executor decides *how* it fills.
 *
 * - `PaperExecutor` (now): fills against MarketData quotes with a slippage model and fee schedule.
 * - `HyperliquidExecutor`, `JupiterExecutor` (later): sign and send real orders, return the
 *   venue's fill. They must use `clientId` as the venue client order id (Hyperliquid `cloid`,
 *   a deterministic Jupiter memo) so a retried request can never fill twice.
 */
export interface Executor {
  readonly mode: "paper" | "live";
  execute(req: OrderRequest, now: number): Promise<ExecutionResult>;
}

export interface OrderRequest {
  /** Deterministic idempotency id (derived from the intent key / position id). */
  clientId: string;
  instrument: Instrument;
  instrumentKey: string;
  side: "buy" | "sell";
  /** "open" adds to a position, "close" reduces one (reduce-only; never blocked by slippage limits). */
  phase: "open" | "close";
  /** Opens: USD notional to trade (perps: margin × leverage). */
  notionalUsd?: number;
  /** Closes and option legs: units to trade. */
  qty?: number;
  order?: Partial<OrderSpec>;
  /** Paper only: price to use if no quote is available (kill switch on a dead feed). */
  fallbackPrice?: number;
  /** The deployment placing the order; live executors use it to pick the user's account and agent. */
  deploymentId?: string;
  /** Opens on perps: the leverage to set on the venue before trading. */
  leverage?: number;
  /**
   * Liquidity pools: where the range sits and what the pool and its quote token are worth now;
   * closes name the on-chain position to withdraw from.
   */
  lp?: { lower: number; upper: number; poolPrice: number; quoteUsd: number; position?: string; shape?: "spot" | "bid_ask" };
  /** Closes: the position being closed (Papertrade settles a win against its entry and leverage). */
  position?: { entryPrice: number; leverage: number; side: "long" | "short"; sizeUsd: number; venueId?: string };
}

export type ExecutionResult =
  | {
      status: "filled";
      qty: number;
      /** Average fill price. */
      price: number;
      /** Mid price at fill time, used as the initial mark. */
      markPrice: number;
      feeUsd: number;
      builderFeeUsd: number;
      /** Liquidity opens on chain: the position account that holds it. */
      lp?: { position: string };
      /** The venue's id for the position this opened (Papertrade). */
      venueId?: string;
      slippageBps: number;
    }
  | { status: "rejected" | "pending"; reason: string };

/** Default paper slippage (bps from mid) when a quote has no fillPrice, impact or book. */
export const DEFAULT_SLIPPAGE_BPS: Record<Instrument["kind"], number> = {
  perp: 2,
  spot: 5,
  token: 30,
  outcome: 50,
  option: 50,
  lp: 0,
  lend: 0,
  synth: 0, // Papertrade fills at the mid
};

export interface PaperExecutorOptions {
  marketData: MarketData;
  fees?: FeeOverrides | FeeSchedule;
  slippageBps?: Partial<Record<Instrument["kind"], number>>;
  quoteTimeoutMs?: number;
  /** Papertrade's live limits and market parameters (defaults to a recent snapshot). */
  synthLimits?: () => Promise<SynthLimits>;
}

/**
 * Paper fill model, in priority order:
 *  1. `quote.fillPrice` (size-aware router quote / book walk) if present;
 *  2. mid ± `quote.priceImpactBps`;
 *  3. ask (buy) / bid (sell);
 *  4. mid ± a per-kind slippage model.
 * Opens are rejected when the fill is worse than `order.maxSlippageBps` from mid or the
 * quoted impact exceeds `order.maxPriceImpactBps`. Limit orders fill only at or through
 * the limit; otherwise they are reported as `pending` (the engine skips them).
 */
export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  private readonly opts: PaperExecutorOptions;
  private readonly fees: FeeSchedule;
  private readonly slip: Record<Instrument["kind"], number>;

  constructor(opts: PaperExecutorOptions) {
    this.opts = opts;
    this.fees = resolveFees(opts.fees as FeeOverrides | undefined);
    this.slip = { ...DEFAULT_SLIPPAGE_BPS, ...opts.slippageBps };
  }

  async execute(req: OrderRequest, _now: number): Promise<ExecutionResult> {
    // Liquidity, booked in $1 units: depositing fills at 1, withdrawing at what a unit is worth now
    // (the engine's mark, which it keeps from the pool's price and fees).
    if (req.instrument.kind === "lp") {
      const qty = req.qty ?? req.notionalUsd;
      const price = req.phase === "open" ? 1 : req.fallbackPrice;
      if (!(qty! > 0) || !(price! > 0)) return { status: "rejected", reason: "nothing to deposit or withdraw" };
      return { status: "filled", qty: qty!, price: price!, markPrice: price!, feeUsd: 0, builderFeeUsd: 0, slippageBps: 0 };
    }
    const sizeHint = req.notionalUsd ?? (req.qty != null && req.fallbackPrice != null ? req.qty * req.fallbackPrice : undefined);
    let quote: Quote | null = null;
    try {
      quote = await withTimeout(
        this.opts.marketData.getQuote(req.instrument, { side: req.side, sizeUsd: sizeHint }),
        this.opts.quoteTimeoutMs ?? 10_000
      );
    } catch (e) {
      if (req.fallbackPrice == null) return { status: "rejected", reason: `no quote: ${errMsg(e)}` };
    }
    const mid = quote?.price ?? req.fallbackPrice!;
    if (!(mid > 0) || !Number.isFinite(mid)) return { status: "rejected", reason: `invalid quote price ${mid}` };

    const buy = req.side === "buy";
    let price = quote ? this.fillPrice(req, quote, mid) : mid;
    if (req.instrument.kind === "outcome") price = Math.min(0.999, Math.max(0.001, price));
    const slippageBps = ((buy ? price - mid : mid - price) / mid) * 10_000;

    if (req.phase === "open") {
      const o = req.order ?? {};
      if (o.type === "limit" && o.limitPrice != null) {
        const through = buy ? price <= o.limitPrice : price >= o.limitPrice;
        if (!through) return { status: "pending", reason: `limit ${o.limitPrice} not reached (would fill at ${round(price)})` };
      }
      if (o.maxSlippageBps != null && slippageBps > o.maxSlippageBps + 1e-9)
        return { status: "rejected", reason: `slippage ${slippageBps.toFixed(1)} bps above max ${o.maxSlippageBps} bps` };
      if (o.maxPriceImpactBps != null && quote?.priceImpactBps != null && quote.priceImpactBps > o.maxPriceImpactBps)
        return { status: "rejected", reason: `price impact ${quote.priceImpactBps} bps above max ${o.maxPriceImpactBps} bps` };
    }

    const qty = req.qty ?? (req.notionalUsd != null ? req.notionalUsd / price : NaN);
    if (!(qty > 0) || !Number.isFinite(qty)) return { status: "rejected", reason: "nothing to fill (qty/notional missing)" };
    if (req.instrument.kind === "synth") return this.synth(req, qty, mid);
    const fee = computeFee(this.fees, req.instrument, req.phase, qty * price, qty);
    return { status: "filled", qty, price, markPrice: mid, feeUsd: fee.feeUsd, builderFeeUsd: fee.builderFeeUsd, slippageBps };
  }

  /**
   * Papertrade, practised: opens are free and checked against its limits; a winning close keeps
   * only what Papertrade would pay (the impact haircut and the 2% win fee are booked as the fee).
   */
  private async synth(req: OrderRequest, qty: number, mid: number): Promise<ExecutionResult> {
    const i = req.instrument as Extract<OrderRequest["instrument"], { kind: "synth" }>;
    const limits = this.opts.synthLimits ? await this.opts.synthLimits() : DEFAULT_SYNTH_LIMITS;
    const m = limits.markets[i.symbol];
    if (req.phase === "open") {
      const notional = qty * mid, lev = req.leverage ?? 1, margin = notional / lev;
      if (limits.paused || !m.active) return { status: "rejected", reason: `Papertrade ${i.symbol} is paused` };
      if (lev > m.maxLeverage) return { status: "rejected", reason: `Papertrade allows up to ${m.maxLeverage}×` };
      if (margin < limits.minMarginUsd - 1e-9) return { status: "rejected", reason: `Papertrade needs at least $${limits.minMarginUsd} of margin` };
      if (notional < limits.minNotionalUsd - 1e-9) return { status: "rejected", reason: `Papertrade needs a position of at least $${limits.minNotionalUsd.toLocaleString("en-US")} (margin × leverage)` };
      if (notional > m.maxPositionUsd) return { status: "rejected", reason: `Papertrade allows positions up to $${m.maxPositionUsd.toLocaleString("en-US")}` };
      return { status: "filled", qty, price: mid, markPrice: mid, feeUsd: 0, builderFeeUsd: 0, slippageBps: 0 };
    }
    const pos = req.position;
    if (!pos) return { status: "rejected", reason: "a Papertrade close needs the position's entry" };
    const { keptByVenue } = synthSettlement(pos.side, pos.entryPrice, mid, qty * pos.entryPrice, m, limits.winFeeRate);
    return { status: "filled", qty, price: mid, markPrice: mid, feeUsd: keptByVenue, builderFeeUsd: 0, slippageBps: 0 };
  }

  private fillPrice(req: OrderRequest, q: Quote, mid: number): number {
    const buy = req.side === "buy";
    const sign = buy ? 1 : -1;
    if (q.fillPrice != null && q.fillPrice > 0) return q.fillPrice;
    if (q.priceImpactBps != null) return mid * (1 + (sign * q.priceImpactBps) / 10_000);
    if (buy && q.ask != null && q.ask > 0) return q.ask;
    if (!buy && q.bid != null && q.bid > 0) return q.bid;
    return mid * (1 + (sign * this.slip[req.instrument.kind]) / 10_000);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
