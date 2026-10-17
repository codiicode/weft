/**
 * Brand config: swap the name/ticker here and it propagates across the site.
 * Alternatives considered: Kairos ($KAIRO), Sibyl ($SIBYL).
 */
export const brand = {
  name: "Weft",
  ticker: "WEFT",
  tagline: "Trade the thesis.",
  description:
    "Write a market view in plain English. Weft turns it into rules you can read and trades them from your own wallet: perps, stocks, prediction markets and Solana tokens.",
  domain: "weft.fi",
  url: "https://weft.fi",
  contractAddress: "HqmFi85adLD8BQA7en1HfajdAfzVFps5REgQaYuw6Ax8",
  chain: "Solana",
  /** Where $WEFT launches. Swap to "pump.fun" (+ curve "bonding curve") and the copy follows. */
  launchpad: "Meteora",
  launchCurve: "Dynamic Bonding Curve",
  builderFeeBps: 10, // Hyperliquid builder fee on perps and prediction markets, 0.1% (Hyperliquid's maximum on perps)
  hlSpotFeeBps: 100, // Hyperliquid spot: 1% on sells (Hyperliquid's maximum; buys pay nothing)
  swapFeeBps: 100, // Jupiter platform fee on Solana swaps, 1% (matches @weft/engine DEFAULT_FEES.solana.platformBps)
  /** Share of fees that buys back $WEFT; the rest is Weft's revenue. */
  buybackShare: 0.5,
  /** Fee on every $WEFT trade (on Meteora's curve and in the graduated pool), and where it goes. Matches apps/api/src/token/curve.ts. */
  tokenFee: { totalBps: 300, protocolBps: 200, buybackBps: 40, meteoraBps: 60 },
  /** $WEFT tiers (apps/api/src/live/holders.ts): fee discount from a number of tokens held. */
  tiers: { holder: { min: 100_000, discount: 0.25 }, whale: { min: 1_000_000, discount: 0.5 } },
  /**
   * Daily $WEFT rewards, split of each day's buyback (matches apps/api/src/lib/rewards.ts): traders by
   * fees paid, creators by the fees their strategies' runs paid, the rest burned. Holders get a boost.
   */
  rewards: { traderShare: 0.5, creatorShare: 0.2, burnShare: 0.3, holderBoost: 1.5, whaleBoost: 2 },
  /** AI drafts per day (apps/api aiDailyLimit / holderAiDailyLimit). */
  aiDrafts: { everyone: 30, holders: 100 },
  socials: {
    x: "https://x.com/weftfinance",
  },
  competitor: {
    name: "Catalyst",
    raised: "$30M",
    investor: "Sequoia",
  },
} as const;

export const $T = `$${brand.ticker}`;
