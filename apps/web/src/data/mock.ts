/**
 * ALL DEMO DATA lives here. Every number on the site is mock data.
 * Swap these exports for live feeds later; components only read from this file.
 */
import type { GraphSpec } from "@/components/graph/types";
import { walk } from "@/lib/rng";

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

export interface Strategy extends GraphSpec {
  id: string;
  title: string;
  category: string;
  thesis: string;
  author: string;
  venues: string[];
  stats: { ret30d: number; winRate: number; maxDD: number; forks: number; followers: number; daysLive: number };
  mode: "Live" | "Paper";
}

export const heroStrategy: Strategy = {
  id: "el-nino-harvest",
  title: "El Niño Harvest",
  category: "Weather",
  thesis: "El Niño is coming — what's the trade?",
  author: "@monsoon_maria",
  venues: ["Hyperliquid", "Jupiter"],
  mode: "Paper",
  stats: { ret30d: 18.4, winRate: 67, maxDD: -5.8, forks: 412, followers: 2310, daysLive: 41 },
  nodes: [
    { id: "s1", kind: "signal", type: "forecast", title: "ENSO outlook", source: "NOAA CPC", value: "Niño 3.4  +1.7°C", delta: "+0.4°C w/w", deltaDir: "up", spark: walk(11, 28, 0.6, 0.35) },
    { id: "s2", kind: "signal", type: "odds", title: "El Niño by winter?", source: "Prediction mkt", value: "Mkt 61% · Model 84%", delta: "23pp edge", deltaDir: "up", spark: walk(4, 28, 0.25, 0.4) },
    { id: "s3", kind: "signal", type: "price", title: "WHEAT-PERP", source: "HIP-3", value: "$5.842", delta: "+2.1% 24h", deltaDir: "up", spark: walk(23, 28, 0.3, 0.5) },
    { id: "s4", kind: "signal", type: "social", title: "Ag-weather desks", source: "X · 38 accts", value: "Sentiment +0.46", delta: "1,240 posts", deltaDir: "up", spark: walk(91, 28, 0.2, 0.6) },
    { id: "t1", kind: "trigger", logic: "AND", conditions: ["Niño 3.4 > +1.5°C", "Model − Mkt > 15pp"], met: true },
    { id: "t2", kind: "trigger", logic: "OR", conditions: ["Wheat 20d trend > 0", "AUS crop est. cut ≥ 5%"], met: true },
    { id: "t3", kind: "trigger", logic: "AND", conditions: ["USD/BRL > 5.60", "Desk sentiment > +0.40"], met: false },
    { id: "a1", kind: "action", side: "buy", asset: "YES · El Niño", venue: "Jupiter", alloc: "12%", tp: "92¢", sl: "48¢", pnl: 9.6, spark: walk(5, 30, 0.6, 0.4) },
    { id: "a2", kind: "action", side: "long", asset: "WHEAT", lev: "3×", venue: "Hyperliquid", alloc: "18%", tp: "+16%", sl: "−6%", pnl: 4.2, spark: walk(8, 30, 0.45, 0.5) },
    { id: "a3", kind: "action", side: "long", asset: "SUGAR", lev: "2×", venue: "Hyperliquid", alloc: "10%", tp: "+12%", sl: "−5%", pnl: 2.7, spark: walk(31, 30, 0.35, 0.55) },
    { id: "a4", kind: "action", side: "short", asset: "BRAZIL-50", lev: "2×", venue: "Hyperliquid", alloc: "8%", tp: "−9%", sl: "+4%", pnl: 0, spark: walk(17, 30, -0.3, 0.4) },
    { id: "x1", kind: "exit", title: "Close all positions", detail: "if Niño 3.4 < +0.5°C" },
  ],
  edges: [
    ["s1", "t1"], ["s2", "t1"], ["s3", "t2"], ["s4", "t2"], ["s4", "t3"],
    ["t1", "a1"], ["t2", "a2"], ["t2", "a3"], ["t3", "a4"], ["t3", "x1"],
  ],
};

