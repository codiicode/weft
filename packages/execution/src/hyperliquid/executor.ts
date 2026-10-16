import type { Hex } from "viem";
import type { CloseIntent, Instrument, Level, OpenIntent } from "@weft/strategy";
import type { ExecutionResult, Executor, OrderRequest } from "../types.ts";
import { HlExchangeClient, orderStatuses, type ExchangeRequest, type ExchangeResponse, type OrderStatus } from "./exchange.ts";
import { AssetResolver, HL_MAINNET_URL, HL_TESTNET_URL, HttpHlInfo, type FetchLike, type HlInfo, type ResolvedAsset } from "./info.ts";
import { signerFromPrivateKey, type TypedDataSigner } from "./signing.ts";
import { roundPrice, roundSize, slippagePrice } from "./ticks.ts";
import {
  cancelAction,
  cancelByCloidAction,
  cloidFromKey,
  orderAction,
  orderToWire,
  updateLeverageAction,
  type BuilderInfo,
  type Grouping,
  type HlOrder,
  type Tif,
} from "./wire.ts";

export interface HyperliquidExecutorConfig {
  /** The AGENT (API) wallet key: can trade, cannot withdraw. Never the user's main key. */
  agentPrivateKey?: Hex;
  /** Alternative to `agentPrivateKey`: a remote/KMS signer for the agent wallet. */
  agentSigner?: TypedDataSigner;
  /** The user's master account (whose positions the agent trades). */
  userAddress: Hex;
  isMainnet: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Defaults to an HTTP client on the same base URL. */
  info?: HlInfo;
  /**
   * Weft builder code. `feeTenthsBps` defaults to 50 (= 5 bps). Pass `null` for no builder.
   * The user must have approved at least this fee (see `buildApproveBuilderFee`).
   */
  builder?: { address: Hex; feeTenthsBps?: number } | null;
  /** Default max slippage for market opens when the order spec has none. Default 100 bps. */
  defaultSlippageBps?: number;
  /** Slippage bound for market closes (never blocked by the open limit). Default 500 bps, like the SDK. */
  closeSlippageBps?: number;
  /** Limit-price bound for market TP/SL trigger orders, as a fraction. Default 0.10. */
  triggerSlippage?: number;
  /** Taker fee estimate used to report fees on fills. Default 4.5 bps. */
  takerFeeBps?: number;
  /** Return the exact signed request body without sending it. */
  dryRun?: boolean;
  /** Required to POST to mainnet. */
  allowMainnetSend?: boolean;
  vaultAddress?: Hex | null;
  expiresAfterMs?: number;
  /** HIP-4 outcome orders (experimental). Disabled unless set. */
  outcomes?: { enabled: boolean; szDecimals?: number };
  /** Called with every signed request (dry run or live), for audit logs. */
  onRequest?: (req: ExchangeRequest) => void;
  now?: () => number;
}

export interface TpslPrices {
  takeProfit?: number;
  stopLoss?: number;
}

export interface PlaceOrderParams {
  instrument: Instrument;
  side: "buy" | "sell";
  /** Units of the instrument, or USD notional converted at the reference price. */
  size: { qty: number } | { notionalUsd: number };
  type: "market" | "limit";
  limitPrice?: number;
  /** Limit orders only. Default "Gtc". Market orders are always IOC. */
  tif?: Exclude<Tif, "Ioc"> | "Ioc";
  reduceOnly?: boolean;
  /** Market orders: worst acceptable price vs mid. */
  maxSlippageBps?: number;
  /** Idempotency key → deterministic cloid. */
  clientId?: string;
  /** Child TP/SL trigger orders, sent atomically with the entry (grouping "normalTpsl"). */
  tpsl?: TpslPrices;
  /** Override the configured builder for this order (`null` = none). */
  builder?: { address: Hex; feeTenthsBps?: number } | null;
  /** Marks a (spot) close: skips the $10 minimum pre-check, which the venue enforces itself. */
  closing?: boolean;
}

export interface PlacedOrder {
  asset: ResolvedAsset;
  orders: HlOrder[];
  grouping: Grouping;
  /** Mid used as reference (market orders, pct exits, notional sizing). */
  mid: number;
  request: ExchangeRequest;
  dryRun: boolean;
  response?: ExchangeResponse;
  statuses?: OrderStatus[];
}

const DEFAULT_BUILDER_FEE = 50;

