"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { instrumentKey, instrumentLabel, type Instrument } from "@weft/strategy";
import type { Fill } from "@weft/engine";
import { api, type ChartData, type ChartRange } from "@/lib/api";
import { useLiveCandle } from "@/lib/live";
import { chartMinMove, priceFormatter } from "@/lib/market-ideas";
import { instrumentIcon } from "@/lib/assets";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { Segmented } from "@/components/ui/Segmented";
import { PriceChart, type Bar, type ChartApi, type TradeMark } from "./PriceChart";

const RANGES: { id: ChartRange; label: string; ms: number }[] = [
  { id: "1H", label: "1H", ms: 3_600_000 },
  { id: "1D", label: "1D", ms: 86_400_000 },
  { id: "1W", label: "1W", ms: 7 * 86_400_000 },
  { id: "1M", label: "1M", ms: 30 * 86_400_000 },
  { id: "1Y", label: "1Y", ms: 365 * 86_400_000 },
];

/** The shortest range that still shows the whole run. */
function rangeFor(startedAt: number): ChartRange {
  const age = Date.now() - startedAt;
  return (RANGES.find((r) => r.ms >= age * 1.05) ?? RANGES.at(-1)!).id;
}

/**
 * The markets a run trades, with its own buys and sells pinned on the price line. One chart at a
 * time; logos switch between markets when a strategy trades more than one.
 */
export function TradesChart({ instruments, fills, startedAt }: { instruments: Instrument[]; fills: Fill[]; startedAt: number }) {
  const charted = instruments.filter((i) => i.kind !== "option");
  const [pick, setPick] = useState(0);
  const inst = charted[Math.min(pick, charted.length - 1)];
  const [range, setRange] = useState<ChartRange>(() => rangeFor(startedAt));
  const [chart, setChart] = useState<ChartData | null>(null);
  const [failed, setFailed] = useState(false);
  const instJson = inst ? JSON.stringify(inst) : null;
  const key = inst ? instrumentKey(inst) : null;
  const fmt = useMemo(() => priceFormatter(inst?.kind === "outcome" ? { product: "predictions" } : null), [inst?.kind]);

  useEffect(() => {
    if (!instJson) return;
    let alive = true;
    setFailed(false);
    api
      .chart(JSON.parse(instJson), range)
      .then((d) => alive && setChart(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [instJson, range]);

  const bars = useMemo<Bar[]>(() => (chart?.candles ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), [chart]);
  const marks = useMemo<TradeMark[]>(() => fills.filter((f) => f.instrumentKey === key).map((f) => ({ t: f.ts, price: f.price, side: f.side })), [fills, key]);
  const apiRef = useRef<ChartApi | null>(null);
  const [live, setLive] = useState<Bar | null>(null);
  useEffect(() => setLive(null), [chart]);
  useLiveCandle(chart?.liveCoin, chart?.interval ?? null, (c) => {
    const bar = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v * c.c };
    apiRef.current?.update(bar);
    setLive(bar);
  });
  const [hover, setHover] = useState<Bar | null>(null);
  if (!inst) return null;

  const last = live ?? bars.at(-1);
  const shown = hover ?? last;
  const first = bars[0];
  const up = (last?.c ?? 0) >= (first?.o ?? 0);
  const buys = marks.filter((m) => m.side === "buy").length;
  const sells = marks.length - buys;
  const hiPrice = bars.length ? Math.max(...bars.map((b) => b.h)) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {charted.length > 1 ? (
            <div className="flex gap-1">
              {charted.map((i, k) => (
                <button
                  key={k}
                  onClick={() => setPick(k)}
                  className={`flex h-8 items-center gap-1.5 rounded-[9px] px-2 text-[13px] transition-colors ${k === pick ? "bg-paper-2 font-medium text-ink" : "text-muted hover:text-ink"}`}
                >
                  <AssetIcon {...instrumentIcon(i)} size={18} />
                  {instrumentLabel(i)}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <AssetIcon {...instrumentIcon(inst)} size={24} />
              <span className="text-[14px] font-medium text-ink">{instrumentLabel(inst)}</span>
            </div>
          )}
          {shown && (
            <span className="tnum truncate text-[13.5px] text-ink-2">
              {inst.kind === "outcome" ? "" : "$"}
              {fmt(shown.c)}
              <span className="ml-2 text-faint">{hover ? new Date(hover.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
            </span>
          )}
        </div>
        <Segmented id="run-range" value={range} options={RANGES} onChange={setRange} />
      </div>
      <div className="relative mt-4 h-[280px]">
        {failed && !bars.length ? (
          <div className="grid h-full place-items-center rounded-[10px] border border-dashed border-line-2 text-[13.5px] text-muted">No price history for this market yet.</div>
        ) : !bars.length ? (
          <div className="h-full animate-pulse rounded-[10px] bg-paper-2/70" />
        ) : (
          <PriceChart
            bars={bars}
            tone={up ? "long" : "short"}
            format={fmt}
            intraday={(chart?.intervalMs ?? 0) < 86_400_000}
            minMove={chartMinMove(inst.kind === "outcome" ? "predictions" : undefined, hiPrice)}
            marks={marks}
            onHover={setHover}
            apiRef={apiRef}
            volume={false}
            className="h-full w-full"
          />
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
        <span className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5"><span className="text-long">▲</span> Bought{buys ? ` · ${buys}` : ""}</span>
          <span className="inline-flex items-center gap-1.5"><span className="text-short">▼</span> Sold{sells ? ` · ${sells}` : ""}</span>
          {marks.length === 0 && <span className="text-faint">No trades in this market yet</span>}
        </span>
        {key && (
          <Link href={`/app/market?key=${encodeURIComponent(key)}`} className="text-ink-2 hover:text-ink">
            Open market →
          </Link>
        )}
      </div>
    </div>
  );
}
