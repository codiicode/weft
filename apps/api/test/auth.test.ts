import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { Catalog } from "@weft/venues";
import type { DeploymentRecord, Engine } from "@weft/engine";
import { createApp } from "../src/app.ts";
import { createAuthenticator } from "../src/lib/auth.ts";
import { Accounts } from "../src/lib/accounts.ts";
import { StrategyLibrary } from "../src/lib/library.ts";

const APP_ID = "test-app-id";
let keys: { publicKey: CryptoKey; privateKey: CryptoKey };

const token = (sub: string, over: { aud?: string; iss?: string; exp?: string } = {}) =>
  new SignJWT({ sid: "s" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject(sub)
    .setIssuer(over.iss ?? "privy.io")
    .setAudience(over.aud ?? APP_ID)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "1h")
    .sign(keys.privateKey);

const catalog: Catalog = { list: async () => [] };

function fakeEngine(): Engine {
  const recs: DeploymentRecord[] = [];
  return {
    async createDeployment(i) {
      const d: DeploymentRecord = { id: `d${recs.length + 1}`, strategy: i.strategy, mode: "paper", allocationUsd: i.allocationUsd, caps: {}, status: "running", intervalSec: 30, createdAt: 1, updatedAt: 1 };
      recs.push(d);
      return d;
    },
    listDeployments: async () => recs,
    getSnapshot: async (id) => {
      const d = recs.find((r) => r.id === id);
      return d ? { deployment: d, equityUsd: 1, cashUsd: 1, realizedPnlUsd: 0, unrealizedPnlUsd: 0, returnPct: 0, positions: [], triggers: [], signalValues: {}, lastTickAt: null, equityCurve: [] } : null;
    },
    getEvents: async () => [],
    getFills: async () => [],
    pause: async (id) => void (recs.find((r) => r.id === id)!.status = "paused"),
    resume: async () => {},
    stop: async () => {},
    kill: async () => {},
    tick: async () => {},
    start() {},
    shutdown: async () => {},
    subscribe: () => () => {},
  };
}

function setup(opts: { aiDailyLimit?: number; anonAiDailyLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "weft-auth-"));
  const accounts = new Accounts(join(dir, "accounts.db"));
  const app = createApp({
    catalog,
    marketData: { getQuote: async () => ({ instrumentKey: "x", price: 1, ts: 0, source: "t" }) },
    engine: fakeEngine(),
    library: new StrategyLibrary(join(dir, "lib.db")),
    signalModes: {},
    auth: createAuthenticator({ appId: APP_ID, keyResolver: keys.publicKey }),
    accounts,
    aiDailyLimit: opts.aiDailyLimit,
    anonAiDailyLimit: opts.anonAiDailyLimit,
  });
  const call = async (method: string, path: string, body?: unknown, tok?: string) =>
    app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { app, call, accounts };
}

beforeAll(async () => {
  keys = (await generateKeyPair("ES256")) as typeof keys;
});

