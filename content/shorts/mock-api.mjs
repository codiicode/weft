// A stand-in API for recording product videos: a signed-in demo user with made-up runs, positions
// and balances. Everything else (markets, traders, strategies, AI drafts, charts, backtests) is
// proxied to the real API, so that part of the footage is live.
//   node content/shorts/mock-api.mjs        → http://localhost:8788
// Pair it with a web build made with NEXT_PUBLIC_DEMO_USER and NEXT_PUBLIC_API_URL=http://localhost:8788.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const REAL = "https://weft-api-production.up.railway.app";
const readRec = (name) => JSON.parse(readFileSync(new URL(`./recordings/${name}`, import.meta.url), "utf8"));
const PORT = 8788;
const now = Date.now();
const H = 3_600_000, D = 24 * H;

const mids = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) }).then((r) => r.json());
const mid = (c) => Number(mids[c]);
const lib = async (id) => (await fetch(`${REAL}/strategies/${id}`).then((r) => r.json())).strategy;

const perp = (symbol) => ({ kind: "perp", venue: "hyperliquid", symbol, assetClass: "crypto" });
/** A position opened at `entry` with `margin` USD at `lev`×, marked at the live mid. */
function position(dep, actionId, symbol, side, margin, lev, entry, openedAgoH) {
  const mark = mid(symbol), qty = (margin * lev) / entry, dir = side === "long" ? 1 : -1;
  const pnl = qty * (mark - entry) * dir;
  return {
    id: `${dep}-${symbol}`, deploymentId: dep, actionId, instrument: perp(symbol), instrumentKey: `hyperliquid:perp:${symbol}`,
    side, qty, entryPrice: entry, sizeUsd: margin, leverage: lev, exits: {}, openedAt: now - openedAgoH * H,
    markPrice: mark, markedAt: now, unrealizedPnlUsd: pnl, unrealizedPnlPct: (pnl / margin) * 100, peakPrice: Math.max(entry, mark),
  };
}
/** A smooth, slightly noisy equity curve from `start` to `end` over `days`. */
function curve(start, end, days, seed = 1) {
  const pts = [], n = 120;
  for (let i = 0; i <= n; i++) {
    const x = i / n, wob = Math.sin(x * 9 + seed) * 0.012 + Math.sin(x * 23 + seed * 2) * 0.006;
    pts.push([Math.round(now - (1 - x) * days * D), +(start + (end - start) * (x * x * (3 - 2 * x)) + start * wob * (i === n ? 0 : 1)).toFixed(2)]);
  }
  return pts;
}
function snapshot({ id, strategy, allocationUsd, status = "running", createdAgoD, positions = [], realized = 0, fees = 0, triggersMet = {}, signalValues = {}, curveSeed = 1, invested = null }) {
  const unreal = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const margin = positions.reduce((s, p) => s + p.sizeUsd, 0);
  const equity = allocationUsd + realized + unreal - fees;
  return {
    deployment: { id, strategy, mode: "live", allocationUsd, caps: {}, status, intervalSec: 15, createdAt: now - createdAgoD * D, updatedAt: now, alertsOnly: false },
    equityUsd: equity, cashUsd: equity - margin - unreal, realizedPnlUsd: realized, unrealizedPnlUsd: unreal,
    returnPct: ((equity - allocationUsd) / allocationUsd) * 100, positions,
    triggers: strategy.triggers.map((t) => ({ id: t.id, value: !!triggersMet[t.id], met: !!triggersMet[t.id], fired: !!triggersMet[t.id], unknown: [] })),
    signalValues, lastTickAt: now - 6_000, equityCurve: curve(allocationUsd, equity, createdAgoD, curveSeed),
    feesUsd: fees, builderFeesUsd: fees, fundingUsd: 0, investedUsd: invested ?? (margin > 0 ? margin : null),
  };
}

// The demo account's runs.
const panic = await lib("buy-the-panic");
const breakout = await lib("eth-breakout-20x");
const fed = await lib("fed-pivot");
const cold = await lib("cold-snap");
const TRADER = "0xeadc152ac1014ace57c6b353f89adf5faffe9d55";
const copy = (() => { const txt = readRec("draft-copy.json").map(([, c]) => c).join(""); return JSON.parse(txt.slice(txt.lastIndexOf("data:") + 5).trim().split("\n")[0]).strategy; })();

