"use client";
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { mulberry32 } from "@/lib/rng";
import { useInterval, useReducedMotion } from "@/lib/hooks";
import { IconForecast } from "@/components/graph/icons";
import { Delta, EASE, MicroLabel, WidgetCard, smoothPath, type WidgetProps } from "./WidgetCard";

/* Mock ENSO (Niño 3.4 anomaly, °C) observations + model ensemble. */
const ENSO = {
  source: "NOAA CPC · 00Z",
  months: ["Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  observed: [-0.2, 0.0, 0.25, 0.55, 0.85, 1.15, 1.45, 1.7],
  /** ensemble mean from "now" (index 7) onward */
  mean: [1.7, 1.85, 1.95, 1.9, 1.7, 1.4, 1.05, 0.75, 0.5],
  members: 24,
  pElNino: 84,
  peak: 1.9,
  wow: 0.4,
};
const Y_MIN = -0.6;
const Y_MAX = 3.0;
const W = 600;
const H = 220;
const NOW = ENSO.observed.length - 1;

const xAt = (i: number) => (i / (ENSO.months.length - 1)) * W;
const yAt = (v: number) => ((Y_MAX - v) / (Y_MAX - Y_MIN)) * H;
const yPct = (v: number) => ((Y_MAX - v) / (Y_MAX - Y_MIN)) * 100;

function members(phase: number) {
  const out: { x: number; y: number }[][] = [];
  for (let k = 0; k < ENSO.members; k++) {
    const r = mulberry32(900 + k);
    const z = (r() - 0.5) * 2.4; // member bias
    const freq = 0.6 + r() * 0.8;
    const ph = r() * Math.PI * 2;
    out.push(
      ENSO.mean.map((m, t) => {
        const lead = t / (ENSO.mean.length - 1);
        const spread = 0.08 + lead * 0.75;
        const wig = Math.sin(t * freq + ph + phase) * 0.12 * lead;
        return { x: xAt(NOW + t), y: yAt(m + z * spread * 0.55 + wig) };
      })
    );
  }
  return out;
}

function Body({ live }: { live: boolean }) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(0);
  useInterval(() => setPhase((p) => p + 0.55), 2600, live);

  const ens = useMemo(() => members(phase), [phase]);
  const obs = smoothPath(ENSO.observed.map((v, i) => ({ x: xAt(i), y: yAt(v) })));
  const meanPts = ENSO.mean.map((v, t) => ({ x: xAt(NOW + t), y: yAt(v) }));
  const mean = smoothPath(meanPts);

  // p10–p90 band from the current ensemble
  const band = useMemo(() => {
    const upper: { x: number; y: number }[] = [];
    const lower: { x: number; y: number }[] = [];
    for (let t = 0; t < ENSO.mean.length; t++) {
      const ys = ens.map((m) => m[t].y).sort((a, b) => a - b);
      upper.push({ x: ys.length ? ens[0][t].x : 0, y: ys[Math.floor(ys.length * 0.1)] });
      lower.push({ x: ys.length ? ens[0][t].x : 0, y: ys[Math.ceil(ys.length * 0.9) - 1] });
    }
    const up = smoothPath(upper);
    const lowRev = smoothPath(lower.slice().reverse()).replace(/^M/, "L");
    return `${up} ${lowRev} Z`;
  }, [ens]);

  const thresholds = [
    { v: 0.5, label: "El Niño +0.5" },
    { v: 1.5, label: "Strong +1.5" },
  ];
  const draw = reduce ? false : { pathLength: 0 };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h3 className="text-[19px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[21px]">
            ENSO outlook <span className="font-normal text-muted">· Niño 3.4</span>
          </h3>
          <p className="mt-1 text-[12.5px] text-muted">Ensemble forecast feeding the El Niño Harvest strategy.</p>
        </div>
        <dl className="flex gap-5">
          <div>
            <dt>
              <MicroLabel>Now</MicroLabel>
            </dt>
            <dd className="tnum mt-0.5 font-mono text-[15px] text-ink">
              +{ENSO.observed[NOW].toFixed(1)}°C{" "}
              <Delta value={ENSO.wow} className="text-[10.5px]">
                +{ENSO.wow.toFixed(1)} w/w
              </Delta>
            </dd>
          </div>
          <div>
            <dt>
              <MicroLabel>Peak</MicroLabel>
            </dt>
            <dd className="tnum mt-0.5 font-mono text-[15px] text-ink">+{ENSO.peak.toFixed(1)}°C</dd>
          </div>
          <div>
            <dt>
              <MicroLabel>P(El Niño)</MicroLabel>
            </dt>
            <dd className="tnum mt-0.5 font-mono text-[15px] text-ink">{ENSO.pElNino}%</dd>
          </div>
        </dl>
      </div>

      <div className="relative mt-5 h-[200px] pl-8 sm:h-[240px]">
        {/* y labels */}
        {[0, 1, 2, 3].map((v) => (
          <span
            key={v}
            className="tnum absolute left-0 -translate-y-1/2 font-mono text-[9.5px] text-faint"
            style={{ top: `${yPct(v)}%` }}
          >
            {v > 0 ? `+${v}` : v}°
          </span>
        ))}
        <div className="relative h-full">
          {/* forecast region tint */}
          <div
            className="absolute inset-y-0 right-0 rounded-[8px] bg-card-2"
            style={{ left: `${(NOW / (ENSO.months.length - 1)) * 100}%` }}
          />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            {[0, 1, 2, 3].map((v) => (
              <line key={v} x1={0} x2={W} y1={yAt(v)} y2={yAt(v)} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
            ))}
            {thresholds.map((t) => (
              <line
                key={t.v}
                x1={0}
                x2={W}
                y1={yAt(t.v)}
                y2={yAt(t.v)}
                stroke="var(--trigger)"
                strokeDasharray="5 5"
                strokeWidth={1}
                opacity={0.75}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <motion.path
              d={band}
              animate={{ d: band }}
              transition={{ duration: 1.8, ease: EASE }}
              fill="var(--signal-soft)"
              initial={reduce ? false : { opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
            />
            {ens.map((m, k) => {
              const d = smoothPath(m);
              return (
                <motion.path
                  key={k}
                  d={d}
                  fill="none"
                  stroke="var(--signal)"
                  strokeWidth={1}
                  strokeOpacity={0.28}
                  vectorEffect="non-scaling-stroke"
                  initial={draw}
                  whileInView={{ pathLength: 1 }}
                  viewport={{ once: true }}
                  animate={{ d }}
                  transition={{
                    pathLength: { duration: 1.4, delay: 0.5 + k * 0.025, ease: EASE },
                    d: { duration: 1.8, ease: EASE },
                  }}
                />
              );
            })}
            <motion.path
              d={mean}
              fill="none"
              stroke="var(--signal)"
              strokeWidth={2.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              initial={draw}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1.4, delay: 0.9, ease: EASE }}
            />
            <motion.path
              d={obs}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={2.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              initial={draw}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1.1, ease: EASE }}
            />
            <line
              x1={xAt(NOW)}
              x2={xAt(NOW)}
              y1={0}
              y2={H}
              stroke="var(--ink-2)"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* threshold labels */}
          {thresholds.map((t) => (
            <span
              key={t.v}
              className="absolute left-1.5 -translate-y-[125%] rounded-[3px] bg-card/85 px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-muted"
              style={{ top: `${yPct(t.v)}%` }}
            >
              {t.label}
            </span>
          ))}
          {/* now marker */}
          <span
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${(NOW / (ENSO.months.length - 1)) * 100}%`, top: `${yPct(ENSO.observed[NOW])}%` }}
          >
            <span className="relative flex h-[9px] w-[9px]">
              {live && <span className="pulse-ring absolute inset-0 rounded-full bg-ink" />}
              <span className="relative h-[9px] w-[9px] rounded-full border-2 border-card bg-ink" />
            </span>
          </span>
          <span
            className="absolute top-1 ml-1.5 rounded-[4px] bg-ink px-1 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-paper"
            style={{ left: `${(NOW / (ENSO.months.length - 1)) * 100}%` }}
          >
            Now
          </span>
          <span className="absolute right-2 top-1 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">Forecast</span>
        </div>
      </div>

      {/* x labels */}
      <div className="pl-8">
        <div className="relative mt-2 h-3 font-mono text-[9px] uppercase tracking-[0.08em] text-faint">
          {ENSO.months.map((m, i) => (
            <span
              key={i}
              className={`absolute top-0 ${i === 0 ? "" : i === ENSO.months.length - 1 ? "-translate-x-full" : "-translate-x-1/2"} ${
                i % 2 === 0 ? "hidden sm:inline" : ""
              } ${i === NOW ? "text-ink-2" : ""}`}
              style={{ left: `${(i / (ENSO.months.length - 1)) * 100}%` }}
            >
              {m}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 font-mono text-[10px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[2px] w-3.5 rounded-full bg-ink" /> Observed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[2px] w-3.5 rounded-full bg-[var(--signal)]" /> Ensemble mean
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[8px] w-3.5 rounded-[2px] bg-[var(--signal-soft)]" /> p10–p90 · {ENSO.members} members
        </span>
      </div>
    </>
  );
}

export function ForecastPlumeWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconForecast} label="Model forecast" meta={ENSO.source} className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
