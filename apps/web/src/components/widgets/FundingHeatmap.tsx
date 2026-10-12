"use client";
import { useRef, useState } from "react";
import { motion } from "motion/react";
import { fundingAssets, fundingGrid } from "@/data/mock";
import { clamp, mulberry32 } from "@/lib/rng";
import { useInterval } from "@/lib/hooks";
import { IconFunding } from "@/components/graph/icons";
import { Delta, MicroLabel, WidgetCard, type WidgetProps } from "./WidgetCard";

/* Heatmap settings. Funding is in % per 8h. */
const FUNDING_SCALE = 0.12; // value that saturates the colour
const FUNDING_CROWDED = 0.08;
const EPOCH_HOURS = 8;

function cellColor(v: number) {
  const t = clamp(Math.abs(v) / FUNDING_SCALE, 0, 1);
  const pct = Math.round(6 + Math.pow(t, 0.85) * 84);
  const hue = v >= 0 ? "var(--long)" : "var(--short)";
  return `color-mix(in oklab, ${hue} ${pct}%, var(--paper-2))`;
}

const epochLabel = (j: number, n: number) => (j === n - 1 ? "now" : `−${(n - 1 - j) * EPOCH_HOURS}h`);
const fmtF = (v: number, d = 3) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`;

function Body({ live }: { live: boolean }) {
  const [grid, setGrid] = useState(() => fundingGrid.map((r) => r.slice()));
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const rand = useRef(mulberry32(512));
  const cols = grid[0]?.length ?? 12;

  // The current epoch is a live estimate; it drifts until it settles.
  useInterval(
    () =>
      setGrid((g) =>
        g.map((row, i) => {
          const next = row.slice();
          const base = fundingGrid[i][cols - 1];
          next[cols - 1] = +(base + (rand.current() - 0.5) * 0.012).toFixed(4);
          return next;
        })
      ),
    1600,
    live
  );

  // hottest cell
  let hot = { i: 0, j: 0, v: 0 };
  grid.forEach((row, i) =>
    row.forEach((v, j) => {
      if (Math.abs(v) > Math.abs(hot.v)) hot = { i, j, v };
    })
  );
  const hotAsset = fundingAssets[hot.i];
  const hotLabel = Math.abs(hot.v) >= FUNDING_CROWDED ? (hot.v > 0 ? "crowded long" : "crowded short") : "elevated";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-card-2 py-1 pl-2 pr-3 font-mono text-[10.5px] text-ink">
          <span className="relative flex h-[7px] w-[7px]">
            {live && <span className="pulse-ring absolute inset-0 rounded-full" style={{ background: "var(--long)" }} />}
            <span className="relative h-[7px] w-[7px] rounded-full" style={{ background: hot.v >= 0 ? "var(--long)" : "var(--short)" }} />
          </span>
          <span className="font-semibold">{hotAsset}</span>
          <Delta value={hot.v}>{fmtF(hot.v, 2)}/8h</Delta>
          <span className="text-muted">· {hotLabel}</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[9.5px] text-faint">
          <span className="tnum">−{FUNDING_SCALE.toFixed(2)}</span>
          <span
            className="h-[6px] w-[96px] rounded-full"
            style={{
              background: `linear-gradient(90deg, ${cellColor(-FUNDING_SCALE)}, ${cellColor(0)}, ${cellColor(FUNDING_SCALE)})`,
            }}
          />
          <span className="tnum">+{FUNDING_SCALE.toFixed(2)}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[38px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[46px_minmax(0,1fr)]" onMouseLeave={() => setHover(null)}>
        {grid.map((row, i) => (
          <div key={fundingAssets[i]} className="contents">
            <div
              className={`flex h-[26px] items-center font-mono text-[10.5px] transition-colors sm:h-[28px] lg:h-[32px] ${
                hover?.i === i ? "text-ink" : "text-muted"
              }`}
            >
              {fundingAssets[i]}
            </div>
            <div className="grid gap-[3px] py-[1.5px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {row.map((v, j) => {
                const isHot = i === hot.i && j === hot.j;
                const isHover = hover?.i === i && hover?.j === j;
                const align = j < 3 ? "left-0" : j > cols - 4 ? "right-0" : "left-1/2 -translate-x-1/2";
                return (
                  <div
                    key={j}
                    onMouseEnter={() => setHover({ i, j })}
                    className={`relative h-[23px] rounded-[5px] transition-[background-color,box-shadow] duration-700 sm:h-[25px] lg:h-[29px] ${
                      isHover ? "z-20 shadow-[0_0_0_1.5px_var(--ink)]" : ""
                    } ${isHot ? "z-10" : ""}`}
                    style={{ background: cellColor(v) }}
                  >
                    {isHot && (
                      <>
                        <span className="absolute inset-0 rounded-[5px] shadow-[0_0_0_1.5px_var(--ink)]" />
                        {live && (
                          <motion.span
                            className="absolute inset-0 rounded-[5px]"
                            style={{ boxShadow: `0 0 0 2px ${hot.v >= 0 ? "var(--long)" : "var(--short)"}` }}
                            animate={{ scale: [1, 1.7], opacity: [0.8, 0] }}
                            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
                          />
                        )}
                      </>
                    )}
                    {isHover && (
                      <div
                        className={`pointer-events-none absolute bottom-[calc(100%+8px)] ${align} w-max rounded-[9px] border border-line-2 bg-card px-2.5 py-2 shadow-lift`}
                      >
                        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                          <span className="font-semibold text-ink">{fundingAssets[i]}</span>
                          {epochLabel(j, cols)}
                        </div>
                        <div className="mt-1 flex items-baseline gap-2 font-mono text-[12px]">
                          <Delta value={v}>{fmtF(v)}</Delta>
                          <span className="tnum text-[10.5px] text-muted">{(v * 3 * 365).toFixed(1)}% APR</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div />
        <div
          className="mt-1.5 grid gap-[3px] font-mono text-[9px] text-faint"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }, (_, j) => (
            <span key={j} className={`text-center ${j === cols - 1 ? "text-ink-2" : ""}`}>
              {j % 3 === 2 || j === cols - 1 ? epochLabel(j, cols) : ""}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <MicroLabel>{fundingAssets.length} perps × {cols} epochs · Hyperliquid</MicroLabel>
        <span className="font-mono text-[10px] text-muted">Longs pay shorts when green</span>
      </div>
    </>
  );
}

export function FundingHeatmapWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconFunding} label="Funding" meta="% per 8h" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
