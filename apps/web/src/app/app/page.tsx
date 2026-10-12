"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApi, fmtUsd, fmtCompact } from "@/lib/use-api";
import { PageHeader, Card, Btn, Stat, Empty } from "@/components/app/AppShell";
import { RunCard } from "@/components/app/RunCard";
import { IconModel, IconSend } from "@/components/graph/icons";

const PRODUCT_TILES = [
  ["perps", "Perps", "Hyperliquid"],
  ["stocks", "Stocks", "HIP-3 · xStocks"],
  ["predictions", "Predictions", "HIP-4 · Jupiter"],
  ["tokens", "Solana tokens", "pump.fun · Meteora · Raydium"],
  ["options", "Options", "Defined-risk"],
] as const;

export default function Overview() {
  const router = useRouter();
  const [thesis, setThesis] = useState("");
  const stats = useApi(() => api.stats(), [], { pollMs: 10_000 });
  const runs = useApi(() => api.deployments(), [], { pollMs: 8_000 });
  const lib = useApi(() => api.strategies(), []);
  const st = stats.data;
  return (
    <>
      <PageHeader eyebrow="Overview" title={<>Trade the <span className="serif-em">thesis.</span></>} sub="Write what you believe. Weft turns it into a graph, runs it on paper against live markets, and goes live only when you approve." />
      <div className="space-y-8 px-5 py-6 lg:px-10">
        <Card className="p-3 sm:p-4">
          <form onSubmit={(e) => { e.preventDefault(); if (thesis.trim().length > 2) router.push(`/app/new?go=1&thesis=${encodeURIComponent(thesis.trim())}`); }} className="flex items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--signal-soft)] text-signal"><IconModel size={16} /></span>
            <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="What do you believe about the market?" className="h-10 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint" aria-label="Thesis" />
            <button type="submit" className="grid h-10 w-10 place-items-center rounded-full bg-ink text-paper" aria-label="Build strategy"><IconSend size={15} /></button>
          </form>
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Running" value={st ? `${st.running}/${st.deployments}` : "—"} sub="paper deployments" />
          <Stat label="Strategies" value={st?.strategies ?? "—"} sub="in the library" />
          <Stat label="Paper volume" value={st ? fmtCompact(st.volumeUsd) : "—"} sub={st ? `${st.fills} fills` : undefined} />
          <Stat label="Builder fees" value={st ? fmtUsd(st.builderFeesUsd, 2) : "—"} sub="would fund buybacks" />
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[17px] font-semibold tracking-[-0.02em]">Markets</h2>
            <Link href="/app/markets" className="font-mono text-[11.5px] text-muted hover:text-ink">All markets →</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {PRODUCT_TILES.map(([id, label, venues]) => (
              <Link key={id} href={`/app/markets?p=${id}`} className="group rounded-[18px] border border-line bg-card p-4 transition-shadow hover:shadow-lift">
                <div className="text-[15px] font-semibold tracking-[-0.02em]">{label}</div>
                <div className="mt-1 font-mono text-[10.5px] text-faint">{venues}</div>
                <div className="mt-4 font-mono text-[11px] text-muted transition-colors group-hover:text-ink">Browse →</div>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[17px] font-semibold tracking-[-0.02em]">Running</h2>
            <Link href="/app/runs" className="font-mono text-[11.5px] text-muted hover:text-ink">All runs →</Link>
          </div>
          {runs.data?.deployments.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{runs.data.deployments.slice(0, 6).map((s) => <RunCard key={s.deployment.id} s={s} />)}</div>
          ) : (
            <Empty title={runs.error ? "Engine offline" : "Nothing running yet"} sub={runs.error ? "Start the API: npm run dev -w @weft/api" : "Start from a thesis or fork a strategy from the library."} action={<Btn href="/app/new">Write a thesis</Btn>} />
          )}
        </section>

        {lib.data?.strategies.length ? (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[17px] font-semibold tracking-[-0.02em]">From the library</h2>
              <Link href="/app/library" className="font-mono text-[11.5px] text-muted hover:text-ink">Library →</Link>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {lib.data.strategies.slice(0, 6).map((e) => (
                <Link key={e.id} href={`/app/strategy?id=${encodeURIComponent(e.id)}`} className="rounded-[18px] border border-line bg-card p-4 transition-shadow hover:shadow-lift">
                  <div className="text-[15px] font-semibold tracking-[-0.02em]">{e.strategy.name}</div>
                  <div className="mt-1 line-clamp-2 text-[13px] text-ink-2">“{e.strategy.thesis}”</div>
                  <div className="mt-3 font-mono text-[10.5px] text-faint">{e.author} · {e.strategy.signals.length} signals · {e.strategy.actions.length} actions</div>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