/**
 * Live Hyperliquid executor (perps, HIP-3 builder-dex perps, spot; HIP-4 outcomes experimental),
 * trading through an approved agent wallet.
 *
 * Conforms structurally to the engine's `Executor` (`execute(OrderRequest)`), and also offers
 * richer intent-level helpers (`executeOpenIntent`, `executeCloseIntent`) that set leverage and
 * attach venue-side TP/SL.
 */
export class HyperliquidExecutor implements Executor {
  readonly mode = "live" as const;
  readonly client: HlExchangeClient;
  readonly assets: AssetResolver;
  private readonly info: HlInfo;
  private builderChecked = new Map<string, boolean>();

  private readonly cfg: HyperliquidExecutorConfig;
  constructor(cfg: HyperliquidExecutorConfig) {
    this.cfg = cfg;
    const signer = cfg.agentSigner ?? (cfg.agentPrivateKey ? signerFromPrivateKey(cfg.agentPrivateKey) : null);
    if (!signer) throw new Error("HyperliquidExecutor needs an agent wallet (agentPrivateKey or agentSigner)");
    if (signer.address.toLowerCase() === cfg.userAddress.toLowerCase())
      throw new Error("refusing to trade with the user's main key: approve an agent wallet and use its key");
    const baseUrl = cfg.baseUrl ?? (cfg.isMainnet ? HL_MAINNET_URL : HL_TESTNET_URL);
    this.client = new HlExchangeClient({
      signer,
      isMainnet: cfg.isMainnet,
      baseUrl,
      fetch: cfg.fetch,
      vaultAddress: cfg.vaultAddress ?? null,
      expiresAfterMs: cfg.expiresAfterMs,
      allowMainnetSend: cfg.allowMainnetSend,
      now: cfg.now,
    });
    this.info = cfg.info ?? new HttpHlInfo(baseUrl, cfg.fetch);
    this.assets = new AssetResolver(this.info, { outcomeSzDecimals: cfg.outcomes?.szDecimals });
  }

  /* -------------------------------- resolution -------------------------------- */

  async resolve(instrument: Instrument): Promise<ResolvedAsset> {
    switch (instrument.kind) {
      case "perp":
        return this.assets.perp(instrument.symbol, instrument.dex);
      case "spot":
        return this.assets.spot(instrument.symbol);
      case "outcome":
        if (instrument.venue !== "hyperliquid") throw new Error("Jupiter prediction outcomes are not executed on Hyperliquid (TODO)");
        if (!this.cfg.outcomes?.enabled) throw new Error("HIP-4 outcome orders are disabled (experimental; set outcomes.enabled)");
        return this.assets.outcome(instrument.market, instrument.outcome);
      default:
        throw new Error(`HyperliquidExecutor cannot trade ${instrument.kind} instruments`);
    }
  }

  private builderFor(override: PlaceOrderParams["builder"]): BuilderInfo | null {
    const b = override === undefined ? this.cfg.builder : override;
    if (!b) return null;
    const f = b.feeTenthsBps ?? DEFAULT_BUILDER_FEE;
    if (!Number.isInteger(f) || f < 0 || f > 1000) throw new Error(`invalid builder fee ${f} (tenths of bps)`);
    return { b: b.address.toLowerCase(), f };
  }

  /** Fail closed if the user has not approved the builder fee: the venue would reject every order. */
  private async checkBuilderApproval(builder: BuilderInfo, a: ResolvedAsset): Promise<void> {
    if (a.market === "perp" && builder.f > 100) throw new Error("builder fee above the 0.1% perp maximum");
    if (!this.info.maxBuilderFee || this.builderChecked.get(`${builder.b}:${builder.f}`)) return;
    const max = await this.info.maxBuilderFee(this.cfg.userAddress, builder.b);
    if (!(max >= builder.f))
      throw new Error(
        `user ${this.cfg.userAddress} approved a max builder fee of ${max} (tenths of bps) for ${builder.b}, below ${builder.f}: ` +
          `have the user sign buildApproveBuilderFee() first`
      );
    this.builderChecked.set(`${builder.b}:${builder.f}`, true);
  }

  /* -------------------------------- orders -------------------------------- */