export const strategies: Strategy[] = [
  heroStrategy,
  {
    id: "fed-pivot",
    title: "Fed Pivot Spread",
    category: "Macro",
    thesis: "The market is underpricing a December cut. If odds firm up while the 2Y rolls over, get long risk and gold.",
    author: "@basis_point_bea",
    venues: ["Hyperliquid", "Jupiter"],
    mode: "Live",
    stats: { ret30d: 11.2, winRate: 61, maxDD: -7.1, forks: 288, followers: 1720, daysLive: 63 },
    nodes: [
      { id: "s1", kind: "signal", type: "odds", title: "Dec FOMC cut", source: "Prediction mkt", value: "YES 68¢", delta: "+9¢ 7d", deltaDir: "up", spark: walk(41, 28, 0.4, 0.4) },
      { id: "s2", kind: "signal", type: "rates", title: "US 2Y yield", source: "Rates feed", value: "3.41%", delta: "−14bp 5d", deltaDir: "down", spark: walk(42, 28, -0.4, 0.3) },
      { id: "s3", kind: "signal", type: "model", title: "CPI nowcast", source: "Weft model", value: "2.6% y/y", delta: "below cons.", deltaDir: "down", spark: walk(43, 28, -0.2, 0.3) },
      { id: "t1", kind: "trigger", logic: "AND", conditions: ["Cut odds > 65%", "2Y yield 5d Δ < −10bp"], met: true },
      { id: "t2", kind: "trigger", logic: "OR", conditions: ["Cut odds < 40%", "CPI nowcast > 3.0%"], met: false },
      { id: "a1", kind: "action", side: "long", asset: "BTC", lev: "2×", venue: "Hyperliquid", alloc: "15%", tp: "+14%", sl: "−5%", pnl: 6.1, spark: walk(44, 30, 0.5, 0.5) },
      { id: "a2", kind: "action", side: "long", asset: "ETH", lev: "2×", venue: "Hyperliquid", alloc: "10%", tp: "+18%", sl: "−6%", pnl: 8.3, spark: walk(45, 30, 0.5, 0.6) },
      { id: "a3", kind: "action", side: "long", asset: "GOLD", lev: "3×", venue: "Hyperliquid", alloc: "12%", tp: "+6%", sl: "−2%", pnl: 3.4, spark: walk(46, 30, 0.4, 0.3) },
      { id: "x1", kind: "exit", title: "Close all positions", detail: "if odds collapse or CPI runs hot" },
    ],
    edges: [["s1", "t1"], ["s2", "t1"], ["s1", "t2"], ["s3", "t2"], ["t1", "a1"], ["t1", "a2"], ["t1", "a3"], ["t2", "x1"]],
  },
  {
    id: "post-and-pounce",
    title: "Post & Pounce",
    category: "Social",
    thesis: "If @fab_insider posts that the export license got approved, go long NVDA. Bail the moment a credible wire contradicts it.",
    author: "@tape_reader",
    venues: ["Hyperliquid"],
    mode: "Live",
    stats: { ret30d: 7.9, winRate: 58, maxDD: -4.2, forks: 534, followers: 3104, daysLive: 22 },
    nodes: [
      { id: "s1", kind: "signal", type: "social", title: "@fab_insider", source: "X · watch", value: "“license approved”", delta: "match 0.93", deltaDir: "up", spark: walk(51, 28, 0.2, 0.9) },
      { id: "s2", kind: "signal", type: "news", title: "Newswire", source: "14 outlets", value: "2 confirming", delta: "0 denying", deltaDir: "up", spark: walk(52, 28, 0.3, 0.5) },
      { id: "s3", kind: "signal", type: "price", title: "NVDA-PERP", source: "HIP-3", value: "$184.20", delta: "+0.6% 1h", deltaDir: "up", spark: walk(53, 28, 0.3, 0.4) },
      { id: "t1", kind: "trigger", logic: "AND", conditions: ["Post matches thesis", "Sentiment > 0.6"], met: true },
      { id: "t2", kind: "trigger", logic: "OR", conditions: ["Wire says “denied”", "Post deleted"], met: false },
      { id: "a1", kind: "action", side: "long", asset: "NVDA", lev: "3×", venue: "Hyperliquid", alloc: "10%", tp: "+8%", sl: "−3%", pnl: 3.8, spark: walk(54, 30, 0.6, 0.5) },
      { id: "x1", kind: "exit", title: "Close all positions", detail: "on contradicting source" },
    ],
    edges: [["s1", "t1"], ["s2", "t1"], ["s3", "t1"], ["s2", "t2"], ["s1", "t2"], ["t1", "a1"], ["t2", "x1"]],
  },
  {
    id: "crowded-fade",
    title: "Crowded Fade",
    category: "Funding",
    thesis: "When SOL perps get too crowded — funding pinned high, OI at a 30-day peak — fade the crowd with a tight stop.",
    author: "@contrarian_kai",
    venues: ["Hyperliquid"],
    mode: "Live",
    stats: { ret30d: 14.6, winRate: 64, maxDD: -6.4, forks: 371, followers: 2088, daysLive: 88 },
    nodes: [
      { id: "s1", kind: "signal", type: "funding", title: "SOL funding", source: "Hyperliquid", value: "+0.124% / 8h", delta: "97th pct", deltaDir: "up", spark: walk(61, 28, 0.6, 0.6) },
      { id: "s2", kind: "signal", type: "price", title: "SOL open interest", source: "Hyperliquid", value: "$1.92B", delta: "30d high", deltaDir: "up", spark: walk(62, 28, 0.5, 0.3) },
      { id: "s3", kind: "signal", type: "social", title: "CT euphoria index", source: "X · 2.1k accts", value: "82 / 100", delta: "+11 24h", deltaDir: "up", spark: walk(63, 28, 0.4, 0.5) },
      { id: "t1", kind: "trigger", logic: "AND", conditions: ["Funding > 0.10% / 8h", "OI z-score > 2.0"], met: true },
      { id: "t2", kind: "trigger", logic: "IF", conditions: ["Funding < 0.02% / 8h"], met: false },
      { id: "a1", kind: "action", side: "short", asset: "SOL", lev: "2×", venue: "Hyperliquid", alloc: "10%", tp: "−9%", sl: "+4%", pnl: 5.2, spark: walk(64, 30, 0.5, 0.5) },
      { id: "x1", kind: "exit", title: "Close all positions", detail: "when funding normalises" },
    ],
    edges: [["s1", "t1"], ["s2", "t1"], ["s3", "t1"], ["s1", "t2"], ["t1", "a1"], ["t2", "x1"]],
  },
  {
    id: "print-run",
    title: "Print Run",
    category: "Earnings",
    thesis: "TSLA into earnings: ride the pre-print drift when implied vol is rich, flat 30 minutes after the call. Never hold through a miss.",
    author: "@iv_crush_ivy",
    venues: ["Hyperliquid"],
    mode: "Paper",
    stats: { ret30d: 5.3, winRate: 55, maxDD: -3.1, forks: 196, followers: 940, daysLive: 19 },
    nodes: [
      { id: "s1", kind: "signal", type: "calendar", title: "TSLA earnings", source: "Calendar", value: "Oct 21 · AMC", delta: "T−2 days", deltaDir: "up" },
      { id: "s2", kind: "signal", type: "model", title: "Implied move", source: "Options feed", value: "±8.4%", delta: "IV rank 74", deltaDir: "up", spark: walk(71, 28, 0.5, 0.3) },
      { id: "s3", kind: "signal", type: "price", title: "TSLA-PERP", source: "HIP-3", value: "$262.15", delta: "+1.2% 1d", deltaDir: "up", spark: walk(72, 28, 0.3, 0.5) },
      { id: "t1", kind: "trigger", logic: "AND", conditions: ["T−2 ≤ date ≤ T−0", "IV rank > 70"], met: true },
      { id: "t2", kind: "trigger", logic: "IF", conditions: ["Print + 30 min"], met: false },
      { id: "a1", kind: "action", side: "long", asset: "TSLA", lev: "2×", venue: "Hyperliquid", alloc: "6%", tp: "+7%", sl: "−3.5%", pnl: 2.1, spark: walk(73, 30, 0.4, 0.5) },
      { id: "x1", kind: "exit", title: "Close all positions", detail: "30 min after the call" },
    ],
    edges: [["s1", "t1"], ["s2", "t1"], ["s3", "t1"], ["s1", "t2"], ["t1", "a1"], ["t2", "x1"]],
  },
  {
    id: "floor-vote",
    title: "Floor Vote",
    category: "Politics",
    thesis: "If the market-structure bill’s odds clear 60% and the whip count holds, the exchanges re-rate. Long COIN and HOOD.",
    author: "@capitol_flow",
    venues: ["Hyperliquid", "Jupiter"],
    mode: "Paper",
    stats: { ret30d: 9.7, winRate: 60, maxDD: -5.5, forks: 159, followers: 812, daysLive: 34 },
    nodes: [
      { id: "s1", kind: "signal", type: "odds", title: "Bill passes Senate", source: "Prediction mkt", value: "YES 57¢", delta: "+6¢ 48h", deltaDir: "up", spark: walk(81, 28, 0.4, 0.5) },
      { id: "s2", kind: "signal", type: "news", title: "Whip count", source: "Hill trackers", value: "58 / 60 yes", delta: "+3 this week", deltaDir: "up" },
      { id: "s3", kind: "signal", type: "price", title: "COIN-PERP", source: "HIP-3", value: "$318.40", delta: "+3.4% 1d", deltaDir: "up", spark: walk(83, 28, 0.4, 0.6) },
      { id: "t1", kind: "trigger", logic: "AND", conditions: ["Odds > 60%", "Whip count ≥ 60"], met: true },
      { id: "t2", kind: "trigger", logic: "IF", conditions: ["Odds < 35%"], met: false },
      { id: "a1", kind: "action", side: "long", asset: "COIN", lev: "2×", venue: "Hyperliquid", alloc: "8%", tp: "+15%", sl: "−6%", pnl: 4.9, spark: walk(84, 30, 0.5, 0.6) },
      { id: "a2", kind: "action", side: "long", asset: "HOOD", lev: "2×", venue: "Hyperliquid", alloc: "6%", tp: "+15%", sl: "−6%", pnl: 6.6, spark: walk(85, 30, 0.5, 0.6) },
      { id: "x1", kind: "exit", title: "Close all positions", detail: "if odds fall under 35%" },
    ],
    edges: [["s1", "t1"], ["s2", "t1"], ["s3", "t1"], ["s1", "t2"], ["t1", "a1"], ["t1", "a2"], ["t2", "x1"]],
  },
  {
    id: "edge-finder",
    title: "Edge Finder",
    category: "Mispricing",
    thesis: "Run a forecast ensemble against live prediction markets. When the model and the market disagree by 12+ points, buy the side the market misprices.",
    author: "@calibrated_cal",
    venues: ["Jupiter", "Hyperliquid"],
    mode: "Live",
    stats: { ret30d: 21.8, winRate: 71, maxDD: -4.9, forks: 688, followers: 4420, daysLive: 112 },
    nodes: [
      { id: "s1", kind: "signal", type: "model", title: "Ensemble forecast", source: "12 models", value: "P(YES) 71%", delta: "σ 4.1pp", deltaDir: "up", spark: walk(91, 28, 0.2, 0.3) },
      { id: "s2", kind: "signal", type: "odds", title: "Market odds", source: "Jupiter · HIP-4", value: "YES 52¢", delta: "−3¢ 24h", deltaDir: "down", spark: walk(92, 28, -0.2, 0.4) },
      { id: "s3", kind: "signal", type: "price", title: "Book depth", source: "Order books", value: "$1.9M", delta: "±2% band", deltaDir: "up" },
      { id: "t1", kind: "trigger", logic: "AND", conditions: ["Model − Mkt ≥ 12pp", "Depth > $250k"], met: true },
      { id: "t2", kind: "trigger", logic: "AND", conditions: ["Mkt − Model ≥ 12pp", "Depth > $250k"], met: false },
      { id: "a1", kind: "action", side: "buy", asset: "YES", venue: "Jupiter", alloc: "8%", tp: "Δ < 3pp", sl: "−25%", pnl: 12.4, spark: walk(93, 30, 0.6, 0.4) },
      { id: "a2", kind: "action", side: "buy", asset: "NO", venue: "Hyperliquid", alloc: "8%", tp: "Δ < 3pp", sl: "−25%", pnl: 0, spark: walk(94, 30, 0.3, 0.4) },
    ],
    edges: [["s1", "t1"], ["s2", "t1"], ["s3", "t1"], ["s1", "t2"], ["s2", "t2"], ["s3", "t2"], ["t1", "a1"], ["t2", "a2"]],
  },
];

