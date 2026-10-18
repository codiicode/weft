import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { defineProvider } from "./common.ts";

/**
 * Yields across DeFi from DefiLlama (yields.llama.fi, free, no key): every lending market, vault,
 * staking and liquidity pool it tracks on every chain (Aave, Morpho, Pendle, Kamino, Jito, …), with
 * its APY and deposits. Read-only data: a yield signal can drive an alert or a trade elsewhere, not a
 * deposit into the pool itself. The full list is about 16,000 pools, fetched at most every 10 minutes.
 */
export const LLAMA_YIELDS = "https://yields.llama.fi/pools";

export interface YieldPool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  poolMeta: string | null;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
  outlier?: boolean;
}

export class Yields {
  private readonly http: Http;
  private readonly url: string;
  constructor(http: Http, url = LLAMA_YIELDS) {
    this.http = http;
    this.url = url;
  }

  async pools(): Promise<YieldPool[]> {
    const r = await this.http.json<{ data?: YieldPool[] }>(this.url, { ttlMs: 10 * 60_000, timeoutMs: 30_000 });
    return r.data ?? [];
  }

  async pool(id: string): Promise<YieldPool | null> {
    return (await this.pools()).find((p) => p.pool === id) ?? null;
  }

  /**
   * Pools matching every word of the query against protocol, token, chain and market name
   * ("kamino usdc", "aave base usdc", "jitosol"), biggest first; tiny and outlier pools left out.
   */
  async search(query: string, limit = 8): Promise<YieldPool[]> {
    const words = query.toLowerCase().split(/[\s,/]+/).filter(Boolean);
    const hay = (p: YieldPool) => `${p.project} ${p.project.replace(/-/g, " ")} ${p.symbol} ${p.chain} ${p.poolMeta ?? ""}`.toLowerCase();
    return (await this.pools())
      .filter((p) => !p.outlier && p.tvlUsd >= 100_000 && p.apy != null && words.every((w) => hay(p).includes(w)))
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, limit);
  }
}

export function yieldProvider(y: Yields, onError?: (kind: string, err: unknown) => void): SignalProvider {
  return defineProvider(
    ["yield"],
    "live",
    async (s) => {
      const p = await y.pool(s.params.pool);
      if (!p) throw new Error(`no yield pool ${s.params.pool}`);
      return {
        apy: p.apy,
        apy_base: p.apyBase,
        apy_reward: p.apyReward,
        tvl_usd: p.tvlUsd,
        apy_change_1d: p.apyPct1D,
        apy_change_7d: p.apyPct7D,
        apy_mean_30d: p.apyMean30d,
      };
    },
    onError,
  );
}
