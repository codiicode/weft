"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { PageHeader, Card, Btn, Pill, Empty } from "@/components/app/AppShell";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";

export default function LibraryPage() {
  const { data, loading, error, refresh } = useApi(() => api.strategies(), []);
  const requireAuth = useRequireAuth();
  const [tag, setTag] = useState<string | null>(null);
  const all = data?.strategies ?? [];
  const tags = [...new Set(all.flatMap((e) => e.strategy.tags))].slice(0, 10);
  const list = tag ? all.filter((e) => e.strategy.tags.includes(tag)) : all;
  return (
    <>
      <PageHeader eyebrow="Library" title={<>Public strategies, <span className="serif-em">forkable.</span></>} sub="Read any strategy node by node. Fork it to make it yours; forking copies the logic, never anyone's funds." />
      <div className="space-y-5 px-5 py-6 lg:px-10">
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setTag(null)} className={`rounded-full px-3 py-1 text-[12.5px] ${!tag ? "bg-ink text-paper" : "border border-line text-ink-2"}`}>All</button>
            {tags.map((t) => (
              <button key={t} onClick={() => setTag(t)} className={`rounded-full px-3 py-1 text-[12.5px] ${tag === t ? "bg-ink text-paper" : "border border-line text-ink-2"}`}>{t}</button>
            ))}
          </div>
        )}
        {error && !all.length ? (
          <Empty title="Can't reach the API" sub={error.message} />
        ) : loading && !all.length ? (
          <div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-72 animate-pulse rounded-[20px] bg-paper-2" />)}</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {list.map((e) => (
              <Card key={e.id} className="flex flex-col p-5">
                <div className="flex items-center gap-2">
                  {e.strategy.tags.slice(0, 3).map((t) => <Pill key={t}>{t}</Pill>)}
                  <span className="ml-auto font-mono text-[11px] text-faint">{e.author}</span>
                </div>
                <Link href={`/app/strategy?id=${encodeURIComponent(e.id)}`} className="mt-3 text-[19px] font-semibold tracking-[-0.03em] hover:underline">{e.strategy.name}</Link>
                <p className="mt-1 line-clamp-2 text-[13.5px] text-ink-2">“{e.strategy.thesis}”</p>
                <div className="mt-4 flex-1">
                  <StrategyCanvas strategy={e.strategy} preset="compact" animate={false} className="py-4" />
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <span className="font-mono text-[11px] text-faint">{e.forks} forks{e.forkedFrom ? ` · forked from ${e.forkedFrom}` : ""}</span>
                  <div className="ml-auto flex gap-2">
                    <Btn variant="ghost" onClick={async () => { if (!requireAuth()) return; await api.fork(e.id); refresh(); }}>Fork</Btn>
                    <Btn href={`/app/strategy?id=${encodeURIComponent(e.id)}`}>Open</Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
