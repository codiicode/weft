import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { examples } from "@weft/strategy/examples";
import { RiskCaps, toGraph, validateStrategy, type Instrument } from "@weft/strategy";
import { Instrument as InstrumentSchema } from "@weft/strategy";
import type { Catalog, MarketData, Product } from "@weft/venues";
import type { Engine, EngineEvent } from "@weft/engine";
import type { StrategyLibrary } from "./lib/library.ts";
import { generateStrategy, GenerationError } from "./ai/generate.ts";
import { runBacktest, type BacktestDeps } from "./backtest/run.ts";
import type { Notifier } from "./lib/alerts.ts";
import { AuthError, LOCAL_USER, type AuthUser, type Authenticator } from "./lib/auth.ts";
import type { Accounts } from "./lib/accounts.ts";

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
}

const PRODUCTS = ["perps", "stocks", "predictions", "tokens", "options"] as const;

const DeployBody = z.object({
  strategy: z.unknown().optional(),
  strategyId: z.string().optional(),
  allocationUsd: z.number().positive().max(10_000_000).default(10_000),
  caps: RiskCaps.optional(),
  intervalSec: z.number().int().min(5).max(3_600).optional(),
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
  const app = new Hono();

  /** The signed-in user, LOCAL_USER in local mode, or null for anonymous requests. */
  const optionalUser = async (c: Context): Promise<AuthUser | null> => {
    if (!authEnabled) return LOCAL_USER;
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
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

  app.use("*", cors({ origin: (o) => o ?? "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    const issues = (err as { issues?: unknown }).issues;
    if (issues) return c.json({ error: err.message, issues }, 400);
    console.error(err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, ts: Date.now(), signals: deps.signalModes, auth: { enabled: authEnabled, appId: deps.auth?.appId ?? null } }));

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
    const rows = await catalog.list(product, { search: c.req.query("search") ?? undefined, limit: Number(c.req.query("limit") ?? 50) });
    return c.json({ product, rows });
  });

  app.post("/quote", async (c) => {
    const body = await c.req.json();
    const instrument = InstrumentSchema.parse(body.instrument) as Instrument;
    const quote = await marketData.getQuote(instrument, { side: body.side, sizeUsd: body.sizeUsd });
    return c.json(quote);
  });

  /* ---------------- Strategies ---------------- */

  app.get("/strategies", (c) => c.json({ strategies: library.list() }));
  app.get("/strategies/examples", (c) => c.json({ strategies: examples }));

  app.get("/strategies/:id", (c) => {
    const e = library.get(c.req.param("id"));
    return e ? c.json({ ...e, graph: toGraph(e.strategy) }) : c.json({ error: "not found" }, 404);
  });

  app.post("/strategies/validate", async (c) => {
    const body = await c.req.json();
    const v = validateStrategy(body.strategy ?? body);
    return c.json(v.ok ? { ok: true, strategy: v.strategy, warnings: v.warnings, graph: toGraph(v.strategy) } : v, v.ok ? 200 : 422);
  });

  app.post("/strategies", async (c) => {
    const user = await requireUser(c);
    const body = await c.req.json();
    const entry = library.save(body.strategy ?? body, { author: String(body.author ?? "@anon").slice(0, 40) });
    accounts?.setStrategyOwner(entry.id, user.id);
    return c.json(entry, 201);
  });

  app.put("/strategies/:id", async (c) => {
    const user = await requireUser(c);
    const id = c.req.param("id");
    if (!library.get(id)) return c.json({ error: "not found" }, 404);
    assertOwner(accounts?.strategyOwner(id), user);
    const body = await c.req.json();
    return c.json(library.save(body.strategy ?? body, { author: "", replaceId: id }));
  });

  app.post("/strategies/:id/fork", async (c) => {
    const user = await requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const entry = library.fork(c.req.param("id"), String((body as { author?: string }).author ?? "@anon").slice(0, 40));
    if (entry) accounts?.setStrategyOwner(entry.id, user.id);
    return entry ? c.json(entry, 201) : c.json({ error: "not found" }, 404);
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
    if (authEnabled && c.req.query("scope") !== "all") {
      const user = await optionalUser(c);
      const mine = user && accounts ? accounts.deploymentsOf(user.id) : new Set<string>();
      records = records.filter((d) => mine.has(d.id));
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
    const record = await engine.createDeployment({
      strategy: v.strategy,
      mode: "paper",
      allocationUsd: body.allocationUsd,
      caps: body.caps,
      intervalSec: body.intervalSec,
    });
    accounts?.setDeploymentOwner(record.id, user.id);
    // First tick right away so the UI has data immediately.
    engine.tick(record.id).catch((e) => console.error("first tick failed", e));
    return c.json(record, 201);
  });

  app.get("/deployments/:id", async (c) => {
    const s = await engine.getSnapshot(c.req.param("id"));
    return s ? c.json({ ...s, graph: toGraph(s.deployment.strategy) }) : c.json({ error: "not found" }, 404);
  });
  app.get("/deployments/:id/events", async (c) =>
    c.json({ events: await engine.getEvents(c.req.param("id"), { sinceTs: Number(c.req.query("since") ?? 0) || undefined, limit: Number(c.req.query("limit") ?? 200) }) })
  );
  app.get("/deployments/:id/fills", async (c) => c.json({ fills: await engine.getFills(c.req.param("id")) }));

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
    const user = only ? null : await optionalUser(c);
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

  /* ---------------- Alerts (Telegram / webhook) ---------------- */

  app.get("/alerts", (c) =>
    c.json({
      sinks: deps.notifier?.sinks ?? [],
      configured: (deps.notifier?.sinks.length ?? 0) > 0,
      recent: deps.notifier?.recent().slice(0, 20) ?? [],
      help: "Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and/or WEFT_ALERT_WEBHOOK_URL, then restart the API.",
    })
  );
  app.post("/alerts/test", async (c) => {
    if (!deps.notifier?.sinks.length) return c.json({ error: "no alert sinks configured" }, 400);
    await deps.notifier.test();
    return c.json({ ok: true });
  });

  /* ---------------- Leaderboard & stats ---------------- */

  app.get("/leaderboard", async (c) => {
    const records = await engine.listDeployments();
    const snaps = (await Promise.all(records.map((d) => engine.getSnapshot(d.id)))).filter((s) => s != null);
    const rows = snaps
      .map((s) => ({
        deploymentId: s.deployment.id,
        strategyId: s.deployment.strategy.id,
        name: s.deployment.strategy.name,
        tags: s.deployment.strategy.tags,
        status: s.deployment.status,
        mode: s.deployment.mode,
        returnPct: s.returnPct,
        equityUsd: s.equityUsd,
        openPositions: s.positions.length,
        equityCurve: s.equityCurve.slice(-60),
        since: s.deployment.createdAt,
      }))
      .sort((a, b) => b.returnPct - a.returnPct);
    return c.json({ rows });
  });

  app.get("/stats", async (c) => {
    const records = await engine.listDeployments();
    const snaps = (await Promise.all(records.map((d) => engine.getSnapshot(d.id)))).filter((s) => s != null);
    const fills = (await Promise.all(records.map((d) => engine.getFills(d.id)))).flat();
    return c.json({
      deployments: records.length,
      running: records.filter((d) => d.status === "running").length,
      strategies: library.list().length,
      fills: fills.length,
      volumeUsd: fills.reduce((n, f) => n + f.qty * f.price, 0),
      feesUsd: fills.reduce((n, f) => n + f.feeUsd, 0),
      builderFeesUsd: snaps.reduce((n, s) => n + ((s as { builderFeesUsd?: number }).builderFeesUsd ?? 0), 0),
    });
  });

  return app;
}
