import {
  checkIntents,
  effectiveRisk,
  evaluate,
  exprRefs,
  instrumentKey,
  instrumentLabel,
  resolveSize,
  type Instrument,
  type Intent,
  type OpenIntent,
  type OptionsIntent,
  type CloseIntent,
  type Signal,
  type SignalSnapshot,
  type TokenFacts,
  type TriggerResult,
} from "@weft/strategy";
import type { MarketData, Quote, SignalProvider, TokenFactsProvider } from "@weft/venues";
import type { DeploymentRecord, EngineEvent, EngineEventType, Fill, FillReason, Position } from "./types.ts";
import type { DeploymentRuntime, StoreBatch } from "./store.ts";
import { errMsg, withTimeout, type Executor } from "./executor.ts";
import { dirOf, exitReason, exposureOf, groupExitReason, groupUnitValue, marginOf, markPosition, unrealizedOf } from "./positions.ts";
import { computeFee, type FeeSchedule } from "./fees.ts";
import { lpBaseShare, lpValueRatio, resolveRange } from "./lp.ts";
import { DEFAULT_MAINTENANCE_MARGIN, fundingPayment, HOUR_MS, liquidationCrossed, liquidationPrice, maintenanceMarginRate, needsLiquidationPrice } from "./perps.ts";

/** Everything a tick needs from the outside world. Injected; the tick itself does no I/O. */
export interface TickDeps {
  marketData: MarketData;
  /** Provider per signal kind. `position` signals are produced by the engine. */
  providers: ReadonlyMap<string, SignalProvider>;
  tokenFacts?: TokenFactsProvider;
  executor: Executor;
  /** Fee schedule, for fills the engine books itself (paper liquidations). */
  fees: FeeSchedule;
  /** Simulate perp funding payments and liquidations (paper). */
  perpRealism: boolean;
  signalTimeoutMs: number;
  quoteTimeoutMs: number;
  /** Quote assets priced for risk checks (native sizing), e.g. { SOL: <SOL perp>, USDC: <USDC token> }. */
  usdPriceInstruments: Record<string, Instrument>;
  newId(): string;
  /** Rate limiter for noisy events: true if an event with this key may be emitted now. */
  allow(key: string, now: number, minGapMs: number): boolean;
  hasIntentKey(deploymentId: string, key: string): Promise<boolean>;
  warningIntervalMs: number;
  tickEventIntervalMs: number;
  equitySampleIntervalMs: number;
  /** Leaders' trades, for copy actions. Without it, copy actions stay idle. */
  copy?: CopyFeeds;
}

/** A Solana wallet's token trades (oldest first) and a Hyperliquid account's open positions. */
export interface CopyFeeds {
  solanaWallet?: (address: string) => Promise<{ id: string; at: number; side: "buy" | "sell"; mint: string }[]>;
  hyperliquidTrader?: (address: string) => Promise<{ positions: { coin: string; side: "long" | "short"; leverage: number }[] }>;
}

const DAY = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Mutable working copy of one deployment for the duration of a tick or a
 * control action. Nothing is persisted until `toBatch()` is committed.
 */
export class Session {
  readonly positions: Map<string, Position>;
  private readonly deleted = new Set<string>();
  private readonly touched = new Set<string>();
  readonly fills: Fill[] = [];
  readonly events: EngineEvent[] = [];
  readonly intentKeys: { key: string; ts: number }[] = [];
  private forceSample = false;
  deployment: DeploymentRecord;
  rt: DeploymentRuntime;
  readonly deps: TickDeps;
  readonly now: number;

  constructor(deployment: DeploymentRecord, rt: DeploymentRuntime, positions: Position[], deps: TickDeps, now: number) {
    this.deployment = deployment;
    this.rt = rt;
    this.deps = deps;
    this.now = now;
    this.positions = new Map(positions.map((p) => [p.id, p]));
  }

  get id() {
    return this.deployment.id;
  }
  open(): Position[] {
    return [...this.positions.values()];
  }
  equity(): number {
    const ps = this.open();
    return this.rt.cashUsd + marginOf(ps) + unrealizedOf(ps);
  }

  emit(type: EngineEventType, message: string, data?: Record<string, unknown>, rate?: { key: string; gapMs: number }): void {
    if (rate && !this.deps.allow(`${this.id}:${rate.key}`, this.now, rate.gapMs)) return;
    this.events.push({ id: this.deps.newId(), deploymentId: this.id, ts: this.now, type, message, ...(data ? { data } : {}) });
  }
  warn(key: string, message: string, data?: Record<string, unknown>) {
    this.emit("warning", message, data, { key: `warn:${key}`, gapMs: this.deps.warningIntervalMs });
  }

  private upsert(p: Position) {
    this.positions.set(p.id, p);
    this.touched.add(p.id);
  }
  private remove(p: Position) {
    this.positions.delete(p.id);
    this.touched.delete(p.id);
    this.deleted.add(p.id);
  }
  markTouched(p: Position) {
    this.touched.add(p.id);
  }

  /** Close `fraction` of a position at market. Exits are never blocked by slippage limits. */
  async closePosition(p: Position, fraction: number, reason: FillReason, clientId: string, intentKey?: string): Promise<boolean> {
    const qty = fraction >= 1 ? p.qty : p.qty * fraction;
    let res;
    try {
      res = await this.deps.executor.execute(
        { clientId, instrument: p.instrument, instrumentKey: p.instrumentKey, side: p.side === "long" ? "sell" : "buy", phase: "close", qty, fallbackPrice: p.markPrice, deploymentId: this.deployment.id },
        this.now
      );
    } catch (e) {
      res = { status: "rejected" as const, reason: errMsg(e) };
    }
    if (res.status !== "filled") {
      this.emit("error", `Could not close ${instrumentLabel(p.instrument)} (${reason}): ${res.reason}`, { positionId: p.id, reason });
      return false;
    }
    this.bookClose(p, res, reason, fraction >= 1, intentKey);
    return true;
  }

  /** Book `qty` out of a position at its mark with no order (it left the wallet outside Weft). */
  bookOutside(p: Position, qty: number): Fill {
    const q = Math.min(p.qty, qty);
    return this.bookClose(p, { qty: q, price: p.markPrice, markPrice: p.markPrice, feeUsd: 0, builderFeeUsd: 0 }, "outside", q >= p.qty * (1 - 1e-9), undefined, "Outside Weft: ");
  }

