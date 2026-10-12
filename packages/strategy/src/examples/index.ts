import { defineStrategy } from "../validate.ts";
import type { Strategy } from "../strategy.ts";

/**
 * Example strategies covering every product: perps, stocks (HIP-3 perps and
 * tokenized stocks on Solana), options, prediction markets and Solana tokens.
 * They double as test fixtures and as few-shot examples for the thesis → graph model.
 *
 * Mint addresses and market ids below are placeholders, not real assets.
 */

export const PUMP_MINT = "PumpExampLeMint11111111111111111111111111111";
export const NVDAX_MINT = "NVDAxExampLeMint1111111111111111111111111111";

/** Weather → commodities perps + HIP-4 mispricing. */
export const elNino = defineStrategy({
  schemaVersion: 1,
  id: "el-nino-harvest",
  name: "El Niño Harvest",
  thesis: "El Niño is coming — what's the trade?",
  tags: ["weather", "commodities", "predictions"],
  signals: [
    { id: "nino", kind: "forecast", label: "ENSO outlook", params: { source: "noaa_cpc", series: "nino34_anomaly" } },
    { id: "nino_odds", kind: "odds", label: "El Niño by winter?", params: { instrument: { kind: "outcome", venue: "hyperliquid", market: "elnino-djf-2026", outcome: "YES", question: "El Niño by winter?" } } },
    { id: "nino_model", kind: "model", params: { question: "Will NOAA declare El Niño conditions for DJF 2026–27?" } },
    { id: "wheat", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "WHEAT", assetClass: "commodity" } } },
    { id: "desks", kind: "social", label: "Ag-weather desks", params: { keywords: ["El Niño", "wheat crop"] } },
    { id: "usdbrl", kind: "macro", params: { series: "USDBRL" } },
  ],
  triggers: [
    {
      id: "enso_mispriced",
      label: "ENSO strong & market lagging",
      when: {
        op: "and",
        args: [
          { op: "gt", left: { ref: "nino.value" }, right: { value: 1.5 } },
          { op: "gt", left: { op: "sub", args: [{ ref: "nino_model.prob" }, { ref: "nino_odds.prob" }] }, right: { value: 0.15 } },
        ],
      },
    },
    {
      id: "grains_bid",
      when: {
        op: "and",
        args: [
          { op: "gt", left: { ref: "desks.sentiment" }, right: { value: 0.3 } },
          { op: "gt", left: { ref: "wheat.change_24h_pct" }, right: { value: 0 } },
        ],
      },
      forMinutes: 60,
    },
    {
      id: "brl_weak",
      when: {
        op: "and",
        args: [
          { op: "gt", left: { ref: "usdbrl.value" }, right: { value: 5.6 } },
          { op: "gt", left: { ref: "desks.sentiment" }, right: { value: 0.4 } },
        ],
      },
    },
    { id: "enso_fades", when: { op: "lt", left: { ref: "nino.value" }, right: { value: 0.5 } } },
  ],
  actions: [
    {
      id: "buy_yes",
      type: "open",
      on: ["enso_mispriced"],
      instrument: { kind: "outcome", venue: "hyperliquid", market: "elnino-djf-2026", outcome: "YES" },
      side: "long",
      size: { unit: "pct_equity", value: 8 },
      exits: { takeProfit: { prob: 0.92 }, stopLoss: { prob: 0.45 } },
    },
    {
      id: "long_wheat",
      type: "open",
      on: ["grains_bid"],
      instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "WHEAT", assetClass: "commodity" },
      side: "long",
      size: { unit: "pct_equity", value: 10 },
      leverage: 3,
      exits: { takeProfit: { pct: 16 }, stopLoss: { pct: 6 } },
    },
    {
      id: "long_sugar",
      type: "open",
      on: ["grains_bid"],
      instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "SUGAR", assetClass: "commodity" },
      side: "long",
      size: { unit: "pct_equity", value: 6 },
      leverage: 2,
      exits: { takeProfit: { pct: 12 }, stopLoss: { pct: 5 } },
    },
    {
      id: "short_brazil",
      type: "open",
      on: ["brl_weak"],
      instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "BRAZIL50", assetClass: "index" },
      side: "short",
      size: { unit: "pct_equity", value: 5 },
      leverage: 2,
      exits: { takeProfit: { pct: 9 }, stopLoss: { pct: 4 } },
    },
    { id: "exit_all", type: "close", on: ["enso_fades"], target: "all" },
  ],
});

