import { z } from "zod";
import { Instrument, OutcomeInstrument, PerpInstrument, SolanaMint } from "./instruments.ts";

/**
 * Signals: data the strategy watches. Each signal kind declares its params and
 * the typed fields it produces. Triggers reference fields as `signalId.field`.
 *
 * Signals describe *what* to observe, never *where to fetch it*. Providers
 * (Hyperliquid WS, Helius, Birdeye, X…) are a runtime concern, so a strategy
 * stays portable and forkable.
 */

export type FieldType = "number" | "boolean";

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "ids are lowercase snake_case, start with a letter, max 40 chars");

const Handle = z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/, "must be an X handle");

/** Registry: params schema + output fields + description (the description is shown to the LLM). */
export const SIGNAL_KINDS = {
  price: {
    description: "Last price and recent changes for any instrument.",
    params: z.object({ instrument: Instrument }),
    fields: {
      price: "number",
      change_5m_pct: "number",
      change_1h_pct: "number",
      change_24h_pct: "number",
      volume_24h_usd: "number",
    },
  },
  funding: {
    description: "Perp funding and open interest on Hyperliquid, plus the same coin's funding on Binance and Bybit (core perps only) and Hyperliquid's gap to the higher of them.",
    params: z.object({ instrument: PerpInstrument }),
    fields: {
      rate_1h_pct: "number",
      rate_8h_pct: "number",
      apr_pct: "number",
      open_interest_usd: "number",
      oi_zscore_30d: "number",
      binance_rate_1h_pct: "number",
      bybit_rate_1h_pct: "number",
      funding_gap_1h_pct: "number",
    },
  },
  liquidity: {
    description: "Order book depth / pool liquidity and expected price impact.",
    params: z.object({ instrument: Instrument }),
    fields: {
      depth_2pct_usd: "number",
      spread_bps: "number",
      price_impact_bps_1k: "number",
    },
  },
  odds: {
    description: "Prediction market probability for one outcome (0–1).",
    params: z.object({ instrument: OutcomeInstrument }),
    fields: {
      prob: "number",
      change_24h_pp: "number",
      volume_24h_usd: "number",
    },
  },
  token_onchain: {
    description: "On-chain health and flow for a Solana token: liquidity, holders, authorities, dev and smart-money activity.",
    params: z.object({ mint: SolanaMint }),
    fields: {
      market_cap_usd: "number",
      liquidity_usd: "number",
      holders: "number",
      holders_change_1h_pct: "number",
      buy_sell_ratio_1h: "number",
      top10_holders_pct: "number",
      age_minutes: "number",
      bonding_curve_pct: "number",
      migrated: "boolean",
      mint_authority_revoked: "boolean",
      freeze_authority_revoked: "boolean",
      lp_locked: "boolean",
      dev_sold_pct: "number",
      smart_wallet_buys_1h: "number",
    },
  },
  social: {
    description: "Social volume and sentiment for cashtags, keywords or accounts. Sentiment is −1 (bearish) to 1 (bullish).",
    params: z
      .object({
        platform: z.enum(["x"]).default("x"),
        cashtags: z.array(z.string().min(1)).default([]),
        keywords: z.array(z.string().min(1)).default([]),
        accounts: z.array(Handle).default([]),
      })
      .refine((p) => p.cashtags.length + p.keywords.length + p.accounts.length > 0, {
        message: "social needs at least one cashtag, keyword or account",
      }),
    fields: {
      mentions_1h: "number",
      mentions_change_1h_pct: "number",
      unique_authors_1h: "number",
      sentiment: "number",
    },
  },
  post_match: {
    description: "Watches specific accounts for a post that semantically matches a claim (and optionally one that contradicts it).",
    params: z.object({
      accounts: z.array(Handle).min(1),
      claim: z.string().min(3).describe("What the post must say, matched semantically"),
      contradiction: z.string().min(3).optional(),
    }),
    fields: {
      matched: "boolean",
      match_score: "number",
      contradicted: "boolean",
      minutes_since_match: "number",
    },
  },
  news: {
    description: "News flow for a query: volume, sentiment and the most relevant headline score.",
    params: z.object({ query: z.string().min(2) }),
    fields: {
      articles_1h: "number",
      sentiment: "number",
      max_relevance: "number",
    },
  },
  forecast: {
    description: "An external forecast or measured series (weather, climate, economics), e.g. NOAA Niño 3.4 anomaly.",
    params: z.object({ source: z.string().min(1), series: z.string().min(1) }),
    fields: {
      value: "number",
      change_7d: "number",
    },
  },
  model: {
    description: "Weft's own model/ensemble probability for a question, to compare with market odds.",
    params: z.object({ question: z.string().min(5), instrument: OutcomeInstrument.optional() }),
    fields: {
      prob: "number",
      confidence: "number",
    },
  },
  calendar: {
    description: "Time to/since a scheduled event (earnings, FOMC, CPI…).",
    params: z.object({
      event: z.enum(["earnings", "fomc", "cpi", "custom"]),
      symbol: z.string().optional(),
      at: z.iso.datetime().optional().describe("Required for custom events"),
    }),
    fields: {
      hours_until: "number",
      hours_since: "number",
    },
  },
  macro: {
    description: "A macro or market-wide series: rates, FX, stock indices, the economy, and crypto-wide data (Fear & Greed, dominance, total market cap, stablecoin supply, TVL, protocol fees). Daily or slower; changes are per observation.",
    params: z.object({ series: z.string().min(1) }),
    fields: {
      value: "number",
      change_1d: "number",
      change_5d: "number",
    },
  },
  wallet: {
    description:
      "A Solana wallet's trading, for following smart money, insiders or a dev wallet: its buys and sells in the last hour (of one token, or of any token when mint is omitted), SOL spent and received, minutes since its last buy or sell, and how much of the token it still holds.",
    params: z.object({ address: SolanaMint.describe("The wallet to watch"), mint: SolanaMint.optional().describe("Only count trades of this token") }),
    fields: {
      buys_1h: "number",
      sells_1h: "number",
      sol_spent_1h: "number",
      sol_received_1h: "number",
      minutes_since_buy: "number",
      minutes_since_sell: "number",
      token_balance: "number",
    },
  },
  trader: {
    description:
      "Another Hyperliquid account's position in one coin (a known trader or a vault), for following them: side (1 long, −1 short, 0 flat), size, leverage, entry, profit, and minutes since it last opened, closed or flipped.",
    params: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a Hyperliquid address (0x…)"), coin: z.string().min(1).describe("Perp symbol, e.g. BTC") }),
    fields: {
      side: "number",
      size_usd: "number",
      leverage: "number",
      entry_price: "number",
      unrealized_pnl_pct: "number",
      minutes_since_change: "number",
      account_value_usd: "number",
    },
  },
  sports: {
    description:
      "A team's regular-season record in a league (ESPN standings): wins, losses, ties or draws, games played, win rate, current streak (+3 = won 3 in a row, −2 = lost 2), league points (soccer and hockey) and standing.",
    params: z.object({
      league: z.enum(["nba", "wnba", "nfl", "mlb", "nhl", "mls", "epl", "laliga", "bundesliga", "seriea", "ligue1"]),
      team: z.string().min(2).describe('Team name, city or abbreviation, e.g. "Spurs", "San Antonio", "SA"'),
    }),
    fields: {
      wins: "number",
      losses: "number",
      ties: "number",
      games_played: "number",
      win_pct: "number",
      streak: "number",
      points: "number",
      rank: "number",
    },
  },
  position: {
    description: "This strategy's own position, for exits like 'close if down 8%'. Omit instrument for the whole strategy.",
    params: z.object({ instrument: Instrument.optional() }),
    fields: {
      open: "boolean",
      size_usd: "number",
      pnl_pct: "number",
      pnl_usd: "number",
      hours_open: "number",
    },
  },
} as const satisfies Record<
  string,
  { description: string; params: z.ZodType; fields: Record<string, FieldType> }
