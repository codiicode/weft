import type { Strategy } from "@weft/strategy";
import type { Catalog, MarketListing } from "@weft/venues";

/**
 * The bundled example strategies use placeholder mints and market ids (they
 * are test fixtures). For the live library we swap those placeholders for
 * real instruments found through the catalog, so seeded strategies produce
 * live signals when deployed. Anything that can't be resolved is left as-is.
 */

const norm = (x: string | undefined) => (x ?? "").replace(/^\$+/, "").toUpperCase();

async function search(catalog: Catalog, product: Parameters<Catalog["list"]>[0], q: string): Promise<MarketListing[]> {
  try {
    return await catalog.list(product, { search: q, limit: 20 });
  } catch {
    return [];
  }
}

export async function resolvePlaceholders(s: Strategy, catalog: Catalog): Promise<{ strategy: Strategy; replaced: string[] }> {
  let json = JSON.stringify(s);
  const replaced: string[] = [];

  // Placeholder Solana mints look like "<SYMBOL>ExampLeMint111…"
  for (const m of new Set(json.match(/"([1-9A-HJ-NP-Za-km-z]{4,12})ExampLeMint1+"/g) ?? [])) {
    const mint = m.slice(1, -1);
    const symbol = mint.replace(/ExampLeMint1+$/, "");
    const row = (await search(catalog, "tokens", symbol))
      .filter((r) => r.instrument.kind === "token" && (norm(r.instrument.symbol) === norm(symbol) || norm(r.label) === norm(symbol)))
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
    if (row?.instrument.kind === "token") {
      json = json.split(mint).join(row.instrument.mint);
      replaced.push(`${symbol} → ${row.instrument.mint}`);
    }
  }

  // Placeholder prediction markets: search by question text, prefer YES outcomes.
  const outcomes = new Map<string, { question?: string; outcome: string }>();
  for (const sig of s.signals) {
    const p = sig.params as { instrument?: { kind: string; market: string; outcome: string; question?: string } };
    if (p.instrument?.kind === "outcome") outcomes.set(p.instrument.market, p.instrument);
  }
  for (const a of s.actions) if (a.type === "open" && a.instrument.kind === "outcome") outcomes.set(a.instrument.market, outcomes.get(a.instrument.market) ?? a.instrument);
  for (const [market, info] of outcomes) {
    const q = info.question ?? market.replace(/-/g, " ");
    const hit = (await search(catalog, "predictions", q)).find((r) => r.instrument.kind === "outcome" && norm(r.instrument.outcome) === norm(info.outcome));
    if (hit?.instrument.kind === "outcome") {
      const real = hit.instrument;
      json = json.replace(new RegExp(`"market":"${market}","outcome":"${info.outcome}"`, "g"), `"market":"${real.market}","outcome":"${real.outcome}"`);
      json = json.replace(new RegExp(`"venue":"(hyperliquid|jupiter)","market":"${real.market}"`, "g"), `"venue":"${real.venue}","market":"${real.market}"`);
      replaced.push(`${market} → ${real.market}`);
    }
  }
  return { strategy: JSON.parse(json) as Strategy, replaced };
}
