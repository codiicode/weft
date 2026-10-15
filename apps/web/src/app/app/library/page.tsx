"use client";
import Link from "next/link";
import { AssetStack } from "@/components/ui/AssetIcon";
import { strategyIcons } from "@/lib/assets";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { describeStrategy } from "@/lib/strategy-view";
import { PageHeader, Btn, Empty } from "@/components/app/AppShell";
import type { LibraryEntry } from "@/lib/api";

function Row({ e, onCopy }: { e: LibraryEntry; onCopy: () => void }) {
  const first = useMemo(() => describeStrategy(e.strategy).rules[0], [e.strategy]);
  return (
    <li className="group relative grid gap-3 px-5 py-5 transition-colors hover:bg-paper-2/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <AssetStack items={strategyIcons(e.strategy)} size={24} max={3} />
          <Link href={`/app/strategy?id=${encodeURIComponent(e.id)}`} className="text-[15.5px] font-medium text-ink after:absolute after:inset-0">
            {e.strategy.name}
          </Link>
        </div>
        <p className="mt-0.5 line-clamp-1 text-[14px] text-muted">{e.strategy.thesis}</p>
        {first && (
          <p className="mt-2 line-clamp-1 text-[13.5px] text-ink-2">
            <span className="text-muted">When </span>
            {first.when.join(first.match === "any" ? " or " : " and ")}
            {first.then[0] && (
              <>
                <span className="text-muted"> → </span>
                {first.then[0].text.split(";")[0]}
              </>
            )}
          </p>
        )}
      </div>
      <div className="relative z-10 flex items-center gap-4 text-[13px] text-muted">
        <span className="hidden whitespace-nowrap sm:inline">
          {e.forks ? `${e.forks} ${e.forks === 1 ? "copy" : "copies"}` : ""}
        </span>
        <Btn variant="ghost" href={`/app/new?from=${encodeURIComponent(e.id)}`}>
          Edit a copy
        </Btn>
      </div>
    </li>
  );
}

export default function LibraryPage() {
  const router = useRouter();
  const { data, loading, error } = useApi(() => api.strategies(), []);
  const requireAuth = useRequireAuth();
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const all = data?.strategies ?? [];
  const tags = [...new Set(all.flatMap((e) => e.strategy.tags))].slice(0, 8);
  const list = all.filter(
    (e) => (!tag || e.strategy.tags.includes(tag)) && (!q || `${e.strategy.name} ${e.strategy.thesis}`.toLowerCase().includes(q.toLowerCase())),
  );
  const copy = async (id: string) => {
    if (!requireAuth()) return;
    const f = await api.fork(id);
    router.push(`/app/strategy?id=${encodeURIComponent(f.id)}`);
  };
  return (
    <>
      <PageHeader title="Strategies" sub="Shared by people using Weft. Read the rules, then make a copy and adjust it." />
      <div className="space-y-4 px-5 pb-16 pt-6 lg:px-10">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="no-scrollbar fade-r flex gap-1 overflow-x-auto">
            {[null, ...tags].map((t) => (
              <button
                key={t ?? "all"}
                onClick={() => setTag(t)}
                className={`h-8 shrink-0 rounded-[8px] px-3 text-[13.5px] capitalize transition-colors ${tag === t ? "bg-paper-2 font-medium text-ink" : "text-muted hover:text-ink"}`}
              >
                {t ?? "All"}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label="Search strategies"
            className="h-9 w-full rounded-[10px] border border-line-2 bg-card px-3.5 text-[14px] text-ink outline-none placeholder:text-faint focus:border-ink/40 md:w-64"
          />
        </div>
        {error && !all.length ? (
          <Empty title="Strategies are unavailable" sub="Can’t reach the Weft server. Try again in a moment." />
        ) : loading && !all.length ? (
          <div className="h-80 animate-pulse rounded-[12px] bg-paper-2" />
        ) : !list.length ? (
          <Empty title="Nothing matches" sub="Try another filter, or write your own." action={<Btn href="/app/new">New strategy</Btn>} />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-card">
            {list.map((e) => (
              <Row key={e.id} e={e} onCopy={() => copy(e.id)} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