/* ------------------------------------------------------------------ */
/* Hero sequence                                                       */
/* ------------------------------------------------------------------ */

export const heroResearch = [
  { label: "NOAA CPC · ENSO diagnostic", detail: "Niño 3.4 at +1.7°C, 4 weeks rising" },
  { label: "Prediction markets", detail: "“El Niño by winter” trades 61¢" },
  { label: "HIP-3 commodity perps", detail: "WHEAT, SUGAR, BRAZIL-50 liquid" },
  { label: "1,240 posts · 38 ag desks", detail: "Sentiment skewing bullish grains" },
  { label: "Backtest · 6 El Niño years", detail: "Wheat +11.8% median, 90d" },
];

export const thesisExamples = [
  "El Niño is coming — what's the trade?",
  "The Fed cuts in December and nobody's positioned for it.",
  "If @fab_insider says the license is approved, go long NVDA.",
  "SOL longs are way too crowded. Fade them.",
  "Hurricane season is underpriced in the prediction markets.",
];

/* ------------------------------------------------------------------ */
/* Ticker tape                                                          */
/* ------------------------------------------------------------------ */

export const tape = [
  { sym: "BTC-PERP", px: 118420.5, ch: 1.84 },
  { sym: "ETH-PERP", px: 4612.18, ch: 2.41 },
  { sym: "SOL-PERP", px: 241.37, ch: -1.12 },
  { sym: "HYPE-PERP", px: 58.94, ch: 4.63 },
  { sym: "GOLD", px: 3912.4, ch: 0.38 },
  { sym: "WHEAT", px: 5.842, ch: 2.12 },
  { sym: "SUGAR", px: 0.2214, ch: 1.27 },
  { sym: "NVDA", px: 184.2, ch: 0.62 },
  { sym: "TSLA", px: 262.15, ch: -0.84 },
  { sym: "WTI", px: 71.36, ch: -0.41 },
  { sym: "“Fed cuts Dec”", px: 0.68, ch: 9.1, odds: true },
  { sym: "“El Niño by winter”", px: 0.61, ch: 3.4, odds: true },
  { sym: "JUP", px: 1.214, ch: 3.02 },
  { sym: "COIN", px: 318.4, ch: 3.41 },
];

