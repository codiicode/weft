"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { PageHeader, Card, Btn, Empty } from "@/components/app/AppShell";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { StrategyRules } from "@/components/app/StrategyRules";
import { DeployPanel } from "@/components/app/DeployPanel";
import { BacktestPanel } from "@/components/app/BacktestPanel";

function StrategyView() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const { data: e, error } = useApi(id ? () => api.strategy(id) : null, [id]);
  const [view, setView] = useState<"rules" | "graph" | "json">("rules");
  const requireAuth = useRequireAuth();
  const [copied, setCopied] = useState(false);
  if (!id) return <div className="p-10"><Empty title="No strategy selected" action={<Btn href="/app/library">Browse strategies</Btn>} /></div>;
  if (!e)
    return (
      <div className="p-10">
        {error ? <Empty title="Strategy not found" sub="It may have been removed." action={<Btn href="/app/library">Browse strategies</Btn>} /> : <div className="h-72 animate-pulse rounded-[12px] bg-paper-2" />}
      </div>
    );
  const s = e.strategy;
  return (
    <>
      <PageHeader
        back={{ href: "/app/library", label: "Strategies" }}
        title={s.name}
        sub={s.thesis}
        actions={
          <>
            <Btn
              variant="quiet"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href);
                } catch {}
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Link copied" : "Share"}
            </Btn>
            <Btn variant="quiet" href={`/app/new?from=${encodeURIComponent(e.id)}`}>
              Edit
            </Btn>
            <Btn
              variant="ghost"
              onClick={async () => {
                if (!requireAuth()) return;
                const f = await api.fork(e.id);
                router.push(`/app/strategy?id=${encodeURIComponent(f.id)}`);
              }}
            >
              Make a copy
            </Btn>
          </>
        }
      />
      <div className="grid gap-8 px-5 pb-16 pt-6 lg:px-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <div role="tablist" aria-label="View" className="flex gap-5 border-b border-line text-[14px]">
            {(
              [
                ["rules", "Rules"],
                ["graph", "Diagram"],
                ["json", "JSON"],
              ] as const
            ).map(([t, l]) => (
              <button
                key={t}
                role="tab"
                aria-selected={view === t}
                onClick={() => setView(t)}
                className={`-mb-px border-b-2 pb-2.5 transition-colors ${view === t ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {l}
              </button>
            ))}
          </div>
          {view === "rules" ? (
            <StrategyRules strategy={s} />
          ) : view === "graph" ? (
            <StrategyCanvas strategy={s} />
          ) : (
            <pre className="max-h-[640px] overflow-auto rounded-[12px] border border-line bg-card p-4 font-mono text-[12.5px] leading-relaxed text-ink">{JSON.stringify(s, null, 2)}</pre>
          )}
          <BacktestPanel strategyId={e.id} />
        </div>
        <div className="space-y-4">
          <DeployPanel strategyId={e.id} />
          <Card className="p-5">
            <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">About</div>
            <dl className="mt-3 space-y-2 text-[13.5px]">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Shared by</dt>
                <dd className="text-ink">{e.author}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Copies</dt>
                <dd className="tnum text-ink">{e.forks}</dd>
              </div>
              {e.forkedFrom && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Based on</dt>
                  <dd className="truncate">
                    <Link href={`/app/strategy?id=${encodeURIComponent(e.forkedFrom)}`} className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
                      {e.forkedFrom}
                    </Link>
                  </dd>
                </div>
              )}
              {s.tags.length > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Topics</dt>
                  <dd className="text-right capitalize text-ink">{s.tags.join(", ")}</dd>
                </div>
              )}
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
