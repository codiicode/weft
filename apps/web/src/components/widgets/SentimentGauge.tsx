"use client";
import { useRef, useState } from "react";
import { clamp, mulberry32 } from "@/lib/rng";
import { useInterval } from "@/lib/hooks";
import { IconSpark } from "@/components/graph/icons";
import { CountUp } from "@/components/ui/CountUp";
import { Delta, MicroLabel, WidgetCard, type WidgetProps } from "./WidgetCard";

/* Mock sentiment composite for SOL. */
const SENTIMENT = {
  asset: "SOL",
  start: 71,
  yesterday: 64,
  min: 58,
  max: 84,
  inputs: [
    { k: "Social", v: 0.46 },
    { k: "Funding", v: 0.62 },
    { k: "News", v: 0.31 },
    { k: "Odds flow", v: -0.12 },
  ],
};

const ZONES = [
  { to: 25, label: "Extreme fear", color: "var(--short)" },
  { to: 45, label: "Fear", color: "color-mix(in oklab, var(--short) 55%, var(--paper-2))" },
  { to: 55, label: "Neutral", color: "var(--line-2)" },
  { to: 75, label: "Greed", color: "color-mix(in oklab, var(--long) 55%, var(--paper-2))" },
  { to: 100, label: "Extreme greed", color: "var(--long)" },
];

const CX = 110;
const CY = 108;
const R = 88;

const polar = (deg: number, r = R) => {
  const a = ((180 + deg) * Math.PI) / 180; // 0 → left, 180 → right
  return { x: +(CX + Math.cos(a) * r).toFixed(2), y: +(CY + Math.sin(a) * r).toFixed(2) };
};
function arc(from: number, to: number, r = R) {
  const a = polar(from, r);
  const b = polar(to, r);
  const large = to - from > 180 ? 1 : 0;
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)} A${r},${r} 0 ${large} 1 ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
}
const zoneOf = (v: number) => ZONES.find((z) => v <= z.to) ?? ZONES[ZONES.length - 1];

function Body({ live }: { live: boolean }) {
  const [value, setValue] = useState(SENTIMENT.start);
  const rand = useRef(mulberry32(71));
  useInterval(
    () =>
      setValue((v) => {
        const r = rand.current;
        const target = SENTIMENT.start + (r() - 0.5) * 14;
        return Math.round(clamp(v + (target - v) * 0.6 + (r() - 0.5) * 4, SENTIMENT.min, SENTIMENT.max));
      }),
    2400,
    live
  );
  const zone = zoneOf(value);
  const angle = -90 + value * 1.8;
  const d = value - SENTIMENT.yesterday;

  let start = 0;
  return (
    <>
      <div className="relative mx-auto w-full max-w-[280px]">
        <svg viewBox="0 0 220 122" className="block w-full overflow-visible" aria-hidden>
          {ZONES.map((z) => {
            const from = start * 1.8 + 1.2;
            const to = z.to * 1.8 - 1.2;
            start = z.to;
            return <path key={z.label} d={arc(from, to)} fill="none" stroke={z.color} strokeWidth={12} />;
          })}
          {/* active progress halo */}
          <path
            d={arc(0, Math.max(1, value * 1.8), R - 14)}
            fill="none"
            stroke="var(--line-2)"
            strokeWidth={1.5}
            strokeDasharray="1.5 3.5"
          />
          {Array.from({ length: 11 }, (_, i) => {
            const a = polar(i * 18, R - 20);
            const b = polar(i * 18, R - (i % 5 === 0 ? 27 : 24));
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--faint)" strokeWidth={1} />;
          })}
          <g transform={`translate(${CX} ${CY})`}>
            <g
              style={{
                transform: `rotate(${angle}deg)`,
                transition: "transform 1.4s cubic-bezier(.34,1.45,.55,1)",
              }}
            >
              <path d="M-2.6,0 L0,-80 L2.6,0 Z" fill="var(--ink)" />
            </g>
            <circle r={7} fill="var(--card)" stroke="var(--ink)" strokeWidth={2} />
            <circle r={2} fill="var(--ink)" />
          </g>
        </svg>
        <div className="mt-1 flex justify-between px-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
          <span>Fear</span>
          <span>Greed</span>
        </div>
      </div>

      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <MicroLabel>{SENTIMENT.asset} sentiment</MicroLabel>
          <div className="mt-1 flex items-baseline gap-2">
            <CountUp value={value} duration={1.2} className="tnum font-mono text-[34px] font-medium leading-none tracking-[-0.04em] text-ink" />
            <span className="text-[15px] font-medium tracking-[-0.01em] text-ink-2">{zone.label}</span>
          </div>
        </div>
        <Delta value={d} className="pb-1 text-[11px]">
          {d >= 0 ? "+" : "−"}
          {Math.abs(d)} vs 24h
        </Delta>
      </div>

      <ul className="mt-4 space-y-2 border-t border-line pt-3">
        {SENTIMENT.inputs.map((inp) => (
          <li key={inp.k} className="grid grid-cols-[72px_minmax(0,1fr)_44px] items-center gap-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">{inp.k}</span>
            <span className="relative h-[4px] rounded-full bg-[var(--paper-2)]">
              <span className="absolute left-1/2 top-[-2px] h-[8px] w-px bg-line-2" />
              <span
                className="absolute top-0 h-full rounded-full"
                style={{
                  left: inp.v >= 0 ? "50%" : `${50 + inp.v * 50}%`,
                  width: `${Math.abs(inp.v) * 50}%`,
                  background: inp.v >= 0 ? "var(--long)" : "var(--short)",
                }}
              />
            </span>
            <Delta value={inp.v} className="text-right text-[10.5px]">
              {inp.v >= 0 ? "+" : "−"}
              {Math.abs(inp.v).toFixed(2)}
            </Delta>
          </li>
        ))}
      </ul>
    </>
  );
}

export function SentimentGaugeWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconSpark} label="Sentiment" meta="Composite" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
