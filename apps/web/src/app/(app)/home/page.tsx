"use client";
import { useState } from "react";
import { AssetStack } from "@/components/ui/AssetIcon";
import { strategyIcons } from "@/lib/assets";
import { cardLine } from "@/lib/strategy-view";
import { useTradingVenues } from "@/lib/trading";
import { liveBlocker } from "@/components/app/DeployPanel";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth";
import { Card, Btn } from "@/components/app/AppShell";
import { RunListHeader, RunRow } from "@/components/app/RunCard";
import { IconSend } from "@/components/graph/icons";

const IDEAS = [
  "Buy $50 of ETH now",
  "If @elonmusk posts about Dogecoin, long DOGE 5x with $100",
  "Long BTC and ETH 20x with $100 each if Fear & Greed drops to 20",
  "Put $1,000 on the Spurs winning the NBA title if their odds pass 25%",
];

function SectionHead({ title, href, link }: { title: string; href?: string; link?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      {href && (
        <Link href={href} className="text-[13.5px] text-muted hover:text-ink">
          {link}
        </Link>
      )}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [thesis, setThesis] = useState("");
  const auth = useAuth();
  const runs = useApi(() => api.deployments(), [auth.authenticated], { pollMs: 8_000 });
  const lib = useApi(() => api.strategies(), []);
  const venues = useTradingVenues();
  // Popular: strategies that can actually trade live (same check as the start button).
  const popular = !venues ? [] : (lib.data?.strategies ?? []).filter((e) => liveBlocker(e.strategy, venues) == null);
  const alerts = useApi(auth.enabled && !auth.authenticated ? null : () => api.alerts(), [auth.authenticated], { pollMs: 30_000 });
  const go = (t: string) => router.push(`/new?go=1&thesis=${encodeURIComponent(t)}`);
  const list = runs.data?.deployments ?? [];

  return (
    <div className="max-w-[1100px] px-5 pb-16 pt-10 lg:px-10 lg:pt-14">
      <h1 className="display text-[clamp(2.2rem,4vw,3.2rem)] leading-[1.05] text-ink">What’s your thesis?</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (thesis.trim().length > 2) go(thesis.trim());
        }}
        className="mt-6 flex items-center gap-2 rounded-[14px] border border-line-2 bg-card p-2 pl-4 focus-within:border-ink/40"
      >
        <input
          value={thesis}
          onChange={(e) => setThesis(e.target.value)}
          placeholder="Describe a trade in your own words…"
          className="h-11 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-faint"
          aria-label="Your thesis"
        />
        <button type="submit" disabled={thesis.trim().length < 3} className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink text-paper disabled:opacity-30" aria-label="Draft strategy">
          <IconSend size={15} />
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13.5px]">
        {IDEAS.map((t) => (
          <button key={t} onClick={() => go(t)} className="text-left text-muted underline decoration-line-2 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink">
            {t}
          </button>
        ))}
      </div>

      <section className="mt-14">
        <SectionHead title="Your strategies" href={list.length ? "/portfolio" : undefined} link="View all" />
        {runs.error ? (
          <Card className="px-5 py-8 text-center text-[14px] text-muted">Can’t reach the Weft server right now. Your runs will show up when it’s back.</Card>
        ) : !runs.data ? (
          <div className="h-40 animate-pulse rounded-[12px] bg-paper-2" />
        ) : list.length ? (
          <Card className="overflow-hidden">
            <RunListHeader />
            <div className="divide-y divide-line">
              {list.slice(0, 6).map((s) => (
                <RunRow key={s.deployment.id} s={s} />
              ))}
            </div>
          </Card>
        ) : (
          <Card className="flex flex-col items-start gap-4 px-5 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[14.5px] font-medium text-ink">{auth.enabled && !auth.authenticated ? "Sign in to see your runs" : "Nothing running yet"}</p>
              <p className="mt-0.5 text-[14px] text-muted">Write a trade idea above, or start from one of the strategies below. Practice it with pretend money before any real money goes in.</p>
            </div>
            {auth.enabled && !auth.authenticated ? (
              <Btn onClick={auth.login} variant="ghost">
                Sign in
              </Btn>
            ) : (
              <Btn href="/strategies" variant="ghost">
                Browse strategies
              </Btn>
            )}
          </Card>
        )}
      </section>

      {popular.length ? (
        <section className="mt-14">
          <SectionHead title="Popular strategies" href="/strategies" link="See all" />
          <div className="grid gap-3 md:grid-cols-3">
            {popular.slice(0, 3).map((e) => (
              <Link
                key={e.id}
                href={`/strategy?id=${encodeURIComponent(e.id)}`}
                className="rounded-[12px] border border-line bg-card p-4 transition-colors hover:border-line-2"
              >
                <AssetStack items={strategyIcons(e.strategy)} size={26} max={3} />
                <div className="mt-3 text-[14.5px] font-medium text-ink">{e.strategy.name}</div>
                <div className="mt-1 line-clamp-2 text-[13.5px] leading-relaxed text-muted">{cardLine(e.strategy)}</div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-[13.5px]">
        {alerts.data?.configured ? (
          <span className="inline-flex items-center gap-2 text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-long" />
            Alerts go to {alerts.data.sinks.join(" and ")}
          </span>
        ) : (
          <span className="text-muted">Trades run from your own account on Hyperliquid or Solana.</span>
        )}
        <Link href="/wallets" className="text-muted hover:text-ink">
          Set up trading →
        </Link>
      </section>
    </div>
  );
}