const runs = [
  snapshot({ id: "demo-panic", strategy: panic, allocationUsd: 250, createdAgoD: 6, triggersMet: { extreme_fear: true }, signalValues: { "fear_greed.value": 23 },
    positions: [position("demo-panic", "long_eth", "ETH", "long", 100, 20, +(mid("ETH") * 0.968).toFixed(1), 30), position("demo-panic", "long_btc", "BTC", "long", 100, 20, Math.round(mid("BTC") * 0.981), 30)], fees: 4.0, curveSeed: 2 }),
  snapshot({ id: "demo-copy", strategy: copy, allocationUsd: 500, createdAgoD: 9, triggersMet: { btc_above_80k: true }, signalValues: { "btc_px.price": mid("BTC") }, realized: 61.4, fees: 3.1,
    positions: [position("demo-copy", "copy_trader", "HYPE", "long", 100, 5, +(mid("HYPE") * 0.955).toFixed(3), 14), position("demo-copy", "copy_trader", "SOL", "short", 100, 3, +(mid("SOL") * 1.021).toFixed(2), 5)], curveSeed: 4 }),
  snapshot({ id: "demo-fed", strategy: fed, allocationUsd: 300, createdAgoD: 3, signalValues: {}, curveSeed: 6 }),
  snapshot({ id: "demo-breakout", strategy: breakout, allocationUsd: 200, status: "stopped", createdAgoD: 12, realized: 38.2, fees: 2.0, curveSeed: 8, invested: 100 }),
];
/** The last check is always a few seconds ago. */
const fresh = (s) => ({ ...s, lastTickAt: Date.now() - 4_000 });
// FRESH=1: a brand-new account (no runs yet, $250 just deposited), for the first-trade video.
const FRESH = process.env.FRESH === "1";
const RUNS = new Map(FRESH ? [] : runs.map((r) => [r.deployment.id, r]));
const fill = (dep, id, sym, side, price, reason, agoMin, pnl) => ({ id, deploymentId: dep, positionId: `${dep}-${sym}`, instrumentKey: `hyperliquid:perp:${sym}`, side, qty: 1, price, feeUsd: 1.0, reason, ts: now - agoMin * 60_000, ...(pnl != null ? { realizedPnlUsd: pnl } : {}) });
const FILLS = {
  "demo-copy": [
    fill("demo-copy", "c4", "SOL", "sell", runs[1].positions[1].entryPrice, "entry", 300),
    fill("demo-copy", "c3", "HYPE", "buy", runs[1].positions[0].entryPrice, "entry", 840),
    fill("demo-copy", "c2", "ETH", "sell", +(mid("ETH") * 0.994).toFixed(1), "close_action", 1460, 41.2),
    fill("demo-copy", "c1", "ETH", "buy", +(mid("ETH") * 0.955).toFixed(1), "entry", 2900),
  ],
  "demo-panic": [
    { id: "f1", deploymentId: "demo-panic", positionId: "demo-panic-ETH", instrumentKey: "hyperliquid:perp:ETH", side: "buy", qty: 0.85, price: runs[0].positions[0].entryPrice, feeUsd: 2.0, reason: "entry", ts: now - 30 * H },
    { id: "f2", deploymentId: "demo-panic", positionId: "demo-panic-BTC", instrumentKey: "hyperliquid:perp:BTC", side: "buy", qty: 0.025, price: runs[0].positions[1].entryPrice, feeUsd: 2.0, reason: "entry", ts: now - 30 * H + 900 },
  ],
};

const ev = (dep, agoMin, type, message) => ({ id: `${dep}-${agoMin}-${type}`, deploymentId: dep, ts: now - agoMin * 60_000, type, message });
const EVENTS = {
  "demo-panic": [
    ev("demo-panic", 1800, "trigger_fired", "Crypto Fear & Greed hit 20"),
    ev("demo-panic", 1800, "fill", `Bought ETH-PERP at ${runs[0].positions[0].entryPrice.toLocaleString("en-US")}, $100 at 20×`),
    ev("demo-panic", 1800, "fill", `Bought BTC-PERP at ${runs[0].positions[1].entryPrice.toLocaleString("en-US")}, $100 at 20×`),
  ].reverse(),
  "demo-copy": [
    ev("demo-copy", 2900, "fill", "0xeadc…9d55 opened ETH long: bought ETH-PERP, $100 at 10×"),
    ev("demo-copy", 1460, "fill", "0xeadc…9d55 closed ETH: sold ETH-PERP, +$41.20"),
    ev("demo-copy", 840, "fill", "0xeadc…9d55 opened HYPE long: bought HYPE-PERP, $100 at 5×"),
    ev("demo-copy", 300, "fill", "0xeadc…9d55 opened SOL short: sold SOL-PERP, $100 at 3×"),
  ].reverse(),
};