  /**
   * Paper liquidation: close the whole position at its liquidation price (not at
   * market), paying the venue taker fee (no builder fee on liquidations).
   */
  liquidate(p: Position): Fill {
    const liq = p.liquidationPrice!;
    const mark = p.markPrice;
    const fee = computeFee(this.deps.fees, p.instrument, "close", p.qty * liq, p.qty);
    const fill = this.bookClose(p, { qty: p.qty, price: liq, markPrice: mark, feeUsd: fee.feeUsd - fee.builderFeeUsd, builderFeeUsd: 0 }, "liquidation", true, undefined, "Liquidated: ");
    this.emit(
      "warning",
      `${instrumentLabel(p.instrument)} ${p.leverage}× ${p.side} liquidated: mark ${fmtPx(mark)} crossed the liquidation price ${fmtPx(liq)} (entry ${fmtPx(p.entryPrice)}). Closed at ${fmtPx(liq)}, P&L ${fmtUsd(fill.realizedPnlUsd ?? 0)}`,
      { liquidation: { positionId: p.id, instrumentKey: p.instrumentKey, side: p.side, leverage: p.leverage, entryPrice: p.entryPrice, liquidationPrice: liq, markPrice: mark }, fill }
    );
    return fill;
  }

  /** Book a closing fill: cash, realized P&L, the fill and its event, then shrink or remove the position. */
  private bookClose(
    p: Position,
    res: { qty: number; price: number; markPrice: number; feeUsd: number; builderFeeUsd: number },
    reason: FillReason,
    full: boolean,
    intentKey?: string,
    prefix = ""
  ): Fill {
    const share = Math.min(1, res.qty / p.qty);
    const gross = res.qty * (res.price - p.entryPrice) * dirOf(p);
    const released = p.sizeUsd * share;
    const net = gross - res.feeUsd;
    // Funding was booked as it accrued; the closed part's share is only reported on the fill.
    const funding = p.fundingPaidUsd != null ? p.fundingPaidUsd * share : null;
    this.rt.cashUsd += released + net;
    this.addRealized(net, res.feeUsd, res.builderFeeUsd);
    const fill: Fill = {
      id: this.deps.newId(),
      deploymentId: this.id,
      positionId: p.id,
      ...(intentKey ? { intentKey } : {}),
      instrumentKey: p.instrumentKey,
      side: p.side === "long" ? "sell" : "buy",
      qty: res.qty,
      price: res.price,
      feeUsd: res.feeUsd,
      realizedPnlUsd: net,
      reason,
      ts: this.now,
      ...(funding != null ? { fundingUsd: funding } : {}),
      ...(res.builderFeeUsd > 0 ? { builderFeeUsd: res.builderFeeUsd } : {}),
    };
    this.fills.push(fill);
    this.forceSample = true;
    const fundingNote = funding != null && Math.abs(funding) >= 0.005 ? `, funding ${fmtUsd(-funding)} (booked while open)` : "";
    this.emit(
      "fill",
      p.lp && p.instrument.kind === "lp"
        ? `${prefix}Withdrew ${fmtUsd(res.qty * res.price)} from the ${p.instrument.symbol} pool (${reason.replace(/_/g, " ")}), P&L ${fmtUsd(net)}, fees earned ${fmtUsd(p.lp.feesUsd * share)}`
        : `${prefix}${fill.side === "buy" ? "Bought" : "Sold"} ${fmtQty(res.qty)} ${instrumentLabel(p.instrument)} @ ${fmtPx(res.price)} (${reason.replace("_", " ")}), P&L ${fmtUsd(net)}${fundingNote}`,
      { fill }
    );
    if (full || p.qty - res.qty <= p.qty * 1e-9) {
      this.remove(p);
    } else {
      p.qty -= res.qty;
      p.sizeUsd -= released;
      if (p.fundingPaidUsd != null && funding != null) p.fundingPaidUsd -= funding;
      markPosition(p, res.markPrice, this.now);
      this.upsert(p);
    }
    return fill;
  }

  /** Book an opening fill as a new position. */
  bookOpen(args: {
    instrument: Instrument;
    side: "long" | "short";
    leverage: number;
    actionId: string;
    intentKey: string;
    exits: Position["exits"];
    res: { qty: number; price: number; markPrice: number; feeUsd: number; builderFeeUsd: number };
    group?: Position["group"];
    /** Perps: venue max leverage, for the liquidation estimate (null/undefined → default maintenance). */
    maxLeverage?: number | null;
    /** Liquidity: the pool side of the position, and the fill message to show. */
    lp?: Position["lp"];
    message?: string;
  }): Position {
    const { res } = args;
    const key = instrumentKey(args.instrument);
    const sizeUsd = (res.qty * res.price) / args.leverage;
    const p: Position = {
      id: this.deps.newId(),
      deploymentId: this.id,
      actionId: args.actionId,
      instrument: args.instrument,
      instrumentKey: key,
      side: args.side,
      qty: res.qty,
      entryPrice: res.price,
      sizeUsd,
      leverage: args.leverage,
      exits: args.exits,
      openedAt: this.now,
      markPrice: res.price,
      markedAt: this.now,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      peakPrice: res.price,
      ...(args.group ? { group: args.group } : {}),
      ...(args.lp ? { lp: args.lp } : {}),
    };
    if (this.deps.perpRealism && args.instrument.kind === "perp") {
      p.fundingPaidUsd = 0;
      p.fundingState = { accruedAt: this.now, lastEventAt: this.now, sinceEventUsd: 0 };
      if (needsLiquidationPrice(p)) {
        const liq = liquidationPrice(p.side, p.entryPrice, p.leverage, maintenanceMarginRate(args.maxLeverage));
        if (liq != null) p.liquidationPrice = liq;
      }
    }
    markPosition(p, res.markPrice, this.now);
    this.rt.cashUsd -= sizeUsd + res.feeUsd;
    this.addRealized(-res.feeUsd, res.feeUsd, res.builderFeeUsd);
    this.upsert(p);
    const inUse = [...this.positions.values()].reduce((n, q) => n + q.sizeUsd, 0);
    this.rt.peakInUseUsd = Math.max(this.rt.peakInUseUsd ?? 0, inUse);
    const fill: Fill = {
      id: this.deps.newId(),
      deploymentId: this.id,
      positionId: p.id,
      intentKey: args.intentKey,
      instrumentKey: key,
      side: args.side === "long" ? "buy" : "sell",
      qty: res.qty,
      price: res.price,
      feeUsd: res.feeUsd,
      reason: "entry",
      ts: this.now,
      ...(res.builderFeeUsd > 0 ? { builderFeeUsd: res.builderFeeUsd } : {}),
    };
    this.fills.push(fill);
    this.forceSample = true;
    this.emit(
      "fill",
      args.message ?? `${fill.side === "buy" ? "Bought" : "Sold"} ${fmtQty(res.qty)} ${instrumentLabel(args.instrument)} @ ${fmtPx(res.price)}${args.leverage > 1 ? ` (${args.leverage}×)` : ""}, fee ${fmtUsd(res.feeUsd)}`,
      { fill }
    );
    return p;
  }

