/**
 * Brand config: swap the name/ticker here and it propagates across the site.
 * Alternatives considered: Kairos ($KAIRO), Sibyl ($SIBYL).
 */
export const brand = {
  name: "Weft",
  ticker: "WEFT",
  tagline: "Trade the thesis.",
  description:
    "Weft turns a market thesis written in plain language into a live, visual trading strategy for perps, stocks, prediction markets and any Solana token. It runs non-custodially on Hyperliquid and Solana (via Jupiter). Strategies are public and forkable; trading fees buy back $WEFT.",
  domain: "weft.trade",
  url: "https://weft.trade",
  contractAddress: "PLACEHOLDER_CONTRACT_ADDRESS_SOLANA",
  chain: "Solana",
  /** Where $WEFT launches. Swap to "pump.fun" (+ curve "bonding curve") and the copy follows. */
  launchpad: "Meteora",
  launchCurve: "Dynamic Bonding Curve",
  builderFeeBps: 5, // Hyperliquid builder fee, 0.05%
  swapFeeBps: 50, // Jupiter platform/referral fee on Solana swaps, 0.5% (matches @weft/engine DEFAULT_FEES.solana.platformBps)
  socials: {
    x: "https://x.com/",
    telegram: "https://t.me/",
    github: "https://github.com/",
  },
  competitor: {
    name: "Catalyst",
    raised: "$30M",
    investor: "Sequoia",
  },
} as const;

export const $T = `$${brand.ticker}`;
