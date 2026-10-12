// Seeds a running API with a curated set of paper runs covering all five products.
// Usage: npm run seed -w @weft/api   (API must be running; API_URL defaults to http://localhost:8787)
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");

const THESES = [
  "Buy $BONK when it dips 5% and sentiment turns bullish, 0.5 SOL",
  "Buy $WIF when X turns bullish and buyers outnumber sellers, 1 SOL",
  "NVDA rips into earnings, flat before the print",
  "El Niño is coming — what's the trade?",
  "The Fed surprises dovish and nobody is positioned",
  "SOL longs are way too crowded. Fade them.",
  "ETH call spread if it breaks out this week",
  "BTC breakout: long on a 3% daily move with a trailing stop",
];

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`);
  return data;
}

// Reuse library strategies with the same name instead of saving duplicates.
const existing = new Map(
  (await call<{ strategies: { id: string; strategy: { name: string } }[] }>("/strategies")).strategies.map((e) => [e.strategy.name.toLowerCase(), e.id]),
);

for (const thesis of THESES) {
  try {
    const gen = await call<{ strategy: { name: string }; source: string }>("/ai/generate", { thesis });
    const known = existing.get(gen.strategy.name.toLowerCase());
    const saved = known ? { id: known } : await call<{ id: string }>("/strategies", { strategy: gen.strategy, author: "@weft_demo" });
    const dep = await call<{ id: string }>("/deployments", { strategyId: saved.id, allocationUsd: 10_000, intervalSec: 30 });
    console.log(`✓ ${gen.strategy.name.padEnd(36)} ${gen.source.padEnd(8)} run ${dep.id}`);
  } catch (e) {
    console.log(`✗ ${thesis}: ${(e as Error).message}`);
  }
}
export {};