  /** Book a funding payment (positive = paid) to cash and realized P&L. */
  bookFunding(p: Position, amountUsd: number) {
    this.rt.cashUsd -= amountUsd;
    this.rt.realizedPnlUsd -= amountUsd;
    this.rt.realizedTodayUsd -= amountUsd;
    this.rt.fundingUsd = (this.rt.fundingUsd ?? 0) + amountUsd;
    p.fundingPaidUsd = (p.fundingPaidUsd ?? 0) + amountUsd;
    this.markTouched(p);
  }

  private addRealized(net: number, fee: number, builder: number) {
    this.rt.realizedPnlUsd += net;
    this.rt.realizedTodayUsd += net;
    this.rt.feesUsd += fee;
    this.rt.builderFeesUsd += builder;
  }

  rollDay() {
    const day = DAY(this.now);
    if (this.rt.day !== day) {
      this.rt.day = day;
      this.rt.realizedTodayUsd = 0;
      this.rt.dayStartEquityUsd = this.equity();
    }
  }

  toBatch(extra: Partial<StoreBatch> = {}): StoreBatch {
    const eq = this.equity();
    const last = this.rt.lastEquitySampleAt ?? null;
    const sample = this.forceSample || last == null || this.now - last >= this.deps.equitySampleIntervalMs;
    if (sample) this.rt.lastEquitySampleAt = this.now;
    return {
      deploymentId: this.id,
      runtime: this.rt,
      upsertPositions: [...this.touched].map((id) => this.positions.get(id)!).filter(Boolean),
      deletePositionIds: [...this.deleted],
      fills: this.fills,
      events: this.events,
      intentKeys: this.intentKeys,
      ...(sample ? { equitySample: [this.now, round2(eq)] as [number, number] } : {}),
      ...extra,
    };
  }
}

/* ------------------------------------------------------------------ */
/* The tick pipeline                                                    */
/* ------------------------------------------------------------------ */

export async function runTick(s: Session): Promise<void> {
  const strategy = s.deployment.strategy;

  // a. Mark positions, exits first.
  await markAll(s);
  s.rollDay();
  if (s.deps.perpRealism) {
    await settleFunding(s);
    await ensureLiquidationPrices(s);
  }
  await runExits(s);

  // b. Signals.
  const snapshots = await fetchSignals(s);

  // c. Evaluate.
  const positionsForEval = s.open().map((p) => ({ actionId: p.actionId, instrumentKey: p.instrumentKey, sizeUsd: p.sizeUsd }));
  const equity = s.equity();
  const result = evaluate(strategy, { now: s.now, signals: snapshots, equityUsd: equity, positions: positionsForEval }, s.rt.evalState);
  s.rt.evalState = result.state;
  triggerEvents(s, result.triggers);
  // c2. Copy trading: the leaders' new trades become intents too (exits first, like the rules').
  const copies = await copyIntents(s, result.triggers, equity);
  if (copies.length) {
    const rank = (i: Intent) => (i.type === "close" ? 0 : i.type === "notify" ? 2 : 1);
    result.intents = [...result.intents, ...copies].sort((x, y) => rank(x) - rank(y));
  }
  for (const i of result.intents) s.emit("intent", `${describeIntent(s, i)} (${ruleName(s, i.triggerId).toLowerCase()})`, { intent: i });

  // d. Risk.
  let approved: Intent[] = [];
  const usdPrices: Record<string, number> = {};
  if (result.intents.length) {
    // Quote-asset prices are only needed to size-check `native` orders.
    const needsPricing = result.intents.some((i) => (i.type === "open" || i.type === "options") && i.size.native != null);
    if (needsPricing) Object.assign(usdPrices, await fetchUsdPrices(s, result.intents));
    const tokenFacts = await fetchTokenFacts(s, result.intents, usdPrices);
    const ps = s.open();
    const dayBase = s.rt.dayStartEquityUsd > 0 ? s.rt.dayStartEquityUsd : equity;
    const dailyPnlPct = ((s.rt.realizedTodayUsd + unrealizedOf(ps)) / dayBase) * 100;
    const risk = checkIntents(result.intents, {
      risk: effectiveRisk(strategy.risk, s.deployment.caps),
      equityUsd: equity,
      exposureUsd: exposureOf(ps),
      dailyPnlPct,
      halted: s.deployment.status !== "running",
      usdPrices,
      tokenFacts,
    });
    for (const w of risk.warnings) {
      const name = w.intent.type === "open" ? instrumentLabel(w.intent.instrument) : "this market";
      s.warn(`gates:${w.intent.actionId}`, `Heads up on ${name}: ${w.reasons.join("; ")}. Buying anyway, as you asked.`, { reasons: w.reasons });
    }
    for (const r of risk.rejected) {
      // Nothing was sent: the rule stays live and tries again on a later check (reported once per reason).
      refund(s, r.intent);
      s.emit("rejected", `Didn’t ${lowerFirst(describeIntent(s, r.intent))} yet: ${r.reasons.join("; ")}`, { intentKey: r.intent.key, reasons: r.reasons }, { key: `blocked:${r.intent.actionId}:${r.reasons.join(";")}`, gapMs: 10 * 60_000 });
    }
    approved = risk.approved;
  }

  // e. Execute.
  for (const intent of approved) await execute(s, intent, usdPrices);

  // f. Bookkeeping.
  s.rt.triggers = result.triggers;
  s.rt.signalValues = signalValues(strategy.triggers.flatMap((t) => exprRefs(t.when).map((r) => r.ref)), s.rt.lastSnapshots, s.rt.signalValues);
  s.rt.lastTickAt = s.now;
  const eq = s.equity();
  s.emit(
    "tick",
    `Checked the market: value ${fmtUsd(eq)}, ${s.positions.size} open position${s.positions.size === 1 ? "" : "s"}`,
    { equityUsd: round2(eq), positions: s.positions.size, fired: result.triggers.filter((t) => t.fired).map((t) => t.id) },
    { key: "tick", gapMs: s.deps.tickEventIntervalMs }
  );
}

/* ---- c2. copy trading ---- */

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * Turn each copy action's leader activity since the last check into intents. Solana: a new buy of a
 * token becomes a buy of the same token (if liquid enough and under the open-copies limit), a sell
 * closes our copy. Hyperliquid: a newly opened (or flipped) position is opened the same way, a
 * closed one closes ours. Whatever the leader held before copying started is left alone.
 */