  /** Build and sign (but do not send) an order action. */
  async buildOrder(p: PlaceOrderParams): Promise<Omit<PlacedOrder, "dryRun" | "response" | "statuses"> & { builder: BuilderInfo | null }> {
    const a = await this.resolve(p.instrument);
    const isBuy = p.side === "buy";
    const mid = await this.assets.mid(a);

    let limitPx: number;
    let tif: Tif;
    if (p.type === "limit") {
      if (p.limitPrice == null) throw new Error("limit order needs limitPrice");
      // A limit far through the market fills at once like a market order, without a slippage bound. Refuse it.
      const maxAway = (p.maxSlippageBps ?? this.cfg.defaultSlippageBps ?? 100) / 10_000;
      const through = isBuy ? p.limitPrice / mid - 1 : 1 - p.limitPrice / mid;
      if (through > maxAway) throw new Error(`limit price ${p.limitPrice} is ${(through * 100).toFixed(1)}% through the market (max ${(maxAway * 100).toFixed(1)}%)`);
      limitPx = roundPrice(p.limitPrice, a.tickKind, a.szDecimals);
      tif = p.tif ?? "Gtc";
    } else {
      const bps = p.maxSlippageBps ?? this.cfg.defaultSlippageBps ?? 100;
      limitPx = slippagePrice(mid, isBuy, bps / 10_000, a.tickKind, a.szDecimals);
      tif = "Ioc";
    }

    // Size from the mid, never from the limit: a low limit must not buy more than the allocation.
    const refPx = mid;
    const rawSz = "qty" in p.size ? p.size.qty : p.size.notionalUsd / refPx;
    const sz = roundSize(rawSz, a.szDecimals, "down");
    if (!(sz > 0)) throw new Error(`size ${rawSz} rounds to 0 at ${a.szDecimals} size decimals`);
    if (!p.reduceOnly && !p.closing && sz * refPx < 10) throw new Error(`order value $${(sz * refPx).toFixed(2)} is below Hyperliquid's $10 minimum`);

    const cloid = p.clientId ? cloidFromKey(p.clientId) : undefined;
    const entry: HlOrder = { asset: a.asset, isBuy, limitPx, sz, reduceOnly: p.reduceOnly ?? false, orderType: { limit: { tif } }, cloid };
    const orders: HlOrder[] = [entry];
    let grouping: Grouping = "na";
    if (p.tpsl && (p.tpsl.takeProfit != null || p.tpsl.stopLoss != null)) {
      if (a.market !== "perp") throw new Error("venue-side TP/SL is only supported for perps");
      grouping = "normalTpsl";
      orders.push(...this.tpslOrders(a, isBuy, sz, p.tpsl, refPx, p.clientId));
    }

    const builder = this.builderFor(p.builder);
    if (builder) await this.checkBuilderApproval(builder, a);
    const action = orderAction(orders.map(orderToWire), builder, grouping);
    const request = await this.client.sign(action);
    return { asset: a, orders, grouping, mid, request, builder };
  }

  /**
   * Reduce-only market trigger orders on the opposite side of a position. Levels must sit on the
   * correct side of `ref` (long: TP above, SL below), or they would trigger immediately.
   */
  private tpslOrders(a: ResolvedAsset, entryIsBuy: boolean, sz: number, t: TpslPrices, ref: number, clientId?: string): HlOrder[] {
    const exitIsBuy = !entryIsBuy;
    const slip = this.cfg.triggerSlippage ?? 0.1;
    const out: HlOrder[] = [];
    const add = (triggerPx: number, tpsl: "tp" | "sl") => {
      const above = triggerPx > ref;
      if ((tpsl === "tp") === entryIsBuy ? !above : above)
        throw new Error(`${tpsl} ${triggerPx} is on the wrong side of the reference price ${ref} for a ${entryIsBuy ? "long" : "short"}`);
      const trig = roundPrice(triggerPx, a.tickKind, a.szDecimals);
      out.push({
        asset: a.asset,
        isBuy: exitIsBuy,
        sz,
        // Like the SDK examples: the limit is an aggressive bound beyond the trigger.
        limitPx: slippagePrice(trig, exitIsBuy, slip, a.tickKind, a.szDecimals),
        reduceOnly: true,
        orderType: { trigger: { triggerPx: trig, isMarket: true, tpsl } },
        cloid: clientId ? cloidFromKey(`${clientId}:${tpsl}`) : undefined,
      });
    };
    if (t.takeProfit != null) add(t.takeProfit, "tp");
    if (t.stopLoss != null) add(t.stopLoss, "sl");
    return out;
  }

