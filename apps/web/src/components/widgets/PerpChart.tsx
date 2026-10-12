"use client";
import { useRef, useState } from "react";
import { tape } from "@/data/mock";
import { fmtNum, mulberry32 } from "@/lib/rng";
import { useInterval } from "@/lib/hooks";
import { IconPrice } from "@/components/graph/icons";
import { Delta, Flash, MicroLabel, WidgetCard, type WidgetProps } from "./WidgetCard";

/* Extra mock detail for the BTC perp widget. */
const BTC_PERP = {
  sym: "BTC-PERP",
  px: tape[0]?.px ?? 118420.5,
  ch: tape[0]?.ch ?? 1.84,
  lev: "40x",
  funding: 0.01,
  oi: "$2.41B",
  vol24h: "$6.82B",
  nextFundingSec: 42 * 60 + 13,
  frames: ["1m", "5m", "15m", "1h"],
  activeFrame: "15m",
};
const CANDLES = 34;
const TICKS_PER_CANDLE = 5;

type Candle = { o: number; h: number; l: number; c: number; v: number };

function seedCandles(end: number): Candle[] {
  const r = mulberry32(31);
  let p = 1;
  const raw: Candle[] = [];
  for (let i = 0; i < CANDLES; i++) {
    const o = p;
    const c = o * (1 + (r() - 0.45) * 0.0075);
    const h = Math.max(o, c) * (1 + r() * 0.0026);
    const l = Math.min(o, c) * (1 - r() * 0.0026);
    raw.push({ o, h, l, c, v: 0.25 + r() * 0.75 });
    p = c;
  }
  const k = end / p;
  return raw.map((c) => ({ o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k, v: c.v }));
}

const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `00:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
};

function Body({ live }: { live: boolean }) {
  const [state, setState] = useState(() => ({ candles: seedCandles(BTC_PERP.px), tick: 0, clock: BTC_PERP.nextFundingSec }));
  const rand = useRef(mulberry32(808));

  useInterval(
    () =>
      setState((s) => {
        const r = rand.current;
        const candles = s.candles.slice();
        const last = { ...candles[candles.length - 1] };
        const nextPx = last.c * (1 + (r() - 0.485) * 0.0016);
        last.c = nextPx;
        last.h = Math.max(last.h, nextPx);
        last.l = Math.min(last.l, nextPx);
        last.v = Math.min(1.1, last.v + r() * 0.08);
        candles[candles.length - 1] = last;
        const tick = s.tick + 1;
        if (tick % TICKS_PER_CANDLE === 0) {
          candles.shift();
          candles.push({ o: nextPx, h: nextPx, l: nextPx, c: nextPx, v: 0.12 });
        }
        return { candles, tick, clock: s.clock > 0 ? s.clock - 1 : 8 * 3600 - 1 };
      }),
    1000,
    live
  );

  const { candles, clock } = state;
  const px = candles[candles.length - 1].c;
  const chg = BTC_PERP.ch + (px / BTC_PERP.px - 1) * 100;

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const PLOT = 84; // % of height for price; rest for volume
  const y = (v: number) => (1 - (v - lo) / (hi - lo)) * PLOT;
  const W = CANDLES * 10;
  const lastY = y(px);
  const levels = [0.2, 0.5, 0.8].map((f) => hi - (hi - lo) * f);
  const up = px >= candles[candles.length - 1].o;

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{BTC_PERP.sym}</span>
            <span className="rounded-[5px] border border-line px-1.5 font-mono text-[9.5px] leading-[16px] text-muted">
              {BTC_PERP.lev}
            </span>
          </div>
          <div className="mt-1.5 font-mono text-[26px] font-medium leading-none tracking-[-0.03em] text-ink sm:text-[30px]">
            <Flash value={Math.round(px * 10)}>
              <span className="tnum">
                <span className="text-muted">$</span>
                {fmtNum(px, 1)}
              </span>
            </Flash>
          </div>
          <Delta value={chg} className="mt-1.5 block text-[11px]">
            {chg >= 0 ? "+" : "−"}
            {Math.abs(chg).toFixed(2)}% <span className="text-faint">24h</span>
          </Delta>
        </div>
        <div className="flex shrink-0 rounded-[8px] border border-line bg-card-2 p-0.5 font-mono text-[10px]">
          {BTC_PERP.frames.map((f) => (
            <span
              key={f}
              className={`rounded-[6px] px-1.5 py-0.5 ${f === BTC_PERP.activeFrame ? "bg-card text-ink shadow-card" : "text-faint"}`}
            >
              {f}
            </span>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative mt-4 h-[170px] min-h-[150px] flex-1 pr-[60px]">
        <div className="relative h-full w-full">
          <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
            {levels.map((v, i) => (
              <line key={i} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
            ))}
            {candles.map((c, i) => {
              const green = c.c >= c.o;
              const col = green ? "var(--long)" : "var(--short)";
              const top = y(Math.max(c.o, c.c));
              const bh = Math.max(0.6, Math.abs(y(c.o) - y(c.c)));
              const cx = i * 10 + 5;
              return (
                <g key={i}>
                  <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <rect x={cx - 3} y={top} width={6} height={bh} rx={0.8} fill={col} />
                  <rect
                    x={cx - 3}
                    y={100 - c.v * 11}
                    width={6}
                    height={c.v * 11}
                    fill={col}
                    opacity={0.22}
                  />
                </g>
              );
            })}
            <line
              x1={0}
              x2={W}
              y1={lastY}
              y2={lastY}
              stroke="var(--ink-2)"
              strokeDasharray="3 3"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.7}
            />
          </svg>
        </div>
        {/* axis */}
        {levels.map((v, i) => (
          Math.abs(y(v) - lastY) < 9 ? null : <span
            key={i}
            className="tnum absolute right-0 w-[56px] -translate-y-1/2 text-right font-mono text-[9.5px] text-faint"
            style={{ top: `${y(v)}%` }}
          >
            {fmtNum(v, 0)}
          </span>
        ))}
        <span
          className="tnum absolute right-0 z-10 w-[58px] -translate-y-1/2 rounded-[5px] py-[2px] text-center font-mono text-[10px] font-medium transition-[top] duration-700"
          style={{
            top: `${lastY}%`,
            background: up ? "var(--long)" : "var(--short)",
            color: "var(--card)",
            transitionTimingFunction: "var(--ease-out)",
          }}
        >
          {fmtNum(px, 0)}
        </span>
      </div>

      {/* Chips */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Chip k="Funding / 8h">
          <Delta value={BTC_PERP.funding}>+{BTC_PERP.funding.toFixed(4)}%</Delta>
        </Chip>
        <Chip k="Open interest">{BTC_PERP.oi}</Chip>
        <Chip k="24h volume">{BTC_PERP.vol24h}</Chip>
        <Chip k="Next funding">{fmtClock(clock)}</Chip>
      </div>
    </>
  );
}

function Chip({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5 rounded-[9px] border border-line bg-card-2 px-2.5 py-1.5 lg:flex-row lg:items-center lg:justify-between lg:gap-2">
      <MicroLabel className="truncate">{k}</MicroLabel>
      <span className="tnum shrink-0 font-mono text-[11.5px] text-ink">{children}</span>
    </div>
  );
}

export function PerpChartWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconPrice} label="Perps" meta="Hyperliquid" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