>;

export type SignalKind = keyof typeof SIGNAL_KINDS;
export const SIGNAL_KIND_NAMES = Object.keys(SIGNAL_KINDS) as SignalKind[];

const base = {
  id: Id,
  label: z.string().max(60).optional(),
  maxAgeSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Values older than this count as unknown; defaults per kind"),
};

export const Signal = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("price"), params: SIGNAL_KINDS.price.params }),
  z.object({ ...base, kind: z.literal("funding"), params: SIGNAL_KINDS.funding.params }),
  z.object({ ...base, kind: z.literal("liquidity"), params: SIGNAL_KINDS.liquidity.params }),
  z.object({ ...base, kind: z.literal("odds"), params: SIGNAL_KINDS.odds.params }),
  z.object({ ...base, kind: z.literal("token_onchain"), params: SIGNAL_KINDS.token_onchain.params }),
  z.object({ ...base, kind: z.literal("social"), params: SIGNAL_KINDS.social.params }),
  z.object({ ...base, kind: z.literal("post_match"), params: SIGNAL_KINDS.post_match.params }),
  z.object({ ...base, kind: z.literal("news"), params: SIGNAL_KINDS.news.params }),
  z.object({ ...base, kind: z.literal("forecast"), params: SIGNAL_KINDS.forecast.params }),
  z.object({ ...base, kind: z.literal("model"), params: SIGNAL_KINDS.model.params }),
  z.object({ ...base, kind: z.literal("calendar"), params: SIGNAL_KINDS.calendar.params }),
  z.object({ ...base, kind: z.literal("macro"), params: SIGNAL_KINDS.macro.params }),
  z.object({ ...base, kind: z.literal("wallet"), params: SIGNAL_KINDS.wallet.params }),
  z.object({ ...base, kind: z.literal("trader"), params: SIGNAL_KINDS.trader.params }),
  z.object({ ...base, kind: z.literal("sports"), params: SIGNAL_KINDS.sports.params }),
  z.object({ ...base, kind: z.literal("position"), params: SIGNAL_KINDS.position.params }),
]);
export type Signal = z.infer<typeof Signal>;

/** Default staleness budget per kind, in seconds. */
export const DEFAULT_MAX_AGE: Record<SignalKind, number> = {
  price: 60,
  funding: 900,
  liquidity: 120,
  odds: 300,
  token_onchain: 120,
  social: 900,
  post_match: 120,
  news: 900,
  forecast: 86_400 * 2,
  model: 3_600,
  calendar: 3_600,
  macro: 3_600,
  wallet: 300,
  trader: 120,
  sports: 3_600,
  position: 60,
};

export function fieldType(kind: SignalKind, field: string): FieldType | undefined {
  return (SIGNAL_KINDS[kind].fields as Record<string, FieldType>)[field];
}
