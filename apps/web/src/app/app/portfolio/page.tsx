"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth";
import { PageHeader, Btn, Empty, Card } from "@/components/app/AppShell";
import { RunListHeader, RunRow } from "@/components/app/RunCard";
import { Portfolio } from "@/components/app/Portfolio";

const FILTERS = [
  ["all", "All"],
  ["running", "Running"],
  ["stopped", "Stopped"],
] as const;

export default function PortfolioPage() {
  const auth = useAuth();
  const { data, loading, error, refresh } = useApi(() => api.deployments(), [auth.authenticated], { pollMs: 6_000 });
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const runs = data?.deployments ?? [];
  const shown = runs.filter((s) =>
    filter === "all" ? true : filter === "running" ? s.deployment.status === "running" || s.deployment.status === "paused" : s.deployment.status === "stopped" || s.deployment.status === "killed",
  );
  return (
    <>
      <PageHeader title="Portfolio" sub="Your money, your positions, and every strategy you’ve started." />
      <div className="px-5 pb-16 pt-6 lg:px-10">
        {error && !runs.length ? (
          <Empty title="Can’t reach the Weft server" sub="Your runs will appear here once it’s back." />
        ) : loading && !runs.length ? (
          <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />
        ) : !runs.length && auth.enabled && !auth.authenticated ? (
          <Empty title="Sign in to see your runs" sub="Runs belong to your account, so they follow you to any device." action={<Btn onClick={auth.login}>Sign in</Btn>} />
        ) : !runs.length ? (
          <Empty title="Nothing running yet" sub="Write a thesis or start from a strategy someone else made." action={<Btn href="/app/new">Write a thesis</Btn>} />
        ) : (
          <>
            <Portfolio runs={runs} onChange={() => void refresh()} />
            <h2 className="mb-3 mt-8 text-[15px] font-semibold tracking-[-0.015em] text-ink">Your strategies</h2>
            <div className="mb-4 flex gap-1">
              {FILTERS.map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`h-8 rounded-[8px] px-3 text-[13.5px] transition-colors ${filter === k ? "bg-paper-2 font-medium text-ink" : "text-muted hover:text-ink"}`}
                >
                  {l}
                </button>
              ))}
            </div>
            <Card className="overflow-hidden">
              <RunListHeader />
              <div className="divide-y divide-line">
                {shown.map((s) => (
                  <RunRow key={s.deployment.id} s={s} />
                ))}
                {!shown.length && <p className="px-5 py-8 text-center text-[14px] text-muted">No runs here.</p>}
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
