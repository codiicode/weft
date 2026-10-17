/**
 * Hyperliquid traders worth copying: the public leaderboard, filtered to accounts that made money
 * over the last 30 days with a believable return (deposits and withdrawals make some returns absurd)
 * and enough money in the account to matter. Refreshed every 30 minutes; the file is large.
 */
export const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

export interface TopTrader {
  address: string;
  name: string | null;
  accountValueUsd: number;
  pnl30dUsd: number;
  roi30dPct: number;
  pnl7dUsd: number;
  pnlAllTimeUsd: number;
  volume30dUsd: number;
}

interface Row {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
}

export function pickTraders(rows: Row[], limit = 50): TopTrader[] {
  const out: TopTrader[] = [];
  for (const r of rows) {
    const w = Object.fromEntries(r.windowPerformances);
    const month = w.month;
    if (!month) continue;
    const value = Number(r.accountValue);
    const pnl = Number(month.pnl);
    const roi = Number(month.roi);
    const vol = Number(month.vlm);
    // Profitable, a believable return (2%–500%), a real account, and actually trading.
    if (!(pnl > 0 && roi >= 0.02 && roi <= 5 && value >= 100_000 && value <= 100_000_000 && vol > value)) continue;
    out.push({
      address: r.ethAddress,
      name: r.displayName,
      accountValueUsd: Math.round(value),
      pnl30dUsd: Math.round(pnl),
      roi30dPct: Math.round(roi * 1000) / 10,
      pnl7dUsd: Math.round(Number(w.week?.pnl ?? 0)),
      pnlAllTimeUsd: Math.round(Number(w.allTime?.pnl ?? 0)),
      volume30dUsd: Math.round(vol),
    });
  }
  return out.sort((a, b) => b.pnl30dUsd - a.pnl30dUsd).slice(0, limit);
}

export function createTopTraders(fetchImpl: typeof fetch = fetch) {
  let cache: { at: number; data: Promise<TopTrader[]> } | null = null;
  return (): Promise<TopTrader[]> => {
    if (!cache || Date.now() - cache.at > 30 * 60_000) {
      const data = fetchImpl(LEADERBOARD_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`leaderboard ${r.status}`);
          return r.json() as Promise<{ leaderboardRows?: Row[] }>;
        })
        .then((d) => pickTraders(d.leaderboardRows ?? []));
      cache = { at: Date.now(), data };
      data.catch(() => {
        if (cache?.data === data) cache = null;
      });
    }
    return cache.data;
  };
}
