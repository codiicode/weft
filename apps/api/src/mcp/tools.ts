import { z } from "zod";
import type { Strategy } from "@weft/strategy";
import { ToolError, type Tool } from "./server.ts";

/** What the tools can reach: given per request, with the caller (if any) already resolved. */
export interface McpCtx {
  userId: string | null;
  site: string;
  searchMarkets: (product: string, query: string, limit: number) => Promise<{ label: string; name?: string; price?: number | null; change24hPct?: number | null; volume24hUsd?: number | null; liquidityUsd?: number | null; meta?: unknown }[]>;
  /** Draft from an idea (counts against the caller's daily AI drafts). */
  draft: (idea: string) => Promise<{ id: string; strategy: Strategy; rationale: string; warnings: string[]; ai: boolean }>;
  /** Plain-language rules of a strategy, one line each. */
  rules: (s: Strategy) => string[];
  topTraders: () => Promise<{ address: string; pnl30dUsd?: number; roi30dPct?: number; accountValueUsd?: number }[]>;
  runs: (userId: string) => Promise<RunView[]>;
  run: (userId: string, id: string) => Promise<(RunView & { positions: unknown[]; recentTrades: unknown[] }) | null>;
}

export interface RunView {
  id: string;
  name: string;
  mode: "live" | "practice" | "alerts";
  status: string;
  returnPct: number;
  openPositions: number;
  startedAt: string;
  url: string;
}

const PRODUCTS = ["perps", "stocks", "predictions", "tokens", "options", "pools", "papertrade"] as const;
const fmt = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d }));
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

const needUser = (ctx: McpCtx): string => {
  if (!ctx.userId) throw new ToolError(`This needs your Weft account. Create a key at ${ctx.site}/settings (AI assistants) and add it to this connection as "Authorization: Bearer <key>".`);
  return ctx.userId;
};