/* ------------------------------------------------------------------ */
/* Signal widgets                                                       */
/* ------------------------------------------------------------------ */

export const predictionMarket = {
  question: "Fed cuts rates in December?",
  venue: "Jupiter · Prediction",
  yes: 0.64,
  model: 0.78,
  volume: "$14.2M",
  closes: "Dec 10",
};

export const perpMarkets = [
  { sym: "NVDA", name: "NVIDIA", px: 184.2, ch: 0.62, kind: "Stock perp", seed: 101 },
  { sym: "GOLD", name: "Gold", px: 3912.4, ch: 0.38, kind: "Commodity", seed: 102 },
  { sym: "WHEAT", name: "Wheat", px: 5.842, ch: 2.12, kind: "Commodity", seed: 103 },
  { sym: "TSLA", name: "Tesla", px: 262.15, ch: -0.84, kind: "Stock perp", seed: 104 },
  { sym: "WTI", name: "Crude oil", px: 71.36, ch: -0.41, kind: "Commodity", seed: 105 },
];

export const socialPosts = [
  { handle: "@fab_insider", name: "Fab Insider", text: "Hearing the export license is approved. Paperwork landed this morning.", match: "license approved", score: 0.93, ago: "12s" },
  { handle: "@monsoon_maria", name: "Maria · Monsoon", text: "Niño 3.4 just printed +1.7. This is not a drill for grain markets.", match: "Niño 3.4", score: 0.88, ago: "41s" },
  { handle: "@contrarian_kai", name: "Kai", text: "SOL funding at 0.12% every 8h. Everyone is on the same side of the boat.", match: "funding", score: 0.81, ago: "1m" },
  { handle: "@basis_point_bea", name: "Bea", text: "2Y down 14bp in five sessions. December is back on the table.", match: "December", score: 0.86, ago: "2m" },
  { handle: "@capitol_flow", name: "Capitol Flow", text: "Whip count at 58. Two undecideds leaning yes after this afternoon.", match: "whip count", score: 0.79, ago: "3m" },
];

