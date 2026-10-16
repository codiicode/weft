import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { clampQuery, connectionCap, rateLimit } from "./lib/ratelimit.ts";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { examples } from "@weft/strategy/examples";
import { RiskCaps, toGraph, validateStrategy, type Instrument } from "@weft/strategy";
import { Instrument as InstrumentSchema } from "@weft/strategy";
import { INTERVAL_MS, type CandleInterval, type Catalog, type MarketData, type Product } from "@weft/venues";
import type { Engine, EngineEvent } from "@weft/engine";
import type { StrategyLibrary } from "./lib/library.ts";
import { generateStrategy, GenerationError } from "./ai/generate.ts";
import { runBacktest, type BacktestDeps } from "./backtest/run.ts";
import type { Notifier } from "./lib/alerts.ts";
import { AuthError, LOCAL_USER, type AuthUser, type Authenticator } from "./lib/auth.ts";
import type { TelegramBot } from "./lib/telegram.ts";
import type { Accounts } from "./lib/accounts.ts";
import type { LiveService } from "./live/service.ts";
import { SECOND_INTERVALS, type SecondInterval, type TradeTape } from "./lib/tape.ts";
import { tradesSolana, type SolanaLive } from "./live/solana.ts";
import type { HlDeposits } from "./live/deposits.ts";
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
  /** Live trading on Hyperliquid. Absent: paper only. */
  live?: LiveService;
  /**
   * Paper (simulated) runs. Off on the hosted service: Weft trades with real money only, and
   * simulated trading is limited to backtests and alerts-only runs. Local development keeps it.
   */
  allowPaper?: boolean;
  /** Live Solana token trading (the user's own Privy wallet, Weft as a limited signer). */
  solana?: SolanaLive;
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
}

const PRODUCTS = ["perps", "stocks", "predictions", "tokens", "options"] as const;

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
  const allowPaper = deps.allowPaper ?? !authEnabled;
  const app = new Hono();

  /** The signed-in user, LOCAL_USER in local mode, or null for anonymous requests. */
  const optionalUser = async (c: Context): Promise<AuthUser | null> => {
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
  const checkAiQuota = (user: AuthUser) => {
    if (!authEnabled || !accounts) return;
    if (accounts.aiUsedToday(user.id) >= aiDailyLimit)
      throw new HTTPException(429, { message: `daily AI limit reached (${aiDailyLimit} strategies per day)` });
    accounts.recordAiUse(user.id);
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
    if (!snap || snap.deployment.mode !== "live" || !authEnabled) return true;
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

  app.get("/health", (c) =>
    c.json({
      ok: true,
      ts: Date.now(),
      signals: deps.signalModes,
      auth: { enabled: authEnabled, appId: deps.auth?.appId ?? null },
      /** Which venues take real orders right now. */
      trading: { hyperliquid: Boolean(deps.live?.cfg.enabled), solana: Boolean(deps.solana?.cfg.enabled), network: deps.live?.cfg.network ?? null },
    })
  );

  /* ---------------- Me ---------------- */

  app.get("/me", async (c) => {
    const user = await optionalUser(c);
    return c.json({
      authEnabled,
      user: user ? (accounts?.get(user.id) ?? { id: user.id }) : null,
      ai: user ? { usedToday: accounts?.aiUsedToday(user.id) ?? 0, dailyLimit: authEnabled ? aiDailyLimit : null } : null,
    });
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
    const user = await requireUser(c);
    const { thesis } = z.object({ thesis: z.string().min(3).max(2_000) }).parse(await c.req.json());
    checkAiQuota(user);
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
    const user = await requireUser(c);
    const { thesis } = z.object({ thesis: z.string().min(3).max(2_000) }).parse(await c.req.json());
    checkAiQuota(user);
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
    const user = await requireUser(c);
    const body = z.object({ strategy: z.unknown(), instruction: z.string().min(2).max(1_000) }).parse(await c.req.json());
    const base = validateStrategy(body.strategy);
    if (!base.ok) return c.json({ error: "invalid strategy", issues: base.errors }, 400);
    checkAiQuota(user);
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
    await requireUser(c);
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

  app.post("/deployments", async (c) => {
    const user = await requireUser(c);
    const body = DeployBody.parse(await c.req.json());
    let raw = body.strategy;
    if (!raw && body.strategyId) raw = library.get(body.strategyId)?.strategy;
    const v = validateStrategy(raw);
    if (!v.ok) return c.json({ error: "invalid strategy", issues: v.errors }, 422);
    const strategy = v.strategy;
    if (body.mode === "paper" && !body.alertsOnly && !allowPaper)
      return c.json({ error: "Weft trades with real money only. Start it live, or as alerts only." }, 400);
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
      if (tradesSolana(v.strategy)) {
        if (!deps.solana) return c.json({ error: "Solana trading is not configured on this server" }, 501);
        const mints = new Set<string>();
        for (const d of await engine.listDeployments()) {
          if (d.mode !== "live" || !mineAll.has(d.id) || d.status === "stopped" || d.status === "killed") continue;
          for (const a of d.strategy.actions) if (a.type === "open" && a.instrument.kind === "token") mints.add(a.instrument.mint);
        }
        try {
          deps.solana.assertDeployable(user.id, v.strategy, body.allocationUsd, mints);
        } catch (e) {
          return c.json({ error: (e as Error).message }, 409);
        }
        const total = deps.liveMaxTotalUsd ?? deps.solana.cfg.maxAllocationUsd * 5;
        const open = await openLive();
        if (open + body.allocationUsd > total)
          return c.json({ error: `you already have $${open.toLocaleString()} live; the limit across all live runs is $${total.toLocaleString()}` }, 409);
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
        deps.live.assertDeployable(user.id, v.strategy, body.allocationUsd, others);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 409);
      }
      // A ceiling on everything this user has live at once, not just per run.
      const total = deps.liveMaxTotalUsd ?? deps.live.cfg.maxAllocationUsd * 5;
      let open = 0;
      for (const d of await engine.listDeployments())
        if (d.mode === "live" && mine.has(d.id) && (d.status === "running" || d.status === "paused")) open += d.allocationUsd;
      if (open + body.allocationUsd > total)
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

  /** Plans waiting for the owner's confirmation (10 minutes). */
  const plans = new Map<string, { userId: string; deploymentId: string; steps: Step[]; expires: number }>();

  /** Turn a plain instruction into reviewable steps (nothing happens yet). */
  app.post("/deployments/:id/instruct", async (c) => {
    const { user, id, snap } = await ownedRun(c);
    const { text } = z.object({ text: z.string().min(2).max(500) }).parse(await c.req.json());
    let steps: Step[] | null;
    let rationale = "";
    try {
      steps = parseInstruction(text, snap.positions);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
    if (!steps) {
      // Anything else: Claude edits the rules (counts toward the daily AI limit).
      checkAiQuota(user);
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
    for (const [k, p] of plans) if (p.expires < Date.now()) plans.delete(k);
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
          await engine.setExits!(id, s.patch, s.positionIds);
          const cur = await engine.getSnapshot(id);
          if (cur) await engine.updateStrategy!(id, withExits(cur.deployment.strategy, s.patch));
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