  private async send(built: { request: ExchangeRequest }): Promise<{ dryRun: boolean; response?: ExchangeResponse; statuses?: OrderStatus[] }> {
    this.cfg.onRequest?.(built.request);
    if (this.cfg.dryRun) return { dryRun: true };
    const response = await this.client.post(built.request);
    return { dryRun: false, response, statuses: orderStatuses(response) };
  }

  async placeOrder(p: PlaceOrderParams): Promise<PlacedOrder> {
    const built = await this.buildOrder(p);
    const { builder: _b, ...rest } = built;
    return { ...rest, ...(await this.send(built)) };
  }

  /**
   * Attach TP/SL to an existing position (grouping "positionTpsl": the venue resizes them with
   * the position). `positionSide` is the side of the open position.
   */
  async setPositionTpsl(
    p: { instrument: Instrument; positionSide: "long" | "short"; size: number; clientId?: string; referencePrice?: number } & TpslPrices
  ) {
    const a = await this.resolve(p.instrument);
    if (a.market !== "perp") throw new Error("venue-side TP/SL is only supported for perps");
    const sz = roundSize(p.size, a.szDecimals, "nearest");
    const ref = p.referencePrice ?? (await this.assets.mid(a));
    const orders = this.tpslOrders(a, p.positionSide === "long", sz, p, ref, p.clientId);
    if (!orders.length) throw new Error("nothing to attach: no takeProfit or stopLoss");
    const builder = this.builderFor(undefined);
    if (builder) await this.checkBuilderApproval(builder, a);
    const request = await this.client.sign(orderAction(orders.map(orderToWire), builder, "positionTpsl"));
    return { asset: a, orders, grouping: "positionTpsl" as const, request, ...(await this.send({ request })) };
  }

  async setLeverage(instrument: Instrument, leverage: number, isCross?: boolean) {
    const a = await this.resolve(instrument);
    if (a.market !== "perp") throw new Error("leverage applies to perps only");
    const lev = Math.floor(leverage);
    if (a.maxLeverage != null && lev > a.maxLeverage) throw new Error(`leverage ${lev}× above the ${a.maxLeverage}× max for ${a.coin}`);
    const cross = isCross ?? !a.onlyIsolated;
    if (cross && a.onlyIsolated) throw new Error(`${a.coin} is isolated-only`);
    const request = await this.client.sign(updateLeverageAction(a.asset, lev, cross));
    return { request, ...(await this.send({ request })) };
  }

  async cancel(p: { instrument: Instrument; oid: number } | { instrument: Instrument; cloid: Hex } | { instrument: Instrument; clientId: string }) {
    const a = await this.resolve(p.instrument);
    const action =
      "oid" in p
        ? cancelAction([{ asset: a.asset, oid: p.oid }])
        : cancelByCloidAction([{ asset: a.asset, cloid: "cloid" in p ? p.cloid : cloidFromKey(p.clientId) }]);
    const request = await this.client.sign(action);
    return { request, ...(await this.send({ request })) };
  }

  /**
   * Market-close (a fraction of) the account's position in `instrument` with a reduce-only IOC.
   * Perps: reads `clearinghouseState`; spot: sells the free base-token balance.
   */
  async closePosition(p: { instrument: Instrument; fraction?: number; clientId?: string; maxSlippageBps?: number }): Promise<PlacedOrder | null> {
    const a = await this.resolve(p.instrument);
    const fraction = p.fraction ?? 1;
    if (!(fraction > 0 && fraction <= 1)) throw new Error(`fraction must be in (0, 1], got ${fraction}`);
    const user = this.cfg.vaultAddress ?? this.cfg.userAddress;
    let qty: number;
    let side: "buy" | "sell";
    if (a.market === "perp") {
      if (!this.info.clearinghouseState) throw new Error("info client cannot read positions");
      const st = await this.info.clearinghouseState(user, a.dex);
      const pos = st.assetPositions.find((x) => x.position.coin === a.coin);
      const szi = pos ? Number(pos.position.szi) : 0;
      if (!szi) return null;
      qty = Math.abs(szi) * fraction;
      side = szi > 0 ? "sell" : "buy";
    } else {
      if (!this.info.spotClearinghouseState) throw new Error("info client cannot read spot balances");
      const base = p.instrument.kind === "spot" ? p.instrument.symbol.split("/")[0]! : a.coin;
      const st = await this.info.spotClearinghouseState(user);
      const bal = st.balances.find((b) => b.coin === base || b.coin === a.coin);
      const free = bal ? Number(bal.total) - Number(bal.hold) : 0;
      if (!(free > 0)) return null;
      qty = free * fraction;
      side = "sell";
    }
    return this.placeOrder({
      instrument: p.instrument,
      side,
      size: { qty }, // rounded down to szDecimals in buildOrder: never sell more than held
      type: "market",
      reduceOnly: a.market === "perp",
      maxSlippageBps: p.maxSlippageBps ?? this.cfg.closeSlippageBps ?? 500,
      clientId: p.clientId,
      closing: true,
    });
  }