export const newsWire = [
  { src: "Wire", text: "NOAA raises El Niño probability to 84% for Dec–Feb", rel: 0.94, ago: "2m" },
  { src: "Wire", text: "Australian bureau trims wheat crop estimate by 6%", rel: 0.9, ago: "7m" },
  { src: "Wire", text: "Fed’s Waller: ‘room to ease further’ if inflation cools", rel: 0.83, ago: "11m" },
  { src: "Wire", text: "SOL perp open interest hits 30-day high above $1.9B", rel: 0.78, ago: "18m" },
  { src: "Wire", text: "Senate whip count on market-structure bill reaches 58", rel: 0.74, ago: "26m" },
  { src: "Wire", text: "Brazil real slides past 5.55 per dollar on fiscal worries", rel: 0.69, ago: "31m" },
];

export const fundingAssets = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "SUI", "WIF"];
/** funding in % per 8h, assets × 12 epochs */
export const fundingGrid: number[][] = fundingAssets.map((_, i) =>
  Array.from({ length: 12 }, (_, j) => {
    const base = [0.012, 0.018, 0.09, 0.034, -0.02, 0.006, -0.055][i];
    const wave = Math.sin((j + i * 1.7) * 0.7) * 0.025;
    return +(base + wave + (i === 2 && j > 8 ? 0.04 : 0)).toFixed(3);
  })
);

