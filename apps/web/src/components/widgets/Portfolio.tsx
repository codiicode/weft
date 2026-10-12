"use client";
import { useId, useState } from "react";
import { motion } from "motion/react";
import { portfolio } from "@/data/mock";
import { fmtNum, fmtUsd } from "@/lib/rng";
import { useLiveSeries, useReducedMotion } from "@/lib/hooks";
import { IconLock } from "@/components/graph/icons";
import { CountUp } from "@/components/ui/CountUp";
import { Delta, EASE, MicroLabel, WidgetCard, smoothPath, toPoints, type WidgetProps } from "./WidgetCard";

/* Donut geometry. */
const DONUT = { size: 132, r: 52, stroke: 13, gapDeg: 3 };

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const p0 = { x: cx + r * Math.cos(rad(a0)), y: cy + r * Math.sin(rad(a0)) };
  const p1 = { x: cx + r * Math.cos(rad(a1)), y: cy + r * Math.sin(rad(a1)) };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} A${r},${r} 0 ${large} 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
}

function Donut({ active, onHover }: { active: number; onHover: (i: number) => void }) {
  const reduce = useReducedMotion();
  const { size, r, stroke, gapDeg } = DONUT;
  const c = size / 2;
  const total = portfolio.allocation.reduce((s, a) => s + a.value, 0);
  let acc = 0;
  const a = portfolio.allocation[active];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--paper-2)" strokeWidth={stroke} />
        {portfolio.allocation.map((seg, i) => {
          const a0 = (acc / total) * 360 + gapDeg / 2;
          acc += seg.value;
          const a1 = (acc / total) * 360 - gapDeg / 2;
          return (
            <motion.path
              key={seg.label}
              d={arcPath(c, c, r, a0, a1)}
              fill="none"
              stroke={seg.color}
              strokeWidth={i === active ? stroke + 3 : stroke}
              strokeLinecap="butt"
              initial={reduce ? false : { pathLength: 0 }}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.9, delay: 0.2 + i * 0.14, ease: EASE }}
              onMouseEnter={() => onHover(i)}
              className="cursor-default transition-[stroke-width] duration-300"
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="tnum font-mono text-[20px] font-medium leading-none tracking-[-0.03em] text-ink">{a.value}%</div>
          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{a.label}</div>
        </div>
      </div>
    </div>
  );
}

function EquityCurve({ data }: { data: number[] }) {
  const gid = useId().replace(/:/g, "");
  const W = 400;
  const H = 64;
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const pad = (max - min) * 0.12;
  const pts = toPoints(data, W, H, min - pad, max + pad);
  const line = smoothPath(pts);
  const last = pts[pts.length - 1];
  return (
    <div className="relative min-h-[64px] w-full flex-1">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <linearGradient id={`eq${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--long)", stopOpacity: 0.22 }} />
            <stop offset="1" style={{ stopColor: "var(--long)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#eq${gid})`} />
        <path d={line} fill="none" stroke="var(--long)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        className="absolute right-0 h-[7px] w-[7px] -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-card"
        style={{ top: `${(last.y / H) * 100}%`, background: "var(--long)" }}
      />
    </div>
  );
}

function Body({ live }: { live: boolean }) {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const [seen, setSeen] = useState(false);
  if (live && !seen) setSeen(true);
  const series = useLiveSeries(4821, { length: 60, start: 100, vol: 0.0035, drift: 0.0009, ms: 1500, active: live });
  const [anchor] = useState(() => series[series.length - 1]);
  const equity = portfolio.equity * (series[series.length - 1] / anchor);
  const pnl = portfolio.pnl24h + (equity - portfolio.equity);
  const pnlPct = (pnl / (equity - pnl)) * 100;
  const total = portfolio.allocation.reduce((s, x) => s + x.value, 0);

  return (
    <>
      <div className="flex items-center gap-5">
        <Donut active={active} onHover={setActive} />
        <div className="min-w-0 flex-1">
          <MicroLabel>Equity</MicroLabel>
          <div className="mt-1 truncate font-mono text-[24px] font-medium leading-none tracking-[-0.035em] text-ink sm:text-[28px]">
            <CountUp
              value={seen || reduce ? equity : 0}
              from={0}
              duration={1.4}
              format={(v) => fmtUsd(v, 2)}
              className="tnum"
            />
          </div>
          <Delta value={pnl} className="mt-2 block text-[11px]">
            {pnl >= 0 ? "+" : "−"}
            {fmtUsd(Math.abs(pnl), 2)} · {pnlPct >= 0 ? "+" : "−"}
            {Math.abs(pnlPct).toFixed(2)}% <span className="text-faint">24h</span>
          </Delta>
          <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {portfolio.allocation.map((seg, i) => (
              <li
                key={seg.label}
                onMouseEnter={() => setActive(i)}
                className={`flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] transition-colors ${
                  i === active ? "text-ink" : "text-muted"
                }`}
              >
                <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: seg.color }} />
                <span className="truncate">{seg.label}</span>
                <span className="tnum ml-auto hidden text-faint lg:inline">{fmtNum((seg.value / total) * equity / 1000, 1)}k</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="relative mt-auto flex flex-1 flex-col pt-5">
        <div className="mb-1.5 flex items-center justify-between">
          <MicroLabel>Equity · 30d</MicroLabel>
          <MicroLabel>Self-custody wallet</MicroLabel>
        </div>
        <EquityCurve data={series} />
      </div>
    </>
  );
}

export function PortfolioWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconLock} label="Portfolio" meta="Non-custodial" tone="ink" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
