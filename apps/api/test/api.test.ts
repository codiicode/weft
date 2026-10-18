import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Instrument } from "@weft/strategy";
import type { Catalog, MarketListing, Product } from "@weft/venues";
import type { DeploymentRecord, DeploymentSnapshot, Engine, EngineEvent } from "@weft/engine";
import { templateStrategy } from "../src/ai/template.ts";
import { SYSTEM_PROMPT } from "../src/ai/prompt.ts";
import { StrategyLibrary } from "../src/lib/library.ts";
import { createApp } from "../src/app.ts";

const MINT = "BonkExampLeMint1111111111111111111111111111";

const listing = (product: Product, instrument: Instrument, label: string, price: number, extra: Partial<MarketListing> = {}): MarketListing => ({
  product,
  instrument,
  instrumentKey: label,
  label,
  price,
  venue: "test",
  ...extra,
});

const fakeCatalog: Catalog = {
  async list(product, q) {
    const s = (q?.search ?? "").toUpperCase();
    const rows: MarketListing[] = {
      tokens: [listing("tokens", { kind: "token", chain: "solana", mint: MINT, symbol: "BONK", quote: "SOL", route: "auto", assetClass: "crypto" }, "$BONK", 0.00002)],
      perps: [
        listing("perps", { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" }, "BTC", 118_000),
        listing("perps", { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" }, "ETH", 4_600),
      ],
      stocks: [listing("stocks", { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" }, "xyz:NVDA", 184)],
      predictions: [listing("predictions", { kind: "outcome", venue: "hyperliquid", market: "fed-dec", outcome: "YES", question: "Fed cuts in December?" }, "Fed cuts in December? · YES", 0.64, { name: "Fed cuts in December?" })],
      options: [],
      pools: [],
      papertrade: [], lending: [],
    }[product];
    return rows.filter((r) => !s || r.label.toUpperCase().includes(s) || (r.name ?? "").toUpperCase().includes(s));
  },
};

describe("template generator", () => {
  it("resolves a cashtag to a real mint and uses the user's price level and size", async () => {
    const r = await templateStrategy("Köp $BONK när den går till 0.000018 och sentimentet är bullish, 0.25 SOL", fakeCatalog);
    expect(r.source).toBe("template");
    const buy = r.strategy.actions.find((a) => a.type === "open");
    expect(buy?.type === "open" && buy.instrument.kind === "token" && buy.instrument.mint).toBe(MINT);
    expect(buy?.type === "open" && buy.size).toEqual({ unit: "native", value: 0.25 });
    expect(JSON.stringify(r.strategy.triggers)).toContain("0.000018");
    expect(r.strategy.signals.map((s) => s.kind).sort()).toEqual(["price", "token_onchain"]);
  });

  it("understands percentage dips and ignores SOL sizes as price levels", async () => {
    const r = await templateStrategy("Buy $BONK when it dips 5% and sentiment turns bullish, 0.5 SOL", fakeCatalog);
    const cond = JSON.stringify(r.strategy.triggers[0]!.when);
    expect(cond).toContain('"ref":"px.change_24h_pct"');
    expect(cond).toContain('"value":-5');
    expect(cond).not.toContain('"ref":"px.price"');
  });

  it("falls back to an alerts-only watcher when a token can't be resolved", async () => {
    const r = await templateStrategy("Ape into $NOPE before it rips", fakeCatalog);
    expect(r.strategy.actions.every((a) => a.type === "notify")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/alerts-only/);
  });

  it("routes macro theses to prediction markets + perps", async () => {
    const r = await templateStrategy("The Fed cuts in December and nobody is positioned", fakeCatalog);
    const outcome = r.strategy.actions.find((a) => a.type === "open" && a.instrument.kind === "outcome");
    expect(outcome?.type === "open" && outcome.instrument.kind === "outcome" && outcome.instrument.market).toBe("fed-dec");
  });

  it("routes stock theses to HIP-3 perps", async () => {
    const r = await templateStrategy("NVDA rips into earnings", fakeCatalog);
    const open = r.strategy.actions.find((a) => a.type === "open");
    expect(open?.type === "open" && open.instrument.kind === "perp" && open.instrument.dex).toBe("xyz");
  });

  it("always returns a valid strategy", async () => {
    for (const t of ["", "hello world", "short ETH if funding is crowded", "long ETH 20x if it breaks 2600"]) {
      const r = await templateStrategy(t || "x y z", fakeCatalog);
      expect(r.strategy.schemaVersion).toBe(1);
    }
  });
});

describe("system prompt", () => {
  it("documents every signal kind and stays deterministic", () => {
    for (const k of ["price", "funding", "token_onchain", "social", "odds", "position"]) expect(SYSTEM_PROMPT).toContain(`- ${k}:`);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/); // no timestamps → cacheable
  });
});

/* ---------------- HTTP routes with a fake engine ---------------- */

function fakeEngine(): Engine & { created: DeploymentRecord[] } {
  const created: DeploymentRecord[] = [];
  const listeners = new Set<(e: EngineEvent) => void>();
  const snap = (d: DeploymentRecord): DeploymentSnapshot => ({
    deployment: d,
    equityUsd: d.allocationUsd * 1.05,
    cashUsd: d.allocationUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: d.allocationUsd * 0.05,
    returnPct: 5,
    positions: [],
    triggers: [],
    signalValues: {},
    lastTickAt: null,
    equityCurve: [],
  });
  return {
    created,
    async createDeployment(input) {
      const d: DeploymentRecord = { id: `dep_${created.length + 1}`, strategy: input.strategy, mode: "paper", allocationUsd: input.allocationUsd, caps: input.caps ?? {}, status: "running", intervalSec: input.intervalSec ?? 30, createdAt: 1, updatedAt: 1, ...(input.alertsOnly ? { alertsOnly: true } : {}) };
      created.push(d);
      return d;
    },
    async listDeployments() {
      return created;
    },
    async getSnapshot(id) {
      const d = created.find((x) => x.id === id);
      return d ? snap(d) : null;
    },
    async getEvents() {
      return [];
    },
    async getFills() {
      return [];
    },
    async pause(id) {
      created.find((x) => x.id === id)!.status = "paused";
    },
    async resume(id) {
      created.find((x) => x.id === id)!.status = "running";
    },
    async stop(id) {
      created.find((x) => x.id === id)!.status = "stopped";
    },
    async kill(id) {
      created.find((x) => x.id === id)!.status = "killed";
    },
    async tick() {},
    start() {},
    async shutdown() {},
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

describe("HTTP API", () => {
  let app: ReturnType<typeof createApp>;
  let engine: ReturnType<typeof fakeEngine>;

  beforeEach(() => {
    engine = fakeEngine();
    const library = new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-api-")), "lib.db"));
    app = createApp({
      catalog: fakeCatalog,
      marketData: { async getQuote() { return { instrumentKey: "x", price: 1, ts: 0, source: "test" }; } },
      engine,
      library,
      signalModes: {},
    });
  });

  const call = (path: string, init?: RequestInit) => app.request(path, init);
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("seeds the library with examples, and forks", async () => {
    const list = (await (await call("/strategies")).json()) as { strategies: { id: string }[] };
    expect(list.strategies.length).toBeGreaterThanOrEqual(6);
    const fork = await post(`/strategies/${list.strategies[0]!.id}/fork`, { author: "@me" });
    expect(fork.status).toBe(201);
    const f = (await fork.json()) as { forkedFrom: string; strategy: { id: string } };
    expect(f.forkedFrom).toBe(list.strategies[0]!.id);
    expect(f.strategy.id).toMatch(/-fork/);
  });

  it("validates and returns a graph, or 422 with issues", async () => {
    const ex = ((await (await call("/strategies/examples")).json()) as { strategies: unknown[] }).strategies[0];
    const ok = await post("/strategies/validate", { strategy: ex });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { graph: { edges: unknown[] } }).graph.edges.length).toBeGreaterThan(0);
    const bad = await post("/strategies/validate", { strategy: { schemaVersion: 1 } });
    expect(bad.status).toBe(422);
  });

  it("generates from a thesis (template mode without credentials)", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const r = await post("/ai/generate", { thesis: "buy $BONK at 0.000018 if sentiment is bullish" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; graph: { nodes: unknown[] } };
    expect(body.source).toBe("template");
    expect(body.graph.nodes.length).toBeGreaterThan(3);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });

  it("deploys a library strategy to paper and controls it", async () => {
    const list = (await (await call("/strategies")).json()) as { strategies: { id: string }[] };
    const dep = await post("/deployments", { strategyId: list.strategies[0]!.id, allocationUsd: 5_000 });
    expect(dep.status).toBe(201);
    const id = ((await dep.json()) as { id: string }).id;
    expect(((await (await post(`/deployments/${id}/pause`, {})).json()) as { deployment: { status: string } }).deployment.status).toBe("paused");
    const lb = (await (await call("/leaderboard")).json()) as { rows: { returnPct: number }[] };
    expect(lb.rows[0]!.returnPct).toBe(5);
    expect((await post("/deployments", { strategy: { nope: true }, allocationUsd: 1 })).status).toBe(422);
    const watch = await post("/deployments", { strategyId: list.strategies[0]!.id, allocationUsd: 1_000, alertsOnly: true });
    expect(watch.status).toBe(201);
    expect(((await watch.json()) as { alertsOnly?: boolean }).alertsOnly).toBe(true);
  });

  it("lists markets per product and 404s unknown products", async () => {
    const r = (await (await call("/markets/stocks?search=nvda")).json()) as { rows: MarketListing[] };
    expect(r.rows[0]!.label).toBe("xyz:NVDA");
    expect((await call("/markets/bonds")).status).toBe(404);
  });
});


describe("rate limits", async () => {
  const { rateLimit } = await import("../src/lib/ratelimit.ts");
  const { Hono } = await import("hono");
  it("limits per client IP and answers 429 with Retry-After", async () => {
    const app = new Hono();
    app.use("*", rateLimit("test", 60, 3));
    app.get("/", (c) => c.text("ok"));
    const hit = (ip: string) => app.request("/", { headers: { "x-forwarded-for": ip } });
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(200);
    const blocked = await hit("1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await hit("2.2.2.2")).status).toBe(200);
  });
});

describe("seeded examples", () => {
  it("pick up rule changes from the code, but keep resolved instruments when only wording changed", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { pumpMomentum, PUMP_MINT } = await import("@weft/strategy/examples");
    const file = join(mkdtempSync(join(tmpdir(), "weft-seed-")), "lib.db");
    new StrategyLibrary(file).close();
    const db = new DatabaseSync(file);
    // An old copy of the example: resolved mint, older wording, and an extra rule since removed.
    const old = JSON.parse(JSON.stringify(pumpMomentum).replaceAll(PUMP_MINT, "RealMint1111111111111111111111111111111111"));
    db.prepare("UPDATE strategies SET doc = ? WHERE id = ?").run(JSON.stringify({ ...old, name: "old name" }), pumpMomentum.id);
    new StrategyLibrary(file).close();
    let doc = JSON.parse((db.prepare("SELECT doc FROM strategies WHERE id = ?").get(pumpMomentum.id) as { doc: string }).doc);
    expect(doc.name).toBe(pumpMomentum.name);
    expect(JSON.stringify(doc)).toContain("RealMint"); // wording only: resolved mint kept
    db.prepare("UPDATE strategies SET doc = ? WHERE id = ?").run(JSON.stringify({ ...old, signals: [...old.signals, { id: "pump_social", kind: "social", params: { cashtags: ["PUMP"] } }] }), pumpMomentum.id);
    new StrategyLibrary(file).close();
    doc = JSON.parse((db.prepare("SELECT doc FROM strategies WHERE id = ?").get(pumpMomentum.id) as { doc: string }).doc);
    expect(doc.signals.map((s: { kind: string }) => s.kind)).not.toContain("social"); // rules changed: replaced
    db.close();
  });
});