export const portfolio = {
  equity: 48216.4,
  pnl24h: 1284.12,
  pnlPct: 2.73,
  allocation: [
    { label: "Perps", value: 46, color: "var(--signal)" },
    { label: "Prediction", value: 22, color: "var(--trigger)" },
    { label: "Spot", value: 18, color: "var(--long)" },
    { label: "Cash", value: 14, color: "var(--faint)" },
  ],
};

/* ------------------------------------------------------------------ */
/* Leaderboard                                                          */
/* ------------------------------------------------------------------ */

export interface LeaderRow {
  id: string;
  name: string;
  author: string;
  category: string;
  r7: number;
  r30: number;
  rAll: number;
  winRate: number;
  maxDD: number;
  forks: number;
  mode: "Live" | "Paper";
  seed: number;
}

export const leaderboard: LeaderRow[] = [
  { id: "edge-finder", name: "Edge Finder", author: "@calibrated_cal", category: "Mispricing", r7: 4.1, r30: 21.8, rAll: 88.2, winRate: 71, maxDD: -4.9, forks: 688, mode: "Live", seed: 201 },
  { id: "el-nino-harvest", name: "El Niño Harvest", author: "@monsoon_maria", category: "Weather", r7: 6.8, r30: 18.4, rAll: 31.5, winRate: 67, maxDD: -5.8, forks: 412, mode: "Paper", seed: 202 },
  { id: "crowded-fade", name: "Crowded Fade", author: "@contrarian_kai", category: "Funding", r7: -1.2, r30: 14.6, rAll: 64.0, winRate: 64, maxDD: -6.4, forks: 371, mode: "Live", seed: 203 },
  { id: "fed-pivot", name: "Fed Pivot Spread", author: "@basis_point_bea", category: "Macro", r7: 2.9, r30: 11.2, rAll: 42.7, winRate: 61, maxDD: -7.1, forks: 288, mode: "Live", seed: 204 },
  { id: "floor-vote", name: "Floor Vote", author: "@capitol_flow", category: "Politics", r7: 3.3, r30: 9.7, rAll: 12.9, winRate: 60, maxDD: -5.5, forks: 159, mode: "Paper", seed: 205 },
  { id: "post-and-pounce", name: "Post & Pounce", author: "@tape_reader", category: "Social", r7: 5.5, r30: 7.9, rAll: 22.4, winRate: 58, maxDD: -4.2, forks: 534, mode: "Live", seed: 206 },
  { id: "hurricane-alpha", name: "Landfall Odds", author: "@isobar_ines", category: "Weather", r7: 7.4, r30: 6.6, rAll: 19.1, winRate: 63, maxDD: -8.0, forks: 97, mode: "Paper", seed: 207 },
  { id: "print-run", name: "Print Run", author: "@iv_crush_ivy", category: "Earnings", r7: 1.1, r30: 5.3, rAll: 27.3, winRate: 55, maxDD: -3.1, forks: 196, mode: "Paper", seed: 208 },
  { id: "basis-hunter", name: "Basis Hunter", author: "@carry_on_cora", category: "Funding", r7: 0.8, r30: 4.4, rAll: 36.8, winRate: 79, maxDD: -1.9, forks: 241, mode: "Live", seed: 209 },
  { id: "derby-day", name: "Derby Day", author: "@longshot_leo", category: "Sports", r7: -2.6, r30: 3.1, rAll: 9.4, winRate: 52, maxDD: -9.6, forks: 64, mode: "Paper", seed: 210 },
];