async function copyIntents(s: Session, triggers: TriggerResult[], equity: number): Promise<Intent[]> {
  const strategy = s.deployment.strategy;
  const out: Intent[] = [];
  const feeds = s.deps.copy;
  for (const a of strategy.actions) {
    if (a.type !== "copy") continue;
    const state = ((s.rt.copy ??= {})[a.id] ??= { since: s.now, seen: [] });
    const gateOpen = !a.on.length || a.on.some((id) => triggers.find((t) => t.id === id)?.met === true);
    const mine = s.open().filter((p) => p.actionId === a.id);
    const base = { strategyId: strategy.id, actionId: a.id, triggerId: `copy:${a.id}` };
    const only = a.only?.map((x) => x.toUpperCase());
    try {
      if (a.leader.venue === "solana") {
        if (!feeds?.solanaWallet) {
          s.warn(`copy:${a.id}`, "Copying a Solana wallet needs wallet data (Helius), which isn't set up on this server");
          continue;
        }
        const trades = await withTimeout(feeds.solanaWallet(a.leader.wallet), s.deps.signalTimeoutMs);
        const seen = new Set(state.seen);
        let open = mine.length;
        for (const t of trades) {
          if (t.at < state.since || seen.has(t.id)) continue;
          seen.add(t.id);
          if (only && !only.includes(t.mint.toUpperCase())) continue;
          const key = `sol:token:${t.mint}`;
          const held = mine.some((p) => p.instrumentKey === key);
          if (t.side === "sell") {
            if (held && a.mirrorExits) out.push({ ...base, key: `${strategy.id}:${a.id}:copy:${t.id}`, type: "close", target: key, fraction: 1 });
            continue;
          }
          if (held || !gateOpen) continue;
          if (open >= a.maxOpen) {
            s.warn(`copy:max:${a.id}`, `Didn’t copy ${shortAddr(t.mint)}: already ${a.maxOpen} copied positions open`);
            continue;
          }
          const facts = await s.deps.tokenFacts?.getTokenFacts(t.mint, {}).catch(() => null);
          if (facts && facts.liquidity_usd < a.minLiquidityUsd) {
            s.emit("rejected", `Didn’t copy ${shortAddr(t.mint)}: liquidity ${fmtUsd(facts.liquidity_usd)} is under ${fmtUsd(a.minLiquidityUsd)}`, { copy: a.id, mint: t.mint });
            continue;
          }
          const instrument = { kind: "token" as const, chain: "solana" as const, mint: t.mint, quote: "SOL" as const, route: "auto" as const, assetClass: "crypto" as const };
          out.push({
            ...base,
            key: `${strategy.id}:${a.id}:copy:${t.id}`,
            type: "open",
            instrument,
            instrumentKey: key,
            side: "long",
            size: resolveSize(a.size, equity),
            leverage: 1,
            order: { ...a.order, maxSlippageBps: a.order.maxSlippageBps ?? strategy.risk.defaultMaxSlippageBps },
            exits: a.exits,
          });
          open++;
        }
        state.seen = [...seen].slice(-300);
      } else {
        if (!feeds?.hyperliquidTrader) continue;
        const now = (await withTimeout(feeds.hyperliquidTrader(a.leader.trader), s.deps.signalTimeoutMs)).positions;
        const cur: Record<string, { side: "long" | "short"; leverage: number }> = {};
        for (const p of now) cur[p.coin] = { side: p.side, leverage: p.leverage };
        // First look: remember what the leader already holds, copy nothing yet.
        if (!state.last) {
          state.last = Object.fromEntries(Object.entries(cur).map(([c, v]) => [c, v.side]));
          continue;
        }
        let open = mine.length;
        const coins = new Set([...Object.keys(state.last), ...Object.keys(cur)]);
        for (const coin of coins) {
          const was = state.last[coin];
          const is = cur[coin]?.side;
          if (was === is) continue;
          if (only && !only.includes(coin.toUpperCase())) continue;
          const key = `hl:perp:${coin}`;
          const held = mine.some((p) => p.instrumentKey === key);
          const tag = `${coin}:${is ?? "flat"}:${s.now}`;
          // Closed or flipped: close our copy first.
          if (was && held && a.mirrorExits) out.push({ ...base, key: `${strategy.id}:${a.id}:copy:${tag}:close`, type: "close", target: key, fraction: 1 });
          if (!is || !gateOpen) continue;
          if (held && !(was && a.mirrorExits)) continue;
          if (open >= a.maxOpen) {
            s.warn(`copy:max:${a.id}`, `Didn’t copy ${coin}: already ${a.maxOpen} copied positions open`);
            continue;
          }
          const leverage = Math.max(1, Math.min(a.leverage ?? cur[coin]!.leverage, strategy.risk.maxLeverage));
          out.push({
            ...base,
            key: `${strategy.id}:${a.id}:copy:${tag}`,
            type: "open",
            instrument: { kind: "perp", venue: "hyperliquid", symbol: coin, assetClass: "crypto" },
            instrumentKey: key,
            side: is,
            size: resolveSize(a.size, equity),
            leverage,
            order: { ...a.order, maxSlippageBps: a.order.maxSlippageBps ?? strategy.risk.defaultMaxSlippageBps },
            exits: a.exits,
          });
          if (!held) open++;
        }
        state.last = Object.fromEntries(Object.entries(cur).map(([c, v]) => [c, v.side]));
      }
    } catch (e) {
      s.warn(`copy:${a.id}`, `Couldn’t read the leader’s trades: ${errMsg(e)}`);
    }
  }
  return out;
}

/* ---- a. marking & exits ---- */

export async function markAll(s: Session): Promise<void> {
  const ps = s.open();
  if (!ps.length) return;
  const byKey = new Map<string, Instrument>();
  for (const p of ps) byKey.set(p.instrumentKey, p.instrument);
  const quotes = await getQuotes(s, [...byKey.values()]);
  for (const p of ps) {
    const q = quotes.get(p.instrumentKey);
    if (!q || !(q.price > 0)) continue;
    if (p.lp) {
      if (markLiquidity(s, p, q)) s.markTouched(p);
      continue;
    }
    markPosition(p, q.price, s.now);
    s.markTouched(p);
  }
  // Group peaks for trailing stops on options spreads.
  for (const legs of groups(ps).values()) {
    const v = groupUnitValue(legs);
    for (const l of legs) if (l.group) l.group.peakValue = Math.max(l.group.peakValue, v);
  }
}

async function getQuotes(s: Session, instruments: Instrument[]): Promise<Map<string, Quote>> {
  const md = s.deps.marketData;
  if (md.getQuotes) {
    try {
      return await withTimeout(md.getQuotes(instruments), s.deps.quoteTimeoutMs);
    } catch (e) {
      s.warn("quotes", `Batch quotes failed, falling back to single quotes: ${errMsg(e)}`);
    }
  }
  const out = new Map<string, Quote>();
  await Promise.all(
    instruments.map(async (i) => {
      const key = instrumentKey(i);
      try {
        out.set(key, await withTimeout(md.getQuote(i), s.deps.quoteTimeoutMs));
      } catch (e) {
        s.warn(`quote:${key}`, `No quote for ${instrumentLabel(i)}: ${errMsg(e)}`, { instrumentKey: key });
      }
    })
  );
  return out;
}

function groups(ps: Position[]): Map<string, Position[]> {
  const m = new Map<string, Position[]>();
  for (const p of ps) if (p.group) m.set(p.group.id, [...(m.get(p.group.id) ?? []), p]);
  return m;
}

