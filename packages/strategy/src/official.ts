import type { Strategy } from "./strategy.ts";

/**
 * Weft's own token. Whenever a strategy names it, it means this mint and nothing else: copies that
 * borrow the ticker are never traded. Checked in market search, after the AI drafts, and at start.
 */
export const OFFICIAL_TOKENS: Readonly<Record<string, string>> = { WEFT: "HqmFi85adLD8BQA7en1HfajdAfzVFps5REgQaYuw6Ax8" };

/** The official mint for a ticker ("$weft" → WEFT's), or null. */
export function officialMint(symbol: string | undefined | null): string | null {
  return OFFICIAL_TOKENS[(symbol ?? "").trim().replace(/^\$+/, "").toUpperCase()] ?? null;
}

/** Points every Solana token named like an official one at the official mint. Returns what changed. */
export function pinOfficialTokens(s: Strategy): { strategy: Strategy; changed: string[] } {
  const changed: string[] = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = walk(x);
    if (o.kind === "token" && typeof o.symbol === "string") {
      const mint = officialMint(o.symbol);
      if (mint && o.mint !== mint) {
        changed.push(`${o.symbol}: ${String(o.mint)} → ${mint}`);
        out.mint = mint;
      }
    }
    return out;
  };
  const strategy = walk(s) as Strategy;
  return { strategy: changed.length ? strategy : s, changed };
}
