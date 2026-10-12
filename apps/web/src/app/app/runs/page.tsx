"use client";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { PageHeader, Btn, Empty } from "@/components/app/AppShell";
import { RunCard } from "@/components/app/RunCard";

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
