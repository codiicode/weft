"use client";
import { useMemo, useState } from "react";

/**
 * Hourly funding over the last week as thin bars around a zero line. Above zero, longs pay
 * shorts. Hover (or tap) a bar to read it; the header shows the latest value otherwise.
 */
export function FundingChart({ points }: { points: [number, number][] }) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 600;
  const H = 120;
  const { max, avg } = useMemo(() => {
    const m = Math.max(1e-7, ...points.map(([, r]) => Math.abs(r)));
    const a = points.length ? points.reduce((s, [, r]) => s + r, 0) / points.length : 0;
    return { max: m, avg: a };
  }, [points]);
  if (!points.length) return null;
  const mid = H / 2;
  const bw = W / points.length;
  const shown = points[hi ?? points.length - 1]!;
  const pct = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r * 100).toFixed(4)}%`;
  const yearly = (r: number) => `${(r * 24 * 365 * 100).toFixed(1)}% a year`;
  const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">Funding, last 7 days</div>
          <p className="mt-0.5 text-[13px] text-muted">Above the line, longs pay shorts every hour. Below it (amber), shorts pay longs.</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum text-[15px] font-medium text-ink">{pct(shown[1])} <span className="font-normal text-muted">/ h</span></div>
          <div className="tnum text-[12px] text-faint">{hi == null ? `Now · ${yearly(shown[1])}` : when(shown[0])}</div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="mt-4 h-[120px] w-full touch-none"
        role="img"
        aria-label={`Hourly funding over the last 7 days, averaging ${pct(avg)} an hour`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHi(Math.max(0, Math.min(points.length - 1, Math.floor(((e.clientX - r.left) / r.width) * points.length))));
        }}
        onPointerLeave={() => setHi(null)}
      >
        <line x1="0" x2={W} y1={mid} y2={mid} style={{ stroke: "var(--line-2)" }} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {points.map(([t, r], i) => {
          const h = Math.max(1, (Math.abs(r) / max) * (mid - 4));
          return (
            <rect
              key={t}
              x={i * bw + bw * 0.2}
              width={Math.max(0.6, bw * 0.6)}
              y={r >= 0 ? mid - h : mid}
              height={h}
              rx={Math.min(1.5, bw * 0.3)}
              style={{ fill: r >= 0 ? "var(--ink-2)" : "var(--trigger)", opacity: hi === i ? 1 : hi == null ? (r >= 0 ? 0.32 : 0.8) : 0.18 }}
            />
          );
        })}
      </svg>
      <div className="mt-1.5 flex justify-between text-[11px] text-faint">
        <span>7 days ago</span>
        <span>Average {pct(avg)} / h</span>
        <span>Now</span>
      </div>
    </div>
  );
}
