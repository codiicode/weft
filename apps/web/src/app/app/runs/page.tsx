"use client";
import Link from "next/link";
import { api, type Snapshot } from "@/lib/api";
import { useApi, fmtUsd, fmtPct, ago } from "@/lib/use-api";
import { PageHeader, Card, Btn, Pill, Empty } from "@/components/app/AppShell";
import { Sparkline } from "@/components/ui/Sparkline";

export function RunCard({ s }: { s: Snapshot }) {
  const d = s.deployment;
  const curve = s.equityCurve.map((p) => p[1]);
  const up = s.returnPct >= 0;
  return (
    <Link href={`/app/run?id=${encodeURIComponent(d.id)}`} className="group block">
      <Card className="h-full p-5 transition-shadow duration-300 group-hover:shadow-lift">
        <div className="flex items-center gap-2">
          <Pill tone={d.status === "running" ? "long" : d.status === "killed" ? "short" : "neutral"}>
            {d.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-long" />}
            {d.status}
          </Pill>
          <span className="ml-auto font-mono text-[10.5px] text-faint">checked {ago(s.lastTickAt)}</span>
        </div>
        <div className="mt-3 truncate text-[17px] font-semibold tracking-[-0.02em]">{d.strategy.name}</div>
        <div className="mt-0.5 line-clamp-1 text-[13px] text-ink-2">“{d.strategy.thesis}”</div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <div className={`tnum font-mono text-[22px] ${up ? "text-long" : "text-short"}`}>{fmtPct(s.returnPct)}</div>
            <div className="tnum font-mono text-[11.5px] text-faint">{fmtUsd(s.equityUsd, 2)} · {s.positions.length} open</div>
          </div>
          {curve.length > 1 && <Sparkline data={curve} width={120} height={36} color={up ? "var(--long)" : "var(--short)"} />}
        </div>
      </Card>
    </Link>
  );
}

export default function RunsPage() {
  const { data, loading, error } = useApi(() => api.deployments(), [], { pollMs: 6_000 });
  const runs = data?.deployments ?? [];
  return (
    <>
      <PageHeader eyebrow="Runs" title="Your strategies, running" sub="Every run is paper-traded against live prices with real fees, slippage and exits." actions={<Btn href="/app/new" variant="volt">New strategy</Btn>} />
      <div className="px-5 py-6 lg:px-10">
        {error && !runs.length ? (
          <Empty title="Can't reach the engine" sub={error.message} />
        ) : loading && !runs.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-44 animate-pulse rounded-[20px] bg-paper-2" />)}</div>
        ) : !runs.length ? (
          <Empty title="Nothing running yet" sub="Write a thesis or start from a library strategy." action={<Btn href="/app/new">Write a thesis</Btn>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {runs.map((s) => <RunCard key={s.deployment.id} s={s} />)}
          </div>
        )}
      </div>
    </>
  );
}
