import { Hono } from "hono";
import { resultCard, resultPage, sharePage, strategyCard, tradesOf, type ResultCard } from "./lib/share.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_X_PREFS, type XPrefs } from "./social/xbot.ts";
import type { TopTrader } from "./lib/traders.ts";
import type { HeliusWebhook } from "./live/helius-webhook.ts";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { clampQuery, connectionCap, rateLimit } from "./lib/ratelimit.ts";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { examples } from "@weft/strategy/examples";
import { RiskCaps, pinOfficialTokens, toGraph, validateStrategy, type Instrument, type Strategy } from "@weft/strategy";
import { Instrument as InstrumentSchema } from "@weft/strategy";
import { INTERVAL_MS, type CandleInterval, type Catalog, type MarketData, type Product } from "@weft/venues";
import type { Engine, EngineEvent } from "@weft/engine";
import type { StrategyLibrary } from "./lib/library.ts";
import { generateStrategy, GenerationError } from "./ai/generate.ts";
import { handleRpc } from "./mcp/server.ts";
import { INSTRUCTIONS as MCP_INSTRUCTIONS, TOOLS as MCP_TOOLS, type McpCtx, type RunView } from "./mcp/tools.ts";
import { runBacktest, type BacktestDeps } from "./backtest/run.ts";
import type { Notifier } from "./lib/alerts.ts";
import { AuthError, LOCAL_USER, type AuthUser, type Authenticator } from "./lib/auth.ts";
import type { TelegramBot } from "./lib/telegram.ts";
import type { Accounts } from "./lib/accounts.ts";
import { REWARDS, type Rewards } from "./lib/rewards.ts";
import type { Treasury } from "./token/treasury.ts";
import type { HolderStatus } from "./live/holders.ts";
import { PublicKey } from "@solana/web3.js";
import type { LiveService } from "./live/service.ts";
import { SECOND_INTERVALS, type SecondInterval, type TradeTape } from "./lib/tape.ts";
import { tradesSolana, type SolanaLive } from "./live/solana.ts";
import type { HlDeposits } from "./live/deposits.ts";
import type { SolanaWithdrawals } from "./live/solana-withdraw.ts";
import { parseInstruction, withExits, type Step } from "./lib/instructions.ts";

/** Chart ranges and the bar size each one uses (about 60–370 bars). */
export const CHART_RANGES = ["1H", "1D", "1W", "1M", "1Y"] as const;
const CHART_SPEC: Record<(typeof CHART_RANGES)[number], { interval: CandleInterval; spanMs: number }> = {
  "1H": { interval: "1m", spanMs: 3_600_000 },
  "1D": { interval: "5m", spanMs: 86_400_000 },
  "1W": { interval: "1h", spanMs: 7 * 86_400_000 },
  "1M": { interval: "4h", spanMs: 30 * 86_400_000 },
  "1Y": { interval: "1d", spanMs: 365 * 86_400_000 },
};