async function runExits(s: Session): Promise<void> {
  const ps = s.open();
  for (const p of ps) {
    if (p.group || !s.positions.has(p.id)) continue;
    if (p.markedAt !== s.now) continue; // not marked this tick: no fresh price, no exit decision
    // Liquidation first: on paper we can't tell whether a stop would have filled before it.
    if (s.deps.perpRealism && liquidationCrossed(p)) {
      s.liquidate(p);
      continue;
    }
    const outTooLong = p.lp?.outOfRangeMinutes != null && p.lp.outSince != null && s.now - p.lp.outSince >= p.lp.outOfRangeMinutes * 60_000;
    const reason = exitReason(p, s.now) ?? (outTooLong ? "out_of_range" : null);
    if (reason) await s.closePosition(p, 1, reason, `${p.id}:${reason}`);
  }
  for (const legs of groups(ps).values()) {
    if (legs.some((l) => l.markedAt !== s.now)) continue;
    const reason = groupExitReason(legs, s.now);
    if (reason) for (const l of legs) await s.closePosition(l, 1, reason, `${l.id}:${reason}`);
  }
}

/* ---- a2. perps: funding & liquidation ---- */

/**
 * Accrue funding on open perps for the time since the last accrual at the
 * current hourly rate (Hyperliquid pays hourly): notional × rate × hours,
 * longs pay when the rate is positive. Booked to cash and realized P&L at once;
 * a `notify` event (data.funding) summarises it at most once per clock hour per
 * position. Without `MarketData.getFundingRate` nothing accrues. When the rate is
 * unavailable the accrual waits, so the next good rate covers the gap.
 */
export async function settleFunding(s: Session): Promise<void> {
  const md = s.deps.marketData;
  const perps = s.open().filter((p) => p.instrument.kind === "perp");
  if (!perps.length || !md.getFundingRate) return;
  const byKey = new Map<string, Instrument>();
  for (const p of perps) {
    if (!p.fundingState) {
      // Opened before funding was modelled: start accruing now (no back-charge).
      p.fundingState = { accruedAt: s.now, lastEventAt: s.now, sinceEventUsd: 0 };
      p.fundingPaidUsd ??= 0;
      s.markTouched(p);
      continue;
    }
    if (s.now > p.fundingState.accruedAt) byKey.set(p.instrumentKey, p.instrument);
  }
  if (!byKey.size) return;
  const rates = new Map<string, number>();
  await Promise.all(
    [...byKey].map(async ([key, inst]) => {
      try {
        const r = await withTimeout(md.getFundingRate!(inst), s.deps.quoteTimeoutMs);
        if (r && Number.isFinite(r.hourlyRate)) rates.set(key, r.hourlyRate);
      } catch (e) {
        s.warn(`funding:${key}`, `No funding rate for ${instrumentLabel(inst)}: ${errMsg(e)}`, { instrumentKey: key });
      }
    })
  );
  for (const p of perps) {
    const st = p.fundingState;
    const rate = rates.get(p.instrumentKey);
    if (!st || rate == null || !s.positions.has(p.id) || !(p.markPrice > 0)) continue;
    const hours = (s.now - st.accruedAt) / HOUR_MS;
    if (!(hours > 0)) continue;
    const amount = fundingPayment(p, rate, hours);
    st.accruedAt = s.now;
    st.sinceEventUsd += amount;
    s.bookFunding(p, amount);
    if (Math.floor(s.now / HOUR_MS) > Math.floor(st.lastEventAt / HOUR_MS) && Math.abs(st.sinceEventUsd) >= 0.005) {
      const since = st.sinceEventUsd;
      s.emit(
        "notify",
        `Funding ${since >= 0 ? "paid" : "received"} on ${instrumentLabel(p.instrument)} ${p.side}: ${fmtUsd(Math.abs(since))} (rate ${(rate * 100).toFixed(4)}%/h), net funding so far ${fmtUsd(-(p.fundingPaidUsd ?? 0))}`,
        { funding: { positionId: p.id, instrumentKey: p.instrumentKey, side: p.side, amountUsd: since, totalUsd: p.fundingPaidUsd ?? 0, hourlyRate: rate, sinceTs: st.lastEventAt } }
      );
      st.lastEventAt = s.now;
      st.sinceEventUsd = 0;
    }
  }
}

/** Venue max leverage for a perp, null when unknown (the default maintenance rate applies). */
async function maxLeverageOf(s: Session, i: Instrument): Promise<number | null> {
  const md = s.deps.marketData;
  if (i.kind !== "perp" || !md.getMaxLeverage) return null;
  try {
    return await withTimeout(md.getMaxLeverage(i), s.deps.quoteTimeoutMs);
  } catch (e) {
    s.warn(`maxlev:${instrumentKey(i)}`, `No max leverage for ${instrumentLabel(i)} (using ${DEFAULT_MAINTENANCE_MARGIN * 100}% maintenance margin): ${errMsg(e)}`);
    return null;
  }
}

/** Positions opened before the liquidation model existed get their liquidation price now. */
async function ensureLiquidationPrices(s: Session): Promise<void> {
  for (const p of s.open()) {
    if (p.liquidationPrice != null || !needsLiquidationPrice(p)) continue;
    const liq = liquidationPrice(p.side, p.entryPrice, p.leverage, maintenanceMarginRate(await maxLeverageOf(s, p.instrument)));
    if (liq == null) continue;
    p.liquidationPrice = liq;
    s.markTouched(p);
  }
}

/* ---- b. signals ---- */

async function fetchSignals(s: Session): Promise<Record<string, SignalSnapshot | undefined>> {
  const strategy = s.deployment.strategy;
  const out: Record<string, SignalSnapshot | undefined> = {};
  await Promise.all(
    strategy.signals.map(async (sig) => {
      if (sig.kind === "position") {
        out[sig.id] = positionSnapshot(s, sig);
        return;
      }
      const provider = s.deps.providers.get(sig.kind);
      let snap: SignalSnapshot | null = null;
      if (!provider) {
        s.warn(`noprovider:${sig.id}`, `No provider for ${sig.kind} signal "${sig.id}"`, { signalId: sig.id });
      } else {
        try {
          snap = await withTimeout(provider.fetch(sig, s.now), s.deps.signalTimeoutMs);
        } catch (e) {
          s.warn(`signal:${sig.id}`, `Signal "${sig.id}" failed: ${errMsg(e)}`, { signalId: sig.id });
        }
      }
      if (snap && Number.isFinite(snap.asOf)) s.rt.lastSnapshots[sig.id] = snap;
      // Carry the last good snapshot forward: the evaluator's staleness budget decides if it still counts.
      out[sig.id] = s.rt.lastSnapshots[sig.id];
    })
  );
  return out;
}

