/**
 * Live smoke test: hits the real public APIs and prints a compact summary.
 *   npm run smoke -w @weft/venues
 * Exits non-zero if a product catalog is empty or a core quote/signal fails.
 */
import type { Instrument, Signal } from "@weft/strategy";
import { SIGNAL_KINDS } from "@weft/strategy";
import { createVenues, type MarketListing, type Product } from "../src/index.ts";

const v = createVenues({ timeoutMs: 20_000 });
const now = Date.now();
const failures: string[] = [];
const fmt = (x: unknown): string => {
  if (x == null) return "null";
  if (typeof x === "number") return Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x * 10_000) / 10_000);
  return String(x);
};
const t0 = Date.now();

console.log(`\n== Catalog (${new Date(now).toISOString()})`);
const listings: Partial<Record<Product, MarketListing[]>> = {};
for (const p of ["perps", "stocks", "predictions", "tokens", "options"] as const) {
  try {
    const rows = await v.catalog.list(p, { limit: 200 });
    listings[p] = rows;
    if (!rows.length) failures.push(`catalog ${p} empty`);
    const top = rows
      .slice(0, 3)
      .map((r) => `${r.label.length > 48 ? r.label.slice(0, 47) + "…" : r.label} @ ${fmt(r.price)} (vol ${fmt(r.volume24hUsd)})`)
      .join(" | ");
    const venues = [...new Set(rows.map((r) => r.venue))].join("+");
    console.log(`${p.padEnd(12)} ${String(rows.length).padStart(3)} rows [${venues}]  ${top}`);
  } catch (e) {
    failures.push(`catalog ${p}: ${(e as Error).message}`);
    console.log(`${p.padEnd(12)} ERROR ${(e as Error).message}`);
  }
}
const stocks = listings.stocks ?? [];
const classes = stocks.reduce<Record<string, number>>((acc, r) => {
  const k = r.instrument.kind === "token" ? "xstock" : String(r.meta?.assetClass);
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
console.log(`stocks mix   ${JSON.stringify(classes)}`);
const search = await v.catalog.list("stocks", { search: "nvidia", limit: 5 });
console.log(`search "nvidia" → ${search.map((r) => `${r.instrumentKey}`).join(", ")}`);

/* ---------------- pick instruments ---------------- */
const pick = (p: Product, f: (r: MarketListing) => boolean = () => true) => listings[p]?.find(f)?.instrument;

// Real mints, looked up via Jupiter search (never hard-coded guesses).
const jupMint = (await v.ctx.jup.searchTokens("JUP")).find((t) => t.symbol === "JUP" && t.isVerified)?.id;
const bonkMint = (await v.ctx.jup.searchTokens("BONK")).find((t) => t.symbol === "Bonk" || (t.symbol.toUpperCase() === "BONK" && t.isVerified))?.id;
console.log(`\nmints: JUP=${jupMint} BONK=${bonkMint}`);

const btc: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" };
const nvda = pick("stocks", (r) => r.instrumentKey === "hl:perp:xyz:NVDA") ?? { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" };
const hype: Instrument = { kind: "spot", venue: "hyperliquid", symbol: "HYPE/USDC", assetClass: "crypto" };
const jup: Instrument | undefined = jupMint ? { kind: "token", chain: "solana", mint: jupMint, symbol: "JUP", quote: "USDC", route: "auto", assetClass: "crypto" } : undefined;
const xstock = pick("stocks", (r) => r.instrument.kind === "token");
const hlOutcome = pick("predictions", (r) => r.venue === "hyperliquid");
const jupOutcome = pick("predictions", (r) => r.venue === "jupiter");
// a liquid-ish ETH option: priced above $20, highest open interest
const option = (listings.options ?? [])
  .filter((r) => r.instrument.kind === "option" && r.instrument.underlying === "ETH" && (r.price ?? 0) > 20)
  .sort((a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0))[0]?.instrument;
// Derive lists its own expiries: pick a near-the-money one from its instrument list
const ethSpot = (await v.marketData.getQuote({ kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" })).price;
const deriveNames = await v.ctx.derive.instruments("ETH").catch(() => [] as string[]);
const deriveExpiry = [...new Set(deriveNames.map((n) => n.split("-")[1]!))].sort()[1];
const deriveName = deriveNames
  .filter((n) => n.split("-")[1] === deriveExpiry && n.endsWith("-C"))
  .sort((a, b) => Math.abs(Number(a.split("-")[2]) - ethSpot) - Math.abs(Number(b.split("-")[2]) - ethSpot))[0];
const deriveOpt: Instrument | undefined = deriveName
  ? {
      kind: "option",
      venue: "derive",
      underlying: "ETH",
      expiry: `${deriveExpiry!.slice(0, 4)}-${deriveExpiry!.slice(4, 6)}-${deriveExpiry!.slice(6, 8)}`,
      strike: Number(deriveName.split("-")[2]),
      right: "call",
    }
  : undefined;

console.log("\n== Quotes (mid | $10k buy fill, impact bps)");
for (const [name, inst] of [
  ["perp BTC", btc],
  ["hip3 NVDA", nvda],
  ["spot HYPE", hype],
  ["token JUP", jup],
  ["xStock", xstock],
  ["outcome HL", hlOutcome],
  ["outcome JUP", jupOutcome],
  ["option deribit", option],
  ["option derive", deriveOpt],
] as const) {
  if (!inst) {
    console.log(`${name.padEnd(15)} (no instrument)`);
    continue;
  }
  try {
    const size = inst.kind === "outcome" || inst.kind === "option" ? 500 : 10_000;
    const [mid, sized] = await Promise.all([v.marketData.getQuote(inst), v.marketData.getQuote(inst, { side: "buy", sizeUsd: size })]);
    console.log(
      `${name.padEnd(15)} ${fmt(mid.price).padStart(12)} | $${size} fill ${fmt(sized.fillPrice)} impact ${fmt(sized.priceImpactBps)}bps${sized.depthExhausted ? " (book exhausted)" : ""}  [${sized.source}]`
    );
  } catch (e) {
    if (name !== "option derive") failures.push(`quote ${name}: ${(e as Error).message}`);
    console.log(`${name.padEnd(15)} ERROR ${(e as Error).message}`);
  }
}
const batch = await v.marketData.getQuotes([btc, nvda, ...(jup ? [jup] : [])]);
console.log(`getQuotes batch → ${[...batch.values()].map((q) => `${q.instrumentKey}=${fmt(q.price)}`).join(", ")}`);

/* ---------------- signals ---------------- */
console.log("\n== Signals");
const sig = (id: string, kind: string, params: unknown) => ({ id, kind, params }) as Signal;
const signals: Signal[] = [
  sig("btc_px", "price", { instrument: btc }),
  sig("nvda_px", "price", { instrument: nvda }),
  ...(jup ? [sig("jup_px", "price", { instrument: jup })] : []),
  sig("sol_funding", "funding", { instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL", assetClass: "crypto" } }),
  sig("btc_liq", "liquidity", { instrument: btc }),
  ...(jup ? [sig("jup_liq", "liquidity", { instrument: jup })] : []),
  ...(hlOutcome ? [sig("hl_odds", "odds", { instrument: hlOutcome })] : []),
  ...(jupOutcome ? [sig("jup_odds", "odds", { instrument: jupOutcome })] : []),
  ...(bonkMint ? [sig("bonk_chain", "token_onchain", { mint: bonkMint })] : []),
  sig("nino", "forecast", { source: "noaa_cpc", series: "nino34_anomaly" }),
  sig("usdbrl", "macro", { series: "USDBRL" }),
  sig("us2y", "macro", { series: "US2Y" }),
  sig("fomc", "calendar", { event: "fomc" }),
  sig("nvda_er", "calendar", { event: "earnings", symbol: "NVDA" }),
  sig("upgrade", "calendar", { event: "custom", at: "2026-11-20T14:00:00Z" }),
  sig("pump_social", "social", { platform: "x", cashtags: ["PUMP"], keywords: [], accounts: [] }),
  sig("claim", "post_match", { accounts: ["@federalreserve"], claim: "rates will be cut in December" }),
  sig("macro_news", "news", { query: "El Niño wheat" }),
  sig("nino_model", "model", { question: "Will NOAA declare El Niño conditions for DJF 2026–27?" }),
  ...(hlOutcome ? [sig("anchored_model", "model", { question: "Will it resolve YES?", instrument: hlOutcome })] : []),
];
const LIVE_REQUIRED = new Set(["btc_px", "nvda_px", "sol_funding", "btc_liq", "nino", "usdbrl", "fomc"]);
for (const s of signals) {
  const snap = await v.signals.fetch(s, now);
  const mode = v.signals.modeOf(s.kind);
  const declared = Object.keys(SIGNAL_KINDS[s.kind].fields);
  const fields = snap ? declared.map((f) => `${f}=${fmt(snap.fields[f])}`).join(" ") : "null";
  if (!snap && LIVE_REQUIRED.has(s.id)) failures.push(`signal ${s.id} returned null`);
  const extra = snap ? Object.keys(snap.fields).filter((f) => !declared.includes(f)) : [];
  if (extra.length) failures.push(`signal ${s.id} has undeclared fields ${extra.join(",")}`);
  console.log(`${s.kind.padEnd(13)} ${(mode ?? "-").padEnd(9)} ${s.id.padEnd(14)} ${fields}`);
}

/* ---------------- token facts ---------------- */
console.log("\n== Token facts ($1,000 buy)");
for (const [name, mint] of [["JUP", jupMint], ["BONK", bonkMint], ["xStock", xstock?.kind === "token" ? xstock.mint : undefined]] as const) {
  if (!mint) continue;
  const f = await v.tokenFacts.getTokenFacts(mint, { sizeUsd: 1_000 });
  if (!f && name !== "xStock") failures.push(`token facts ${name} null`);
  console.log(`${name.padEnd(7)} ${f ? JSON.stringify(f) : "null"}`);
}

console.log(`\nHTTP: ${JSON.stringify(v.ctx.http.stats)}  elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("\nsmoke OK");