/** Bar sizes a chart can ask for. Seconds come from the trade tape. */
export const CHART_INTERVALS = ["5s", "15s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;

export interface AppDeps {
  /** The public website, for share links and previews. Default https://weft.fi */
  siteUrl?: string;
  /** Profitable Hyperliquid traders to copy (public leaderboard, cached). */
  topTraders?: () => Promise<TopTrader[]>;
  /** Papertrade live trading is on (WEFT_PAPERTRADE_LIVE=1, with its executor wired). */
  papertradeLive?: boolean;
  /** Money in and out of the Hyperliquid account from any chain, through Rift. */
  rift?: import("./live/rift.ts").RiftFunding;
  /** Papertrade accounts: session keys, registration, deposit address, status. */
  papertrade?: import("./live/papertrade.ts").PapertradeAccounts;
  /** Helius pushes watched wallets' transactions here (wallet signals and copy trading react at once). */
  heliusWebhook?: HeliusWebhook;
  catalog: Catalog;
  marketData: MarketData;
  engine: Engine;
  library: StrategyLibrary;
  /** "live" | "simulated" per signal kind, from the venues providers. */
  signalModes: Record<string, "live" | "simulated">;
  notifier?: Notifier;
  /** History provider (+ token facts, calendar) for POST /backtest. Absent: 501. */
  backtest?: BacktestDeps;
  /** Privy auth. Absent or disabled: local mode, every request is the "local" user. */
  auth?: Authenticator;
  accounts?: Accounts;
  /** AI generations per user per UTC day when auth is enabled (cost control). */
  aiDailyLimit?: number;
  /** The same for $WEFT holders (default 100). */
  holderAiDailyLimit?: number;
  /** $WEFT holder status (fee discount, reward boost, perks). */
  holders?: { enabled: boolean; status(userId: string): Promise<HolderStatus> };
  /** Daily $WEFT rewards: the fee ledger, closed days and claims. */
  rewards?: Rewards;
  /** Buys, burns and pays out $WEFT. Absent until the token and its key are configured. */
  treasury?: Treasury;
  /** Drafts per day for visitors without an account (per hashed IP), and for all of them together. */
  anonAiDailyLimit?: number;
  anonAiDailyTotal?: number;
  /** Live trading on Hyperliquid. Absent: paper only. */
  live?: LiveService;
  /**
   * Paper (simulated) runs. Off on the hosted service: Weft trades with real money only, and
   * simulated trading is limited to backtests and alerts-only runs. Local development keeps it.
   */
  allowPaper?: boolean;
  /** Practice money per user (pretend dollars on the paper engine, real prices); null or 0: practice is off. */
  practiceBudgetUsd?: number | null;
  /** Live Solana token trading (the user's own Privy wallet, Weft as a limited signer). */
  solana?: SolanaLive;
  /** Weft's owners (see earnings). */
  isAdmin?: (userId: string) => boolean;
  /** What Weft has earned in fees (public on /revenue). */
  earnings?: () => Promise<unknown>;
  /** Withdrawals from users' Weft Solana wallets (signed by the user's own wallet). */
  solanaWithdrawals?: SolanaWithdrawals;
  /** Called after an owner changes a run's exits (venue-side stops re-sync right away). */
  onExitsChanged?: () => void;
  /** Gas-free Hyperliquid deposits: USDC on Arbitrum → permit → Weft's relayer → Hyperliquid bridge. */
  deposits?: HlDeposits;
  /** Records Hyperliquid trades for second-level charts. */
  tape?: TradeTape;
  /** Per-user Telegram alerts (TELEGRAM_BOT_TOKEN). */
  telegram?: TelegramBot;
  /** Web origins allowed by CORS (WEB_ORIGINS). Absent: any origin (local development). */
  webOrigins?: string[];
  /** Ceiling on one user's open live allocation across all runs, USD. */
  liveMaxTotalUsd?: number;
  /**
   * In-process calls as a given user (the X bot starting a run someone tweeted): the request carries
   * this key and the user id. Random per boot, never leaves the process.
   */
  internalKey?: string;
  /** Answer one tweet again by id (internal key only). */
  xbotRetry?: (id: string) => Promise<string>;
  /** The X account Privy says the user linked (id and handle), for Tweet a trade. */
  xAccountOf?: (userId: string) => Promise<{ id: string; username: string } | null>;
}

const PRODUCTS = ["perps", "stocks", "predictions", "tokens", "options"] as const;

/** Plain names for signal kinds in messages. */
const SIGNAL_NAMES: Record<string, string> = { social: "social sentiment", news: "news", post_match: "match results", model: "model forecasts" };

const DeployBody = z.object({
  mode: z.enum(["paper", "live"]).default("paper"),
  /** Live only: the user typed this to confirm real-money trading. */
  confirm: z.string().optional(),
  strategy: z.unknown().optional(),
  strategyId: z.string().optional(),
  allocationUsd: z.number().positive().max(10_000_000).default(10_000),
  caps: RiskCaps.optional(),
  intervalSec: z.number().int().min(5).max(3_600).optional(),
  /** Watch only: every trade becomes an alert. Paper engine; never live. */
  alertsOnly: z.boolean().optional(),
});

const BacktestBody = z.object({
  strategy: z.unknown().optional(),
  strategyId: z.string().optional(),
  days: z.number().int().min(1).max(90).default(30),
  allocationUsd: z.number().positive().max(10_000_000).default(10_000),
  interval: z.enum(["1h", "15m"]).default("1h"),
});

export function createApp(deps: AppDeps) {
  const { catalog, marketData, engine, library, accounts } = deps;
  const authEnabled = !!deps.auth?.enabled;
  const aiDailyLimit = deps.aiDailyLimit ?? 30;
  const holderAiDailyLimit = deps.holderAiDailyLimit ?? 100;
  /** Holders draft more: the AI is one of the things $WEFT pays for. */
  const aiLimitFor = async (userId: string) => (deps.holders?.enabled && (await deps.holders.status(userId).catch(() => null))?.active ? holderAiDailyLimit : aiDailyLimit);
  const allowPaper = deps.allowPaper ?? !authEnabled;
  const practiceBudget = deps.practiceBudgetUsd && deps.practiceBudgetUsd > 0 ? deps.practiceBudgetUsd : null;
  /** At most this many practice runs going at once per person. */
  const PRACTICE_MAX_RUNS = 5;
  const isPractice = (d: { mode: string; alertsOnly?: boolean }) => d.mode === "paper" && !d.alertsOnly;
  /** A user's practice money in use: the budgets of their running or paused practice runs. */
  const practiceUse = async (userId: string) => {
    const mine = accounts ? accounts.deploymentsOf(userId) : new Set<string>();
    let usedUsd = 0, running = 0;
    for (const d of await engine.listDeployments())
      if (isPractice(d) && mine.has(d.id) && (d.status === "running" || d.status === "paused")) (usedUsd += d.allocationUsd), running++;
    return { usedUsd, running };
  };
  const app = new Hono();

  /** The signed-in user, LOCAL_USER in local mode, or null for anonymous requests. */
  const internalKey = deps.internalKey ? Buffer.from(deps.internalKey) : null;

  // Operator tool: what runs with real money right now (no user ids or wallets, a short hash per person).
  app.get("/internal/live-runs", async (c) => {
    const ik = Buffer.from(c.req.header("x-weft-internal") ?? "");
    if (!internalKey || ik.length !== internalKey.length || !timingSafeEqual(ik, internalKey)) return c.json({ error: "not found" }, 404);
    const who = (id: string | null | undefined) => (id ? createHash("sha256").update(id).digest("hex").slice(0, 6) : "?");
    const rows = [];
    for (const d of await engine.listDeployments()) {
      if (d.mode !== "live") continue;
      const snap = await engine.getSnapshot(d.id).catch(() => null);
      const fills = await engine.getFills(d.id).catch(() => []);
      const kinds = [...new Set(d.strategy.actions.flatMap((a) => (a.type === "open" ? [`${a.instrument.kind}:${(a.instrument as { symbol?: string }).symbol ?? ""}`] : a.type === "copy" ? [`copy:${a.leader.venue}`] : a.type === "liquidity" ? ["lp"] : [])))];
      rows.push({
        name: d.strategy.name, status: d.status, person: who(accounts?.deploymentOwner(d.id)), createdAt: d.createdAt, allocationUsd: d.allocationUsd,
        markets: kinds, fills: fills.length, feesUsd: fills.reduce((n, f) => n + (f.feeUsd ?? 0), 0), builderUsd: fills.reduce((n, f) => n + ((f as { builderFeeUsd?: number }).builderFeeUsd ?? 0), 0),
        equityUsd: snap?.equityUsd ?? null, realizedPnlUsd: snap?.realizedPnlUsd ?? null, unrealizedPnlUsd: snap?.unrealizedPnlUsd ?? null, openPositions: snap?.positions.length ?? 0,
        id: d.id,
        // For running ones: what it has been saying lately, and where its triggers stand.
        ...(d.status === "running" && c.req.query("detail")
          ? {
              events: (await engine.getEvents(d.id, { limit: 12 }).catch(() => [])).map((e) => `${new Date(e.ts).toISOString().slice(5, 16)} ${e.type}: ${e.message.slice(0, 220)}`),
              triggers: snap?.triggers?.map((t) => ({ id: t.id, fired: t.fired, held: (t as { held?: string }).held ?? null })) ?? [],
              signals: snap?.signalValues ?? {},
              strategy: c.req.query("detail") === "full" ? d.strategy : undefined,
              papertrade:
                c.req.query("detail") === "full" && deps.papertrade && d.strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "synth")
                  ? await (async () => {
                      const st = (await deps.papertrade!.rawState(accounts?.deploymentOwner(d.id) ?? "")) as Record<string, unknown> | null;
                      return st && { funds: st.funds, balance: st.balance, queued: st.queued, locked: st.locked, openPositions: st.openPositions, operations: Array.isArray(st.operations) ? (st.operations as unknown[]).slice(-12) : st.operations, error: st.error };
                    })()
                  : undefined,
              fillLog: c.req.query("detail") === "full" ? fills.map((f) => `${new Date(f.ts).toISOString().slice(5, 19)} ${f.side} ${f.reason} qty ${f.qty} @ ${f.price} pnl ${(f.realizedPnlUsd ?? 0).toFixed(2)}`) : undefined,
            }
          : {}),
      });
    }
    return c.json({ runs: rows.sort((a, b) => b.createdAt - a.createdAt) });
  });

  // Operator tool: make the X bot answer a tweet whose answer got lost (e.g. cut short by a restart).
  app.post("/internal/xbot/retry", async (c) => {
    const ik = Buffer.from(c.req.header("x-weft-internal") ?? "");
    if (!internalKey || ik.length !== internalKey.length || !timingSafeEqual(ik, internalKey)) return c.json({ error: "not found" }, 404);
    if (!deps.xbotRetry) return c.json({ error: "x bot is off" }, 501);
    const { id } = z.object({ id: z.string().regex(/^\d{5,25}$/) }).parse(await c.req.json());
    return c.json({ id, result: await deps.xbotRetry(id) });
  });
  const optionalUser = async (c: Context): Promise<AuthUser | null> => {
    const ik = c.req.header("x-weft-internal");
    if (internalKey && ik) {
      const got = Buffer.from(ik);
      const as = c.req.header("x-weft-as");
      if (got.length === internalKey.length && timingSafeEqual(got, internalKey) && as) return { id: as };
      throw new HTTPException(401, { message: "bad internal key" });
    }
    if (!authEnabled) return LOCAL_USER;
    const header = c.req.header("authorization");
    // Query-string tokens only for the event stream (EventSource can't send headers); never elsewhere.
    const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.path === "/events/stream" ? c.req.query("token") : undefined;
    if (!token) return null;
    try {
      const user = await deps.auth!.verify(token);
      accounts?.touch(user.id);
      return user;
    } catch (e) {
      if (e instanceof AuthError) throw new HTTPException(401, { message: e.message });
      throw e;
    }
  };
  const requireUser = async (c: Context): Promise<AuthUser> => {
    const u = await optionalUser(c);
    if (!u) throw new HTTPException(401, { message: "sign in required" });
    return u;
  };
  /** Owner check. Unowned records (seeded before auth) are only editable in local mode. */
  const assertOwner = (owner: string | null | undefined, user: AuthUser) => {
    if (!authEnabled) return;
    if (owner !== user.id) throw new HTTPException(403, { message: "not yours" });
  };
  const checkAiQuota = async (user: AuthUser) => {
    if (!authEnabled || !accounts) return;
    const limit = await aiLimitFor(user.id);
    if (accounts.aiUsedToday(user.id) >= limit)
      throw new HTTPException(429, { message: `daily AI limit reached (${limit} strategies per day)${limit === aiDailyLimit && deps.holders?.enabled ? "; $WEFT holders get more" : ""}` });
    accounts.recordAiUse(user.id);
  };

  // Visitors may draft and test before they sign up. They are counted per hashed IP (the address
  // itself is never stored), with a ceiling for all of them together so AI spend stays bounded.
  const anonSalt = (() => {
    const k = "anon-salt";
    const v = accounts?.kvGet(k);
    if (v) return v;
    const s = randomBytes(16).toString("hex");
    accounts?.kvSet(k, s);
    return s;
  })();
  const visitorKey = (c: Context) => {
    const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || c.req.header("x-real-ip") || "unknown";
    return createHash("sha256").update(`${anonSalt}:${ip}`).digest("hex").slice(0, 24);
  };
  /** Signed-in users use their own quota; visitors a smaller one. `kind` keeps AI and backtests apart. */
  const allowVisitor = async (c: Context, kind: "ai" | "backtest") => {
    const user = await optionalUser(c);
    if (user) {
      if (kind === "ai") await checkAiQuota(user);
      return user;
    }
    if (!authEnabled || !accounts) return null;
    const perVisitor = kind === "ai" ? (deps.anonAiDailyLimit ?? 5) : 20;
    const total = kind === "ai" ? (deps.anonAiDailyTotal ?? 400) : 3_000;
    const me = `anon:${kind}:${visitorKey(c)}`;
    const all = `anon:${kind}:*`;
    if (accounts.aiUsedToday(me) >= perVisitor)
      throw new HTTPException(429, {
        message: kind === "ai" ? `You’ve drafted ${perVisitor} strategies today without an account. Sign in, it’s free, to keep going.` : "Sign in to run more tests today.",
      });
    if (accounts.aiUsedToday(all) >= total) throw new HTTPException(429, { message: "Lots of people are drafting right now. Sign in to keep going." });
    accounts.recordAiUse(me);
    accounts.recordAiUse(all);
    return null;
  };

  const origins = deps.webOrigins;
  app.use(
    "*",
    cors({
      origin: (o) => (!origins ? (o ?? "*") : o && origins.includes(o) ? o : origins[0]!),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  app.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));
  app.use("*", rateLimit("general", 300));
  app.use("/quote", rateLimit("quotes", 40));
  app.use("/markets/*", rateLimit("markets", 90));
  app.use("/market", rateLimit("markets", 60));
  app.use("/chart", rateLimit("charts", 60));
  app.use("/backtest", rateLimit("backtests", 6));
  app.use("/ai/*", rateLimit("drafting", 12));
  app.use("/strategies/validate", rateLimit("validation", 30));
  app.use("/events/stream", rateLimit("streams", 20));
  const streams = connectionCap(6);

  /** Live runs are private: only their owner sees positions, fills and events. */
  const canView = async (c: Context, id: string): Promise<boolean> => {
    const snap = await engine.getSnapshot(id);
    if (!snap || !authEnabled || (snap.deployment.mode !== "live" && !isPractice(snap.deployment))) return true;
    const user = await optionalUser(c);
    return !!user && accounts?.deploymentOwner(id) === user.id;
  };
  /** Strategies are shared anonymously: no name, email or wallet is stored or shown with them. */
  const authorFor = (_user: AuthUser, _fallback: unknown) => "";
  const pub = <T extends { author?: string }>(e: T) => {
    const { author: _drop, ...rest } = e;
    return rest;
  };
  // One live deployment at a time per user, so caps and overlap checks can't race.
  const liveLocks = new Map<string, Promise<unknown>>();
  const withLiveLock = <T,>(userId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = liveLocks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    liveLocks.set(userId, run.catch(() => undefined));
    return run;
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    const issues = (err as { issues?: unknown }).issues;
    if (issues) return c.json({ error: err.message, issues }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
  });

  /* ---------------- Share links (link previews) ---------------- */

  // weft.fi/s/<id> and weft.fi/og/strategy/<id>.png are rewritten here by the website.
  const site = (deps.siteUrl ?? "https://weft.fi").replace(/\/$/, "");
  const cards = new Map<string, { at: number; png: Buffer }>();
  app.get("/share/:id", (c) => {
    const e = library.get(c.req.param("id"));
    if (!e) return c.redirect(`${site}/strategies`, 302);
    c.header("cache-control", "public, max-age=300");
    return c.html(sharePage(e.strategy, e.id, site));
  });
  app.get("/og/strategy/:file", async (c) => {
    const id = c.req.param("file").replace(/\.png$/, "");
    const e = library.get(id);
    if (!e) return c.redirect(`${site}/og.png`, 302);
    let hit = cards.get(id);
    if (!hit || hit.at !== e.updatedAt) {
      hit = { at: e.updatedAt, png: await strategyCard(e.strategy) };
      cards.set(id, hit);
      if (cards.size > 500) cards.delete(cards.keys().next().value!);
    }
    return c.body(new Uint8Array(hit.png), 200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
  });

  /* ---------------- Result cards: a run's outcome, shared by its owner ---------------- */

  // weft.fi/r/<id> and weft.fi/og/result/<id>.png are rewritten here by the website.
  const readResult = (id: string): ResultCard | null => {
    if (!/^[a-z0-9]{6,24}$/.test(id)) return null;
    const raw = accounts?.kvGet(`result:${id}`);
    return raw ? (JSON.parse(raw) as ResultCard) : null;
  };
  /** Owner: freeze this run's result (percent only) into a card with its own link. */
  app.post("/deployments/:id/card", async (c) => {
    const user = await requireUser(c);
    const id = c.req.param("id");
    const snap = await engine.getSnapshot(id);
    if (!snap) return c.json({ error: "not found" }, 404);
    assertOwner(accounts?.deploymentOwner(id), user);
    if (!accounts) return c.json({ error: "sharing needs the account store" }, 503);
    const d = snap.deployment;
    if (d.alertsOnly) return c.json({ error: "alerts-only runs don’t trade, so there’s no result to share" }, 400);
    const fills = await engine.getFills(id);
    const pnl = snap.realizedPnlUsd + snap.unrealizedPnlUsd;
    const openMargin = snap.positions.reduce((n, p) => n + p.sizeUsd, 0);
    const invested = snap.investedUsd ?? (openMargin > 0 ? openMargin : null);
    if (!invested || !(invested > 0) || !fills.length) return c.json({ error: "nothing has traded yet" }, 400);
    // The same return the run page shows: profit over what went in. The curve is scaled to match.
    const eq = snap.equityCurve;
    const step = Math.max(1, Math.ceil(eq.length / 60));
    const curve = eq.filter((_, i) => i % step === 0 || i === eq.length - 1).map(([, v]) => ((v - eq[0]![1]) / invested) * 100);
    const card: ResultCard = {
      id: randomBytes(8).toString("hex").replace(/[^a-z0-9]/g, "").slice(0, 12),
      deploymentId: id,
      createdAt: Date.now(),
      practice: d.mode !== "live",
      name: d.strategy.name,
      thesis: d.strategy.thesis,
      markets: tradesOf(d.strategy).length ? tradesOf(d.strategy) : [...new Set(fills.map((f) => f.instrumentKey.split(":").pop()!.slice(0, 12)))].slice(0, 4),
      returnPct: (pnl / invested) * 100,
      curve: [...curve.slice(0, -1), (pnl / invested) * 100],
      since: d.createdAt,
      trades: fills.length,
      strategy: d.strategy,
    };
    accounts.kvSet(`result:${card.id}`, JSON.stringify(card));
    return c.json({ id: card.id, url: `${site}/r/${card.id}`, image: `${site}/og/result/${card.id}.png`, returnPct: card.returnPct, practice: card.practice });
  });
  app.get("/result/:id", (c) => {
    const r = readResult(c.req.param("id"));
    if (!r) return c.redirect(`${site}/strategies`, 302);
    c.header("cache-control", "public, max-age=3600");
    return c.html(resultPage(r, site));
  });
  /** A shared result's strategy, so whoever opens the link can run it themselves. */
  app.get("/results/:id", (c) => {
    const r = readResult(c.req.param("id"));
    return r ? c.json({ id: r.id, name: r.name, practice: r.practice, returnPct: r.returnPct, strategy: r.strategy }) : c.json({ error: "not found" }, 404);
  });
  const resultPngs = new Map<string, Buffer>();
  app.get("/og/result/:file", async (c) => {
    const id = c.req.param("file").replace(/\.png$/, "");
    const r = readResult(id);
    if (!r) return c.redirect(`${site}/og.png`, 302);
    let png = resultPngs.get(id);
    if (!png) {
      png = await resultCard(r);
      resultPngs.set(id, png);
      if (resultPngs.size > 500) resultPngs.delete(resultPngs.keys().next().value!);
    }
    return c.body(new Uint8Array(png), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400, immutable" });
  });

  /* ---------------- Drafts: strategies the X bot wrote for someone who tagged @weftfinance ---------------- */

  // weft.fi/d/<id> and weft.fi/og/draft/<id>.png are rewritten here by the website.
  type Draft = { id: string; strategy: Strategy; thesis: string; tweetId: string; author: string; at: number };
  const readDraft = (id: string): Draft | null => {
    if (!/^[a-z0-9]{6,24}$/.test(id)) return null;
    const raw = accounts?.kvGet(`draft:${id}`);
    return raw ? (JSON.parse(raw) as Draft) : null;
  };
  app.get("/draft/:id", (c) => {
    const d = readDraft(c.req.param("id"));
    if (!d) return c.redirect(`${site}/new`, 302);
    c.header("cache-control", "public, max-age=3600");
    return c.html(sharePage(d.strategy, d.id, site, { href: `${site}/new?from=${encodeURIComponent(`draft:${d.id}`)}`, image: `${site}/og/draft/${d.id}.png`, path: "d" }));
  });
  app.get("/drafts/:id", (c) => {
    const d = readDraft(c.req.param("id"));
    return d ? c.json({ id: d.id, thesis: d.thesis, strategy: d.strategy }) : c.json({ error: "not found" }, 404);
  });
  const draftPngs = new Map<string, Buffer>();
  app.get("/og/draft/:file", async (c) => {
    const id = c.req.param("file").replace(/\.png$/, "");
    const d = readDraft(id);
    if (!d) return c.redirect(`${site}/og.png`, 302);
    let png = draftPngs.get(id);
    if (!png) {
      png = await strategyCard(d.strategy);
      draftPngs.set(id, png);
      if (draftPngs.size > 500) draftPngs.delete(draftPngs.keys().next().value!);
    }
    return c.body(new Uint8Array(png), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400, immutable" });
  });

  /* ---------------- Papertrade accounts ---------------- */

  /** The signed-in user's Papertrade account: wallet, session key, deposit address, balance. */
  app.get("/papertrade/account", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ enabled: false });
    return c.json({ enabled: true, live: Boolean(deps.papertradeLive), ...(await deps.papertrade.status(user.id)) });
  });
  /** PAPER farmed by one of the user's live runs: the account's PAPER now, and when the run started. */
  app.get("/papertrade/paper/:runId", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    const id = c.req.param("runId");
    assertOwner(accounts?.deploymentOwner(id), user);
    const now = await deps.papertrade.paperOf(user.id);
    const start = Number(accounts?.kvGet(`pt:paper0:${id}`) ?? NaN);
    return c.json({ paper: now, atStart: Number.isFinite(start) ? start : null, earned: now != null && Number.isFinite(start) ? Math.max(0, now - start) : null });
  });
  /** The RegisterSessionKey message for the user's wallet to sign (it creates the session key if needed). */
  app.post("/papertrade/registration", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    try {
      return c.json(await deps.papertrade.registration(user.id));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });
  /** The signed registration: checked here, then sent to Papertrade. */
  app.post("/papertrade/register", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    const { signed } = z.object({ signed: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    try {
      return c.json(await deps.papertrade.register(user.id, signed as never));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Money from the user's Hyperliquid account into Papertrade, less Weft's 1% fee: steps to sign. */
  app.post("/papertrade/deposit/prepare", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    const b = z.object({ amountUsd: z.number().positive(), signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
    try {
      return c.json(await deps.papertrade.prepareDeposit(user.id, b.amountUsd, b.signatureChainId));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  app.post("/papertrade/deposit/submit", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    const { signatures } = z.object({ signatures: z.array(z.string().regex(/^0x[0-9a-fA-F]{130}$/)).min(1).max(4) }).parse(await c.req.json());
    try {
      const r = await deps.papertrade.submitDeposit(user.id, signatures as `0x${string}`[]);
      console.log(`[papertrade ${user.id.slice(-6)}] deposit sent: ${r.summary}`);
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  /** Money back from Papertrade to the user's Hyperliquid account: the message to sign, then the signed one. */
  app.post("/papertrade/withdraw/prepare", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    const { amountUsd } = z.object({ amountUsd: z.number().positive() }).parse(await c.req.json());
    try {
      return c.json(await deps.papertrade.prepareWithdraw(user.id, amountUsd));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  app.post("/papertrade/withdraw/submit", async (c) => {
    const user = await requireUser(c);
    if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 503);
    const { signed } = z.object({ signed: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    try {
      return c.json(await deps.papertrade.submitWithdraw(user.id, signed));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  /* ---------------- Rift: fund or withdraw the Hyperliquid account from any chain ---------------- */

  const riftOr = (c: Context) => {
    if (!deps.rift) throw new HTTPException(503, { message: "deposits from other chains aren’t set up on this server" });
    return deps.rift;
  };
  const riftTry = async <T,>(c: Context, fn: () => Promise<T>) => {
    try {
      return c.json(await fn() as never);
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      return c.json({ error: (e as Error).message }, 422);
    }
  };
  app.get("/rift/assets", async (c) => c.json({ assets: (await import("./live/rift.ts")).RIFT_ASSETS }));
  app.post("/rift/quote", async (c) => {
    const user = await requireUser(c);
    const b = z.object({ kind: z.enum(["in", "out"]), asset: z.string().max(40), amount: z.number().positive() }).parse(await c.req.json());
    return riftTry(c, () => riftOr(c).quote(user.id, b.kind, b.asset, b.amount));
  });
  app.post("/rift/deposit", async (c) => {
    const user = await requireUser(c);
    const { quoteId } = z.object({ quoteId: z.string().uuid() }).parse(await c.req.json());
    return riftTry(c, () => riftOr(c).depositOrder(user.id, quoteId));
  });
  app.post("/rift/withdraw", async (c) => {
    const user = await requireUser(c);
    const b = z.object({ quoteId: z.string().uuid(), toAddress: z.string().min(20).max(100), signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
    return riftTry(c, () => riftOr(c).withdrawOrder(user.id, b.quoteId, b.toAddress, b.signatureChainId));
  });
  app.post("/rift/withdraw/submit", async (c) => {
    const user = await requireUser(c);
    const { signatures } = z.object({ signatures: z.array(z.string().regex(/^0x[0-9a-fA-F]{130}$/)).min(1).max(3) }).parse(await c.req.json());
    return riftTry(c, () => riftOr(c).submitWithdraw(user.id, signatures as `0x${string}`[]));
  });
  app.post("/rift/to-perps/prepare", async (c) => {
    const user = await requireUser(c);
    const b = z.object({ orderId: z.string().min(1).max(80), signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
    return riftTry(c, () => riftOr(c).prepareToPerps(user.id, b.orderId, b.signatureChainId));
  });
  app.post("/rift/to-perps/submit", async (c) => {
    const user = await requireUser(c);
    const { signatures } = z.object({ signatures: z.array(z.string().regex(/^0x[0-9a-fA-F]{130}$/)).min(1).max(1) }).parse(await c.req.json());
    return riftTry(c, () => riftOr(c).submitToPerps(user.id, signatures as `0x${string}`[]));
  });
  app.get("/rift/orders", async (c) => {
    const user = await requireUser(c);
    return riftTry(c, async () => ({ orders: await riftOr(c).list(user.id) }));
  });

  /* ---------------- AI assistants: personal keys and the MCP endpoint ---------------- */

  // A key lets an assistant (Claude, ChatGPT, Cursor…) read the user's own runs over MCP. Only its
  // hash is stored; the key itself is shown once. Keys never start, change or stop anything.
  type KeyRow = { id: string; hash: string; label: string; createdAt: number };
  const keyHash = (k: string) => createHash("sha256").update(k).digest("hex");
  const keysOf = (userId: string): KeyRow[] => JSON.parse(accounts?.kvGet(`pats:${userId}`) || "[]") as KeyRow[];
  const userOfKey = (k: string): string | null => {
    const raw = accounts?.kvGet(`pat:${keyHash(k)}`);
    return raw ? (JSON.parse(raw) as { userId: string }).userId : null;
  };
  app.get("/me/ai-keys", async (c) => {
    const user = await requireUser(c);
    return c.json({ keys: keysOf(user.id).map(({ id, label, createdAt }) => ({ id, label, createdAt })) });
  });
  app.post("/me/ai-keys", async (c) => {
    const user = await requireUser(c);
    if (!accounts) return c.json({ error: "keys need the account store" }, 503);
    const { label } = z.object({ label: z.string().trim().max(40).default("AI assistant") }).parse(await c.req.json().catch(() => ({})));
    const list = keysOf(user.id);
    if (list.length >= 5) return c.json({ error: "You have 5 keys already: remove one first." }, 400);
    const key = `weft_${randomBytes(24).toString("hex")}`;
    const row: KeyRow = { id: randomBytes(4).toString("hex"), hash: keyHash(key), label: label || "AI assistant", createdAt: Date.now() };
    accounts.kvSet(`pat:${row.hash}`, JSON.stringify({ userId: user.id, id: row.id }));
    accounts.kvSet(`pats:${user.id}`, JSON.stringify([...list, row]));
    return c.json({ key, id: row.id, label: row.label, createdAt: row.createdAt });
  });
  app.delete("/me/ai-keys/:id", async (c) => {
    const user = await requireUser(c);
    if (!accounts) return c.json({ error: "keys need the account store" }, 503);
    const list = keysOf(user.id);
    const row = list.find((k) => k.id === c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    accounts.kvSet(`pat:${row.hash}`, "");
    accounts.kvSet(`pats:${user.id}`, JSON.stringify(list.filter((k) => k.id !== row.id)));
    return c.json({ ok: true });
  });

  const runView = (snap: NonNullable<Awaited<ReturnType<typeof engine.getSnapshot>>>): RunView => {
    const d = snap.deployment;
    const pnl = snap.realizedPnlUsd + snap.unrealizedPnlUsd;
    const open = snap.positions.reduce((n, p) => n + p.sizeUsd, 0);
    const invested = snap.investedUsd ?? (open > 0 ? open : null);
    return {
      id: d.id,
      name: d.strategy.name,
      mode: d.alertsOnly ? "alerts" : d.mode === "live" ? "live" : "practice",
      status: d.status,
      returnPct: invested && invested > 0 ? (pnl / invested) * 100 : snap.returnPct,
      openPositions: snap.positions.length,
      startedAt: new Date(d.createdAt).toISOString(),
      url: `${site}/run?id=${encodeURIComponent(d.id)}`,
    };
  };
  const level = (l: { pct?: number; positionPct?: number; price?: number } | undefined) =>
    !l ? null : l.positionPct != null ? `${l.positionPct}% on the position` : l.pct != null ? `${l.pct}% price move` : l.price != null ? `$${l.price}` : null;
  const plainRules = (st: Strategy): string[] => [
    ...toGraph(st).nodes.flatMap((n) =>
      n.kind === "trigger" ? [`When ${n.lines.join(n.logic === "OR" ? " or " : " and ")}`]
      : n.kind === "action" ? [`${n.title}${n.subtitle ? ` (${n.subtitle})` : ""}`]
      : n.kind === "exit" ? [`${n.title}: ${n.subtitle}`]
      : []
    ),
    // Each opening action's own exits.
    ...st.actions.flatMap((a) => {
      const ex = "exits" in a ? (a.exits as { takeProfit?: never; stopLoss?: never; trailingStopPct?: number; timeExitHours?: number } | undefined) : undefined;
      if (!ex) return [];
      const parts = [
        level(ex.stopLoss) && `stop loss at ${level(ex.stopLoss)}`,
        level(ex.takeProfit) && `take profit at ${level(ex.takeProfit)}`,
        ex.trailingStopPct != null && `trailing stop ${ex.trailingStopPct}%`,
        ex.timeExitHours != null && `out after ${ex.timeExitHours} h`,
      ].filter(Boolean);
      return parts.length ? [`Exits: ${parts.join(", ")}`] : [];
    }),
  ];

  app.get("/mcp", (c) => c.json({ error: "POST JSON-RPC messages to this endpoint (MCP, streamable HTTP without a stream)" }, 405, { allow: "POST" }));
  app.post("/mcp", async (c) => {
    // The caller: a Weft key, or a signed-in Weft session; anyone else gets the public tools.
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    let userId: string | null = null;
    if (bearer.startsWith("weft_")) {
      userId = userOfKey(bearer);
      if (!userId) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "That Weft key isn’t valid (removed?). Create a new one in Settings." } }, 401);
    } else if (bearer) userId = (await optionalUser(c).catch(() => null))?.id ?? null;
    const ctx: McpCtx = {
      userId,
      site,
      searchMarkets: async (product, query, limit) => (await catalog.list(product as never, { search: query, limit })).map((r) => ({ label: r.label, name: r.name, price: r.price, change24hPct: r.change24hPct, volume24hUsd: r.volume24hUsd, liquidityUsd: r.liquidityUsd, meta: r.meta })),
      draft: async (idea) => {
        if (userId) await checkAiQuota({ id: userId });
        else await allowVisitor(c, "ai");
        const r = await generateStrategy(idea, { catalog });
        const id = randomBytes(8).toString("hex").slice(0, 12);
        accounts?.kvSet(`draft:${id}`, JSON.stringify({ id, strategy: r.strategy, thesis: idea, tweetId: "", author: userId ? "mcp:user" : "mcp", at: Date.now() }));
        return { id, strategy: r.strategy, rationale: r.rationale, warnings: r.warnings.map((w) => (typeof w === "string" ? w : (w as { message?: string }).message ?? String(w))), ai: r.source !== "template" };
      },
      rules: plainRules,
      topTraders: async () => (deps.topTraders ? await deps.topTraders() : []),
      runs: async (uid) => {
        const mine = accounts?.deploymentsOf(uid) ?? new Set<string>();
        const snaps = await Promise.all([...mine].map((id) => engine.getSnapshot(id)));
        return snaps.filter((x) => x != null).map(runView).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      },
      run: async (uid, id) => {
        if (accounts?.deploymentOwner(id) !== uid) return null;
        const snap = await engine.getSnapshot(id);
        if (!snap) return null;
        const fills = await engine.getFills(id);
        return {
          ...runView(snap),
          positions: snap.positions.map((p) => ({ market: p.instrumentKey, side: p.side, leverage: p.leverage ?? 1, unrealizedPnlPct: p.unrealizedPnlPct })),
          recentTrades: fills.slice(-10).map((f) => ({ at: new Date(f.ts).toISOString(), market: f.instrumentKey, side: f.side, reason: f.reason })),
        };
      },
    };
    const body = await c.req.json().catch(() => null);
    if (body == null) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    const info = { name: "weft", version: "1.0.0", instructions: MCP_INSTRUCTIONS };
    const run = async (m: unknown) => {
      try {
        return await handleRpc(m as never, MCP_TOOLS, ctx, info);
      } catch (e) {
        // A quota or auth stop inside a tool, as a readable tool result.
        const msg = e instanceof HTTPException ? e.message : (e as Error).message;
        return { jsonrpc: "2.0" as const, id: (m as { id?: string | number }).id ?? null, result: { content: [{ type: "text", text: msg }], isError: true } };
      }
    };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(run))).filter((x) => x != null);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await run(body);
    return out ? c.json(out) : c.body(null, 202);
  });

  /** Hyperliquid traders worth copying, with their current positions on request. */
  app.get("/traders", async (c) => {
    if (!deps.topTraders) return c.json({ traders: [] });
    return c.json({ traders: await deps.topTraders() });
  });

  app.post("/webhooks/helius", async (c) => {
    const hook = deps.heliusWebhook;
    if (!hook) return c.json({ error: "not found" }, 404);
    if (!hook.authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => []);
    return c.json({ ok: true, wallets: hook.handle(body).length });
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      ts: Date.now(),
      signals: deps.signalModes,
      auth: { enabled: authEnabled, appId: deps.auth?.appId ?? null },
      /** Which venues take real orders right now. */
      trading: { hyperliquid: Boolean(deps.live?.cfg.enabled), solana: Boolean(deps.solana?.cfg.enabled), liquidity: Boolean(deps.solana?.cfg.enabled && deps.solana?.cfg.lpEnabled), lending: Boolean(deps.solana?.cfg.enabled && deps.solana?.cfg.lendEnabled), jupiterLend: Boolean(deps.solana?.cfg.enabled && deps.solana?.cfg.jlendEnabled), papertrade: Boolean(deps.papertradeLive), network: deps.live?.cfg.network ?? null },
    })
  );

  /* ---------------- Me ---------------- */

  app.get("/me", async (c) => {
    const user = await optionalUser(c);
    return c.json({
      authEnabled,
      user: user ? (accounts?.get(user.id) ?? { id: user.id }) : null,
      ai: user ? { usedToday: accounts?.aiUsedToday(user.id) ?? 0, dailyLimit: authEnabled ? await aiLimitFor(user.id) : null } : null,
      isAdmin: user ? Boolean(deps.isAdmin?.(user.id)) : false,
    });
  });

  /* ---------------- $WEFT rewards ---------------- */

  /** The program and its public totals. */
  app.get("/rewards", (c) =>
    c.json({
      enabled: Boolean(deps.rewards?.enabled),
      startDay: deps.rewards?.startDay ?? null,
      claims: Boolean(deps.treasury),
      // WEFT_REWARDS_HOLD: pots fill up but nothing is shared out or claimable yet
      paused: process.env.WEFT_REWARDS_HOLD === "1",
      config: REWARDS,
      holders: deps.holders?.enabled ? { minAmount: Number(process.env.WEFT_HOLDER_MIN ?? 100_000), bigAmount: Number(process.env.WEFT_BIG_HOLDER_MIN ?? 1_000_000) } : null,
      aiDailyLimit: { everyone: aiDailyLimit, holders: holderAiDailyLimit },
      stats: deps.rewards?.stats() ?? null,
    })
  );

  /** Yours: today so far, what's waiting to be claimed, your holder tier. */
  app.get("/me/rewards", async (c) => {
    const user = await requireUser(c);
    if (!deps.rewards) return c.json({ error: "rewards are not configured" }, 501);
    const holder = deps.holders?.enabled ? await deps.holders.status(user.id).catch(() => null) : null;
    return c.json({
      ...deps.rewards.summary(user.id),
      enabled: deps.rewards.enabled,
      claims: Boolean(deps.treasury),
      wallet: accounts?.solanaAccount(user.id)?.address ?? null,
      holder: holder ? { tier: holder.tier, holds: holder.holds, minAmount: holder.minAmount, bigAmount: holder.bigAmount, boost: REWARDS.boost[holder.tier] } : null,
    });
  });

  /** Send everything claimable to your Weft Solana wallet. */
  const claiming = new Set<string>();
  app.post("/rewards/claim", async (c) => {
    const user = await requireUser(c);
    if (!deps.rewards || !deps.treasury) return c.json({ error: "claims open when $WEFT launches" }, 503);
    const wallet = accounts?.solanaAccount(user.id)?.address;
    if (!wallet) return c.json({ error: "Set up your Solana wallet under Wallets first; rewards are sent there." }, 409);
    if (claiming.has(user.id)) return c.json({ error: "a claim is already on its way" }, 409);
    claiming.add(user.id);
    try {
      const r = await deps.rewards.claim(user.id, (tokens) => deps.treasury!.pay(new PublicKey(wallet), tokens));
      return r ? c.json({ ok: true, tokens: r.tokens, tx: r.tx, wallet }) : c.json({ error: "nothing to claim yet" }, 409);
    } catch (e) {
      console.warn(`[rewards] claim failed for ${user.id.slice(0, 10)}: ${(e as Error).message.slice(0, 200)}`);
      return c.json({ error: "The claim didn’t go through. Nothing was lost; try again in a minute." }, 502);
    } finally {
      claiming.delete(user.id);
    }
  });

  /**
   * Protocol revenue: Weft's fee earnings and $WEFT buybacks. Public, since every figure is on-chain
   * anyway. Cached for a minute so page views don't hit Hyperliquid and the Solana RPC each time.
   */
  let revenueCache: { at: number; data: Promise<unknown> } | null = null;
  app.get("/revenue", async (c) => {
    if (!deps.earnings) return c.json({ error: "not found" }, 404);
    if (!revenueCache || Date.now() - revenueCache.at > 60_000) {
      const data = deps.earnings();
      revenueCache = { at: Date.now(), data };
      data.catch(() => {
        if (revenueCache?.data === data) revenueCache = null;
      });
    }
    return c.json(await revenueCache.data);
  });

  /* ---------------- Tweet a trade: a connected X account and what its tweets do ---------------- */

  const XPrefsBody = z
    .object({
      mode: z.enum(["draft", "practice", "live"]),
      sizeUsd: z.number().min(1).max(100_000),
      maxPerTweetUsd: z.number().min(1).max(100_000),
      maxPerDayUsd: z.number().min(1).max(1_000_000),
      /** Switching to live: the user typed this. */
      confirm: z.string().optional(),
    })
    .refine((p) => p.maxPerTweetUsd <= p.maxPerDayUsd, { message: "The per-tweet limit can't be above the daily limit." });
  const xOf = (userId: string) => {
    const raw = accounts?.kvGet(`x:user:${userId}`);
    return raw ? (JSON.parse(raw) as { id: string; username: string; at: number }) : null;
  };
  const xPrefsOf = (userId: string): XPrefs => {
    const raw = accounts?.kvGet(`x:prefs:${userId}`);
    return raw ? { ...DEFAULT_X_PREFS, ...(JSON.parse(raw) as Partial<XPrefs>) } : DEFAULT_X_PREFS;
  };
  const xView = (userId: string) => {
    const day = new Date().toISOString().slice(0, 10);
    return { enabled: Boolean(deps.xAccountOf), account: xOf(userId), prefs: xPrefsOf(userId), liveUsedTodayUsd: Number(accounts?.kvGet(`xbot:live:${userId}:${day}`) ?? 0) };
  };
  app.get("/me/x", async (c) => {
    const user = await requireUser(c);
    return c.json(xView(user.id));
  });
  /** After linking X with Privy on the website: read the link from Privy (not from the browser) and store it. */
  app.post("/me/x/sync", async (c) => {
    const user = await requireUser(c);
    if (!deps.xAccountOf || !accounts) return c.json({ error: "Tweet a trade isn’t set up on this server." }, 501);
    const x = await deps.xAccountOf(user.id);
    const old = xOf(user.id);
    if (old && old.id !== x?.id) accounts.kvSet(`x:link:${old.id}`, "");
    if (!x) {
      accounts.kvSet(`x:user:${user.id}`, "");
      return c.json(xView(user.id));
    }
    const other = accounts.kvGet(`x:link:${x.id}`);
    if (other && other !== user.id) return c.json({ error: "That X account is connected to another Weft account." }, 409);
    accounts.kvSet(`x:link:${x.id}`, user.id);
    accounts.kvSet(`x:user:${user.id}`, JSON.stringify({ id: x.id, username: x.username, at: Date.now() }));
    return c.json(xView(user.id));
  });
  app.put("/me/x/prefs", async (c) => {
    const user = await requireUser(c);
    if (!accounts) return c.json({ error: "not available" }, 501);
    const body = XPrefsBody.parse(await c.req.json());
    if (body.mode === "live" && xPrefsOf(user.id).mode !== "live" && body.confirm !== "GO LIVE")
      return c.json({ error: 'Type "GO LIVE" to let your tweets start real-money trades.' }, 400);
    const { confirm: _c, ...prefs } = body;
    accounts.kvSet(`x:prefs:${user.id}`, JSON.stringify(prefs));
    return c.json(xView(user.id));
  });
  app.delete("/me/x", async (c) => {
    const user = await requireUser(c);
    const old = xOf(user.id);
    if (old) accounts?.kvSet(`x:link:${old.id}`, "");
    accounts?.kvSet(`x:user:${user.id}`, "");
    accounts?.kvSet(`x:prefs:${user.id}`, "");
    return c.json(xView(user.id));
  });

  /** Client reports linked wallets / display name (display only; never used for authorization). */
  app.post("/me", async (c) => {
    const user = await requireUser(c);
    const body = z
      .object({ wallets: z.array(z.string().max(64)).max(10).optional(), displayName: z.string().max(40).nullable().optional() })
      .parse(await c.req.json());
    return c.json(accounts?.touch(user.id, body) ?? { id: user.id });
  });

  /* ---------------- Markets ---------------- */

  app.get("/markets/:product", async (c) => {
    const product = c.req.param("product") as Product;
    if (!PRODUCTS.includes(product as (typeof PRODUCTS)[number])) return c.json({ error: `unknown product ${product}` }, 404);
    const rows = await catalog.list(product, { search: c.req.query("search") ?? undefined, limit: clampQuery(c.req.query("limit"), 50, 300) });
    return c.json({ product, rows });
  });

  app.get("/market", async (c) => {
    const key = (c.req.query("key") ?? "").slice(0, 200);
    if (!key || !catalog.find) return c.json({ error: "not found" }, 404);
    const row = await catalog.find(key);
    return row ? c.json(row) : c.json({ error: "not found" }, 404);
  });

  /**
   * Price history for one market. Either a `range` (the bar size follows from it) or an `interval`
   * with `bars` ending before `end`, which is how a chart pages back as you scroll left.
   * Second intervals come from the recorded trade tape (Hyperliquid markets only).
   */
  app.post("/chart", async (c) => {
    const history = deps.backtest?.history;
    if (!history) return c.json({ error: "charts are not configured" }, 501);
    const body = z
      .object({
        instrument: z.unknown(),
        range: z.enum(CHART_RANGES).optional(),
        interval: z.enum(CHART_INTERVALS).optional(),
        end: z.number().int().positive().optional(),
        bars: z.number().int().min(10).max(1500).optional(),
        funding: z.boolean().optional(),
      })
      .refine((b) => b.range || b.interval, "range or interval is required")
      .parse(await c.req.json());
    const instrument = InstrumentSchema.parse(body.instrument) as Instrument;
    const reason = history.unsupportedReason(instrument);
    if (reason) return c.json({ error: reason, unsupported: true }, 422);
    const now = deps.backtest?.now?.() ?? Date.now();
    const liveCoinP = history.liveCoin ? history.liveCoin(instrument).catch(() => null) : Promise.resolve(null);
    const fundingP = body.funding && instrument.kind === "perp" ? history.funding(instrument, now - 7 * 86_400_000, now).catch(() => []) : Promise.resolve(undefined);
    const interval = body.interval ?? CHART_SPEC[body.range!].interval;
    const end = Math.min(body.end ?? now + 1, now + 1);
    const out = (candles: { t: number; o: number; h: number; l: number; c: number; volUsd: number | null }[], step: number, source: string, liveCoin: string | null, hasMore: boolean, extra: Record<string, unknown> = {}) => ({
      range: body.range ?? null,
      interval,
      intervalMs: step,
      source,
      liveCoin,
      hasMore,
      candles: candles.map((k) => [k.t, k.o, k.h, k.l, k.c, k.volUsd]),
      ...extra,
    });

    if (interval in SECOND_INTERVALS) {
      const coin = await liveCoinP;
      if (!coin || !deps.tape) return c.json({ error: "Second charts are only available for Hyperliquid markets", unsupported: true }, 422);
      deps.tape.ensure(coin);
      const step = SECOND_INTERVALS[interval as SecondInterval];
      const candles = deps.tape.bars(coin, step, end, body.bars ?? 500);
      const since = deps.tape.since(coin);
      return c.json(out(candles, step, "weft:trades", coin, false, { recordedSince: since, funding: (await fundingP)?.map((f) => [f.time, f.rate]) }));
    }

    const iv = interval as CandleInterval;
    const step = INTERVAL_MS[iv];
    const endAligned = Math.ceil(end / step) * step;
    const start = body.range && !body.interval ? endAligned - CHART_SPEC[body.range].spanMs : endAligned - (body.bars ?? 500) * step;
    const [series, liveCoin, funding] = await Promise.all([history.candles(instrument, iv, start, endAligned), liveCoinP, fundingP]);
    const first = series.candles[0];
    return c.json({
      ...out(series.candles, step, series.source, liveCoin, Boolean(first && first.t <= start + 2 * step)),
      funding: funding?.map((f) => [f.time, f.rate]),
    });
  });

  app.post("/quote", async (c) => {
    const body = await c.req.json();
    const instrument = InstrumentSchema.parse(body.instrument) as Instrument;
    const quote = await marketData.getQuote(instrument, { side: body.side, sizeUsd: body.sizeUsd });
    return c.json(quote);
  });

  /* ---------------- Strategies ---------------- */

  app.get("/strategies", (c) => c.json({ strategies: library.list().map(pub) }));
  app.get("/strategies/examples", (c) => c.json({ strategies: examples }));

  app.get("/strategies/:id", (c) => {
    const e = library.get(c.req.param("id"));
    return e ? c.json({ ...pub(e), graph: toGraph(e.strategy) }) : c.json({ error: "not found" }, 404);
  });

  app.post("/strategies/validate", async (c) => {
    const body = await c.req.json();
    const v = validateStrategy(body.strategy ?? body);
    return c.json(v.ok ? { ok: true, strategy: v.strategy, warnings: v.warnings, graph: toGraph(v.strategy) } : v, v.ok ? 200 : 422);
  });

  app.post("/strategies", async (c) => {
    const user = await requireUser(c);
    const body = await c.req.json();
    const entry = library.save(body.strategy ?? body, { author: authorFor(user, body.author) });
    accounts?.setStrategyOwner(entry.id, user.id);
    return c.json(pub(entry), 201);
  });

  app.put("/strategies/:id", async (c) => {
    const user = await requireUser(c);
    const id = c.req.param("id");
    if (!library.get(id)) return c.json({ error: "not found" }, 404);
    assertOwner(accounts?.strategyOwner(id), user);
    const body = await c.req.json();
    return c.json(pub(library.save(body.strategy ?? body, { author: "", replaceId: id })));
  });

  app.post("/strategies/:id/fork", async (c) => {
    const user = await requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const entry = library.fork(c.req.param("id"), authorFor(user, (body as { author?: string }).author));
    if (entry) accounts?.setStrategyOwner(entry.id, user.id);
    return entry ? c.json(pub(entry), 201) : c.json({ error: "not found" }, 404);
  });

  app.delete("/strategies/:id", async (c) => {
    const user = await requireUser(c);
    const id = c.req.param("id");
    if (!library.get(id)) return c.json({ error: "not found" }, 404);
    assertOwner(accounts?.strategyOwner(id), user);
    library.delete(id);
    return c.json({ ok: true });
  });

  /* ---------------- AI: thesis → strategy ---------------- */

  app.post("/ai/generate", async (c) => {
    const { thesis } = z.object({ thesis: z.string().min(3).max(2_000) }).parse(await c.req.json());
    await allowVisitor(c, "ai");
    try {
      const r = await generateStrategy(thesis, { catalog });
      return c.json({ ...r, graph: toGraph(r.strategy) });
    } catch (e) {
      if (e instanceof GenerationError) return c.json({ error: e.message }, 422);
      throw e;
    }
  });

  /** Same as /ai/generate but streams progress as SSE (consume with fetch + ReadableStream). */
  app.post("/ai/generate/stream", async (c) => {
    const { thesis } = z.object({ thesis: z.string().min(3).max(2_000) }).parse(await c.req.json());
    await allowVisitor(c, "ai");
    return streamSSE(c, async (stream) => {
      try {
        const r = await generateStrategy(thesis, {
          catalog,
          onProgress: (p) => void stream.writeSSE({ event: "progress", data: JSON.stringify(p) }),
        });
        await stream.writeSSE({ event: "result", data: JSON.stringify({ ...r, graph: toGraph(r.strategy) }) });
      } catch (e) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: (e as Error).message }) });
      }
    });
  });

  /** Change an existing strategy with a plain-language instruction; streams progress like /ai/generate/stream. */
  app.post("/ai/refine/stream", async (c) => {
    const body = z.object({ strategy: z.unknown(), instruction: z.string().min(2).max(1_000) }).parse(await c.req.json());
    const base = validateStrategy(body.strategy);
    if (!base.ok) return c.json({ error: "invalid strategy", issues: base.errors }, 400);
    await allowVisitor(c, "ai");
    return streamSSE(c, async (stream) => {
      try {
        const r = await generateStrategy(base.strategy.thesis, {
          catalog,
          onProgress: (p) => void stream.writeSSE({ event: "progress", data: JSON.stringify(p) }),
        }, { base: base.strategy, instruction: body.instruction });
        await stream.writeSSE({ event: "result", data: JSON.stringify({ ...r, graph: toGraph(r.strategy) }) });
      } catch (e) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: (e as Error).message }) });
      }
    });
  });

  /* ---------------- Backtest ---------------- */

  /** Replays the strategy through the real engine over the last N days of history. */
  app.post("/backtest", async (c) => {
    if (!deps.backtest) return c.json({ error: "backtesting is not configured" }, 501);
    await allowVisitor(c, "backtest");
    const body = BacktestBody.parse(await c.req.json());
    let raw = body.strategy;
    if (!raw && body.strategyId) {
      raw = library.get(body.strategyId)?.strategy;
      if (!raw) return c.json({ error: `strategy ${body.strategyId} not found` }, 404);
    }
    if (!raw) return c.json({ error: "strategy or strategyId is required" }, 400);
    const v = validateStrategy(raw);
    if (!v.ok) return c.json({ error: "invalid strategy", issues: v.errors }, 422);
    const result = await runBacktest({ strategy: v.strategy, days: body.days, allocationUsd: body.allocationUsd, interval: body.interval }, deps.backtest);
    return c.json(result);
  });

  /* ---------------- Deployments (paper) ---------------- */

  /** Your deployments (all of them in local mode); ?scope=all lists everyone's (public). */
  app.get("/deployments", async (c) => {
    let records = await engine.listDeployments();
    if (authEnabled) {
      const user = await optionalUser(c);
      const mine = user && accounts ? accounts.deploymentsOf(user.id) : new Set<string>();
      // scope=all: everyone's paper runs, but live runs only when they're yours.
      // scope=all: others' paper runs (local development) plus your own.
      records = c.req.query("scope") === "all" ? records.filter((d) => (allowPaper && d.mode !== "live") || mine.has(d.id)) : records.filter((d) => mine.has(d.id));
    }
    const snaps = await Promise.all(records.map((d) => engine.getSnapshot(d.id)));
    return c.json({ deployments: snaps.filter(Boolean) });
  });

  /** Your practice money: how much there is, how much your practice runs are using. */
  app.get("/practice", async (c) => {
    if (!practiceBudget) return c.json({ enabled: false, budgetUsd: 0, usedUsd: 0, leftUsd: 0, running: 0, maxRuns: PRACTICE_MAX_RUNS });
    const user = await optionalUser(c);
    const use = user ? await practiceUse(user.id) : { usedUsd: 0, running: 0 };
    return c.json({ enabled: true, budgetUsd: practiceBudget, ...use, leftUsd: Math.max(0, practiceBudget - use.usedUsd), maxRuns: PRACTICE_MAX_RUNS });
  });

  app.post("/deployments", async (c) => {
    const user = await requireUser(c);
    const body = DeployBody.parse(await c.req.json());
    let raw = body.strategy;
    if (!raw && body.strategyId) raw = library.get(body.strategyId)?.strategy;
    const v = validateStrategy(raw);
    if (!v.ok) return c.json({ error: "invalid strategy", issues: v.errors }, 422);
    // $WEFT always means Weft's own token: a strategy naming it trades the official mint, whatever it says.
    const strategy = pinOfficialTokens(v.strategy).strategy;
    if (body.mode === "paper" && !body.alertsOnly && !allowPaper) {
      if (!practiceBudget) return c.json({ error: "Weft trades with real money only. Start it live, or as alerts only." }, 400);
      const { usedUsd, running } = await practiceUse(user.id);
      if (running >= PRACTICE_MAX_RUNS) return c.json({ error: `You have ${running} practice runs going. Stop one to start another.` }, 409);
      const left = practiceBudget - usedUsd;
      if (body.allocationUsd > left + 1e-9)
        return c.json({ error: left <= 0 ? `All $${practiceBudget.toLocaleString("en-US")} of your practice money is in use. Stop a practice run to free some up.` : `You have $${Math.floor(left).toLocaleString("en-US")} of practice money left.` }, 409);
    }
    // Live liquidity only once it's switched on (WEFT_SOL_LP).
    if (body.mode === "live" && !body.alertsOnly && strategy.actions.some((a) => a.type === "liquidity") && !deps.solana?.cfg.lpEnabled)
      return c.json({ error: "Liquidity strategies run as practice for now. Live deposits to Meteora are coming." }, 409);
    if (body.mode === "live" && !body.alertsOnly && strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "lend") && !deps.solana?.cfg.lendEnabled)
      return c.json({ error: "Lending runs as practice for now. Live deposits are coming." }, 409);
    if (body.mode === "live" && !body.alertsOnly && strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "lend" && a.instrument.venue === "jupiter") && !deps.solana?.cfg.jlendEnabled)
      return c.json({ error: "Jupiter Lend runs as practice for now. Live deposits are coming; Kamino lending is live." }, 409);
    if (body.mode === "live" && !body.alertsOnly && strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "synth") && !deps.papertradeLive)
      return c.json({ error: "Papertrade runs as practice for now. Live trading there is coming." }, 409);
    // Real money never rides on made-up data: signals Weft only simulates (no live feed yet) can run
    // as alerts, not trades.
    if (body.mode === "live" && !body.alertsOnly) {
      const fake = [...new Set(strategy.signals.filter((s) => deps.signalModes[s.kind] === "simulated").map((s) => SIGNAL_NAMES[s.kind] ?? s.kind))];
      if (fake.length)
        return c.json({ error: `This strategy uses ${fake.join(" and ")}, which Weft doesn’t have live data for yet. Run it as alerts only, or change that rule.` }, 409);
    }
    if (body.mode === "live") return withLiveLock(user.id, async () => {
      if (body.confirm !== "GO LIVE") return c.json({ error: 'type "GO LIVE" to confirm real-money trading' }, 400);
      const mineAll = accounts ? accounts.deploymentsOf(user.id) : new Set<string>();
      const openLive = async () => {
        let n = 0;
        for (const d of await engine.listDeployments())
          if (d.mode === "live" && mineAll.has(d.id) && (d.status === "running" || d.status === "paused")) n += d.allocationUsd;
        return n;
      };
      // Solana tokens: the user's own Privy wallet, Weft as a limited signer.
      if (tradesSolana(strategy)) {
        if (!deps.solana) return c.json({ error: "Solana trading is not configured on this server" }, 501);
        const mints = new Set<string>();
        for (const d of await engine.listDeployments()) {
          if (d.mode !== "live" || !mineAll.has(d.id) || d.status === "stopped" || d.status === "killed") continue;
          for (const a of d.strategy.actions) {
            if (a.type === "open" && (a.instrument.kind === "token" || a.instrument.kind === "lend")) mints.add(a.instrument.mint);
            if (a.type === "liquidity") for (const m of [a.pool.baseMint, a.pool.quoteMint]) if (m !== "So11111111111111111111111111111111111111112") mints.add(m);
          }
        }
        try {
          deps.solana.assertDeployable(user.id, strategy, body.allocationUsd, mints);
        } catch (e) {
          return c.json({ error: (e as Error).message }, 409);
        }
        const perRun = deps.solana.cfg.maxAllocationUsd;
        const total = deps.liveMaxTotalUsd ?? (perRun != null ? perRun * 5 : null);
        const open = total != null ? await openLive() : 0;
        if (total != null && open + body.allocationUsd > total)
          return c.json({ error: `you already have $${open.toLocaleString()} live; the limit across all live runs is $${total.toLocaleString()}` }, 409);
        return create();
      }
      // Papertrade only: its own account (a registered session key and money in it), not Hyperliquid's agent.
      const opens = strategy.actions.filter((a) => a.type === "open");
      if (opens.length && opens.every((a) => a.type === "open" && a.instrument.kind === "synth") && strategy.actions.every((a) => a.type === "open" || a.type === "close" || a.type === "notify")) {
        if (!deps.papertrade) return c.json({ error: "Papertrade isn’t set up on this server" }, 501);
        const st = await deps.papertrade.status(user.id);
        if (!st.wallet) return c.json({ error: "Set up your Hyperliquid wallet in Weft first: Papertrade uses the same wallet." }, 409);
        if (!st.registered) return c.json({ error: "Connect Papertrade under Wallets first (one signature)." }, 409);
        if (st.availableUsd != null && st.availableUsd < 10) return c.json({ error: "Your Papertrade account is empty: deposit USDC under Wallets first." }, 409);
        return create();
      }
      if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
      // Instruments already traded by this user's other live runs (positions would net on the venue).
      const mine = accounts ? accounts.deploymentsOf(user.id) : new Set<string>();
      const others = new Set<string>();
      for (const d of await engine.listDeployments()) {
        if (d.mode !== "live" || !mine.has(d.id) || d.status === "stopped" || d.status === "killed") continue;
        for (const a of d.strategy.actions)
          if (a.type === "open" && (a.instrument.kind === "perp" || a.instrument.kind === "spot"))
            others.add(a.instrument.kind === "perp" ? `hl:perp:${a.instrument.dex ? `${a.instrument.dex}:` : ""}${a.instrument.symbol}` : `hl:spot:${a.instrument.symbol}`);
          else if (a.type === "open" && a.instrument.kind === "outcome" && a.instrument.venue === "hyperliquid")
            others.add(`hl:outcome:${a.instrument.market}:${a.instrument.outcome}`);
      }
      try {
        deps.live.assertDeployable(user.id, strategy, body.allocationUsd, others);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 409);
      }
      // A ceiling on everything this user has live at once, not just per run.
      const perRun = deps.live.cfg.maxAllocationUsd;
      const total = deps.liveMaxTotalUsd ?? (perRun != null ? perRun * 5 : null);
      let open = 0;
      for (const d of await engine.listDeployments())
        if (d.mode === "live" && mine.has(d.id) && (d.status === "running" || d.status === "paused")) open += d.allocationUsd;
      if (total != null && open + body.allocationUsd > total)
        return c.json({ error: `you already have $${open.toLocaleString()} live; the limit across all live runs is $${total.toLocaleString()}` }, 409);
      return create();
    });
    return create();

    async function create() {
    const record = await engine.createDeployment({
      strategy,
      mode: body.mode,
      allocationUsd: body.allocationUsd,
      caps: body.caps,
      intervalSec: body.intervalSec,
      alertsOnly: body.mode === "paper" && body.alertsOnly ? true : undefined,
    });
    accounts?.setDeploymentOwner(record.id, user.id);
    // Papertrade with real money: note the account's PAPER now, so the run can show what it farmed.
    if (body.mode === "live" && deps.papertrade && strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "synth"))
      void deps.papertrade.paperOf(user.id).then((p) => p != null && accounts?.kvSet(`pt:paper0:${record.id}`, String(p))).catch(() => {});
    // Someone else's published strategy (or a copy of one): its creator earns from this run's fees.
    const creator = accounts ? (accounts.strategyOwner(strategy.id) ?? (strategy.forkedFrom ? accounts.strategyOwner(strategy.forkedFrom) : null)) : null;
    if (creator && creator !== user.id) accounts?.setDeploymentCreator(record.id, creator);
    // First tick right away so the UI has data immediately.
    engine.tick(record.id).catch((e) => console.error("first tick failed", e));
    return c.json(record, 201);
    }
  });

  app.get("/deployments/:id", async (c) => {
    if (!(await canView(c, c.req.param("id")))) return c.json({ error: "this is a private live run" }, 403);
    const s = await engine.getSnapshot(c.req.param("id"));
    return s ? c.json({ ...s, graph: toGraph(s.deployment.strategy), shared: accounts?.isShared(s.deployment.id) ?? false }) : c.json({ error: "not found" }, 404);
  });
  app.get("/deployments/:id/events", async (c) =>
    !(await canView(c, c.req.param("id")))
      ? c.json({ error: "this is a private live run" }, 403)
      : c.json({ events: await engine.getEvents(c.req.param("id"), { sinceTs: Number(c.req.query("since") ?? 0) || undefined, limit: clampQuery(c.req.query("limit"), 200, 500) }) })
  );
  app.get("/deployments/:id/fills", async (c) =>
    !(await canView(c, c.req.param("id"))) ? c.json({ error: "this is a private live run" }, 403) : c.json({ fills: await engine.getFills(c.req.param("id")) }),
  );

  /* ---------------- Owner instructions on a running strategy ---------------- */

  const ownedRun = async (c: Context) => {
    const user = await requireUser(c);
    const id = c.req.param("id")!;
    const snap = await engine.getSnapshot(id);
    if (!snap) throw new HTTPException(404, { message: "not found" });
    assertOwner(accounts?.deploymentOwner(id), user);
    if (snap.deployment.status === "stopped" || snap.deployment.status === "killed") throw new HTTPException(409, { message: `this run is ${snap.deployment.status}` });
    return { user, id, snap };
  };

  /** Sell part or all of one position at market, now. */
  app.post("/deployments/:id/positions/:pid/close", async (c) => {
    const { id } = await ownedRun(c);
    const { fraction } = z.object({ fraction: z.number().gt(0).max(1).default(1) }).parse(await c.req.json().catch(() => ({})));
    if (!engine.closePosition) return c.json({ error: "selling on request isn’t available" }, 501);
    try {
      const ok = await engine.closePosition(id, c.req.param("pid"), fraction);
      return c.json({ ok, snapshot: await engine.getSnapshot(id) }, ok ? 200 : 422);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  /**
   * Plans waiting for the owner's confirmation (10 minutes). Kept in the accounts database when
   * there is one, so a server restart between Review and Confirm doesn't lose them.
   */
  type Plan = { userId: string; deploymentId: string; steps: Step[]; expires: number };
  const memPlans = new Map<string, Plan>();
  const plans = {
    get(id: string): Plan | undefined {
      if (!accounts) return memPlans.get(id);
      const raw = accounts.kvGet(`plan:${id}`);
      return raw ? (JSON.parse(raw) as Plan) : undefined;
    },
    set(id: string, p: Plan) {
      if (accounts) accounts.kvSet(`plan:${id}`, JSON.stringify(p));
      else memPlans.set(id, p);
    },
    delete(id: string) {
      if (accounts) accounts.kvSet(`plan:${id}`, "");
      memPlans.delete(id);
    },
    sweep() {
      for (const [k, p] of memPlans) if (p.expires < Date.now()) memPlans.delete(k);
    },
  };

  /** Turn a plain instruction into reviewable steps (nothing happens yet). */
  app.post("/deployments/:id/instruct", async (c) => {
    const { user, id, snap } = await ownedRun(c);
    const { text } = z.object({ text: z.string().min(2).max(500) }).parse(await c.req.json());
    let steps: Step[] | null;
    let rationale = "";
    try {
      steps = parseInstruction(text, snap.positions, snap.deployment.strategy);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
    if (!steps) {
      // Anything else: Claude edits the rules (counts toward the daily AI limit).
      await checkAiQuota(user);
      try {
        const r = await generateStrategy(snap.deployment.strategy.thesis, { catalog }, { base: snap.deployment.strategy, instruction: text });
        const v = validateStrategy(r.strategy);
        if (!v.ok) return c.json({ error: "That change didn’t produce valid rules. Try saying it differently." }, 422);
        rationale = r.rationale;
        steps = [{ kind: "rules", strategy: v.strategy, label: r.rationale || "Update the rules as asked" }];
        // Exits on the open actions also apply to positions already open.
        const before = snap.deployment.strategy.actions.filter((a) => a.type === "open");
        for (const a of v.strategy.actions) {
          if (a.type !== "open") continue;
          const old = before.find((b) => b.id === a.id);
          if (!old || JSON.stringify(old.exits) === JSON.stringify(a.exits)) continue;
          const held = snap.positions.filter((p) => p.actionId === a.id);
          if (!held.length) continue;
          const patch: Record<string, unknown> = {};
          for (const k of ["stopLoss", "takeProfit", "trailingStopPct", "timeExitHours"] as const) patch[k] = a.exits[k] ?? null;
          steps.push({ kind: "exits", patch, positionIds: held.map((p) => p.id), label: "Apply the new exits to the positions already open" });
        }
      } catch (e) {
        if (e instanceof GenerationError) return c.json({ error: e.message }, 422);
        throw e;
      }
    }
    const planId = crypto.randomUUID();
    plans.sweep();
    plans.set(planId, { userId: user.id, deploymentId: id, steps, expires: Date.now() + 10 * 60_000 });
    return c.json({ planId, steps: steps.map((s) => ({ kind: s.kind, label: s.label })), rationale });
  });

  /** Carry out a reviewed plan. */
  app.post("/deployments/:id/instruct/:planId/apply", async (c) => {
    const { user, id } = await ownedRun(c);
    const plan = plans.get(c.req.param("planId"));
    if (!plan || plan.expires < Date.now() || plan.userId !== user.id || plan.deploymentId !== id) return c.json({ error: "that plan expired; ask again" }, 410);
    plans.delete(c.req.param("planId"));
    const done: string[] = [];
    try {
      for (const s of plan.steps) {
        if (s.kind === "sell") {
          const ok = await engine.closePosition!(id, s.positionId, s.fraction);
          done.push(ok ? s.label : `${s.label}: didn’t fill`);
        } else if (s.kind === "exits") {
          const changed = await engine.setExits!(id, s.patch, s.positionIds);
          const cur = await engine.getSnapshot(id);
          if (cur) await engine.updateStrategy!(id, withExits(cur.deployment.strategy, s.patch));
          console.log(`[instruct ${id.slice(0, 8)}] ${s.label} (${changed} position${changed === 1 ? "" : "s"}): ${JSON.stringify(s.patch)}`);
          deps.onExitsChanged?.();
          done.push(s.label);
        } else {
          await engine.updateStrategy!(id, s.strategy);
          done.push(s.label);
        }
      }
    } catch (e) {
      return c.json({ error: (e as Error).message, done }, 409);
    }
    return c.json({ done, snapshot: await engine.getSnapshot(id) });
  });

  for (const action of ["pause", "resume", "stop", "kill", "tick"] as const) {
    app.post(`/deployments/:id/${action}`, async (c) => {
      const user = await requireUser(c);
      const id = c.req.param("id");
      if (!(await engine.getSnapshot(id))) return c.json({ error: "not found" }, 404);
      assertOwner(accounts?.deploymentOwner(id), user);
      await engine[action](id);
      return c.json(await engine.getSnapshot(id));
    });
  }

  /** Live engine events. ?deploymentId= for one run (public); otherwise your runs (pass ?token= since EventSource can't set headers). */
  app.get("/events/stream", async (c) => {
    const only = c.req.query("deploymentId");
    if (only && !(await canView(c, only))) return c.json({ error: "this is a private live run" }, 403);
    const user = only ? null : await optionalUser(c);
    const release = streams.acquire(c);
    if (!release) return c.json({ error: "too many open streams" }, 429);
    const visible = (deploymentId: string) =>
      !!only || !authEnabled || (!!user && !!accounts && accounts.deploymentOwner(deploymentId) === user.id);
    return streamSSE(c, async (stream) => {
      const queue: EngineEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = engine.subscribe((e) => {
        if (only && e.deploymentId !== only) return;
        if (!visible(e.deploymentId)) return;
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        release();
        unsub();
        wake?.();
      });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
          wake = null;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
          continue;
        }
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
      }
      unsub();
    });
  });

  /* ---------------- Live trading (Hyperliquid) ---------------- */

  /* ---------------- Live: Solana tokens ---------------- */

  app.get("/live/solana", async (c) => {
    if (!deps.solana) return c.json({ error: "Solana trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    return c.json(await deps.solana.status(user.id));
  });
  app.post("/live/solana/link", async (c) => {
    if (!deps.solana) return c.json({ error: "Solana trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    const { address } = z.object({ address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) }).parse(await c.req.json());
    try {
      return c.json(await deps.solana.link(user.id, address));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  app.get("/live/status", async (c) => {
    if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    return c.json(await deps.live.status(user.id));
  });
  app.post("/live/account", async (c) => {
    if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    const { hlAddress } = z.object({ hlAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await c.req.json());
    deps.live.linkAccount(user.id, hlAddress);
    return c.json(await deps.live.status(user.id));
  });
  // Withdrawals from the user's Solana wallet: Weft builds, the user's wallet signs, Weft checks and sends.
  app.post("/live/solana/withdraw/prepare", async (c) => {
    if (!deps.solanaWithdrawals || !accounts) return c.json({ error: "Solana is not configured on this server" }, 501);
    const user = await requireUser(c);
    const w = accounts.solanaAccount(user.id);
    if (!w) return c.json({ error: "set up your Solana wallet first" }, 409);
    const b = z.object({ asset: z.string().min(3).max(64), amount: z.union([z.number().positive(), z.literal("max")]), destination: z.string().min(32).max(64) }).parse(await c.req.json());
    try {
      return c.json(await deps.solanaWithdrawals.prepare(user.id, w.address, b.asset, b.amount, b.destination));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  app.post("/live/solana/withdraw/submit", async (c) => {
    if (!deps.solanaWithdrawals) return c.json({ error: "Solana is not configured on this server" }, 501);
    const user = await requireUser(c);
    const { transaction } = z.object({ transaction: z.string().min(100).max(4000) }).parse(await c.req.json());
    try {
      const r = await deps.solanaWithdrawals.submit(user.id, transaction);
      console.log(`[withdraw ${user.id.slice(-6)}] Solana transfer ${r.signature}`);
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // Withdrawals from the user's Hyperliquid account to Arbitrum, signed by the account owner.
  app.post("/live/withdraw/prepare", async (c) => {
    if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    const b = z.object({ destination: z.string(), amountUsd: z.number().positive(), signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
    try {
      return c.json(await deps.live.prepareWithdraw(user.id, b.destination, b.amountUsd, b.signatureChainId));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  app.post("/live/withdraw/submit", async (c) => {
    if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    const { signature } = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).parse(await c.req.json());
    try {
      const r = await deps.live.submitWithdraw(user.id, signature as `0x${string}`);
      console.log(`[withdraw ${user.id.slice(-6)}] Hyperliquid withdrawal sent`);
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // Deposits into the linked Hyperliquid address (the user's Weft wallet), gas paid by Weft.
  const depositOwner = (userId: string) => {
    const a = deps.accounts?.liveAccount(userId);
    if (!a || a.network !== deps.live?.cfg.network) throw new HTTPException(409, { message: "set up your Hyperliquid wallet first" });
    return a.hlAddress;
  };
  app.get("/live/deposit", async (c) => {
    if (!deps.live || !deps.deposits) return c.json({ error: "deposits are not configured on this server" }, 501);
    const user = await requireUser(c);
    return c.json(await deps.deposits.status(user.id, depositOwner(user.id)));
  });
  app.post("/live/deposit/prepare", async (c) => {
    if (!deps.live || !deps.deposits) return c.json({ error: "deposits are not configured on this server" }, 501);
    const user = await requireUser(c);
    try {
      return c.json(await deps.deposits.prepare(user.id, depositOwner(user.id)));
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  app.post("/live/deposit/submit", async (c) => {
    if (!deps.live || !deps.deposits) return c.json({ error: "deposits are not configured on this server" }, 501);
    const user = await requireUser(c);
    const { signature } = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).parse(await c.req.json());
    try {
      const r = await deps.deposits.submit(user.id, signature as `0x${string}`);
      console.log(`[deposit ${user.id.slice(-6)}] ${r.usdc} USDC to Hyperliquid ${deps.live.cfg.network}: ${r.tx}`);
      return c.json(r);
    } catch (e) {
      console.warn(`[deposit ${user.id.slice(-6)}] failed: ${(e as Error).message.slice(0, 300)}`);
      return c.json({ error: (e as Error).message.split("\n")[0] }, 422);
    }
  });
  app.post("/live/approvals/prepare", async (c) => {
    if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    const { signatureChainId } = z.object({ signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
    return c.json(await deps.live.prepareApprovals(user.id, signatureChainId));
  });
  app.post("/live/approvals/submit", async (c) => {
    if (!deps.live) return c.json({ error: "live trading is not configured on this server" }, 501);
    const user = await requireUser(c);
    const { kind, signature } = z.object({ kind: z.enum(["agent", "builder"]), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).parse(await c.req.json());
    try {
      return c.json(await deps.live.submitApproval(user.id, kind, signature as `0x${string}`));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  /* ---------------- Alerts (Telegram / webhook) ---------------- */

  app.get("/alerts", async (c) => {
    const user = await requireUser(c);
    const mine = authEnabled && accounts ? accounts.deploymentsOf(user.id) : null;
    return c.json({
      sinks: deps.notifier?.sinks ?? [],
      configured: (deps.notifier?.sinks.length ?? 0) > 0,
      recent: (deps.notifier?.recent() ?? []).filter((a) => !mine || mine.has(a.deploymentId)).slice(0, 20),
      help: "Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and/or WEFT_ALERT_WEBHOOK_URL, then restart the API.",
    });
  });
  /* Per-user Telegram alerts */
  app.get("/alerts/me", async (c) => {
    const user = await requireUser(c);
    const link = deps.accounts?.telegramLink(user.id) ?? null;
    return c.json({ available: !!deps.telegram, telegram: link ? { username: link.username, linkedAt: link.linkedAt } : null });
  });
  app.post("/alerts/telegram/link", async (c) => {
    const user = await requireUser(c);
    if (!deps.telegram) return c.json({ error: "Telegram alerts aren’t set up on this server." }, 501);
    return c.json({ url: await deps.telegram.linkUrl(user.id) });
  });
  app.delete("/alerts/telegram", async (c) => {
    const user = await requireUser(c);
    deps.accounts?.removeTelegramLink(user.id);
    return c.json({ ok: true });
  });
  app.post("/alerts/me/test", async (c) => {
    const user = await requireUser(c);
    if (!deps.telegram) return c.json({ error: "Telegram alerts aren’t set up on this server." }, 501);
    const ok = await deps.telegram.sendToUser(user.id, "◆ Weft\nTest alert. Alerts from your runs will look like this.");
    return ok ? c.json({ ok: true }) : c.json({ error: "Connect Telegram first." }, 400);
  });

  app.post("/alerts/test", async (c) => {
    // The operator's shared chat: only in local mode. Signed-in users test their own chat via /alerts/me/test.
    if (authEnabled) return c.json({ error: "use /alerts/me/test" }, 403);
    if (!deps.notifier?.sinks.length) return c.json({ error: "no alert sinks configured" }, 400);
    await deps.notifier.test();
    return c.json({ ok: true });
  });

  /* ---------------- Leaderboard & stats ---------------- */

  /**
   * Real results only: live runs whose owners chose to share them. Returns are shown in percent;
   * amounts, positions and wallets stay private. (Local development ranks paper runs instead.)
   */
  app.get("/leaderboard", async (c) => {
    const shared = accounts?.sharedRuns() ?? new Set<string>();
    const records = (await engine.listDeployments()).filter((d) => !d.alertsOnly && (allowPaper ? d.mode !== "live" : d.mode === "live" && shared.has(d.id)));
    const snaps = (await Promise.all(records.map((d) => engine.getSnapshot(d.id)))).filter((s) => s != null);
    const rows = snaps
      .map((s) => {
        const owner = accounts?.deploymentOwner(s.deployment.id);
        const alloc = s.deployment.allocationUsd || 1;
        return {
          deploymentId: s.deployment.id,
          strategyId: s.deployment.strategy.id,
          strategy: s.deployment.strategy,
          name: s.deployment.strategy.name,
          // Anonymous: who runs a strategy is never shown.
          author: null,
          tags: s.deployment.strategy.tags,
          status: s.deployment.status,
          mode: s.deployment.mode,
          returnPct: s.returnPct,
          openPositions: s.positions.length,
          /** Return in percent over time (never dollar amounts). */
          returnCurve: s.equityCurve.slice(-60).map(([ts, eq]) => [ts, (eq / alloc - 1) * 100] as [number, number]),
          since: s.deployment.createdAt,
        };
      })
      .sort((a, b) => b.returnPct - a.returnPct);
    return c.json({ rows });
  });

  /** Owner: show (or hide) a live run's return on the leaderboard. */
  app.post("/deployments/:id/share", async (c) => {
    const user = await requireUser(c);
    const id = c.req.param("id");
    const snap = await engine.getSnapshot(id);
    if (!snap) return c.json({ error: "not found" }, 404);
    assertOwner(accounts?.deploymentOwner(id), user);
    if (snap.deployment.mode !== "live" || snap.deployment.alertsOnly) return c.json({ error: "only live runs can be shared" }, 400);
    const { shared } = z.object({ shared: z.boolean() }).parse(await c.req.json());
    accounts?.setShared(id, shared);
    return c.json({ shared });
  });

  let statsCache: { at: number; body: unknown } | null = null;
  app.get("/stats", async (c) => {
    if (statsCache && Date.now() - statsCache.at < 30_000) return c.json(statsCache.body);
    const records = (await engine.listDeployments()).filter((d) => allowPaper || d.mode === "live");
    const snaps = (await Promise.all(records.map((d) => engine.getSnapshot(d.id)))).filter((s) => s != null);
    const fills = (await Promise.all(records.map((d) => engine.getFills(d.id)))).flat();
    const body = {
      deployments: records.length,
      running: records.filter((d) => d.status === "running").length,
      strategies: library.list().length,
      fills: fills.length,
      volumeUsd: fills.reduce((n, f) => n + f.qty * f.price, 0),
      feesUsd: fills.reduce((n, f) => n + f.feeUsd, 0),
      builderFeesUsd: snaps.reduce((n, s) => n + ((s as { builderFeesUsd?: number }).builderFeesUsd ?? 0), 0),
    };
    statsCache = { at: Date.now(), body };
    return c.json(body);
  });

  return app;
}
