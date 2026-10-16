import type { Snapshot } from "./api";

/**
 * One way to count a run's money, used everywhere (run page, runs list, portfolio): returns are on
 * what was actually put into positions, not on the budget. A stated order ("$5 at 20×") keeps a
 * small unspent reserve for fees, and counting that reserve made the same trade show a different
 * percent on each page.
 */
export function runMoney(s: Snapshot) {
  const putIn = s.positions.reduce((n, p) => n + p.sizeUsd, 0);
  const pnl = s.realizedPnlUsd + s.unrealizedPnlUsd;
  if (putIn > 0)
    return { putIn, worth: putIn + s.unrealizedPnlUsd, pnl, returnPct: (pnl / putIn) * 100, openPct: (s.unrealizedPnlUsd / putIn) * 100, fees: s.feesUsd ?? 0 };
  // Nothing open: the run's result against its budget.
  return { putIn: s.deployment.allocationUsd, worth: s.equityUsd, pnl, returnPct: s.returnPct, openPct: 0, fees: s.feesUsd ?? 0 };
}
