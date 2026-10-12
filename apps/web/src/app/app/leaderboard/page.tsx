"use client";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApi, fmtUsd, fmtPct, ago } from "@/lib/use-api";
import { PageHeader, Card, Empty, Btn } from "@/components/app/AppShell";
import { Sparkline } from "@/components/ui/Sparkline";
import { trendColor } from "@/components/app/RunCard";

export default function LeaderboardPage() {
  const { data, loading, error } = useApi(() => api.leaderboard(), [], { pollMs: 10_000 });
  const rows = data?.rows ?? [];
  return (
    <>
      <PageHeader title="Leaderboard" sub="Every run, ranked by return since it started. Paper runs use simulated trades at live prices." />
      <div className="px-5 pb-16 pt-6 lg:px-10">
        {error && !rows.length ? (
          <Empty title="The leaderboard is unavailable" sub="Can’t reach the Weft server. Try again in a moment." />
        ) : loading && !rows.length ? (
          <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />
        ) : !rows.length ? (
          <Empty title="No runs yet" sub="Start a run and it will show up here." action={<Btn href="/app/new">New strategy</Btn>} />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[14px]">
                <thead className="text-[12.5px] text-muted">
                  <tr className="border-b border-line">
                    <th className="w-12 px-5 py-2.5 font-normal">#</th>
                    <th className="px-3 py-2.5 font-normal">Strategy</th>
                    <th className="px-3 py-2.5 text-right font-normal">Return</th>
                    <th className="px-3 py-2.5 text-right font-normal">Value</th>
                    <th className="px-3 py-2.5 text-right font-normal">Trend</th>
                    <th className="px-5 py-2.5 text-right font-normal">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.deploymentId} className="relative border-b border-line transition-colors last:border-0 hover:bg-paper-2/40">
                      <td className="tnum px-5 py-3.5 text-muted">{r.returnPct === 0 ? "–" : i + 1}</td>
                      <td className="px-3 py-3.5">
                        <Link href={`/app/run?id=${encodeURIComponent(r.deploymentId)}`} className="font-medium text-ink after:absolute after:inset-0">
                          {r.name}
                        </Link>
                        <div className="mt-0.5 text-[12.5px] capitalize text-muted">
                          {r.status !== "running" ? `${r.status} · ` : ""}
                          {r.tags.slice(0, 3).join(", ")}
                        </div>
                      </td>
                      <td className={`tnum px-3 py-3.5 text-right ${r.returnPct === 0 ? "text-[13px] text-muted" : r.returnPct > 0 ? "font-medium text-long" : "font-medium text-short"}`}>{r.returnPct === 0 ? "No change yet" : fmtPct(r.returnPct)}</td>
                      <td className="tnum px-3 py-3.5 text-right text-ink-2">{fmtUsd(r.equityUsd, 0)}</td>
                      <td className="px-3 py-3.5">
                        <div className="flex justify-end">
                          {r.equityCurve.length > 1 && <Sparkline data={r.equityCurve.map((p) => p[1])} width={96} height={26} strokeWidth={1.4} color={trendColor(r.returnPct)} />}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right text-[13px] text-muted">{ago(r.since)}</td>
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
