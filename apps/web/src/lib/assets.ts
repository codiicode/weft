import type { Instrument, Strategy } from "@weft/strategy";

export type IconRef = { symbol: string; src?: string | null; dex?: string | null; alt?: string[] };

/** DexScreener's logo CDN, by mint: covers most Solana tokens (404s fall back to the next source). */
export const tokenLogo = (mint: string) => `https://cdn.dexscreener.com/tokens/solana/${mint}.png`;

/** The logo to show for any instrument the strategy schema knows. */
export function instrumentIcon(i: Instrument, meta?: Record<string, unknown> | null): IconRef {
  const src = (meta?.icon as string | undefined) ?? (meta?.image as string | undefined) ?? null;
  switch (i.kind) {
    case "perp":
      return { symbol: i.symbol, dex: i.dex ?? null, src };
    case "spot":
      return { symbol: i.symbol.split("/")[0]!, src };
    case "token":
      return { symbol: i.symbol ?? i.mint.slice(0, 4), src, alt: [tokenLogo(i.mint)] };
    case "option":
      return { symbol: i.underlying, src };
    case "outcome":
      return { symbol: "OUTCOME", src: src ?? "/coins/OUTCOME.svg" };
    case "lp":
      return { symbol: i.symbol.split("-")[0]!, src, alt: [tokenLogo(i.baseMint)] };
    default:
      return { symbol: "?", src };
  }
}

/** Distinct instruments a strategy trades, for a row of logos. */
export function strategyIcons(s: Strategy): IconRef[] {
  const seen = new Set<string>();
  const out: IconRef[] = [];
  for (const a of s.actions) {
    const inst = a.type === "open" ? a.instrument : a.type === "options" ? a.legs[0]!.instrument : a.type === "liquidity" ? a.pool : null;
    if (!inst) continue;
    const ref = instrumentIcon(inst);
    const k = `${ref.dex ?? ""}:${ref.symbol}`;
    if (!seen.has(k)) seen.add(k), out.push(ref);
  }
  return out;
}

/** Distinct instruments a strategy opens positions in (options by their first leg). */
export function strategyInstruments(s: Strategy): Instrument[] {
  const seen = new Set<string>();
  const out: Instrument[] = [];
  for (const a of s.actions) {
    const inst: Instrument | null =
      a.type === "open" ? a.instrument : a.type === "options" ? a.legs[0]!.instrument
      // a pool is charted as its base token
      : a.type === "liquidity" ? { kind: "token", chain: "solana", mint: a.pool.baseMint, symbol: a.pool.symbol.split("-")[0], quote: "USDC", route: "auto", assetClass: "crypto" }
      : null;
    if (!inst) continue;
    const k = JSON.stringify(inst);
    if (!seen.has(k)) seen.add(k), out.push(inst);
  }
  return out;
}
