"use client";
import { api, type TopTrader } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { PageHeader, Empty } from "@/components/app/AppShell";

const usd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}k` : `$${Math.round(a)}`;
  return `${n < 0 ? "−" : ""}${s}`;
};
const signed = (n: number) => `${n >= 0 ? "+" : ""}${usd(n)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function copyThesis(t: TopTrader) {
  return `Copy Hyperliquid trader ${t.address} with $100 per trade, at most 5 positions at once.`;
}

function Row({ t, i }: { t: TopTrader; i: number }) {
  return (
    <tr className="border-b border-line transition-colors last:border-0 hover:bg-paper-2/40">
      <td className="tnum px-4 py-3 text-[13px] text-faint">{i + 1}</td>
      <td className="px-3 py-3">
        <a href={`https://hypurrscan.io/address/${t.address}`} target="_blank" rel="noopener noreferrer" className="font-medium text-ink hover:underline">
          {t.name ?? short(t.address)}
        </a>
        {t.name && <div className="text-[12px] text-faint">{short(t.address)}</div>}
      </td>
      <td className="tnum px-3 py-3 text-right text-long">{signed(t.pnl30dUsd)}</td>
      <td className="tnum px-3 py-3 text-right text-ink-2">+{t.roi30dPct}%</td>
      <td className={`tnum hidden px-3 py-3 text-right sm:table-cell ${t.pnl7dUsd >= 0 ? "text-ink-2" : "text-short"}`}>{signed(t.pnl7dUsd)}</td>
      <td className="tnum hidden px-3 py-3 text-right text-ink-2 md:table-cell">{usd(t.accountValueUsd)}</td>
      <td className="px-4 py-3 text-right">
        <a
          href={`/new?thesis=${encodeURIComponent(copyThesis(t))}`}
          className="inline-flex h-8 items-center rounded-[8px] border border-line-2 px-3 text-[13px] font-medium text-ink transition-colors hover:border-ink/30"
        >
          Copy
        </a>
      </td>
    </tr>
  );
}

/** Profitable Hyperliquid traders from the public leaderboard, each one a click away from being copied. */
export default function TradersPage() {
  const { data, loading, error } = useApi(() => api.traders(), []);
  const rows = data?.traders ?? [];
  return (
    <>
      <PageHeader
        title="Traders"
        sub="The most profitable accounts on Hyperliquid over the last 30 days. Copy one and Weft opens every new position they open, with your own amount, and closes it when they do."
      />
      <div className="px-5 pb-16 pt-6 lg:px-10">
        {error && !rows.length ? (
          <Empty title="Traders are unavailable" sub="Couldn’t load Hyperliquid’s leaderboard. Try again in a moment." />
        ) : loading && !rows.length ? (
          <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />
        ) : !rows.length ? (
          <Empty title="No traders to show" sub="Try again in a few minutes." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-[12px] border border-line bg-card">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-muted">
                    <th className="px-4 py-2.5 font-normal">#</th>
                    <th className="px-3 py-2.5 font-normal">Trader</th>
                    <th className="px-3 py-2.5 text-right font-normal">30-day profit</th>
                    <th className="px-3 py-2.5 text-right font-normal">30-day return</th>
                    <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Last 7 days</th>
                    <th className="hidden px-3 py-2.5 text-right font-normal md:table-cell">Account</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t, i) => (
                    <Row key={t.address} t={t} i={i} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-[46rem] text-[12.5px] leading-relaxed text-faint">
              From Hyperliquid’s public leaderboard: accounts above $100k that made money over 30 days, sorted by profit. Past results don’t
              mean they’ll keep winning, and a copy starts with their next trade, not the ones they already hold. Not advice.
            </p>
          </>
        )}
      </div>
    </>
  );
}
