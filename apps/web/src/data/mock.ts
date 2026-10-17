/**
 * The landing page's market showcase: one example strategy per product. Every example only uses
 * data Weft has live (prices, funding, liquidity, on-chain flow, odds, rates, earnings dates).
 */

export interface CompiledLine {
  signal: string;
  trigger: string;
  action: string;
}

export interface ProductMarket {
  venue: string;
  thesis: string;
  graph: CompiledLine;
}

export interface Product {
  id: "perps" | "stocks" | "predictions" | "tokens" | "options";
  name: string;
  venues: string[];
  status: "live" | "soon";
  markets: ProductMarket[];
}

export const products: Product[] = [
  {
    id: "perps",
    name: "Perps",
    venues: ["Hyperliquid"],
    status: "live",
    markets: [
      {
        venue: "Hyperliquid",
        thesis: "If the Fear & Greed Index hits 20, open a 20× long on ETH and on BTC with $100 each.",
        graph: { signal: "Crypto Fear & Greed Index", trigger: "20 or lower", action: "Long ETH and BTC at 20×, $100 each" },
      },
    ],
  },
  {
    id: "stocks",
    name: "Stocks",
    venues: ["Hyperliquid", "Solana"],
    status: "live",
    markets: [
      {
        venue: "Solana via Jupiter",
        thesis: "Tesla drops 5% in a day? Buy some tokenized TSLA.",
        graph: { signal: "TSLAx price", trigger: "Down 5% in 24 hours", action: "Buy TSLAx with 2 SOL, stop at −15%" },
      },
    ],
  },
  {
    id: "predictions",
    name: "Predictions",
    venues: ["Hyperliquid"],
    status: "live",
    markets: [
      {
        venue: "Hyperliquid",
        thesis: "Bonds are pricing a Fed cut before the odds are.",
        graph: { signal: "2-year yield and Fed odds on Polymarket", trigger: "Yield down 10 bp in 5 days, odds under 70%", action: "Buy YES on Hyperliquid, up to 70¢" },
      },
    ],
  },
  {
    id: "tokens",
    name: "Solana tokens",
    venues: ["Solana", "Jupiter"],
    status: "live",
    markets: [
      {
        venue: "Solana via Jupiter",
        thesis: "When the wallet I follow buys $WIF, buy it too.",
        graph: { signal: "Wallet 7xKp…9fQe and $WIF liquidity", trigger: "It buys $WIF, liquidity above $1M", action: "Buy $WIF with 0.5 SOL, stop at −20%" },
      },
    ],
  },
  {
    id: "options",
    name: "Options",
    venues: [],
    status: "soon",
    markets: [
      {
        venue: "Deribit and Derive, when options open",
        thesis: "Bullish on ETH, but never lose more than $120.",
        graph: { signal: "ETH price", trigger: "ETH closes above $2,600", action: "Buy a call spread, most you can lose $120" },
      },
    ],
  },
];
