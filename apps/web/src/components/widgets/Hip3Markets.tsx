"use client";
import { useState } from "react";
import { perpMarkets } from "@/data/mock";
import { fmtNum } from "@/lib/rng";
import { useLiveSeries } from "@/lib/hooks";
import { IconRates } from "@/components/graph/icons";
import { Sparkline } from "@/components/ui/Sparkline";
import { Delta, Flash, MicroLabel, WidgetCard, type WidgetProps } from "./WidgetCard";

/* Display order + decimals for the HIP-3 board. */
const HIP3_ORDER = ["NVDA", "GOLD", "WHEAT", "TSLA", "WTI"];
const HIP3_DIGITS: Record<string, number> = { NVDA: 2, GOLD: 1, WHEAT: 3, TSLA: 2, WTI: 2 };

type Market = (typeof perpMarkets)[number];

function Row({ m, i, live }: { m: Market; i: number; live: boolean }) {
  const series = useLiveSeries(m.seed, {
    length: 32,
    start: m.px,
    vol: 0.0016,
    drift: m.ch > 0 ? 0.00012 : -0.00012,
    ms: 1100 + i * 230,
    active: live,
  });
  // Re-anchor so the first render shows exactly the mock price.
  const [anchor] = useState(() => series[series.length - 1]);
  const px = m.px * (series[series.length - 1] / anchor);
  const chg = m.ch + (px / m.px - 1) * 100;
  const digits = HIP3_DIGITS[m.sym] ?? 2;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-2.5 sm:gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">{m.sym}</span>
          <span className="truncate font-mono text-[9px] uppercase tracking-[0.1em] text-faint">-PERP</span>
        </div>
        <div className="truncate text-[11.5px] text-muted">
          {m.name} · {m.kind}
        </div>
      </div>
      <Sparkline
        data={series}
        width={58}
        height={22}
        color={chg >= 0 ? "var(--long)" : "var(--short)"}
        strokeWidth={1.3}
        className="opacity-90"
      />
      <div className="w-[88px] text-right">
        <div className="font-mono text-[13px] text-ink">
          <Flash value={Math.round(px * 10 ** digits)}>
            <span className="tnum">{fmtNum(px, digits)}</span>
          </Flash>
        </div>
        <Delta value={chg} className="text-[10.5px]">
          {chg >= 0 ? "+" : "−"}
          {Math.abs(chg).toFixed(2)}%
        </Delta>
      </div>
    </li>
  );
}

function Body({ live }: { live: boolean }) {
  const markets = HIP3_ORDER.map((s) => perpMarkets.find((m) => m.sym === s)).filter(Boolean) as Market[];
  return (
    <>
      <div className="flex items-center justify-between">
        <MicroLabel>Market</MicroLabel>
        <MicroLabel>Last · 24h</MicroLabel>
      </div>
      <ul className="mt-1 divide-y divide-line">
        {markets.map((m, i) => (
          <Row key={m.sym} m={m} i={i} live={live} />
        ))}
      </ul>
      <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 font-mono text-[10px] text-muted">
        <span className="h-[5px] w-[5px] rounded-full bg-[var(--signal)]" />
        Equities &amp; commodities, trading 24/7 onchain
      </div>
    </>
  );
}

export function Hip3MarketsWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconRates} label="Stocks & commodities" meta="HIP-3" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