  /* -------------------------------- intents -------------------------------- */

  /**
   * OpenIntent → (updateLeverage for perps) → entry order with venue-side TP/SL children when the
   * exits are price/pct levels. Trailing stops and time exits are not venue-native: they are
   * returned in `engineManagedExits` for the engine's exit monitor.
   */
  async executeOpenIntent(intent: OpenIntent) {
    const i = intent.instrument;
    if (i.kind === "token") throw new Error("Solana tokens execute via the Jupiter path, not Hyperliquid");
    if (i.kind !== "perp" && intent.side === "short") throw new Error(`${i.kind} is long-only`);
    const leverage = i.kind === "perp" ? Math.max(1, Math.floor(intent.leverage)) : 1;
    const steps: { request: ExchangeRequest; response?: ExchangeResponse }[] = [];
    if (i.kind === "perp") steps.push(await this.setLeverage(i, leverage));

    const a = await this.resolve(i);
    const mid = await this.assets.mid(a);
    const isBuy = intent.side === "long";
    const ref = intent.order.type === "limit" && intent.order.limitPrice ? intent.order.limitPrice : mid;
    const tpsl: TpslPrices = {};
    if (i.kind === "perp") {
      if (intent.exits.takeProfit) tpsl.takeProfit = levelToPrice(intent.exits.takeProfit, ref, isBuy, "tp", leverage);
      if (intent.exits.stopLoss) tpsl.stopLoss = levelToPrice(intent.exits.stopLoss, ref, isBuy, "sl", leverage);
    }
    const size = intent.size.usd != null ? { notionalUsd: intent.size.usd * leverage } : { qty: intent.size.native! };
    const placed = await this.placeOrder({
      instrument: i,
      side: isBuy ? "buy" : "sell",
      size,
      type: intent.order.type,
      limitPrice: intent.order.limitPrice,
      maxSlippageBps: intent.order.maxSlippageBps,
      clientId: intent.key,
      tpsl: Object.keys(tpsl).length ? tpsl : undefined,
    });
    const engineManagedExits = {
      trailingStopPct: intent.exits.trailingStopPct,
      timeExitHours: intent.exits.timeExitHours,
      ...(i.kind !== "perp" ? { takeProfit: intent.exits.takeProfit, stopLoss: intent.exits.stopLoss } : {}),
    };
    return { placed, leverageSteps: steps, engineManagedExits };
  }

  /**
   * CloseIntent → reduce-only market orders for the strategy's own positions (not the whole
   * account: several strategies can share one Hyperliquid account). `positions` are the engine's
   * open positions for this deployment.
   */
  async executeCloseIntent(
    intent: CloseIntent,
    positions: { instrument: Instrument; instrumentKey: string; side: "long" | "short"; qty: number }[]
  ): Promise<PlacedOrder[]> {
    const targets = positions.filter(
      (p) => (intent.target === "all" || p.instrumentKey === intent.target) && (p.instrument.kind === "perp" || p.instrument.kind === "spot")
    );
    const out: PlacedOrder[] = [];
    for (const p of targets) {
      const a = await this.resolve(p.instrument);
      const qty = roundSize(p.qty * intent.fraction, a.szDecimals, "nearest");
      if (!(qty > 0)) continue;
      out.push(
        await this.placeOrder({
          instrument: p.instrument,
          side: p.side === "long" ? "sell" : "buy",
          size: { qty },
          type: "market",
          reduceOnly: p.instrument.kind === "perp",
          maxSlippageBps: this.cfg.closeSlippageBps ?? 500,
          clientId: `${intent.key}:${p.instrumentKey}`,
          closing: true,
        })
      );
    }
    return out;
  }

