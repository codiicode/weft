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

/** Perps: a 20× ETH breakout while funding is still cheap (the crowd isn't long yet). */
export const ethBreakout = defineStrategy({
  schemaVersion: 1,
  id: "eth-breakout-20x",
  name: "ETH Breakout 20×",
  thesis: "Open a 20× ETH long if ETH breaks $2,600 while funding stays under 0.01% an hour.",
  tags: ["perps", "breakout"],
  risk: { maxLeverage: 20 },
  signals: [
    { id: "eth_px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" } } },
    { id: "eth_funding", kind: "funding", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" } } },
  ],
  triggers: [
    {
      id: "breakout",
      when: {
        op: "and",
        args: [
          { op: "gt", left: { ref: "eth_px.price" }, right: { value: 2600 } },
          { op: "lt", left: { ref: "eth_funding.rate_1h_pct" }, right: { value: 0.01 } },
        ],
      },
      maxFires: 1,
    },
  ],
  actions: [
    {
      id: "long_eth",
      type: "open",
      on: ["breakout"],
      instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" },
      side: "long",
      size: { unit: "usd", value: 50 },
      leverage: 20,
      reentry: "never",
      exits: { stopLoss: { positionPct: 20 }, takeProfit: { positionPct: 50 } },
    },
  ],
});

/** Solana token: price level + buyers in control + locked liquidity. */
export const pumpMomentum = defineStrategy({
  schemaVersion: 1,
  id: "pump-momentum",
  name: "PUMP dip, buyers in control",
  thesis: "Buy $PUMP when it drops to 0.004 while buyers still outnumber sellers and the liquidity is locked.",
  tags: ["solana", "tokens"],
  signals: [
    { id: "pump_px", kind: "price", params: { instrument: { kind: "token", chain: "solana", mint: PUMP_MINT, symbol: "PUMP" } } },
    { id: "pump_chain", kind: "token_onchain", params: { mint: PUMP_MINT } },
  ],
  triggers: [
    {
      id: "entry",
      label: "Dip with buyers in control",
      when: {
        op: "and",
        args: [
          { op: "lte", left: { ref: "pump_px.price" }, right: { value: 0.004 } },
          { op: "gt", left: { ref: "pump_chain.buy_sell_ratio_1h" }, right: { value: 1.5 } },
          { op: "is", ref: "pump_chain.lp_locked", value: true },
        ],
      },
      forMinutes: 5,
    },
    { id: "dev_dump", when: { op: "gt", left: { ref: "pump_chain.dev_sold_pct" }, right: { value: 20 } } },
    { id: "sellers_take_over", when: { op: "lt", left: { ref: "pump_chain.buy_sell_ratio_1h" }, right: { value: 0.7 } }, forMinutes: 30 },
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
    { id: "exit_pump", type: "close", on: ["dev_dump", "sellers_take_over"], target: { instrument: { kind: "token", chain: "solana", mint: PUMP_MINT, symbol: "PUMP" } } },
  ],
});

/** Macro: Fed cut odds crossing up while the 2Y falls → buy YES, long BTC and gold. */
export const fedPivot = defineStrategy({
  schemaVersion: 1,
  id: "fed-pivot",
  name: "Fed cut odds",
  thesis: "Bonds are pricing a rate cut before the odds are. When cut odds pass 65% while the 2-year yield falls, buy YES and get long BTC and gold.",
  tags: ["macro", "predictions"],
  signals: [
    { id: "cut_odds", kind: "odds", label: "Fed cut odds", params: { instrument: { kind: "outcome", venue: "hyperliquid", market: "fomc-dec-2026-cut", outcome: "YES", question: "Fed cuts rates in December 2026?" } } },
    { id: "us2y", kind: "macro", label: "US 2-year yield", params: { series: "US2Y" } },
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
      instrument: { kind: "outcome", venue: "hyperliquid", market: "fomc-dec-2026-cut", outcome: "YES", question: "Fed cuts rates in December 2026?" },
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
      exits: { takeProfit: { positionPct: 28 }, stopLoss: { positionPct: 10 } },
    },
    {
      id: "long_gold",
      type: "open",
      on: ["pivot"],
      instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "GOLD", assetClass: "commodity" },
      side: "long",
      size: { unit: "pct_equity", value: 8 },
      leverage: 3,
      exits: { takeProfit: { positionPct: 18 }, stopLoss: { positionPct: 6 } },
    },
    { id: "exit_all", type: "close", on: ["pivot_off"], target: "all" },
  ],
});

