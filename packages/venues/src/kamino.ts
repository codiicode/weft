import type { LendInstrument } from "@weft/strategy";
import type { Http } from "./http.ts";

/**
 * Kamino lending, read side: the markets and their reserves with today's supply rates and deposits,
 * from Kamino's public API (api.kamino.finance). What a kToken is worth comes from the chain (the
 * reserve account), through `lendRate`, which the API server provides.
 */
export const KAMINO_API = "https://api.kamino.finance";

export interface KaminoReserveRow {
  market: string;
  marketName: string;
  primary: boolean;
  reserve: string;
  symbol: string;
  mint: string;
  supplyApyPct: number;
  borrowApyPct: number;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  /** Share of deposits lent out (0–1): near 1, withdrawals may have to wait. */
  utilization: number;
}

export class Kamino {
  private readonly http: Http;
  private readonly base: string;
  constructor(http: Http, base = KAMINO_API) {
    this.http = http;
    this.base = base;
  }

  async markets(): Promise<{ lendingMarket: string; name: string; isPrimary: boolean }[]> {
    return this.http.json(`${this.base}/v2/kamino-market?env=mainnet-beta`, { ttlMs: 60 * 60_000, timeoutMs: 20_000 });
  }

  /** Every reserve worth showing (at least $100k deposited) across Kamino's markets. */
  async reserves(): Promise<KaminoReserveRow[]> {
    const markets = await this.markets();
    const rows = await Promise.all(
      markets.map(async (m) => {
        const list = await this.http
          .json<{ reserve: string; liquidityToken: string; liquidityTokenMint: string; supplyApy: string; borrowApy: string; totalSupplyUsd: string; totalBorrowUsd: string }[]>(`${this.base}/kamino-market/${m.lendingMarket}/reserves/metrics?env=mainnet-beta`, { ttlMs: 5 * 60_000, timeoutMs: 20_000 })
          .catch(() => []);
        return list.map((r) => {
          const supply = Number(r.totalSupplyUsd), borrow = Number(r.totalBorrowUsd);
          return {
            market: m.lendingMarket,
            marketName: m.name,
            primary: Boolean(m.isPrimary),
            reserve: r.reserve,
            symbol: r.liquidityToken,
            mint: r.liquidityTokenMint,
            supplyApyPct: Number(r.supplyApy) * 100,
            borrowApyPct: Number(r.borrowApy) * 100,
            totalSupplyUsd: supply,
            totalBorrowUsd: borrow,
            utilization: supply > 0 ? Math.min(1, borrow / supply) : 0,
          };
        });
      }),
    );
    return rows.flat().filter((r) => r.totalSupplyUsd >= 100_000);
  }

  async reserve(reserve: string): Promise<KaminoReserveRow | null> {
    return (await this.reserves()).find((r) => r.reserve === reserve) ?? null;
  }

  /** Reserves for a token or market name ("usdc", "sol", "jito"), biggest first; the main market ranks first on ties. */
  async search(q: string, limit = 10): Promise<KaminoReserveRow[]> {
    const words = q.toLowerCase().replace(/kamino|lend(ing)?|supply|deposit/g, " ").split(/[\s,/]+/).filter(Boolean);
    const all = await this.reserves();
    // A word that is a token's symbol ("sol", "usdc") picks that token, not every reserve in a market named after it.
    const symbols = new Set(all.map((r) => r.symbol.toLowerCase()));
    const sym = words.filter((w) => symbols.has(w));
    return all
      .filter((r) => (sym.length ? sym.includes(r.symbol.toLowerCase()) : true) && words.every((w) => sym.includes(w) || `${r.symbol} ${r.marketName}`.toLowerCase().includes(w)))
      .sort((a, b) => b.totalSupplyUsd * (b.primary ? 1.5 : 1) - a.totalSupplyUsd * (a.primary ? 1.5 : 1))
      .slice(0, limit);
  }
}

export function lendInstrument(r: KaminoReserveRow, decimals: number): LendInstrument {
  return { kind: "lend", venue: "kamino", market: r.market, reserve: r.reserve, mint: r.mint, symbol: r.symbol, decimals, marketName: r.marketName, assetClass: "crypto" };
}
