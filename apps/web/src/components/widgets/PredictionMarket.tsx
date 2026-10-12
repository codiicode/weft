"use client";
import { useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { predictionMarket } from "@/data/mock";
import { clamp, mulberry32 } from "@/lib/rng";
import { useInterval } from "@/lib/hooks";
import { IconOdds, IconTrigger } from "@/components/graph/icons";
import { Delta, Flash, MicroLabel, WidgetCard, smoothPath, toPoints, type WidgetProps } from "./WidgetCard";

/* Extra mock detail for this widget (kept local; see src/data/mock.ts for the shared bits). */
const PREDICTION_EXTRA = {
  venueLabel: "Hyperliquid · HIP-4",
  change24h: 9.1,
  traders: "8,412",
  liquidity: "$2.9M",
  rule: "Model − Mkt > 10pp",
  action: "Buy YES · 4% alloc",
  threshold: 10,
};
const HIST_LEN = 48;
const DOMAIN: [number, number] = [0.46, 0.84];

function seedHistory(target: number) {
  const r = mulberry32(2024);
  const out: number[] = [];
  let v = target - 0.12;
  for (let i = 0; i < HIST_LEN; i++) {
    const t = i / (HIST_LEN - 1);
    const goal = target - 0.12 * (1 - t) ** 1.4;
    v = v + (goal - v) * 0.35 + (r() - 0.5) * 0.034;
    out.push(v);
  }
  out[HIST_LEN - 1] = target;
  return out;
}

function Body({ live }: { live: boolean }) {
  const { yes: base, model, question, volume, closes } = predictionMarket;
  const [hist, setHist] = useState(() => seedHistory(base));
  const rand = useRef(mulberry32(99));
  const gid = useId().replace(/:/g, "");

  useInterval(
    () =>
      setHist((h) => {
        const last = h[h.length - 1];
        const next = clamp(last + (base - last) * 0.3 + (rand.current() - 0.5) * 0.032, base - 0.045, base + 0.045);
        return [...h.slice(1), next];
      }),
    1300,
    live
  );

  const yes = hist[hist.length - 1];
  const yesPct = yes * 100;
  const modelPct = model * 100;
  const edge = modelPct - yesPct;
  const met = edge > PREDICTION_EXTRA.threshold;
  const chg = PREDICTION_EXTRA.change24h + (yes - base) * 100;

  // history chart
  const W = 400;
  const H = 100;
  const pts = toPoints(hist, W, H, DOMAIN[0], DOMAIN[1]);
  const line = smoothPath(pts);
  const area = `${line} L${W},${H} L0,${H} Z`;
  const modelY = ((DOMAIN[1] - model) / (DOMAIN[1] - DOMAIN[0])) * 100;
  const lastY = (pts[pts.length - 1].y / H) * 100;

  const spring = { type: "spring", stiffness: 120, damping: 18, mass: 0.8 } as const;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <h3 className="max-w-[22ch] text-[22px] font-semibold leading-[1.12] tracking-[-0.03em] text-ink text-balance sm:text-[27px]">
          {question}
        </h3>
        <span className="hidden shrink-0 rounded-full border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted sm:inline-block">
          {PREDICTION_EXTRA.venueLabel}
        </span>
      </div>

      {/* Odds readout */}
      <div className="mt-5 grid grid-cols-3 divide-x divide-line rounded-[12px] border border-line bg-card-2">
        <div className="min-w-0 px-3 py-3 sm:px-4">
          <MicroLabel>Yes</MicroLabel>
          <div className="mt-1 flex items-baseline gap-0.5 font-mono text-[22px] font-medium leading-none tracking-[-0.02em] text-ink sm:text-[28px]">
            <Flash value={Math.round(yesPct * 10)}>
              <span className="tnum">{yesPct.toFixed(1)}</span>
              <span className="text-[0.55em] text-muted">¢</span>
            </Flash>
          </div>
          <Delta value={chg} className="mt-1.5 block text-[10.5px]">
            {chg >= 0 ? "+" : "−"}
            {Math.abs(chg).toFixed(1)}% 24h
          </Delta>
        </div>
        <div className="min-w-0 px-3 py-3 sm:px-4">
          <MicroLabel>No</MicroLabel>
          <div className="mt-1 flex items-baseline gap-0.5 font-mono text-[22px] font-medium leading-none tracking-[-0.02em] text-ink-2 sm:text-[28px]">
            <span className="tnum">{(100 - yesPct).toFixed(1)}</span>
            <span className="text-[0.55em] text-muted">¢</span>
          </div>
          <span className="tnum mt-1.5 block font-mono text-[10.5px] text-faint">implied</span>
        </div>
        <div className="min-w-0 px-3 py-3 sm:px-4">
          <MicroLabel>Edge</MicroLabel>
          <div className="mt-1 font-mono text-[22px] font-medium leading-none tracking-[-0.02em] sm:text-[28px]">
            <Delta value={edge}>
              {edge >= 0 ? "+" : "−"}
              {Math.abs(edge).toFixed(1)}
              <span className="text-[0.55em]">pp</span>
            </Delta>
          </div>
          <span className="tnum mt-1.5 block font-mono text-[10.5px] text-faint">model − mkt</span>
        </div>
      </div>

      {/* Price bar with model marker */}
      <div className="relative mt-5 pb-6 pt-8">
        <motion.div
          className="absolute top-0 z-10 -translate-x-1/2"
          style={{ left: `${modelPct}%` }}
        >
          <span className="block whitespace-nowrap rounded-[6px] bg-volt px-1.5 py-[3px] font-mono text-[10px] font-semibold leading-none text-[#0b0c0f] shadow-[0_4px_12px_-4px_rgba(0,0,0,0.25)]">
            Weft model {modelPct.toFixed(0)}%
          </span>
        </motion.div>
        <div className="relative h-3 overflow-hidden rounded-full bg-[var(--short-soft)]">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ background: "linear-gradient(90deg, color-mix(in oklab, var(--long) 70%, transparent), var(--long))" }}
            initial={false}
            animate={{ width: `${yesPct}%` }}
            transition={spring}
          />
          <motion.div
            className="absolute inset-y-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, color-mix(in oklab, var(--signal) 60%, transparent) 0 1.5px, transparent 1.5px 5px)",
            }}
            initial={false}
            animate={{ left: `${yesPct}%`, width: `${Math.max(0, edge)}%` }}
            transition={spring}
          />
        </div>
        {/* model tick */}
        <div
          className="absolute top-[24px] h-[28px] w-[2px] -translate-x-1/2 rounded-full bg-ink"
          style={{ left: `${modelPct}%` }}
        />
        {/* market tick + label */}
        <motion.div
          className="absolute top-[44px] -translate-x-1/2"
          initial={false}
          animate={{ left: `${yesPct}%` }}
          transition={spring}
        >
          <span className="mx-auto block h-[6px] w-px bg-ink-2" />
          <span className="tnum mt-0.5 block whitespace-nowrap font-mono text-[10px] text-ink-2">
            Mkt {yesPct.toFixed(1)}
          </span>
        </motion.div>
        <div className="mt-1.5 flex justify-between font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
          <span>Yes</span>
          <span>No</span>
        </div>
      </div>

      {/* Odds history */}
      <div className="relative mt-3 h-[92px] sm:h-[104px]">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={`pm${gid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" style={{ stopColor: "var(--ink)", stopOpacity: 0.1 }} />
              <stop offset="1" style={{ stopColor: "var(--ink)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
          ))}
          <line
            x1={0}
            x2={W}
            y1={(modelY / 100) * H}
            y2={(modelY / 100) * H}
            stroke="var(--signal)"
            strokeDasharray="4 4"
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
          />
          <path d={area} fill={`url(#pm${gid})`} />
          <path d={line} fill="none" stroke="var(--ink)" strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span
          className="absolute right-0 -translate-y-[130%] font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-2"
          style={{ top: `${modelY}%` }}
        >
          <span className="mr-1 inline-block h-[6px] w-[6px] rounded-full bg-[var(--signal)] align-middle" />
          Model {modelPct.toFixed(0)}
        </span>
        <span
          className="absolute right-0 h-[7px] w-[7px] -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-card bg-ink"
          style={{ top: `${lastY}%` }}
        />
        <span className="absolute bottom-0 left-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">30d odds</span>
      </div>

      {/* Market meta */}
      <dl className="mt-5 grid grid-cols-2 gap-y-3 border-t border-line pt-4 sm:grid-cols-4">
        {[
          ["Volume", volume],
          ["Closes", closes],
          ["Traders", PREDICTION_EXTRA.traders],
          ["Liquidity", PREDICTION_EXTRA.liquidity],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt>
              <MicroLabel>{k}</MicroLabel>
            </dt>
            <dd className="tnum mt-0.5 font-mono text-[13px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      {/* Agent read-out → trigger */}
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[10px] border border-dashed border-line-2 bg-card-2 px-3 py-2 font-mono text-[10.5px] text-ink-2">
        <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-[var(--trigger-soft)] text-[var(--trigger)]">
          <IconTrigger size={11} />
        </span>
        <span className="text-faint">IF</span>
        <span className="tnum">{PREDICTION_EXTRA.rule}</span>
        <span className="text-faint">→</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-1.5 py-[1px] uppercase tracking-[0.08em] text-ink">
          <span
            className="h-[5px] w-[5px] rounded-full transition-colors duration-500"
            style={{ background: met ? "var(--met)" : "var(--faint)" }}
          />
          {met ? "Met" : "Watching"}
        </span>
        <span className="text-faint">→</span>
        <span className="text-ink">{PREDICTION_EXTRA.action}</span>
      </div>
    </>
  );
}

export function PredictionMarketWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconOdds} label="Prediction market" meta="Odds" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
