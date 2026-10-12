import { Hono } from "hono";
import { cors } from "hono/cors";
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
  const { catalog, marketData, engine, library } = deps;
  const app = new Hono();

  app.use("*", cors({ origin: (o) => o ?? "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));

  app.onError((err, c) => {
    const issues = (err as { issues?: unknown }).issues;
    if (issues) return c.json({ error: err.message, issues }, 400);
    console.error(err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, ts: Date.now(), signals: deps.signalModes }));

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
    const body = await c.req.json();
    const entry = library.save(body.strategy ?? body, { author: String(body.author ?? "@anon") });
    return c.json(entry, 201);
  });

  app.put("/strategies/:id", async (c) => {
    const id = c.req.param("id");
    if (!library.get(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    return c.json(library.save(body.strategy ?? body, { author: "", replaceId: id }));
  });

  app.post("/strategies/:id/fork", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const entry = library.fork(c.req.param("id"), String((body as { author?: string }).author ?? "@anon"));
    return entry ? c.json(entry, 201) : c.json({ error: "not found" }, 404);
  });

  app.delete("/strategies/:id", (c) => (library.delete(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  /* ---------------- AI: thesis → strategy ---------------- */

  app.post("/ai/generate", async (c) => {
    const { thesis } = z.object({ thesis: z.string().min(3).max(2_000) }).parse(await c.req.json());
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

  app.get("/deployments", async (c) => {
    const records = await engine.listDeployments();
    const snaps = await Promise.all(records.map((d) => engine.getSnapshot(d.id)));
    return c.json({ deployments: snaps.filter(Boolean) });
  });

  app.post("/deployments", async (c) => {
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
      const id = c.req.param("id");
      if (!(await engine.getSnapshot(id))) return c.json({ error: "not found" }, 404);
      await engine[action](id);
      return c.json(await engine.getSnapshot(id));
    });
  }

  /** Live engine events. Optional ?deploymentId= filter. */
  app.get("/events/stream", (c) => {
    const only = c.req.query("deploymentId");
    return streamSSE(c, async (stream) => {
      const queue: EngineEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = engine.subscribe((e) => {
        if (only && e.deploymentId !== only) return;
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
