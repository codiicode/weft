"use client";
import { useId, useMemo } from "react";
import { motion } from "motion/react";

interface Props {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  area?: boolean;
  strokeWidth?: number;
  /** animate the line drawing in */
  draw?: boolean;
  /** show an end dot */
  dot?: boolean;
  className?: string;
  pad?: number;
}

export function sparkPath(data: number[], width: number, height: number, pad = 2) {
  if (data.length < 2) return { line: "", area: "", last: { x: 0, y: 0 } };
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = (width - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => ({
    x: pad + i * step,
    y: pad + (1 - (v - min) / span) * (height - pad * 2),
  }));
  // Smooth with a light Catmull-Rom → Bezier conversion
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  const a = `${d} L${last.x.toFixed(2)},${height} L${pts[0].x.toFixed(2)},${height} Z`;
  return { line: d, area: a, last };
}

export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = "var(--ink)",
  area = true,
  strokeWidth = 1.5,
  draw = false,
  dot = false,
  className,
  pad = 2,
}: Props) {
  const id = useId().replace(/:/g, "");
  const { line, area: areaD, last } = useMemo(() => sparkPath(data, width, height, pad), [data, width, height, pad]);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
      overflow="visible"
    >
      <defs>
        <linearGradient id={`sg${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: color, stopOpacity: 0.22 }} />
          <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {area && (
        <motion.path
          d={areaD}
          fill={`url(#sg${id})`}
          initial={draw ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: draw ? 0.5 : 0 }}
        />
      )}
      <motion.path
        d={line}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={draw ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
      />
      {dot && (
        <circle cx={last.x} cy={last.y} r={2.4} style={{ fill: color }} />
      )}
    </svg>
  );
}