export const TOOLS: Tool<McpCtx>[] = [
  {
    name: "search_markets",
    title: "Search markets",
    description:
      "Find markets Weft can watch and trade: Hyperliquid perps (crypto, plus stocks and commodities), Solana tokens, prediction markets, options, Meteora liquidity pools and Papertrade (BTC and ETH up to 1000×). Returns live prices and 24 h numbers.",
    input: z.object({
      query: z.string().max(80).default("").describe("A symbol, name or pair, e.g. \"SOL\", \"NVDA\", \"SOL-USDC\", \"Fed cut\". Empty for the most active."),
      product: z.enum(PRODUCTS).default("perps").describe("Which kind of market"),
      limit: z.number().int().min(1).max(15).default(8),
    }),
    readOnly: true,
    async call(a: { query: string; product: string; limit: number }, ctx) {
      const rows = await ctx.searchMarkets(a.product, a.query, a.limit);
      if (!rows.length) return { text: `No ${a.product} found for “${a.query}”.`, data: { markets: [] } };
      const text = rows.map((r) => `${r.label}${r.name && r.name !== r.label ? ` (${r.name})` : ""}${r.price != null ? ` · ${fmt(r.price, 6)}` : ""}${r.liquidityUsd != null ? ` · $${fmt(r.liquidityUsd, 0)} liquidity` : ""}${r.change24hPct != null ? ` (${pct(r.change24hPct)} 24h)` : ""}${r.volume24hUsd != null ? ` · $${fmt(r.volume24hUsd, 0)} volume` : ""}`).join("\n");
      return { text, data: { markets: rows } };
    },
  },
  {
    name: "draft_strategy",
    title: "Draft a trading strategy",
    description:
      "Turn a trade idea in plain words into a Weft strategy: what it watches, when it acts, what it trades, how much and when it gets out. Examples: \"Long SOL 10x if it breaks $110, stop at -15%\", \"LP SOL-USDC, tight range, out if it leaves for an hour\", \"Copy the top Hyperliquid trader, only BTC, $100 per trade\". Nothing runs: it returns the plan and a link where the user reads it and chooses to practise with pretend money, get alerts, or run it for real.",
    input: z.object({ idea: z.string().min(3).max(2000).describe("The trade idea, in the user's own words") }),
    readOnly: true,
    async call(a: { idea: string }, ctx) {
      const d = await ctx.draft(a.idea);
      const link = `${ctx.site}/d/${d.id}`;
      const rules = ctx.rules(d.strategy);
      const text = [
        `${d.strategy.name}`,
        d.rationale ? `\n${d.rationale}` : "",
        rules.length ? `\nRules:\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
        d.warnings.length ? `\nWarnings:\n${d.warnings.map((w) => `- ${w}`).join("\n")}` : "",
        d.ai ? "" : "\n(Drafted from a template: Weft’s AI was unavailable, so read the rules carefully.)",
        `\nOpen it in Weft to read it and start it (practice, alerts or real money): ${link}`,
        "Nothing has been started.",
      ].join("\n");
      return { text, data: { id: d.id, url: link, name: d.strategy.name, rationale: d.rationale, rules, warnings: d.warnings, strategy: d.strategy } };
    },
  },
  {
    name: "top_traders",
    title: "Top Hyperliquid traders",
    description: "The most profitable Hyperliquid accounts over the last 30 days, to look at or copy (copying is a strategy: use draft_strategy with \"copy <address> …\").",
    input: z.object({ limit: z.number().int().min(1).max(25).default(10) }),
    readOnly: true,
    async call(a: { limit: number }, ctx) {
      const list = (await ctx.topTraders()).slice(0, a.limit);
      if (!list.length) return { text: "No trader data right now.", data: { traders: [] } };
      return {
        text: list.map((t, i) => `${i + 1}. ${t.address}${t.roi30dPct != null ? ` · ${pct(t.roi30dPct)} 30d` : ""}${t.pnl30dUsd != null ? ` · $${fmt(t.pnl30dUsd, 0)} profit` : ""}`).join("\n"),
        data: { traders: list },
      };
    },
  },
  {
    name: "list_my_runs",
    title: "My running strategies",
    description: "The user's strategies on Weft (live, practice and alerts-only): status and return in percent. Needs the user's Weft key.",
    input: z.object({}),
    readOnly: true,
    async call(_a: Record<string, never>, ctx) {
      const runs = await ctx.runs(needUser(ctx));
      if (!runs.length) return { text: `No runs yet. Draft one with draft_strategy, or start at ${ctx.site}/new.`, data: { runs: [] } };
      return { text: runs.map((r) => `${r.name} · ${r.mode} · ${r.status} · ${pct(r.returnPct)} · ${r.openPositions} open · ${r.url}`).join("\n"), data: { runs } };
    },
  },
  {
    name: "get_my_run",
    title: "One of my runs",
    description: "Details of one of the user's runs: status, return, open positions and recent trades. Needs the user's Weft key.",
    input: z.object({ run_id: z.string().min(1).max(80).describe("The run's id, from list_my_runs") }),
    readOnly: true,
    async call(a: { run_id: string }, ctx) {
      const r = await ctx.run(needUser(ctx), a.run_id);
      if (!r) throw new ToolError("No run with that id on this account.");
      return { text: `${r.name} · ${r.mode} · ${r.status} · ${pct(r.returnPct)}\nOpen positions: ${r.openPositions}\n${r.url}`, data: r };
    },
  },
];

export const INSTRUCTIONS =
  "Weft is an AI trading agent: people describe a trade idea in words and Weft runs it as rules, from their own wallet (Hyperliquid perps, Solana tokens, Meteora liquidity pools, prediction markets). " +
  "Use search_markets to check what exists and its price, draft_strategy to turn an idea into a plan, and list_my_runs / get_my_run to see the user's runs. " +
  "Nothing trades from this connection: a draft opens in Weft, where the user reads it and chooses practice (pretend money), alerts, or real money. Always give the user the link. Returns are percent; never promise profits.";
