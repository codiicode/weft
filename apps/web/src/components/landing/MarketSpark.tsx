"use client";
import { useEffect, useState } from "react";
import type { Instrument } from "@weft/strategy";
import { api } from "@/lib/api";
import { Sparkline } from "../ui/Sparkline";

/** A market's real price over the last 30 days, fetched when the card comes into view. */
export function MarketSpark({ instrument, label }: { instrument: Instrument; label: string }) {
  const [closes, setCloses] = useState<number[] | null>(null);
  const json = JSON.stringify(instrument);
  useEffect(() => {
    let alive = true;
    api
      .chart(JSON.parse(json), "1M")
      .then((d) => alive && setCloses(d.candles.map((k) => k[4])))
      .catch(() => alive && setCloses([]));
    return () => {
      alive = false;
    };
  }, [json]);
  const first = closes?.[0];
  const last = closes?.at(-1);
  const chg = first && last ? ((last - first) / first) * 100 : null;
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-muted">{label}, last 30 days</span>
        {chg != null && <span className={`tnum ${chg >= 0 ? "text-long" : "text-short"}`}>{`${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(1)}%`}</span>}
      </div>
      {closes && closes.length > 1 ? (
        <Sparkline data={closes} width={300} height={44} color={chg != null && chg < 0 ? "var(--short)" : "var(--long)"} strokeWidth={1.5} className="mt-1.5 w-full" />
      ) : (
        <div className={`mt-1.5 h-[44px] rounded-[6px] ${closes ? "" : "animate-pulse bg-paper-2"}`} />
      )}
    </div>
  );
}
