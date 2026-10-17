"use client";
import { Suspense, useState } from "react";
import { useTitle } from "@/lib/use-title";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { PageHeader, Card, Btn, Empty } from "@/components/app/AppShell";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { StrategyRules } from "@/components/app/StrategyRules";
import { DeployPanel } from "@/components/app/DeployPanel";
import { BacktestPanel, CopyNoBacktest } from "@/components/app/BacktestPanel";

function StrategyView() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const { data: e, error } = useApi(id ? () => api.strategy(id) : null, [id]);
  const [view, setView] = useState<"rules" | "graph" | "json">("rules");
  const requireAuth = useRequireAuth();
  const [copied, setCopied] = useState(false);
  useTitle(e?.strategy.name);
  if (!id) return <div className="p-10"><Empty title="No strategy selected" action={<Btn href="/strategies">Browse strategies</Btn>} /></div>;
  if (!e)
    return (
      <div className="p-10">
        {error ? <Empty title="Strategy not found" sub="It may have been removed." action={<Btn href="/strategies">Browse strategies</Btn>} /> : <div className="h-72 animate-pulse rounded-[12px] bg-paper-2" />}
      </div>
    );
  const s = e.strategy;
  return (
    <>
      <PageHeader
        back={{ href: "/strategies", label: "Strategies" }}
        title={s.name}
        sub={s.thesis}
        actions={
          <>
            {/* The share link (/s/<id>) shows this strategy's own title and card when posted. */}
            <Btn
              variant="quiet"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${window.location.origin}/s/${encodeURIComponent(e.id)}`);
                } catch {}
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Link copied" : "Copy link"}
            </Btn>
            <Btn
              variant="quiet"
              href={`https://x.com/intent/post?text=${encodeURIComponent(`${s.name}, a strategy on Weft`)}&url=${encodeURIComponent(`https://weft.fi/s/${e.id}`)}&via=weftfinance`}
            >
              Post on X
            </Btn>

            <Btn variant="ghost" href={`/new?from=${encodeURIComponent(e.id)}`}>
              Edit a copy
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
            <button
              onClick={() => setView(view === "json" ? "rules" : "json")}
              className={`-mb-px ml-auto border-b-2 pb-2.5 text-[13px] transition-colors ${view === "json" ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {view === "json" ? "Close JSON" : "View JSON"}
            </button>
          </div>
          {view === "rules" ? (
            <StrategyRules strategy={s} />
          ) : view === "graph" ? (
            <StrategyCanvas strategy={s} />
          ) : (
            <pre className="max-h-[640px] overflow-auto rounded-[12px] border border-line bg-card p-4 font-mono text-[12.5px] leading-relaxed text-ink">{JSON.stringify(s, null, 2)}</pre>
          )}
          {s.actions.some((a) => a.type === "copy") ? <CopyNoBacktest /> : <BacktestPanel strategyId={e.id} />}
        </div>
        <div className="order-first space-y-4 xl:order-none">
          <DeployPanel strategyId={e.id} strategy={e.strategy} />
          <Card className="p-5">
            <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">About</div>
            <dl className="mt-3 space-y-2 text-[13.5px]">
              {e.forks > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Copies</dt>
                  <dd className="tnum text-ink">{e.forks}</dd>
                </div>
              )}
              {e.forkedFrom && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Based on</dt>
                  <dd className="truncate">
                    <Link href={`/strategy?id=${encodeURIComponent(e.forkedFrom)}`} className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
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
