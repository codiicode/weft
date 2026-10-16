import type { Snapshot } from "./api";

/**
 * One way to count a run's money, used everywhere (run page, runs list, portfolio): returns are on
 * what was actually put into positions (the most that was in at once), not on the budget. A stated
 * order ("$5 at 20×") keeps a small unspent reserve for fees, and counting that reserve made the
 * same trade show a different percent on each page, and again once it closed.
 */
export function runMoney(s: Snapshot) {
  const openMargin = s.positions.reduce((n, p) => n + p.sizeUsd, 0);
  const pnl = s.realizedPnlUsd + s.unrealizedPnlUsd;
  const fees = s.feesUsd ?? 0;
  const invested = s.investedUsd ?? (openMargin > 0 ? openMargin : null);
  if (invested && invested > 0) {
    return {
      putIn: invested,
      open: openMargin > 0,
      // Open: what the positions are worth now. Closed: what came back.
      worth: openMargin > 0 ? openMargin + s.unrealizedPnlUsd : invested + pnl,
      pnl,
      returnPct: (pnl / invested) * 100,
      openPct: openMargin > 0 ? (s.unrealizedPnlUsd / openMargin) * 100 : 0,
      fees,
      traded: true,
    };
  }
  // Nothing bought yet: the budget, untouched.
  return { putIn: s.deployment.allocationUsd, open: false, worth: s.equityUsd, pnl, returnPct: s.returnPct, openPct: 0, fees, traded: false };
}
