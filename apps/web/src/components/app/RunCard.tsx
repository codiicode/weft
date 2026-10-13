"use client";
import Link from "next/link";
import { AssetStack } from "@/components/ui/AssetIcon";
import { strategyIcons } from "@/lib/assets";
import type { Snapshot } from "@/lib/api";
import { fmtUsd, fmtPct, ago } from "@/lib/use-api";
import { Card } from "./AppShell";
import { Sparkline } from "@/components/ui/Sparkline";

export const trendColor = (v: number) => (v > 0 ? "var(--long)" : v < 0 ? "var(--short)" : "var(--faint)");

const STATUS: Record<string, string> = { running: "Running", paused: "Paused", stopped: "Stopped", killed: "Stopped" };

export function RunStatus({ s }: { s: Snapshot }) {
  const d = s.deployment;
  const running = d.status === "running";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-ink-2">
      <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-long" : d.status === "paused" ? "bg-trigger" : "bg-faint"}`} />
      {STATUS[d.status] ?? d.status}
      {d.mode === "live" ? (
        <span className="rounded-[5px] bg-[var(--short-soft)] px-1.5 text-[11.5px] font-medium text-short">Live</span>
      ) : (
        <span className="text-faint">· {d.alertsOnly ? "alerts only" : "paper"}</span>
      )}
    </span>
  );
}

/** One run as a table-like row (overview, runs list). */
export function RunRow({ s }: { s: Snapshot }) {
  const d = s.deployment;
  const curve = s.equityCurve.map((p) => p[1]);
  const up = s.returnPct >= 0;
  return (
    <Link
      href={`/app/run?id=${encodeURIComponent(d.id)}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 px-4 py-3.5 transition-colors hover:bg-paper-2/50 sm:grid-cols-[minmax(0,1fr)_140px_90px_110px_100px] sm:px-5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <AssetStack items={strategyIcons(d.strategy)} size={26} max={2} />
        <div className="min-w-0">
          <div className="truncate text-[14.5px] font-medium text-ink">{d.strategy.name}</div>
          <div className="truncate text-[13px] text-muted">{d.strategy.thesis}</div>
        </div>
      </div>
      <div className="hidden sm:block">
        <RunStatus s={s} />
      </div>
      <div className={`tnum text-right text-[14.5px] font-medium ${s.returnPct === 0 ? "text-ink-2" : up ? "text-long" : "text-short"}`}>{fmtPct(s.returnPct)}</div>
      <div className="tnum hidden text-right text-[13.5px] text-ink-2 sm:block">{fmtUsd(s.equityUsd, 0)}</div>
      <div className="hidden justify-end sm:flex">
        {curve.length > 1 ? <Sparkline data={curve} width={96} height={26} color={trendColor(s.returnPct)} strokeWidth={1.4} /> : <span className="text-[12px] text-faint">—</span>}
      </div>
    </Link>
  );
}

export function RunListHeader() {
  return (
    <div className="hidden grid-cols-[minmax(0,1fr)_140px_90px_110px_100px] gap-x-6 border-b border-line px-5 py-2.5 text-[12.5px] text-muted sm:grid">
      <span>Strategy</span>
      <span>Status</span>
      <span className="text-right">Return</span>
      <span className="text-right">Equity</span>
      <span className="text-right">Since start</span>
    </div>
  );
}

export function RunCard({ s }: { s: Snapshot }) {
  const d = s.deployment;
  const curve = s.equityCurve.map((p) => p[1]);
  const up = s.returnPct >= 0;
  return (
    <Link href={`/app/run?id=${encodeURIComponent(d.id)}`} className="group block">
      <Card className="h-full p-5 transition-colors group-hover:border-line-2">
        <div className="flex items-center justify-between gap-2">
          <RunStatus s={s} />
          <span className="text-[12px] text-faint">checked {ago(s.lastTickAt)}</span>
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <AssetStack items={strategyIcons(d.strategy)} size={24} max={3} />
          <div className="truncate text-[16px] font-semibold tracking-[-0.015em] text-ink">{d.strategy.name}</div>
        </div>
        <div className="mt-0.5 line-clamp-1 text-[13.5px] text-muted">{d.strategy.thesis}</div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <div className={`tnum text-[22px] font-medium tracking-[-0.02em] ${s.returnPct === 0 ? "text-ink" : up ? "text-long" : "text-short"}`}>{fmtPct(s.returnPct)}</div>
            <div className="tnum text-[12.5px] text-faint">
              {fmtUsd(s.equityUsd, 2)} · {s.positions.length} open
            </div>
          </div>
          {curve.length > 1 && <Sparkline data={curve} width={120} height={36} color={trendColor(s.returnPct)} />}
        </div>
      </Card>
    </Link>
  );
}