/** Memecoin on Solana: price level + bullish sentiment + healthy on-chain flow. */
export const pumpMomentum = defineStrategy({
  schemaVersion: 1,
  id: "pump-momentum",
  name: "PUMP dip + hype",
  thesis: "Köp $PUMP när den går till 0.004 och sentimentet är bullish.",
  tags: ["solana", "memecoin"],
  signals: [
    { id: "pump_px", kind: "price", params: { instrument: { kind: "token", chain: "solana", mint: PUMP_MINT, symbol: "PUMP" } } },
    { id: "pump_chain", kind: "token_onchain", params: { mint: PUMP_MINT } },
    { id: "pump_social", kind: "social", params: { cashtags: ["PUMP"] } },
  ],
  triggers: [
    {
      id: "entry",
      label: "Price level + bullish",
      when: {
        op: "and",
        args: [
          { op: "lte", left: { ref: "pump_px.price" }, right: { value: 0.004 } },
          { op: "gt", left: { ref: "pump_social.sentiment" }, right: { value: 0.3 } },
          { op: "gt", left: { ref: "pump_social.mentions_change_1h_pct" }, right: { value: 150 } },
          { op: "gt", left: { ref: "pump_chain.buy_sell_ratio_1h" }, right: { value: 1.3 } },
          { op: "is", ref: "pump_chain.lp_locked", value: true },
        ],
      },
      forMinutes: 5,
    },
    { id: "dev_dump", when: { op: "gt", left: { ref: "pump_chain.dev_sold_pct" }, right: { value: 20 } } },
    { id: "hype_gone", when: { op: "lt", left: { ref: "pump_social.sentiment" }, right: { value: -0.2 } }, forMinutes: 30 },
  ],
  actions: [
    {
      id: "buy_pump",
      type: "open",
      on: ["entry"],
      instrument: { kind: "token", chain: "solana", mint: PUMP_MINT, symbol: "PUMP" },
      side: "long",
      size: { unit: "native", value: 0.5 },
      order: { maxPriceImpactBps: 200 },
      exits: { takeProfit: { pct: 40 }, stopLoss: { pct: 20 }, timeExitHours: 48 },
    },
    { id: "alert_entry", type: "notify", on: ["entry"], channel: "telegram", message: "PUMP entry conditions met: buying 0.5 SOL." },
    { id: "exit_pump", type: "close", on: ["dev_dump", "hype_gone"], target: { instrument: { kind: "token", chain: "solana", mint: PUMP_MINT, symbol: "PUMP" } } },
  ],
});

/** Macro: HIP-4 FOMC odds crossing up while the 2Y falls → long BTC + gold, buy YES. */
export const fedPivot = defineStrategy({
  schemaVersion: 1,
  id: "fed-pivot",
  name: "Fed Pivot Spread",
  thesis: "The market is underpricing a December cut. If odds firm up while the 2Y rolls over, get long risk and gold.",
  tags: ["macro", "predictions"],
  signals: [
    { id: "cut_odds", kind: "odds", params: { instrument: { kind: "outcome", venue: "hyperliquid", market: "fomc-dec-2026-cut", outcome: "YES" } } },
    { id: "us2y", kind: "macro", params: { series: "US2Y" } },
    { id: "btc", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" } } },
  ],
  triggers: [
    {
      id: "pivot",
      when: {
        op: "and",
        args: [
          { op: "crosses_above", left: { ref: "cut_odds.prob" }, right: { value: 0.65 } },
          { op: "lt", left: { ref: "us2y.change_5d" }, right: { value: -0.1 } },
        ],
      },
    },
    { id: "pivot_off", when: { op: "lt", left: { ref: "cut_odds.prob" }, right: { value: 0.4 } } },
  ],
  actions: [
    {
      id: "buy_cut",
      type: "open",
      on: ["pivot"],
      instrument: { kind: "outcome", venue: "hyperliquid", market: "fomc-dec-2026-cut", outcome: "YES" },
      side: "long",
      size: { unit: "pct_equity", value: 5 },
      exits: { takeProfit: { prob: 0.9 } },
    },
    {
      id: "long_btc",
      type: "open",
      on: ["pivot"],
      instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" },
      side: "long",
      size: { unit: "pct_equity", value: 8 },
      leverage: 2,
      exits: { takeProfit: { pct: 14 }, stopLoss: { pct: 5 } },
    },
    {
      id: "long_gold",
      type: "open",
      on: ["pivot"],
      instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "GOLD", assetClass: "commodity" },
      side: "long",
      size: { unit: "pct_equity", value: 8 },
      leverage: 3,
      exits: { takeProfit: { pct: 6 }, stopLoss: { pct: 2 } },
    },
    { id: "exit_all", type: "close", on: ["pivot_off"], target: "all" },
  ],
});

