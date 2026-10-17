"use client";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApi, fmtPct, ago } from "@/lib/use-api";
import { PageHeader, Card, Empty, Btn } from "@/components/app/AppShell";
import { Sparkline } from "@/components/ui/Sparkline";
import { trendColor } from "@/components/app/RunCard";
import { AssetStack } from "@/components/ui/AssetIcon";
import { strategyIcons } from "@/lib/assets";

export default function LeaderboardPage() {
  const { data, loading, error } = useApi(() => api.leaderboard(), [], { pollMs: 15_000 });
  const rows = data?.rows ?? [];
  return (
    <>
      <PageHeader
        title="Leaderboard"
        sub="Real strategies, trading real money. Owners choose to share; you see the return in percent, never amounts or wallets."
      />
      <div className="px-5 pb-16 pt-6 lg:px-10">
        {error && !rows.length ? (
          <Empty title="The leaderboard is unavailable" sub="Can’t reach the Weft server. Try again in a moment." />
        ) : loading && !rows.length ? (
          <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />
        ) : !rows.length ? (
          <Empty
            title="No shared results yet"
            sub="Running a strategy? Share its return from the run’s page and it shows up here."
            action={<Btn href="/new">New strategy</Btn>}
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[14px] sm:min-w-[680px]">
                <thead className="text-[12.5px] text-muted">
                  <tr className="border-b border-line">
                    <th className="hidden w-12 px-5 py-2.5 font-normal sm:table-cell">#</th>
                    <th className="py-2.5 pl-4 pr-3 font-normal sm:pl-3">Strategy</th>
                    <th className="px-3 py-2.5 text-right font-normal">Return</th>
                    <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Trend</th>
                    <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Running</th>
                    <th className="py-2.5 pl-2 pr-4 sm:px-5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.deploymentId} className="border-b border-line transition-colors last:border-0 hover:bg-paper-2/40">
                      <td className="tnum hidden px-5 py-3.5 text-muted sm:table-cell">{i + 1}</td>
                      <td className="py-3.5 pl-4 pr-3 sm:pl-3">
                        <div className="flex items-center gap-3">
                          {r.strategy && <AssetStack items={strategyIcons(r.strategy)} size={26} max={2} />}
                          <div className="min-w-0">
                            <div className="font-medium text-ink">{r.name}</div>
                            {r.status !== "running" && <div className="mt-0.5 text-[12.5px] text-muted">{r.status === "paused" ? "Paused" : "Ended"}</div>}
                          </div>
                        </div>
                      </td>
                      <td className={`tnum whitespace-nowrap px-3 py-3.5 text-right font-medium ${r.returnPct > 0 ? "text-long" : r.returnPct < 0 ? "text-short" : "text-muted"}`}>
                        {fmtPct(r.returnPct)}
                      </td>
                      <td className="hidden px-3 py-3.5 sm:table-cell">
                        <div className="flex justify-end">
                          {r.returnCurve.length > 1 && <Sparkline data={r.returnCurve.map((p) => p[1])} width={96} height={26} strokeWidth={1.4} color={trendColor(r.returnPct)} />}
                        </div>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3.5 text-right text-[13px] text-muted sm:table-cell">{ago(r.since).replace(" ago", "")}</td>
                      <td className="py-3.5 pl-2 pr-4 text-right sm:px-5">
                        {r.strategy && (
                          <Link href={`/new?from=${encodeURIComponent(`shared:${r.deploymentId}`)}`} className="whitespace-nowrap text-[13.5px] font-medium text-ink hover:underline">
                            Copy →
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