  /* -------------------------------- engine Executor -------------------------------- */

  async execute(req: OrderRequest, _now: number): Promise<ExecutionResult> {
    try {
      const k = req.instrument.kind;
      if (k !== "perp" && k !== "spot" && !(k === "outcome" && req.instrument.venue === "hyperliquid"))
        return { status: "rejected", reason: `HyperliquidExecutor cannot trade ${k}` };
      if (req.phase === "close" && req.qty == null) return { status: "rejected", reason: "close needs qty" };
      if (req.phase === "open" && req.qty == null && req.notionalUsd == null) return { status: "rejected", reason: "open needs notionalUsd or qty" };

      // Idempotency: if an order with this cloid already exists, never send another.
      const cloid = cloidFromKey(req.clientId);
      if (!this.cfg.dryRun && this.info.orderStatus) {
        const st = (await this.info.orderStatus(this.cfg.vaultAddress ?? this.cfg.userAddress, cloid)) as { status?: string; order?: { status?: string } };
        if (st?.status && st.status !== "unknownOid")
          return { status: "rejected", reason: `duplicate: order ${cloid} for ${req.clientId} already exists (${st.order?.status ?? st.status}); reconcile instead of resending` };
      }

      // Set the venue leverage before a perp open (the engine sizes notional as margin × leverage).
      if (req.phase === "open" && req.instrument.kind === "perp" && req.leverage != null && req.leverage >= 1 && !this.cfg.dryRun) {
        const lev = await this.setLeverage(req.instrument, req.leverage);
        const st = lev as { status?: string; response?: unknown };
        if (st?.status && st.status !== "ok") return { status: "rejected", reason: `could not set leverage: ${JSON.stringify(st.response ?? st).slice(0, 200)}` };
      }

      const isLimit = req.phase === "open" && req.order?.type === "limit" && req.order.limitPrice != null;
      const placed = await this.placeOrder({
        instrument: req.instrument,
        side: req.side,
        size: req.qty != null ? { qty: req.qty } : { notionalUsd: req.notionalUsd! },
        type: isLimit ? "limit" : "market",
        limitPrice: req.order?.limitPrice,
        reduceOnly: req.phase === "close" && req.instrument.kind === "perp",
        maxSlippageBps: req.phase === "close" ? (this.cfg.closeSlippageBps ?? 500) : req.order?.maxSlippageBps,
        clientId: req.clientId,
        closing: req.phase === "close",
      });
      if (placed.dryRun) return { status: "pending", reason: "dry run: signed request built, not sent" };
      const s = placed.statuses?.[0];
      if (!s) return { status: "rejected", reason: "no order status in response" };
      if (typeof s === "string") return { status: "pending", reason: s };
      if ("error" in s) return { status: "rejected", reason: s.error };
      if ("resting" in s) return { status: "pending", reason: `resting oid ${s.resting.oid}` };
      const qty = Number(s.filled.totalSz);
      const price = Number(s.filled.avgPx);
      const notional = qty * price;
      const builder = this.builderFor(undefined);
      const builderPays = builder && !(placed.asset.market !== "perp" && req.side === "buy"); // no builder fee on spot buys
      const builderFeeUsd = builderPays ? (notional * builder.f) / 100_000 : 0;
      const feeUsd = (notional * (this.cfg.takerFeeBps ?? 4.5)) / 10_000 + builderFeeUsd;
      const buy = req.side === "buy";
      const slippageBps = ((buy ? price - placed.mid : placed.mid - price) / placed.mid) * 10_000;
      return { status: "filled", qty, price, markPrice: placed.mid, feeUsd, builderFeeUsd, slippageBps };
    } catch (e) {
      return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * Strategy exit level → absolute trigger price. `pct` is a favourable (TP) / adverse (SL) price move
 * from `ref`; `positionPct` is gain/loss on the margin, so the price move is positionPct / leverage.
 */
export function levelToPrice(level: Level, ref: number, isLong: boolean, kind: "tp" | "sl", leverage = 1): number {
  if ("price" in level) return level.price;
  if ("prob" in level) return level.prob;
  const move = "pct" in level ? level.pct : level.positionPct / Math.max(1, leverage);
  const up = (kind === "tp") === isLong;
  return ref * (1 + ((up ? 1 : -1) * move) / 100);
}
