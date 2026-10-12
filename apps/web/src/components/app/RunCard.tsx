"use client";
import Link from "next/link";
import type { Snapshot } from "@/lib/api";
import { fmtUsd, fmtPct, ago } from "@/lib/use-api";
import { Card, Pill } from "./AppShell";
import { Sparkline } from "@/components/ui/Sparkline";

export function RunCard({ s }: { s: Snapshot }) {
  const d = s.deployment;
  const curve = s.equityCurve.map((p) => p[1]);
  const up = s.returnPct >= 0;
  return (
    <Link href={`/app/run?id=${encodeURIComponent(d.id)}`} className="group block">
      <Card className="h-full p-5 transition-shadow duration-300 group-hover:shadow-lift">
        <div className="flex items-center gap-2">
          <Pill tone={d.status === "running" ? "long" : d.status === "killed" ? "short" : "neutral"}>
            {d.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-long" />}
            {d.status}
          </Pill>
          <span className="ml-auto font-mono text-[10.5px] text-faint">checked {ago(s.lastTickAt)}</span>
        </div>
        <div className="mt-3 truncate text-[17px] font-semibold tracking-[-0.02em]">{d.strategy.name}</div>
        <div className="mt-0.5 line-clamp-1 text-[13px] text-ink-2">“{d.strategy.thesis}”</div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <div className={`tnum font-mono text-[22px] ${up ? "text-long" : "text-short"}`}>{fmtPct(s.returnPct)}</div>
            <div className="tnum font-mono text-[11.5px] text-faint">{fmtUsd(s.equityUsd, 2)} · {s.positions.length} open</div>
          </div>
          {curve.length > 1 && <Sparkline data={curve} width={120} height={36} color={up ? "var(--long)" : "var(--short)"} />}
        </div>
      </Card>
    </Link>
  );
}
