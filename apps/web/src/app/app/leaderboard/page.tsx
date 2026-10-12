"use client";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApi, fmtUsd, fmtPct, ago } from "@/lib/use-api";
import { PageHeader, Card, Pill, Empty, Btn } from "@/components/app/AppShell";
import { Sparkline } from "@/components/ui/Sparkline";

export default function LeaderboardPage() {
  const { data, loading, error } = useApi(() => api.leaderboard(), [], { pollMs: 10_000 });
  const rows = data?.rows ?? [];
  return (
    <>
      <PageHeader eyebrow="Leaderboard" title="Paper leaderboard" sub="Ranked by return since start. Every number comes from simulated fills against live prices; on mainnet it will come from on-chain fills." />
      <div className="px-5 py-6 lg:px-10">
        {error && !rows.length ? (
          <Empty title="Can't reach the engine" sub={error.message} />
        ) : loading && !rows.length ? (
          <div className="h-64 animate-pulse rounded-[20px] bg-paper-2" />
        ) : !rows.length ? (
          <Empty title="No runs yet" sub="Start a paper run and it will show up here." action={<Btn href="/app/new">Write a thesis</Btn>} />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-[13.5px]">
                <thead className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">
                  <tr className="border-b border-line">
                    <th className="px-5 py-3 font-normal">#</th>
                    <th className="px-3 py-3 font-normal">Strategy</th>
                    <th className="px-3 py-3 font-normal">Status</th>
                    <th className="px-3 py-3 text-right font-normal">Return</th>
                    <th className="px-3 py-3 text-right font-normal">Equity</th>
                    <th className="px-3 py-3 font-normal">Curve</th>
                    <th className="px-5 py-3 text-right font-normal">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.deploymentId} className="border-b border-line last:border-0 hover:bg-paper-2/60">
                      <td className="px-5 py-3 font-mono text-faint">{String(i + 1).padStart(2, "0")}</td>
                      <td className="px-3 py-3">
                        <Link href={`/app/run?id=${encodeURIComponent(r.deploymentId)}`} className="font-medium hover:underline">{r.name}</Link>
                        <div className="mt-0.5 flex gap-1">{r.tags.slice(0, 3).map((t) => <span key={t} className="font-mono text-[10.5px] text-faint">{t}</span>)}</div>
                      </td>
                      <td className="px-3 py-3"><Pill tone={r.status === "running" ? "long" : "neutral"}>{r.status}</Pill></td>
                      <td className={`tnum px-3 py-3 text-right font-mono ${r.returnPct >= 0 ? "text-long" : "text-short"}`}>{fmtPct(r.returnPct)}</td>
                      <td className="tnum px-3 py-3 text-right font-mono text-ink-2">{fmtUsd(r.equityUsd, 0)}</td>
                      <td className="px-3 py-3">{r.equityCurve.length > 1 && <Sparkline data={r.equityCurve.map((p) => p[1])} width={110} height={28} color={r.returnPct >= 0 ? "var(--long)" : "var(--short)"} />}</td>
                      <td className="px-5 py-3 text-right font-mono text-[12px] text-faint">{ago(r.since)}</td>
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