function positionSnapshot(s: Session, sig: Extract<Signal, { kind: "position" }>): SignalSnapshot {
  const key = sig.params.instrument ? instrumentKey(sig.params.instrument) : null;
  const ps = s.open().filter((p) => key == null || p.instrumentKey === key);
  const size = marginOf(ps);
  const pnl = unrealizedOf(ps);
  const opened = ps.length ? Math.min(...ps.map((p) => p.openedAt)) : null;
  const snap: SignalSnapshot = {
    asOf: s.now,
    fields: {
      open: ps.length > 0,
      size_usd: size,
      pnl_usd: pnl,
      pnl_pct: size > 0 ? (pnl / size) * 100 : null,
      hours_open: opened == null ? null : (s.now - opened) / 3_600_000,
    },
  };
  s.rt.lastSnapshots[sig.id] = snap;
  return snap;
}

function signalValues(
  refs: string[],
  snaps: Record<string, SignalSnapshot>,
  prev: Record<string, number | boolean | null>
): Record<string, number | boolean | null> {
  const out: Record<string, number | boolean | null> = {};
  for (const ref of new Set(refs)) {
    const [sid, field] = ref.split(".") as [string, string];
    const v = snaps[sid]?.fields[field];
    out[ref] = v === undefined ? (prev[ref] ?? null) : v;
  }
  return out;
}

/* ---- c. trigger events ---- */

function triggerEvents(s: Session, results: TriggerResult[]) {
  const prev = new Map(s.rt.triggers.map((t) => [t.id, t]));
  for (const t of results) {
    if (t.met && !prev.get(t.id)?.met) s.emit("trigger_met", `Conditions met: ${ruleName(s, t.id)}`, { triggerId: t.id });
    if (t.fired) s.emit("trigger_fired", `${ruleName(s, t.id)} fired`, { triggerId: t.id });
  }
}

/* ---- d. risk inputs ---- */

