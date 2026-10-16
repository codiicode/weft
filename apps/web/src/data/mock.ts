/**
 * Demo data for the landing page's market showcase. Everything else on the site is live.
 */

export interface CompiledLine {
  signal: string;
  trigger: string;
  action: string;
}

export interface ProductMarket {
  /** chip label */
  sym: string;
  name: string;
  venue: string;
  thesis: string;
  graph: CompiledLine;
  /** price-like products */
  px?: number;
  ch?: number;
  seed?: number;
  lev?: string;
  /** prediction markets: YES price + Weft model probability, 0..1 */
  yes?: number;
  model?: number;
  closes?: string;
  /** options: payoff shape, strikes and premium as % of spot */
  /** Options payoff in normalised spot units (x 0..1): strikes, premium paid, and the dollar value of that premium. */
  payoff?: { kind: "call-spread" | "long-put" | "long-call"; k1: number; k2?: number; premium: number; lossUsd: number; maxGain: string; breakeven: string };
}

export interface Product {
  id: "perps" | "stocks" | "predictions" | "tokens" | "options";
  n: string;
  name: string;
  kicker: string;
  venues: string[];
  status: "live" | "soon";
  markets: ProductMarket[];
}

export const products: Product[] = [
  {
    id: "perps",
    n: "01",
    name: "Perps",
    kicker: "Crypto perpetuals with leverage, stops and targets on every order.",
    venues: ["Hyperliquid"],
    status: "live",
    markets: [
      { sym: "BTC", name: "Bitcoin", venue: "Hyperliquid", px: 118420.5, ch: 1.84, seed: 401, lev: "3×", thesis: "ETF inflows three days running? Get long BTC.", graph: { signal: "Bitcoin ETF flows", trigger: "Money flows in 3 days in a row", action: "Go long BTC at 3×, stop at −5%" } },
      { sym: "ETH", name: "Ether", venue: "Hyperliquid", px: 4612.18, ch: 2.41, seed: 402, lev: "2×", thesis: "When ETH funding pins above 0.1%, fade the crowd.", graph: { signal: "ETH funding", trigger: "Funding > 0.10%", action: "Short ETH 2×" } },
      { sym: "HYPE", name: "Hyperliquid", venue: "Hyperliquid", px: 58.94, ch: 4.63, seed: 403, lev: "3×", thesis: "Buy HYPE on a fee-revenue record with a tight stop.", graph: { signal: "Protocol revenue", trigger: "Revenue 7d at high", action: "Long HYPE 3×" } },
    ],
  },
  {
    id: "stocks",
    n: "02",
    name: "Stocks",
    kicker: "Equities, indices and commodities as HIP-3 perps, plus tokenized stocks on Solana.",
    venues: ["Hyperliquid", "Solana"],
    status: "live",
    markets: [
      { sym: "NVDA", name: "NVIDIA · HIP-3 perp", venue: "Hyperliquid", px: 184.2, ch: 0.62, seed: 411, lev: "3×", thesis: "If the export license is approved, long NVDA before the open.", graph: { signal: "Posts from @fab_insider on X", trigger: "A post says the license is approved", action: "Go long NVDA at 3×, stop at −3%" } },
      { sym: "GOLD", name: "Gold · HIP-3 perp", venue: "Hyperliquid", px: 3912.4, ch: 0.38, seed: 412, lev: "2×", thesis: "Real yields roll over and gold breaks out. Long into the cut.", graph: { signal: "US 10Y real yield", trigger: "Real yield 5d < −15bp", action: "Long GOLD 2×" } },
      { sym: "TSLAx", name: "Tesla · tokenized", venue: "xStocks on Solana", px: 262.04, ch: -0.79, seed: 413, thesis: "Accumulate tokenized Tesla on every 5% dip before earnings.", graph: { signal: "TSLAx price", trigger: "Off 20d high ≥ 5%", action: "Buy TSLAx $250" } },
    ],
  },
  {
    id: "predictions",
    n: "03",
    name: "Predictions",
    kicker: "Outcome markets where the agent buys the side its model thinks is mispriced.",
    venues: ["Hyperliquid", "Polymarket soon"],
    status: "live",
    markets: [
      { sym: "Fed cut", name: "Fed cuts in December?", venue: "Hyperliquid", yes: 0.64, model: 0.78, closes: "Dec 10", thesis: "The market is underpricing a December cut.", graph: { signal: "Fed odds and the 2-year yield", trigger: "Our model is 10+ points above the market", action: "Buy YES up to 70¢" } },
      { sym: "BTC $90k", name: "BTC above $90k on Friday?", venue: "Hyperliquid", yes: 0.31, model: 0.44, closes: "Fri", thesis: "Funding is flat and the dip is being bought; the odds look too low.", graph: { signal: "BTC price, funding", trigger: "Model − odds > 10pp", action: "Buy YES ≤ 34¢" } },
      { sym: "NE–NYJ", name: "Patriots beat the Jets?", venue: "Hyperliquid", yes: 0.75, model: 0.68, closes: "Sun", thesis: "The line moved too far on one injury report.", graph: { signal: "Injury news, odds", trigger: "Odds − model > 6pp", action: "Buy NYJ ≤ 27¢" } },
    ],
  },
  {
    id: "tokens",
    n: "04",
    name: "Solana tokens",
    kicker: "Anything on Solana by mint, memecoins included, routed through Jupiter with rug checks before every swap.",
    venues: ["Jupiter", "pump.fun", "Meteora", "Raydium LaunchLab", "StonkFun"],
    status: "soon",
    markets: [
      { sym: "$PUMP", name: "Pump", venue: "Jupiter route", px: 0.00412, ch: -6.8, seed: 421, thesis: "Buy $PUMP when it hits 0.004 and sentiment turns bullish.", graph: { signal: "$PUMP price and mood on X", trigger: "Price at 0.004 or lower and mood turns bullish", action: "Buy with 0.5 SOL, stop at −20%" } },
      { sym: "$WIF", name: "dogwifhat", venue: "Jupiter route", px: 1.382, ch: 5.12, seed: 422, thesis: "Ride $WIF when buyers outnumber sellers 1.5 to 1.", graph: { signal: "Buy / sell ratio", trigger: "Ratio > 1.5 · 1h", action: "Buy 1 SOL" } },
      { sym: "$LOOM", name: "Loom (3h old)", venue: "pump.fun → Jupiter", px: 0.000183, ch: 412.5, seed: 423, thesis: "Ape the next fresh launch if CT catches on early.", graph: { signal: "New launches", trigger: "Rug checks pass", action: "Buy 0.5 SOL" } },
    ],
  },
  {
    id: "options",
    n: "05",
    name: "Options",
    kicker: "Defined risk only: spreads and bought calls or puts. Your max loss is known before you trade.",
    venues: ["Defined risk only"],
    status: "soon",
    markets: [
      { sym: "Call spread", name: "ETH 4,800 / 5,200", venue: "Deribit", payoff: { kind: "call-spread", k1: 0.4, k2: 0.66, premium: 0.078, lossUsd: 120, maxGain: "+$280", breakeven: "4,920" }, thesis: "Bullish into the upgrade, max loss capped at $120.", graph: { signal: "ETH options prices", trigger: "Options are cheap compared with the past year", action: "Buy a call spread, most you can lose $120" } },
      { sym: "Long put", name: "BTC 110k put", venue: "Defined risk", payoff: { kind: "long-put", k1: 0.58, premium: 0.07, lossUsd: 310, maxGain: "+$1,640", breakeven: "106.9k" }, thesis: "Hedge the bag into CPI without a liquidation price.", graph: { signal: "CPI nowcast", trigger: "Nowcast > 3.0%", action: "Buy BTC put" } },
      { sym: "Long call", name: "SOL 260 call", venue: "Defined risk", payoff: { kind: "long-call", k1: 0.46, premium: 0.06, lossUsd: 85, maxGain: "Uncapped", breakeven: "268.5" }, thesis: "If the ETF gets approved, I want upside, not liquidations.", graph: { signal: "ETF decision odds", trigger: "Odds > 70%", action: "Buy SOL call" } },
    ],
  },
];

/** Token identity + pre-trade rug checks for the Solana tokens tile and on-chain widget. */
