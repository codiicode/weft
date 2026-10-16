"use client";
import Link from "next/link";
import { instrumentLabel } from "@weft/strategy";
import { api, type Snapshot } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, fmtUsd, fmtPct } from "@/lib/use-api";
import { instrumentIcon } from "@/lib/assets";
import { priceFormatter } from "@/lib/market-ideas";
import { hlFreeUsd } from "@/lib/trading";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { Card } from "./AppShell";
import { SellButton } from "./RunControls";

const tone = (v: number) => (v > 0 ? "text-long" : v < 0 ? "text-short" : "text-ink");
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtUsd(Math.abs(v), 2)}`;

/**
 * Your money at a glance: what's free to trade on each venue, what's in positions, and how they're
 * doing in dollars and percent. Then every open position across your strategies, with a Sell button.
 */
export function Portfolio({ runs, onChange }: { runs: Snapshot[]; onChange: () => void }) {
  const auth = useAuth();
  const signedIn = auth.enabled && auth.authenticated;
  const hl = useApi(signedIn ? () => api.liveStatus() : null, [signedIn], { pollMs: 20_000 });
  const sol = useApi(signedIn ? () => api.solanaStatus() : null, [signedIn], { pollMs: 20_000 });

  const live = runs.filter((s) => s.deployment.mode === "live" && !s.deployment.alertsOnly);
  const positions = live.flatMap((s) => s.positions.map((p) => ({ p, run: s })));
  const invested = positions.reduce((n, { p }) => n + p.sizeUsd, 0);
  const open = positions.reduce((n, { p }) => n + p.unrealizedPnlUsd, 0);
  const value = invested + open;
  const closed = live.reduce((n, s) => n + s.realizedPnlUsd, 0);

  const hlFree = hlFreeUsd(hl.data?.venue);
  const solFree = sol.data?.balances?.usd ?? null;
  const testnet = hl.data?.config.network === "testnet";

  return (
    <section className="space-y-4">
      <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-3">
        <div className="bg-card p-5">
          <div className="text-[13px] text-muted">Available to trade</div>
          <div className="tnum mt-1.5 text-[26px] font-semibold tracking-[-0.03em] text-ink">
            {hlFree == null && solFree == null ? "—" : fmtUsd((hlFree ?? 0) + (solFree ?? 0), 2)}
          </div>
          <dl className="mt-2 space-y-1 text-[12.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Hyperliquid{testnet ? " (testnet)" : ""}</dt>
              <dd className="tnum text-ink-2">
                {hlFree != null ? fmtUsd(hlFree, 2) : <Link href="/app/live" className="text-ink underline decoration-line-2 underline-offset-4">Connect</Link>}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Solana</dt>
              <dd className="tnum text-ink-2">
                {solFree != null ? (
                  <>
                    {fmtUsd(solFree, 2)}
                    {sol.data?.balances?.sol != null && <span className="text-faint"> · {sol.data.balances.sol.toFixed(3)} SOL</span>}
                  </>
                ) : (
                  <Link href="/app/live?venue=solana" className="text-ink underline decoration-line-2 underline-offset-4">Set up</Link>
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-4 text-[12.5px]">
            <Link href="/app/live" className="font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">Add money</Link>
            <Link href="/app/live" className="font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">Withdraw</Link>
          </div>
        </div>
        <div className="bg-card p-5">
          <div className="text-[13px] text-muted">In positions</div>
          <div className="tnum mt-1.5 text-[26px] font-semibold tracking-[-0.03em] text-ink">{fmtUsd(value, 2)}</div>
          <div className="mt-2 text-[12.5px] text-muted">
            {positions.length ? `${positions.length} open position${positions.length === 1 ? "" : "s"}, bought for ${fmtUsd(invested, 2)}` : "Nothing open right now"}
          </div>
        </div>
        <div className="bg-card p-5">
          <div className="text-[13px] text-muted">Up or down</div>
          <div className={`tnum mt-1.5 text-[26px] font-semibold tracking-[-0.03em] ${tone(open)}`}>
            {signed(open)}
            {invested > 0 && <span className="ml-2 text-[16px] font-medium">{fmtPct((open / invested) * 100)}</span>}
          </div>
          <div className="mt-2 text-[12.5px] text-muted">
            On open positions · closed so far <span className={`tnum ${tone(closed)}`}>{signed(closed)}</span>
          </div>
        </div>
      </div>

      {positions.length > 0 && (
        <Card className="overflow-hidden">
          {/* Phones: one compact row per position instead of a seven-column table. */}
          <ul className="divide-y divide-line sm:hidden">
            {positions.map(({ p, run }) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <AssetIcon {...instrumentIcon(p.instrument)} size={26} />
                <Link href={`/app/run?id=${encodeURIComponent(run.deployment.id)}`} className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">
                    {instrumentLabel(p.instrument)}
                    {p.leverage > 1 && <span className="ml-1.5 text-[12px] font-normal text-muted">{p.leverage}×</span>}
                    {p.side === "short" && <span className="ml-1.5 text-[12px] font-normal text-short">short</span>}
                  </div>
                  <div className="tnum truncate text-[12px] text-muted">
                    {fmtUsd(p.sizeUsd + p.unrealizedPnlUsd, 2)} · bought for {fmtUsd(p.sizeUsd, 2)}
                  </div>
                </Link>
                <div className={`tnum text-right text-[13px] font-medium ${tone(p.unrealizedPnlUsd)}`}>
                  {signed(p.unrealizedPnlUsd)}
                  <div className="text-[11.5px] font-normal opacity-80">{fmtPct(p.unrealizedPnlPct)}</div>
                </div>
                {(run.deployment.status === "running" || run.deployment.status === "paused") && (
                  <SellButton deploymentId={run.deployment.id} positionId={p.id} label={instrumentLabel(p.instrument)} onDone={onChange} />
                )}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] text-left text-[13.5px]">
              <thead className="text-[12.5px] text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-normal">Position</th>
                  <th className="px-3 py-2.5 text-right font-normal">Bought for</th>
                  <th className="px-3 py-2.5 text-right font-normal">Worth now</th>
                  <th className="px-3 py-2.5 text-right font-normal">Entry</th>
                  <th className="px-3 py-2.5 text-right font-normal">Now</th>
                  <th className="px-3 py-2.5 text-right font-normal">Up or down</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {positions.map(({ p, run }) => {
                  const fmt = priceFormatter(p.instrument.kind === "outcome" ? { product: "predictions" } : null);
                  return (
                    <tr key={p.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <AssetIcon {...instrumentIcon(p.instrument)} size={24} />
                          <div className="min-w-0">
                            <div className="font-medium text-ink">
                              {instrumentLabel(p.instrument)}
                              {p.side === "short" && <span className="ml-1.5 text-[12px] font-normal text-short">short</span>}
                              {p.leverage > 1 && <span className="ml-1.5 text-[12px] font-normal text-muted">{p.leverage}×</span>}
                            </div>
                            <Link href={`/app/run?id=${encodeURIComponent(run.deployment.id)}`} className="block truncate text-[12px] text-muted hover:text-ink">
                              {run.deployment.strategy.name}
                            </Link>
                          </div>
                        </div>
                      </td>
                      <td className="tnum px-3 py-3 text-right text-ink-2">{fmtUsd(p.sizeUsd, 2)}</td>
                      <td className="tnum px-3 py-3 text-right text-ink">{fmtUsd(p.sizeUsd + p.unrealizedPnlUsd, 2)}</td>
                      <td className="tnum px-3 py-3 text-right text-ink-2">{fmt(p.entryPrice)}</td>
                      <td className="tnum px-3 py-3 text-right text-ink-2">{fmt(p.markPrice)}</td>
                      <td className={`tnum px-3 py-3 text-right font-medium ${tone(p.unrealizedPnlUsd)}`}>
                        {signed(p.unrealizedPnlUsd)} <span className="text-[12px] font-normal opacity-80">{fmtPct(p.unrealizedPnlPct)}</span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        {(run.deployment.status === "running" || run.deployment.status === "paused") && (
                          <SellButton deploymentId={run.deployment.id} positionId={p.id} label={instrumentLabel(p.instrument)} onDone={onChange} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}