/** Funding: fade a crowded SOL long, re-enter after each close. */
export const crowdedFade = defineStrategy({
  schemaVersion: 1,
  id: "crowded-fade",
  name: "Crowded Fade",
  thesis: "When SOL perps get too crowded, funding pinned high and OI at a 30-day peak, fade the crowd with a tight stop.",
  tags: ["funding", "perps"],
  signals: [{ id: "sol_funding", kind: "funding", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL" } } }],
  triggers: [
    {
      id: "crowded",
      when: {
        op: "and",
        args: [
          { op: "gt", left: { ref: "sol_funding.rate_8h_pct" }, right: { value: 0.1 } },
          { op: "gt", left: { ref: "sol_funding.oi_zscore_30d" }, right: { value: 2 } },
        ],
      },
      forMinutes: 60,
      cooldownMinutes: 1_440,
    },
    { id: "normalised", when: { op: "lt", left: { ref: "sol_funding.rate_8h_pct" }, right: { value: 0.02 } } },
  ],
  actions: [
    {
      id: "short_sol",
      type: "open",
      on: ["crowded"],
      instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL" },
      side: "short",
      size: { unit: "pct_equity", value: 8 },
      leverage: 2,
      reentry: "after_close",
      exits: { takeProfit: { pct: 9 }, stopLoss: { pct: 4 } },
    },
    { id: "exit_sol", type: "close", on: ["normalised"], target: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL" } } },
  ],
});

/** Options: defined-risk ETH call spread ahead of a scheduled catalyst. */
export const ethCallSpread = defineStrategy({
  schemaVersion: 1,
  id: "eth-catalyst-spread",
  name: "ETH Catalyst Spread",
  thesis: "ETH runs into the upgrade. Cap the downside with a call spread instead of a naked long.",
  tags: ["options", "events"],
  signals: [
    { id: "upgrade", kind: "calendar", params: { event: "custom", symbol: "ETH", at: "2026-11-20T14:00:00Z" } },
    { id: "eth", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" } } },
  ],
  triggers: [
    {
      id: "window",
      when: {
        op: "and",
        args: [
          { op: "between", value: { ref: "upgrade.hours_until" }, min: { value: 24 }, max: { value: 72 } },
          { op: "gt", left: { ref: "eth.change_24h_pct" }, right: { value: 0 } },
        ],
      },
    },
  ],
  actions: [
    {
      id: "call_spread",
      type: "options",
      on: ["window"],
      legs: [
        { instrument: { kind: "option", venue: "derive", underlying: "ETH", expiry: "2026-12-25", strike: 4800, right: "call" }, side: "buy" },
        { instrument: { kind: "option", venue: "derive", underlying: "ETH", expiry: "2026-12-25", strike: 5400, right: "call" }, side: "sell" },
      ],
      size: { unit: "usd", value: 500 },
      exits: { takeProfit: { pct: 120 }, timeExitHours: 96 },
    },
  ],
});

/** Stocks on Solana: tokenized NVDA into earnings, flat after. */
export const nvdaxEarnings = defineStrategy({
  schemaVersion: 1,
  id: "nvdax-earnings-drift",
  name: "NVDAx Earnings Drift",
  thesis: "Buy tokenized NVDA two days before earnings, sell before the print.",
  tags: ["stocks", "earnings", "solana"],
  signals: [
    { id: "nvda_er", kind: "calendar", params: { event: "earnings", symbol: "NVDA" } },
    { id: "nvdax", kind: "price", params: { instrument: { kind: "token", chain: "solana", mint: NVDAX_MINT, symbol: "NVDAx", quote: "USDC", assetClass: "equity" } } },
  ],
  triggers: [
    { id: "pre_print", when: { op: "between", value: { ref: "nvda_er.hours_until" }, min: { value: 2 }, max: { value: 48 } } },
    { id: "print_close", when: { op: "lt", left: { ref: "nvda_er.hours_until" }, right: { value: 1 } } },
  ],
  actions: [
    {
      id: "buy_nvdax",
      type: "open",
      on: ["pre_print"],
      instrument: { kind: "token", chain: "solana", mint: NVDAX_MINT, symbol: "NVDAx", quote: "USDC", assetClass: "equity", route: "jupiter" },
      side: "long",
      size: { unit: "usd", value: 1_000 },
      order: { maxPriceImpactBps: 50 },
      exits: { takeProfit: { pct: 12 }, stopLoss: { pct: 7 } },
    },
    { id: "flat_before_print", type: "close", on: ["print_close"], target: "all" },
  ],
});

export const examples: Strategy[] = [elNino, pumpMomentum, fedPivot, crowdedFade, ethCallSpread, nvdaxEarnings];
