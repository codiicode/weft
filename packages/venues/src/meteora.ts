import type { Http } from "./http.ts";
import type { LpInstrument } from "@weft/strategy";
import { num } from "./util.ts";

/**
 * Meteora DLMM pools, from Meteora's public data API (no key): price, TVL, volume and fees per pool,
 * and search by pair or token. Prices are the base token (x) in the quote token (y).
 */
export const METEORA_DATA_API = "https://dlmm.datapi.meteora.ag";

export interface DlmmPool {
  address: string;
  name: string;
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  /** Base in quote (SOL-USDC: USDC per SOL). */
  price: number;
  tvlUsd: number;
  volume24hUsd: number;
  /** Fees that went to liquidity providers over 24h (protocol share removed), USD. */
  lpFees24hUsd: number;
  baseUsd: number | null;
  quoteUsd: number | null;
  binStep: number | null;
  baseFeePct: number | null;
  blacklisted: boolean;
}

type Raw = Record<string, unknown> & {
  token_x?: Record<string, unknown>;
  token_y?: Record<string, unknown>;
  volume?: Record<string, unknown>;
  fees?: Record<string, unknown>;
  protocol_fees?: Record<string, unknown>;
  pool_config?: Record<string, unknown>;
};

export function parseDlmmPool(r: Raw): DlmmPool | null {
  const address = typeof r.address === "string" ? r.address : null;
  const price = num(r.current_price);
  if (!address || price == null || !(price > 0)) return null;
  const fees = num(r.fees?.["24h"]) ?? 0;
  const protocol = num(r.protocol_fees?.["24h"]) ?? 0;
  return {
    address,
    name: String(r.name ?? ""),
    baseMint: String(r.token_x?.address ?? ""),
    baseSymbol: String(r.token_x?.symbol ?? ""),
    quoteMint: String(r.token_y?.address ?? ""),
    quoteSymbol: String(r.token_y?.symbol ?? ""),
    price,
    tvlUsd: num(r.tvl) ?? 0,
    volume24hUsd: num(r.volume?.["24h"]) ?? 0,
    lpFees24hUsd: Math.max(0, fees - protocol),
    baseUsd: num(r.token_x?.price),
    quoteUsd: num(r.token_y?.price),
    binStep: num(r.pool_config?.bin_step),
    baseFeePct: num(r.pool_config?.base_fee_pct),
    blacklisted: r.is_blacklisted === true,
  };
}

/** The pool as a strategy instrument. */
export function dlmmInstrument(p: DlmmPool): LpInstrument {
  return { kind: "lp", venue: "meteora", pool: p.address, symbol: p.name || `${p.baseSymbol}-${p.quoteSymbol}`, baseMint: p.baseMint, quoteMint: p.quoteMint, quoteSymbol: p.quoteSymbol };
}

/** Fees paid to liquidity per day, as a fraction of the pool's TVL (0.001 = 0.1% a day). */
export const feePerDay = (p: DlmmPool) => (p.tvlUsd > 0 ? p.lpFees24hUsd / p.tvlUsd : 0);

export class MeteoraDlmm {
  private readonly http: Http;
  private readonly base: string;
  constructor(http: Http, base = METEORA_DATA_API) {
    this.http = http;
    this.base = base;
  }

  async pool(address: string): Promise<DlmmPool> {
    const r = await this.http.json<Raw>(`${this.base}/pools/${encodeURIComponent(address)}`, { ttlMs: 15_000 });
    const p = parseDlmmPool(r);
    if (!p) throw new Error(`meteora: no DLMM pool ${address}`);
    return p;
  }

  /** Pools matching a pair ("SOL-USDC"), a symbol or a mint, busiest first. */
  async search(query: string, limit = 20): Promise<DlmmPool[]> {
    const r = await this.http.json<{ data?: Raw[] }>(`${this.base}/pools?query=${encodeURIComponent(query)}&page=1&page_size=${Math.min(50, limit)}`, { ttlMs: 60_000 });
    return (r.data ?? []).map(parseDlmmPool).filter((p): p is DlmmPool => !!p && !p.blacklisted).sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  }
}