async function fetchUsdPrices(s: Session, intents: Intent[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const jobs: [string, Instrument][] = Object.entries(s.deps.usdPriceInstruments);
  for (const i of intents)
    if (i.type === "open" && i.size.native != null && i.instrument.kind !== "token") jobs.push([i.instrumentKey, i.instrument]);
  await Promise.all(
    jobs.map(async ([k, inst]) => {
      try {
        const q = await withTimeout(s.deps.marketData.getQuote(inst), s.deps.quoteTimeoutMs);
        if (q.price > 0) out[k] = q.price;
      } catch (e) {
        s.warn(`usdprice:${k}`, `No USD price for ${k}: ${errMsg(e)}`);
      }
    })
  );
  // A dollar stablecoin is worth a dollar when its feed is down; SOL and others fail closed.
  out.USDC ??= 1;
  return out;
}

function intentUsd(i: OpenIntent | OptionsIntent, usdPrices: Record<string, number>): number | null {
  if (i.size.usd != null) return i.size.usd;
  const key = i.type === "open" ? (i.instrument.kind === "token" ? i.instrument.quote : i.instrumentKey) : null;
  const px = key ? usdPrices[key] : undefined;
  return px == null ? null : i.size.native! * px;
}

async function fetchTokenFacts(s: Session, intents: Intent[], usdPrices: Record<string, number>): Promise<Record<string, TokenFacts | undefined>> {
  const out: Record<string, TokenFacts | undefined> = {};
  const provider = s.deps.tokenFacts;
  const buys = intents.filter((i): i is OpenIntent => i.type === "open" && i.instrument.kind === "token");
  if (!provider || !buys.length) return out;
  await Promise.all(
    buys.map(async (i) => {
      if (i.instrument.kind !== "token") return;
      const mint = i.instrument.mint;
      const sizeUsd = intentUsd(i, usdPrices) ?? undefined;
      try {
        out[mint] = (await withTimeout(provider.getTokenFacts(mint, { sizeUsd }), s.deps.signalTimeoutMs)) ?? undefined;
      } catch (e) {
        s.warn(`tokenfacts:${mint}`, `Token facts for ${mint} failed: ${errMsg(e)}`);
      }
    })
  );
  return out;
}

/* ---- e. execution ---- */

async function execute(s: Session, intent: Intent, usdPrices: Record<string, number>): Promise<void> {
  if (s.intentKeys.some((k) => k.key === intent.key) || (await s.deps.hasIntentKey(s.id, intent.key))) {
    s.emit("warning", `Intent ${intent.key} was already executed; skipped`, { intentKey: intent.key });
    return;
  }
  s.intentKeys.push({ key: intent.key, ts: s.now });
  // Alerts only: say what it would do, and do nothing.
  if (s.deployment.alertsOnly && intent.type !== "notify") {
    if (intent.type === "close" && !s.open().length) return;
    s.emit("notify", `${ruleName(s, intent.triggerId)}: would ${describeIntent(s, intent).replace(/^\w/, (c) => c.toLowerCase())}`, {
      channel: "telegram",
      actionId: intent.actionId,
      intentKey: intent.key,
      alertsOnly: true,
    });
    return;
  }
  switch (intent.type) {
    case "open":
      return executeOpen(s, intent, usdPrices);
    case "options":
      return executeOptions(s, intent, usdPrices);
    case "close":
      return executeClose(s, intent);
    case "notify":
      s.emit("notify", intent.message, { channel: intent.channel, actionId: intent.actionId, intentKey: intent.key });
      return;
  }
}

async function executeOpen(s: Session, i: OpenIntent, usdPrices: Record<string, number>): Promise<void> {
  if (i.instrument.kind === "lp") return executeLiquidity(s, i, i.instrument, usdPrices);
  let usd = intentUsd(i, usdPrices);
  if (usd == null || !(usd > 0)) return retryLater(s, i, "cannot size order: no USD price");
  // A share of the budget ("all of it", "half") leaves room for the fee instead of waiting for cash
  // that never comes; a stated amount is used as given.
  if (!i.size.fixed && s.rt.cashUsd < usd * 1.01) {
    const fit = s.rt.cashUsd / (1.01 + (i.instrument.kind === "token" ? 0.02 : 0.003 * i.leverage));
    if (fit >= 1) usd = Math.min(usd, fit);
  }
  if (s.rt.cashUsd < usd * 1.01) return retryLater(s, i, `insufficient cash: need ${fmtUsd(usd)}, have ${fmtUsd(s.rt.cashUsd)}`);
  // Prediction markets: make sure the position could be sold straight back before buying it.
  if (i.instrument.kind === "outcome") {
    const max = s.deployment.strategy.risk.maxExitLossPct ?? 10;
    try {
      const [b, x] = await Promise.all([
        withTimeout(s.deps.marketData.getQuote(i.instrument, { side: "buy", sizeUsd: usd }), s.deps.quoteTimeoutMs),
        withTimeout(s.deps.marketData.getQuote(i.instrument, { side: "sell", sizeUsd: usd }), s.deps.quoteTimeoutMs),
      ]);
      const buy = b.fillPrice ?? b.ask ?? b.price;
      const sell = x.fillPrice ?? x.bid ?? x.price;
      const loss = buy > 0 ? (1 - sell / buy) * 100 : Infinity;
      if (!(loss <= max)) return retryLater(s, i, `the market is too thin: selling straight back would lose ${Number.isFinite(loss) ? `${loss.toFixed(1)}%` : "everything"} (limit ${max}%)`);
    } catch (e) {
      return retryLater(s, i, `couldn’t check how easy it is to sell back: ${errMsg(e)}`);
    }
  }
  let res;
  try {
    res = await s.deps.executor.execute(
      {
        clientId: i.key,
        instrument: i.instrument,
        instrumentKey: i.instrumentKey,
        side: i.side === "long" ? "buy" : "sell",
        phase: "open",
        notionalUsd: usd * i.leverage,
        order: i.order,
        deploymentId: s.deployment.id,
        leverage: i.leverage,
      },
      s.now
    );
  } catch (e) {
    res = { status: "rejected" as const, reason: errMsg(e) };
  }
  if (res.status !== "filled") return reject(s, i, res.reason, res.status === "pending");
  const maxLeverage = s.deps.perpRealism && i.instrument.kind === "perp" && needsLiquidationPrice({ instrument: i.instrument, side: i.side, leverage: i.leverage }) ? await maxLeverageOf(s, i.instrument) : null;
  s.bookOpen({ instrument: i.instrument, side: i.side, leverage: i.leverage, actionId: i.actionId, intentKey: i.key, exits: i.exits, res, maxLeverage });
}

/** Deposit into a pool: read its price, fix the range around it, and book the position in $1 units. */
async function executeLiquidity(s: Session, i: OpenIntent, pool: Extract<Instrument, { kind: "lp" }>, usdPrices: Record<string, number>): Promise<void> {
  let usd = intentUsd(i, usdPrices);
  if (usd == null || !(usd > 0)) return retryLater(s, i, "cannot size the deposit");
  if (!i.size.fixed && s.rt.cashUsd < usd * 1.01) usd = Math.min(usd, s.rt.cashUsd / 1.01);
  if (s.rt.cashUsd < usd * 1.01 || usd < 1) return retryLater(s, i, `insufficient cash: need ${fmtUsd(usd)}, have ${fmtUsd(s.rt.cashUsd)}`);
  let q: Quote;
  try {
    q = await withTimeout(s.deps.marketData.getQuote(pool), s.deps.quoteTimeoutMs);
  } catch (e) {
    return retryLater(s, i, `couldn’t read the ${pool.symbol} pool: ${errMsg(e)}`);
  }
  if (!(q.price > 0) || !q.lp) return retryLater(s, i, `no price for the ${pool.symbol} pool`);
  const { lower, upper } = resolveRange(i.lp!.range, q.price);
  if (!(lower > 0 && upper > lower)) return reject(s, i, `the range ${fmtPx(lower)}–${fmtPx(upper)} isn’t valid`);
  let res;
  try {
    res = await s.deps.executor.execute(
      { clientId: i.key, instrument: pool, instrumentKey: i.instrumentKey, side: "buy", phase: "open", notionalUsd: usd, order: i.order, deploymentId: s.deployment.id, leverage: 1 },
      s.now
    );
  } catch (e) {
    res = { status: "rejected" as const, reason: errMsg(e) };
  }
  if (res.status !== "filled") return reject(s, i, res.reason, res.status === "pending");
  const inRange = q.price >= lower && q.price <= upper;
  s.bookOpen({
    instrument: pool,
    side: "long",
    leverage: 1,
    actionId: i.actionId,
    intentKey: i.key,
    exits: i.exits,
    res: { ...res, price: 1, markPrice: 1 },
    lp: {
      entryPoolPrice: q.price,
      poolPrice: q.price,
      lower,
      upper,
      entryQuoteUsd: q.lp.quoteUsd,
      feesUsd: 0,
      accruedAt: s.now,
      outSince: inRange ? null : s.now,
      ...(i.lp!.outOfRangeMinutes != null ? { outOfRangeMinutes: i.lp!.outOfRangeMinutes } : {}),
      baseShare: lpBaseShare(q.price, lower, upper),
    },
    message: `Added ${fmtUsd(res.qty)} of liquidity to the ${pool.symbol} pool between ${fmtPx(lower)} and ${fmtPx(upper)} ${pool.quoteSymbol} (price ${fmtPx(q.price)})`,
  });
}

/**
 * A liquidity position's mark: its value over what went in, at the pool's price and the quote
 * token's USD price, plus fees. Practice fees accrue at the pool's fees-per-day over TVL on the
 * position's value, only while the price is in range (conservative: a narrow range really earns more).
 */
function markLiquidity(s: Session, p: Position, q: Quote): boolean {
  const lp = p.lp;
  if (!lp || !q.lp || !(q.price > 0) || !(q.lp.quoteUsd > 0)) return false;
  const ratio = lpValueRatio(lp.entryPoolPrice, q.price, lp.lower, lp.upper) * (q.lp.quoteUsd / lp.entryQuoteUsd);
  const inRange = q.price >= lp.lower && q.price <= lp.upper;
  const days = Math.max(0, s.now - lp.accruedAt) / 86_400_000;
  if (inRange && days > 0) lp.feesUsd += p.qty * ratio * q.lp.feePerDay * days;
  lp.accruedAt = s.now;
  lp.poolPrice = q.price;
  lp.baseShare = lpBaseShare(q.price, lp.lower, lp.upper);
  lp.outSince = inRange ? null : (lp.outSince ?? s.now);
  markPosition(p, ratio + lp.feesUsd / p.qty, s.now);
  return true;
}

async function executeOptions(s: Session, i: OptionsIntent, usdPrices: Record<string, number>): Promise<void> {
  const budget = intentUsd(i, usdPrices);
  if (budget == null || !(budget > 0)) return reject(s, i, "cannot size options order: no USD budget");
  const mids: number[] = [];
  for (const leg of i.legs) {
    try {
      const q = await withTimeout(s.deps.marketData.getQuote(leg.instrument), s.deps.quoteTimeoutMs);
      if (!(q.price > 0)) throw new Error(`invalid premium ${q.price}`);
      mids.push(q.price);
    } catch (e) {
      return reject(s, i, `no quote for ${instrumentLabel(leg.instrument)}: ${errMsg(e)}`);
    }
  }
  const sgn = (side: "buy" | "sell") => (side === "buy" ? 1 : -1);
  const netDebit = i.legs.reduce((a, l, k) => a + sgn(l.side) * l.ratio * mids[k]!, 0);
  const gross = i.legs.reduce((a, l, k) => a + l.ratio * mids[k]!, 0);
  // Debit: budget buys this many spreads. Credit: budget is the max-loss budget; size conservatively on gross premium.
  const units = netDebit > 0 ? budget / netDebit : budget / gross;
  if (s.rt.cashUsd < units * gross * 1.01) return reject(s, i, `insufficient cash for ${units.toFixed(2)} spreads`);

  const opened: Position[] = [];
  for (const leg of i.legs) {
    let res;
    try {
      res = await s.deps.executor.execute(
        { clientId: `${i.key}:${leg.instrumentKey}`, instrument: leg.instrument, instrumentKey: leg.instrumentKey, side: leg.side, phase: "open", qty: units * leg.ratio, order: i.order, deploymentId: s.deployment.id },
        s.now
      );
    } catch (e) {
      res = { status: "rejected" as const, reason: errMsg(e) };
    }
    if (res.status !== "filled") {
      for (const p of opened) await s.closePosition(p, 1, "manual", `${p.id}:unwind`, i.key);
      return reject(s, i, `leg ${instrumentLabel(leg.instrument)}: ${res.reason}${opened.length ? " (filled legs unwound)" : ""}`);
    }
    opened.push(
      s.bookOpen({
        instrument: leg.instrument,
        side: leg.side === "buy" ? "long" : "short",
        leverage: 1,
        actionId: i.actionId,
        intentKey: i.key,
        exits: i.exits,
        res,
        group: { id: i.key, units, ratio: leg.ratio, peakValue: 0 },
      })
    );
  }
  const v = groupUnitValue(opened);
  for (const p of opened) p.group!.peakValue = v;
}

async function executeClose(s: Session, i: CloseIntent): Promise<void> {
  const targets = s.open().filter((p) => i.target === "all" || p.instrumentKey === i.target);
  if (!targets.length) {
    s.emit("intent", `${ruleName(s, i.triggerId)} matched, but there was no open ${i.target === "all" ? "position" : `${keyLabel(s, i.target)} position`} to close`, { intentKey: i.key, triggerId: i.triggerId, noop: true });
    return;
  }
  for (const p of targets) await s.closePosition(p, i.fraction, "close_action", `${i.key}:${p.id}`, i.key);
}

function reject(s: Session, i: Intent, reason: string, pending = false): void {
  s.emit("rejected", `Didn’t ${lowerFirst(describeIntent(s, i))}: ${reason}`, { intentKey: i.key, reasons: [reason], ...(pending ? { pending: true } : {}) });
}

/** Rejected before anything reached the market: keep the rule live so it tries again later. */
function retryLater(s: Session, i: Intent, reason: string): void {
  refund(s, i);
  s.emit("rejected", `Didn’t ${lowerFirst(describeIntent(s, i))} yet: ${reason}`, { intentKey: i.key, reasons: [reason], retry: true }, { key: `blocked:${i.actionId}:${reason}`, gapMs: 10 * 60_000 });
}

/** Undo a fire whose order never went out: the trigger re-arms, counts drop back, the key is forgotten. */
function refund(s: Session, i: Intent): void {
  const t = s.rt.evalState.triggers[i.triggerId];
  if (t) {
    t.fires = Math.max(0, t.fires - 1);
    t.armed = true;
    t.lastFiredAt = null;
  }
  const a = s.rt.evalState.actions[i.actionId];
  if (a) a.fires = Math.max(0, a.fires - 1);
  const k = s.intentKeys.findIndex((x) => x.key === i.key);
  if (k >= 0) s.intentKeys.splice(k, 1);
}

const lowerFirst = (t: string) => t.replace(/^\w/, (c) => c.toLowerCase());

/* ---- formatting ---- */

/** "Rule 2" or the trigger's own label: the same names the app shows. */
function ruleName(s: Session, triggerId: string): string {
  if (triggerId.startsWith("copy:")) {
    const a = s.deployment.strategy.actions.find((x) => x.id === triggerId.slice(5));
    if (a?.type === "copy") return `Copying ${shortAddr(a.leader.venue === "solana" ? a.leader.wallet : a.leader.trader)}`;
  }
  const triggers = s.deployment.strategy.triggers;
  const idx = triggers.findIndex((t) => t.id === triggerId);
  const t = triggers[idx];
  if (t?.label) return `Rule “${t.label}”`;
  return idx >= 0 ? `Rule ${idx + 1}` : `Rule ${triggerId}`;
}

/** A readable name for an instrument key, from open positions or the strategy itself. */
function keyLabel(s: Session, key: string): string {
  const p = s.open().find((x) => x.instrumentKey === key);
  if (p) return instrumentLabel(p.instrument);
  for (const a of s.deployment.strategy.actions) if (a.type === "open" && instrumentKey(a.instrument) === key) return a.label ?? instrumentLabel(a.instrument);
  const tail = key.split(":").pop() ?? key;
  return tail.length > 16 ? `${tail.slice(0, 4)}…${tail.slice(-4)}` : tail;
}

function sizeText(size: { usd?: number | null; native?: number | null }, quote?: string): string {
  return size.usd != null ? fmtUsd(size.usd) : `${size.native}${quote ? ` ${quote}` : ""}`;
}

function describeIntent(s: Session, i: Intent): string {
  switch (i.type) {
    case "open": {
      if (i.instrument.kind === "lp") {
        const r = i.lp?.range;
        const where = !r ? "" : "lowerPct" in r ? ` from −${r.lowerPct}% to +${r.upperPct}% around the price` : ` between ${r.lower} and ${r.upper} ${i.instrument.quoteSymbol}`;
        return `Add ${sizeText(i.size)} of liquidity to the ${i.instrument.symbol} pool${where}`;
      }
      const longOnly = i.instrument.kind === "token" || i.instrument.kind === "outcome" || i.instrument.kind === "spot";
      const verb = longOnly ? "Buy" : i.side === "long" ? "Go long" : "Go short";
      const quote = i.instrument.kind === "token" ? i.instrument.quote : undefined;
      return `${verb} ${instrumentLabel(i.instrument)} with ${sizeText(i.size, quote)}${i.leverage > 1 ? ` at ${i.leverage}×` : ""}`;
    }
    case "options":
      return `Open a ${i.legs.length}-leg options position with ${sizeText(i.size)}`;
    case "close":
      return `${i.fraction < 1 ? `Close ${Math.round(i.fraction * 100)}% of` : "Close"} ${i.target === "all" ? "every position" : keyLabel(s, i.target)}`;
    case "notify":
      return `Send a ${i.channel} alert`;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
export const fmtUsd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const fmtPx = (n: number) => (Math.abs(n) >= 1 ? n.toFixed(4).replace(/\.?0+$/, "") : n.toPrecision(4));
const fmtQty = (n: number) => (Math.abs(n) >= 1 ? n.toFixed(4).replace(/\.?0+$/, "") : n.toPrecision(4));