/* ------------------------------------------------------------------ */
/* Token                                                                */
/* ------------------------------------------------------------------ */

export const tokenStats = {
  boughtBackTokens: 18_442_915,
  boughtBackUsd: 1_284_330,
  /** tokens bought back per second for the live counter */
  tokensPerSec: 2.8,
  usdPerSec: 0.195,
  supplyPct: 1.84,
  fees24h: 41_208,
  volume24h: 82_416_000,
  buybacks7d: 271_904,
};

export const buybackLedger = [
  { t: "00:42", tokens: 41_220, usd: 2_871.4, tx: "5xKq…9fQe" },
  { t: "00:36", tokens: 38_904, usd: 2_709.1, tx: "3hTn…Lk2a" },
  { t: "00:30", tokens: 44_610, usd: 3_106.8, tx: "2wPd…r8Vm" },
  { t: "00:24", tokens: 36_118, usd: 2_515.2, tx: "4qZa…Xc7n" },
  { t: "00:18", tokens: 40_027, usd: 2_787.6, tx: "Gm9e…tB3s" },
  { t: "00:12", tokens: 39_451, usd: 2_747.3, tx: "7Ryk…uP1d" },
  { t: "00:06", tokens: 42_883, usd: 2_986.0, tx: "9cVw…hN4j" },
];

/* ------------------------------------------------------------------ */
/* Comparison + FAQ                                                     */
/* ------------------------------------------------------------------ */

export const comparison: { label: string; us: string; them: string }[] = [
  { label: "Who holds your funds", us: "You do. Your wallet, your venues.", them: "Usually the app, or its broker." },
  { label: "What the agent can do", us: "Trade only. The key can’t withdraw.", them: "Whatever the custody terms allow." },
  { label: "Strategy logic", us: "A public graph you can read node by node.", them: "A black box." },
  { label: "Track record", us: "On-chain fills, verifiable by anyone.", them: "Screenshots and marketing." },
  { label: "Fork a strategy", us: "One click, then make it yours.", them: "Not possible." },
  { label: "Where fees go", us: "Builder fees buy back the token, publicly.", them: "To the company and its investors." },
  { label: "Default mode", us: "Paper trading, with approval before going live.", them: "Varies." },
];

export const faqs = [
  {
    q: "Is it really non-custodial?",
    a: "Yes. Funds stay in your own accounts on Hyperliquid and Solana. You authorise a scoped trading key (an API/agent wallet) that can place and cancel orders but has no permission to withdraw or transfer. Revoke it any time.",
  },
  {
    q: "What venues does it trade on?",
    a: "Hyperliquid for perps, HIP-3 stock and commodity perps, and HIP-4 prediction markets; Jupiter on Solana for swaps and prediction markets. More venues will follow when they support scoped, withdraw-proof keys.",
  },
  {
    q: "How does the AI turn a thesis into a strategy?",
    a: "It researches the thesis across forecasts, market odds, prices, news and social feeds, then proposes a graph: signals feed triggers (with AND/OR logic and thresholds), and triggers fire actions with sizing, take-profit and stop-loss. You can edit every node before anything goes live.",
  },
  {
    q: "What stops it from blowing up my account?",
    a: "Paper trading is the default. Going live needs your explicit approval. Every action needs a stop. You set per-trade and total caps, and a kill switch closes everything at once.",
  },
  {
    q: "Why are strategies public?",
    a: "Because a strategy you can read is one you can trust, improve, or fork. The logic is public; your wallet and position sizes stay yours.",
  },
  {
    q: "What does the token do?",
    a: "The platform earns a small builder fee on executed trades. Those fees are used to buy back the token on the open market, and every buyback is published on-chain.",
  },
  {
    q: "Is this financial advice?",
    a: "No. The agent executes the strategy you approve. Markets are risky, leverage amplifies losses, and past performance (paper or live) doesn’t predict future results.",
  },
];