const accountValue = FRESH ? 250 : 2400;
const LIVE_STATUS = {
  config: { enabled: true, network: "mainnet", builder: "0x0000000000000000000000000000000000000000", builderFeeBps: 10, maxAllocationUsd: null, maxLeverage: 20 },
  account: { userId: "demo", network: "mainnet", hlAddress: "0x5e2b7a40c3d91f6a8be0e4b1d7c2a9f03b6e91ad", agentApprovedAt: now - 20 * D, builderApprovedAt: now - 20 * D },
  agentAddress: "0x1111111111111111111111111111111111111111",
  venue: FRESH
    ? { accountValueUsd: accountValue, withdrawableUsd: accountValue, marginUsedUsd: 0, positionsWorthUsd: 0, agentApprovedOnVenue: true, builderMaxFeeTenthsBps: 1000 }
    : { accountValueUsd: accountValue, withdrawableUsd: 1462.5, marginUsedUsd: 600, positionsWorthUsd: 937.5, agentApprovedOnVenue: true, builderMaxFeeTenthsBps: 100 },
  ready: true, blockers: [],
};
const SOLANA = {
  enabled: true, signerId: "demo", policyId: "demo", wallet: { address: "7xKpQ2mVb9fQe4tLr8NcZs1Wd3Hy6Ju5Ag0Ek9fQe", delegated: true },
  balances: FRESH ? { sol: 0, usdc: 0, usd: 0 } : { sol: 3.2, usdc: 140, usd: 140 + 3.2 * 180 }, solUsd: 180, maxAllocationUsd: null, feeBps: 100, holder: null, ready: true, blockers: [],
};

const MOCK = [
  ["GET", /^\/deployments$/, () => ({ deployments: [...RUNS.values()].map(fresh) })],
  ["GET", /^\/deployments\/([^/]+)$/, (m) => (RUNS.has(m[1]) ? fresh(RUNS.get(m[1])) : [404, { error: "not found" }])],
  ["GET", /^\/deployments\/([^/]+)\/fills$/, (m) => ({ fills: FILLS[m[1]] ?? [] })],
  ["GET", /^\/deployments\/([^/]+)\/events$/, (m) => ({ events: EVENTS[m[1]] ?? (RUNS.has(m[1]) ? [{ id: `${m[1]}-start`, deploymentId: m[1], ts: RUNS.get(m[1]).deployment.createdAt, type: "status", message: "Started. Checking SOL-PERP every 15 seconds." }] : []) })],
  ["POST", /^\/deployments$/, (_, body) => {
    const id = `demo-new-${RUNS.size}`;
    const snap = snapshot({ id, strategy: body.strategy, allocationUsd: body.allocationUsd ?? 100, createdAgoD: 0, curveSeed: 3 });
    snap.deployment.createdAt = Date.now(); snap.equityCurve = [[Date.now(), snap.equityUsd]];
    RUNS.set(id, snap); return snap.deployment;
  }],
  ["GET", /^\/live\/status$/, () => LIVE_STATUS],
  ["GET", /^\/live\/solana$/, () => SOLANA],
  ["GET", /^\/alerts$/, () => ({ sinks: ["telegram"], configured: true, recent: [], help: "" })],
  ["GET", /^\/alerts\/me$/, () => ({ available: true, telegram: { username: "demo", linkedAt: now - 10 * D } })],
  ["GET", /^\/me$/, () => ({ authEnabled: true, user: { id: "demo", wallets: [LIVE_STATUS.account.hlAddress] }, ai: { usedToday: 1, dailyLimit: null } })],
  ["POST", /^\/me$/, () => ({ id: "demo" })],
];

/** Real drafts from Weft, recorded once and replayed, picked by what the thesis is about. */
const DRAFTS = { copy: readRec("draft-copy.json"), sol: readRec("draft-sol.json") };
const DRAFT_SPEED = Number(process.env.DRAFT_SPEED ?? 0.5);
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  // a real draft from Weft, recorded once and replayed (so takes are repeatable)
  if (url.pathname === "/ai/generate/stream") {
    const thesis = JSON.parse(raw).thesis ?? "";
    res.writeHead(200, { ...cors, "content-type": "text/event-stream" });
    let last = 0;
    for (const [at, chunk] of DRAFTS[/copy/i.test(thesis) ? "copy" : "sol"]) { await new Promise((r) => setTimeout(r, (at - last) * 1000 * DRAFT_SPEED)); last = at; res.write(chunk); }
    return res.end();
  }
  if (url.pathname === "/events/stream") { res.writeHead(200, { ...cors, "content-type": "text/event-stream" }); return res.end(": demo\n\n"); }
  for (const [method, re, fn] of MOCK) {
    const m = url.pathname.match(re);
    if (m && method === req.method) {
      let out = fn(m, raw.length ? JSON.parse(raw) : null), status = 200;
      if (Array.isArray(out)) [status, out] = out;
      res.writeHead(status, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify(out));
    }
  }
  // everything else is the real API, as a visitor
  const headers = { "content-type": req.headers["content-type"] ?? "application/json" };
  const r = await fetch(REAL + url.pathname + url.search, { method: req.method, headers, body: raw.length ? raw : undefined });
  const h = { ...cors, "content-type": r.headers.get("content-type") ?? "application/json" };
  res.writeHead(r.status, h);
  if (r.body) for await (const c of r.body) res.write(c);
  res.end();
}).listen(PORT, () => console.log(`mock api on http://localhost:${PORT}`));
