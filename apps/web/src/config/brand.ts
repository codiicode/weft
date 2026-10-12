/**
 * Brand config: swap the name/ticker here and it propagates across the site.
 * Alternatives considered: Kairos ($KAIRO), Sibyl ($SIBYL).
 */
export const brand = {
  name: "Weft",
  ticker: "WEFT",
  tagline: "Trade the thesis.",
  description:
    "Weft turns a market thesis written in plain language into a live, visual trading strategy that runs non-custodially on Hyperliquid and Jupiter. Strategies are public and forkable; builder fees buy back $WEFT.",
  domain: "weft.trade",
  url: "https://weft.trade",
  contractAddress: "PLACEHOLDER_CONTRACT_ADDRESS_SOLANA",
  chain: "Solana",
  builderFeeBps: 5, // 0.05%
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
