"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { instrumentKey, instrumentLabel, type Instrument } from "@weft/strategy";
import type { Fill } from "@weft/engine";
import type { ChartInterval } from "@/lib/api";
import { instrumentIcon } from "@/lib/assets";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { TradingChart, type TradeMark } from "./TradingChart";

/** A bar size that shows the whole run without zooming out. */
function intervalFor(startedAt: number): ChartInterval {
  const h = (Date.now() - startedAt) / 3_600_000;
  return h < 3 ? "1m" : h < 24 ? "5m" : h < 7 * 24 ? "1h" : "4h";
}

/**
 * The markets a run trades, with its own buys and sells pinned on the price. Logos switch between
 * markets when a strategy trades more than one.
 */
export function TradesChart({ instruments, fills, startedAt }: { instruments: Instrument[]; fills: Fill[]; startedAt: number }) {
  const charted = instruments.filter((i) => i.kind !== "option");
  const [pick, setPick] = useState(0);
  const inst = charted[Math.min(pick, charted.length - 1)];
  const key = inst ? instrumentKey(inst) : null;
  const marks = useMemo<TradeMark[]>(() => fills.filter((f) => f.instrumentKey === key).map((f) => ({ t: f.ts, price: f.price, side: f.side })), [fills, key]);
  const [defaultInterval] = useState(() => intervalFor(startedAt));
  if (!inst) return null;
  const buys = marks.filter((m) => m.side === "buy").length;
  const sells = marks.length - buys;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
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
        <span className="flex items-center gap-4 text-[12.5px] text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="text-long">▲</span> Bought{buys ? ` · ${buys}` : ""}</span>
          <span className="inline-flex items-center gap-1.5"><span className="text-short">▼</span> Sold{sells ? ` · ${sells}` : ""}</span>
          {key && (
            <Link href={`/market?key=${encodeURIComponent(key)}`} className="text-ink-2 hover:text-ink">
              Open market →
            </Link>
          )}
        </span>
      </div>
      <TradingChart key={key} instrument={inst} marks={marks} defaultInterval={defaultInterval} prefsKey="run" className="h-[420px]" />
    </div>
  );
}
