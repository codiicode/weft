"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { PageHeader, Card, Btn, Pill, Empty } from "@/components/app/AppShell";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { DeployPanel } from "@/components/app/DeployPanel";
import { BacktestPanel } from "@/components/app/BacktestPanel";

function StrategyView() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const { data: e, error } = useApi(id ? () => api.strategy(id) : null, [id]);
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!id) return <div className="p-10"><Empty title="No strategy selected" action={<Btn href="/app/library">Library</Btn>} /></div>;
  if (!e) return <div className="p-10">{error ? <Empty title="Strategy not found" sub={error.message} action={<Btn href="/app/library">Library</Btn>} /> : <div className="h-72 animate-pulse rounded-[20px] bg-paper-2" />}</div>;
  const s = e.strategy;
  return (
    <>
      <PageHeader
        eyebrow={`Strategy · ${e.author}`}
        title={s.name}
        sub={<span className="italic">“{s.thesis}”</span>}
        actions={
          <>
            <Btn variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(window.location.href); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy link"}</Btn>
            <Btn variant="ghost" onClick={async () => { const f = await api.fork(e.id); router.push(`/app/strategy?id=${encodeURIComponent(f.id)}`); }}>Fork</Btn>
          </>
        }
      />
      <div className="grid gap-6 px-5 py-6 lg:px-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {s.tags.map((t) => <Pill key={t}>{t}</Pill>)}
            {e.forkedFrom && <Pill tone="signal">fork of {e.forkedFrom}</Pill>}
            <button onClick={() => setShowJson((v) => !v)} className="ml-auto font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-ink">{showJson ? "Graph" : "JSON"}</button>
          </div>
          {showJson ? (
            <pre className="max-h-[640px] overflow-auto rounded-2xl border border-line bg-card p-4 font-mono text-[12px] leading-relaxed">{JSON.stringify(s, null, 2)}</pre>
          ) : (
            <StrategyCanvas strategy={s} />
          )}
          <BacktestPanel strategyId={e.id} />
        </div>
        <div className="space-y-4">
          <DeployPanel strategyId={e.id} />
          <Card className="p-5 font-mono text-[12px]">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted">Graph</div>
            <dl className="mt-3 grid grid-cols-2 gap-y-2">
              <dt className="text-faint">Signals</dt><dd className="text-right">{s.signals.length}</dd>
              <dt className="text-faint">Triggers</dt><dd className="text-right">{s.triggers.length}</dd>
              <dt className="text-faint">Actions</dt><dd className="text-right">{s.actions.length}</dd>
              <dt className="text-faint">Forks</dt><dd className="text-right">{e.forks}</dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function StrategyPage() {
  return (
    <Suspense>
      <StrategyView />
    </Suspense>
  );
}