/** Funding: fade a crowded SOL long, re-enter after each close. */
export const crowdedFade = defineStrategy({
  schemaVersion: 1,
  id: "crowded-fade",
  name: "Crowded Fade",
  thesis: "When SOL longs get crowded, with funding high and open interest far above normal, short it with a tight stop.",
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
      exits: { takeProfit: { positionPct: 18 }, stopLoss: { positionPct: 8 } },
    },
    { id: "exit_sol", type: "close", on: ["normalised"], target: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL" } } },
  ],
});

/** Options: defined-risk ETH call spread ahead of a scheduled date. */
export const ethCallSpread = defineStrategy({
  schemaVersion: 1,
  id: "eth-catalyst-spread",
  name: "ETH Call Spread",
  thesis: "Bullish on ETH into a big date, but want a capped loss? Buy a call spread instead of a leveraged long.",
  tags: ["options", "events"],
  signals: [
    { id: "event", kind: "calendar", params: { event: "custom", symbol: "ETH", at: "2026-11-20T14:00:00Z" } },
    { id: "eth", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" } } },
  ],
  triggers: [
    {
      id: "window",
      when: {
        op: "and",
        args: [
          { op: "between", value: { ref: "event.hours_until" }, min: { value: 24 }, max: { value: 72 } },
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
        { instrument: { kind: "option", venue: "derive", underlying: "ETH", expiry: "2026-12-25", strike: 2800, right: "call" }, side: "buy" },
        { instrument: { kind: "option", venue: "derive", underlying: "ETH", expiry: "2026-12-25", strike: 3200, right: "call" }, side: "sell" },
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

/** Sentiment: the whole market at extreme fear → small, leveraged longs on the majors. */
export const buyThePanic = defineStrategy({
  schemaVersion: 1,
  id: "buy-the-panic",
  name: "Buy the panic",
  thesis: "When the Fear & Greed Index hits 20, the market is scared. Open 20× longs on ETH and BTC with $100 each.",
  tags: ["sentiment", "perps"],
  risk: { maxLeverage: 20 },
  signals: [{ id: "fear_greed", kind: "macro", label: "Crypto Fear & Greed", params: { series: "FEAR_GREED" } }],
  triggers: [{ id: "extreme_fear", when: { op: "lte", left: { ref: "fear_greed.value" }, right: { value: 20 } }, maxFires: 1 }],
  actions: [
    { id: "long_eth", type: "open", on: ["extreme_fear"], instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" }, side: "long", size: { unit: "usd", value: 100 }, leverage: 20, exits: {} },
    { id: "long_btc", type: "open", on: ["extreme_fear"], instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" }, side: "long", size: { unit: "usd", value: 100 }, leverage: 20, exits: {} },
  ],
});

/** Hyperliquid's own market on the 2026-27 NBA champion, the Spurs' YES side. */
const SPURS_TITLE = { kind: "outcome", venue: "hyperliquid", market: "11493", outcome: "YES", question: "NBA 2026/2027 winner: San Antonio Spurs?" } as const;

/** Prediction markets: a strong start to the season, once the title odds start to agree → buy YES. */
export const spursHotStart = defineStrategy({
  schemaVersion: 1,
  id: "spurs-hot-start",
  name: "Back a hot start",
  thesis: "If the Spurs win at least 10 of their first 15 games and their title odds pass 25%, put $1,000 on them winning the NBA title. Sell if the odds drop below 15%.",
  tags: ["predictions", "sports"],
  risk: { maxPositionPct: 100, maxTotalExposurePct: 100 },
  signals: [
    { id: "spurs", kind: "sports", label: "Spurs record (NBA)", params: { league: "nba", team: "Spurs" } },
    { id: "title_odds", kind: "odds", label: "Spurs title odds", params: { instrument: SPURS_TITLE } },
  ],
  triggers: [
    {
      id: "hot_start",
      label: "10+ wins in the first 15 games, odds above 25%",
      when: {
        op: "and",
        args: [
          { op: "gte", left: { ref: "spurs.games_played" }, right: { value: 15 } },
          { op: "gte", left: { ref: "spurs.wins" }, right: { value: 10 } },
          { op: "gt", left: { ref: "title_odds.prob" }, right: { value: 0.25 } },
        ],
      },
      maxFires: 1,
    },
    { id: "fade", label: "Odds back under 15%", when: { op: "lt", left: { ref: "title_odds.prob" }, right: { value: 0.15 } } },
  ],
  actions: [
    { id: "buy_yes", type: "open", on: ["hot_start"], instrument: SPURS_TITLE, side: "long", size: { unit: "usd", value: 1000 }, exits: {} },
    { id: "sell_yes", type: "close", on: ["fade"], target: { instrument: SPURS_TITLE } },
  ],
});

/** Weather: a Chicago cold snap (more heating demand) → long natural gas. */
export const coldSnap = defineStrategy({
  schemaVersion: 1,
  id: "cold-snap",
  name: "Cold snap in Chicago",
  thesis: "A colder week in the Midwest means more heating and more demand for gas. Long natural gas when Chicago's forecast drops 5°C.",
  tags: ["weather", "commodities"],
  signals: [{ id: "chicago", kind: "forecast", params: { source: "weather", series: "temp:Chicago" } }],
  triggers: [{ id: "cold", when: { op: "lte", left: { ref: "chicago.change_7d" }, right: { value: -5 } } }],
  actions: [
    {
      id: "long_gas",
      type: "open",
      on: ["cold"],
      instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NATGAS", assetClass: "commodity" },
      side: "long",
      size: { unit: "usd", value: 100 },
      leverage: 2,
      exits: { stopLoss: { positionPct: 10 }, takeProfit: { positionPct: 20 } },
    },
  ],
});

/**
 * Papertrade: farm PAPER hedged, in rounds. A $1,000 BTC long on Papertrade (100×, $10) against a
 * $1,000 short on Hyperliquid (40×, $25): while both are open they cancel out. A move of about 1%
 * busts the Papertrade leg (the loss earns PAPER) and the short, which gained about as much, is
 * closed at once; then the next round opens (at most one round every 3 minutes). Up to 30 rounds,
 * and the day stops after half the budget is spent.
 */
const PT_BTC = { kind: "synth", venue: "papertrade", symbol: "BTC" } as const;
const HL_BTC = { kind: "perp", venue: "hyperliquid", symbol: "BTC" } as const;
export const farmPaper = defineStrategy({
  schemaVersion: 1,
  id: "farm-paper-btc",
  name: "Farm PAPER, hedged",
  thesis: "Farm PAPER on Papertrade without betting on BTC: a 100× BTC long on Papertrade against the same size short on Hyperliquid, round after round.",
  tags: ["papertrade", "hedge", "farm"],
  risk: { maxLeverage: 100, maxPositionPct: 100, maxTotalExposurePct: 10_000, maxDailyLossPct: 50 },
  signals: [
    { id: "pt", kind: "position", label: "Papertrade leg", params: { instrument: PT_BTC } },
    { id: "hl", kind: "position", label: "Hyperliquid leg", params: { instrument: HL_BTC } },
  ],
  triggers: [
    {
      id: "round",
      label: "Neither leg is open",
      when: { op: "and", args: [{ op: "is", ref: "pt.open", value: false }, { op: "is", ref: "hl.open", value: false }] },
      cooldownMinutes: 3,
      maxFires: 30,
    },
    { id: "pt_gone", label: "Papertrade leg closed", when: { op: "and", args: [{ op: "is", ref: "pt.open", value: false }, { op: "is", ref: "hl.open", value: true }] } },
    { id: "hl_gone", label: "Hyperliquid leg closed", when: { op: "and", args: [{ op: "is", ref: "hl.open", value: false }, { op: "is", ref: "pt.open", value: true }] } },
  ],
  actions: [
    { id: "pt_long", on: ["round"], type: "open", label: "Long BTC 100× on Papertrade", instrument: PT_BTC, side: "long", size: { unit: "usd", value: 10 }, leverage: 100, reentry: "after_close" },
    { id: "hl_short", on: ["round"], type: "open", label: "Short BTC 40× on Hyperliquid", instrument: HL_BTC, side: "short", size: { unit: "usd", value: 25 }, leverage: 40, reentry: "after_close" },
    { id: "close_after_pt", on: ["pt_gone"], type: "close", target: "all" },
    { id: "close_after_hl", on: ["hl_gone"], type: "close", target: "all" },
  ],
});

export const examples: Strategy[] = [ethBreakout, buyThePanic, spursHotStart, coldSnap, pumpMomentum, fedPivot, crowdedFade, ethCallSpread, nvdaxEarnings, farmPaper];
