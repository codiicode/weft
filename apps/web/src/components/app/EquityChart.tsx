"use client";
import { useId, useMemo, useState } from "react";
import { fmtUsd } from "@/lib/use-api";

/** Equity curve with a hover crosshair. Colors by sign of the period return. */
export function EquityChart({
  points,
  base,
  height = 180,
  formatTime = (ts) => new Date(ts).toLocaleTimeString(),
  emptyLabel = "The chart appears after a few checks",
}: {
  points: [number, number][];
  base?: number;
  height?: number;
  /** Hover label for a sample's timestamp (default: local time of day). */
  formatTime?: (ts: number) => string;
  emptyLabel?: string;
}) {
  const id = useId().replace(/[^a-z0-9]/gi, "");
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = height;
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const ref = base ?? ys[0]!;
    const minY = Math.min(...ys, ref), maxY = Math.max(...ys, ref);
    const pad = (maxY - minY) * 0.12 || Math.max(1, Math.abs(maxY) * 0.002);
    const sx = (x: number) => ((x - minX) / (maxX - minX || 1)) * W;
    const sy = (y: number) => H - 8 - ((y - (minY - pad)) / (maxY - minY + 2 * pad)) * (H - 16);
    const pts = points.map(([x, y]) => [sx(x), sy(y)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return { pts, line, area: `${line} L${W},${H} L0,${H} Z`, refY: sy(ref), up: ys.at(-1)! >= ref };
  }, [points, base, H]);

  const flat = points.length > 1 && points.every((p) => p[1] === points[0]![1]);
  if (!geo || flat) {
    return (
      <div className="grid place-items-center rounded-[10px] border border-line text-[12.5px] text-faint" style={{ height }}>
        {flat ? "No change yet. The chart starts moving after the first trade." : emptyLabel}
      </div>
    );
  }
  const color = geo.up ? "var(--long)" : "var(--short)";
  const h = hover != null ? points[hover] : null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          geo.pts.forEach(([px], i) => (Math.abs(px - x) < Math.abs(geo.pts[best]![0] - x) ? (best = i) : null));
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`eq${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" style={{ stopColor: color, stopOpacity: 0.22 }} />
            <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={geo.refY} y2={geo.refY} strokeDasharray="4 6" style={{ stroke: "var(--line-2)" }} vectorEffect="non-scaling-stroke" />
        <path d={geo.area} fill={`url(#eq${id})`} />
        <path d={geo.line} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ stroke: color }} />
        {hover != null && (
          <line x1={geo.pts[hover]![0]} x2={geo.pts[hover]![0]} y1="0" y2={H} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--line-2)" }} />
        )}
      </svg>
      {h && (
        <div className="pointer-events-none absolute right-2 top-2 rounded-[8px] border border-line bg-card/95 px-2.5 py-1.5 text-[12.5px]">
          <div className="text-ink">{fmtUsd(h[1], 2)}</div>
          <div className="text-faint">{formatTime(h[0])}</div>
        </div>
      )}
    </div>
  );
}