describe("Privy auth", () => {
  it("public reads work anonymously; writes need a valid token", async () => {
    const { call } = setup();
    expect((await call("GET", "/strategies")).status).toBe(200);
    expect((await call("GET", "/health")).status).toBe(200);
    expect(((await (await call("GET", "/health")).json()) as { auth: { enabled: boolean } }).auth.enabled).toBe(true);
    expect((await call("POST", "/deployments", { strategyId: "crowded-fade", allocationUsd: 1000 })).status).toBe(401);
    expect((await call("POST", "/strategies", { strategy: {} })).status).toBe(401);
  });

  it("lets visitors draft a few strategies without an account, counted per IP", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // template mode, no network
    const { app } = setup({ anonAiDailyLimit: 2 });
    const draft = (ip: string) =>
      app.request("/ai/generate", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` }, body: JSON.stringify({ thesis: "long btc 2x if it drops 5% in a day" }) });
    expect((await draft("1.1.1.1")).status).toBe(200);
    expect((await draft("1.1.1.1")).status).toBe(200);
    const third = await draft("1.1.1.1");
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toMatch(/Sign in/);
    expect((await draft("2.2.2.2")).status).toBe(200); // another visitor has their own count
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });

  it("rejects tokens for another app, another issuer, or expired ones", async () => {
    const { call } = setup();
    for (const t of [await token("did:privy:a", { aud: "other-app" }), await token("did:privy:a", { iss: "evil" }), await token("did:privy:a", { exp: "-1m" })]) {
      expect((await call("POST", "/deployments", { strategyId: "crowded-fade" }, t)).status).toBe(401);
    }
  });

  it("deployments belong to their creator: listed for them, controllable only by them", async () => {
    const { call, accounts } = setup();
    const alice = await token("did:privy:alice");
    const bob = await token("did:privy:bob");
    const res = await call("POST", "/deployments", { strategyId: "crowded-fade", allocationUsd: 1000, alertsOnly: true }, alice);
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect(accounts.deploymentOwner(id)).toBe("did:privy:alice");
    expect(accounts.get("did:privy:alice")).not.toBeNull();

    const list = async (t?: string, q = "") => ((await (await call("GET", `/deployments${q}`, undefined, t)).json()) as { deployments: unknown[] }).deployments.length;
    expect(await list(alice)).toBe(1);
    expect(await list(bob)).toBe(0);
    expect(await list()).toBe(0);
    expect(await list(undefined, "?scope=all")).toBe(0); // nobody else's runs are listed
    expect(await list(alice, "?scope=all")).toBe(1);
    expect((await call("GET", `/deployments/${id}`)).status).toBe(200); // runs are publicly readable

    expect((await call("POST", `/deployments/${id}/pause`, {}, bob)).status).toBe(403);
    expect((await call("POST", `/deployments/${id}/pause`, {}, alice)).status).toBe(200);
  });

  it("trades with real money only: no paper runs, and only live runs can be shared", async () => {
    const { call } = setup();
    const alice = await token("did:privy:alice");
    const paper = await call("POST", "/deployments", { strategyId: "crowded-fade", allocationUsd: 1000 }, alice);
    expect(paper.status).toBe(400);
    expect(((await paper.json()) as { error: string }).error).toMatch(/real money/);
    const alerts = await call("POST", "/deployments", { strategyId: "crowded-fade", allocationUsd: 1000, alertsOnly: true }, alice);
    const id = ((await alerts.json()) as { id: string }).id;
    expect((await call("POST", `/deployments/${id}/share`, { shared: true }, alice)).status).toBe(400);
    const board = (await (await call("GET", "/leaderboard")).json()) as { rows: unknown[] };
    expect(board.rows).toHaveLength(0);
  });

  it("strategies: owner edits and deletes, others fork", async () => {
    const { call } = setup();
    const alice = await token("did:privy:alice");
    const bob = await token("did:privy:bob");
    const ex = ((await (await call("GET", "/strategies/examples")).json()) as { strategies: { id: string }[] }).strategies[0]!;
    const saved = (await (await call("POST", "/strategies", { strategy: { ...ex, id: "alices-plan" } }, alice)).json()) as { id: string; strategy: unknown };
    expect((await call("DELETE", `/strategies/${saved.id}`, undefined, bob)).status).toBe(403);
    expect((await call("PUT", `/strategies/${saved.id}`, { strategy: saved.strategy }, bob)).status).toBe(403);
    const fork = await call("POST", `/strategies/${saved.id}/fork`, {}, bob);
    expect(fork.status).toBe(201);
    const forkId = ((await fork.json()) as { id: string }).id;
    expect((await call("DELETE", `/strategies/${forkId}`, undefined, bob)).status).toBe(200);
    expect((await call("DELETE", `/strategies/${saved.id}`, undefined, alice)).status).toBe(200);
    // seeded examples have no owner: nobody can delete them once sign-in is on
    expect((await call("DELETE", `/strategies/crowded-fade`, undefined, alice)).status).toBe(403);
  });

  it("caps AI generations per user per day", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // template mode, no network
    const { call } = setup({ aiDailyLimit: 2 });
    const alice = await token("did:privy:alice");
    for (let i = 0; i < 2; i++) expect((await call("POST", "/ai/generate", { thesis: "hello world thesis" }, alice)).status).toBe(200);
    const third = await call("POST", "/ai/generate", { thesis: "hello world thesis" }, alice);
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toMatch(/daily AI limit/);
    const me = (await (await call("GET", "/me", undefined, alice)).json()) as { ai: { usedToday: number; dailyLimit: number } };
    expect(me.ai).toEqual({ usedToday: 2, dailyLimit: 2 });
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});
