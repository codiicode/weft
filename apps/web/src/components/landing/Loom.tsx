"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useInView, useReducedMotion, useWidth } from "@/lib/hooks";

/**
 * The hero visual. A weft is the thread woven across a loom: here every
 * thread is a signal Weft watches, passing over and under the warp (time),
 * until the threads meet in a knot (the rule) and leave as one trade.
 */

type Scene = { threads: [label: string, value: string][]; rule: string; trade: string; detail: string };

const SCENES: Scene[] = [
  {
    threads: [
      ["$PUMP price", "0.00398"],
      ["Mood on X", "+0.41"],
      ["Mentions", "+180%"],
      ["Dev wallet", "0% sold"],
    ],
    rule: "All four conditions met",
    trade: "Buy $PUMP with 0.5 SOL",
    detail: "Stop at −20% · Solana via Jupiter",
  },
  {
    threads: [
      ["NOAA El Niño forecast", "+1.7°C"],
      ["Prediction market", "61%"],
      ["Wheat", "$5.84"],
      ["Ag accounts on X", "bullish"],
    ],
    rule: "Forecast ahead of the market",
    trade: "Long wheat at 2×",
    detail: "Plus YES on “El Niño by winter”",
  },
  {
    threads: [
      ["Fed cut odds", "68%"],
      ["2-year yield", "−14 bp"],
      ["Inflation nowcast", "2.6%"],
      ["Bitcoin", "$118,420"],
    ],
    rule: "Odds firm, yields fall",
    trade: "Long BTC at 2×",
    detail: "Stop at −5% · Hyperliquid",
  },
  {
    threads: [
      ["NVIDIA", "$184.20"],
      ["Earnings", "in 2 days"],
      ["Analyst revisions", "+3 this week"],
      ["Options flow", "calls 2 : 1"],
    ],
    rule: "Two days before earnings",
    trade: "Long NVDA at 2×",
    detail: "Closes an hour before the report",
  },
];

const OPACITY = [1, 0.7, 0.85, 0.55];

export function Loom() {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const inView = useInView(wrap, { rootMargin: "0px" });
  const reduce = useReducedMotion();
  const narrow = width > 0 && width < 700;

  // Geometry in viewBox units; a narrower box on phones keeps the type legible.
  const W = narrow ? 640 : 1200;
  const H = narrow ? 420 : 400;
  const fs = narrow ? 17 : 13;
  const gap = narrow ? 26 : 22;
  const knot = narrow ? { x: 400, y: 200 } : { x: 820, y: 200 };
  const straight = narrow ? 250 : 600;
  const ys = narrow ? [70, 150, 250, 330] : [70, 150, 250, 330];

  const [scene, setScene] = useState(0);
  const [stage, setStage] = useState(reduce ? 3 : 0); // 0 drawing, 1 knot, 2 trade, 3 hold
  const s = SCENES[scene]!;

  useEffect(() => {
    if (reduce) {
      setStage(3);
      return;
    }
    if (!inView) return;
    setStage(0);
    const t = [
      setTimeout(() => setStage(1), 2300),
      setTimeout(() => setStage(2), 2900),
      setTimeout(() => setStage(3), 3500),
      setTimeout(() => setScene((i) => (i + 1) % SCENES.length), 7600),
    ];
    return () => t.forEach(clearTimeout);
  }, [scene, inView, reduce]);

  const warps = useMemo(() => Array.from({ length: Math.floor(W / gap) + 1 }, (_, k) => k * gap + gap / 2), [W, gap]);
  const paths = ys.map((y) => `M0 ${y} L${straight} ${y} C${straight + (knot.x - straight) * 0.55} ${y} ${knot.x - (knot.x - straight) * 0.35} ${knot.y} ${knot.x} ${knot.y}`);
  const out = `M${knot.x} ${knot.y} L${W} ${knot.y}`;

  return (
    <div ref={wrap} className="relative w-full select-none" aria-label={`Example: ${s.threads.map((t) => t[0]).join(", ")} lead to: ${s.trade}`} role="img">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id="loom-fade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.18" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.82" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="loom-mask">
            <rect width={W} height={H} fill="url(#loom-fade)" />
          </mask>
        </defs>
        {/* warp */}
        <g mask="url(#loom-mask)">
          {warps.map((x) => (
            <line key={x} x1={x} x2={x} y1={0} y2={H} style={{ stroke: "var(--line-2)" }} strokeWidth={1} />
          ))}
        </g>

        <AnimatePresence mode="wait">
          <motion.g key={scene} initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.45 } }}>
            {/* weft threads */}
            {paths.map((d, i) => (
              <motion.path
                key={i}
                d={d}
                fill="none"
                strokeWidth={narrow ? 3.2 : 2.6}
                strokeLinecap="round"
                style={{ stroke: "var(--signal)", opacity: OPACITY[i] }}
                initial={{ pathLength: reduce ? 1 : 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.7, delay: i * 0.18, ease: [0.45, 0, 0.2, 1] }}
              />
            ))}
            {/* where the warp passes over the weft */}
            {ys.map((y, i) =>
              warps
                .filter((x, k) => x < straight - 6 && (k + i) % 2 === 0)
                .map((x) => (
                  <g key={`${i}-${x}`}>
                    <rect x={x - 1.6} y={y - 3} width={3.2} height={6} style={{ fill: "var(--paper)" }} />
                    <line x1={x} x2={x} y1={y - 3.5} y2={y + 3.5} style={{ stroke: "var(--line-2)" }} strokeWidth={1.2} />
                  </g>
                )),
            )}
            {/* labels riding on each thread */}
            {s.threads.map(([label, value], i) => (
              <motion.text
                key={label}
                x={narrow ? 6 : 10}
                y={ys[i]! - (narrow ? 12 : 10)}
                fontSize={fs}
                initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.25 + i * 0.18 }}
                style={{ paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 8, strokeLinejoin: "round" }}
              >
                <tspan style={{ fill: "var(--muted)" }}>{label}</tspan>
                <tspan dx={8} style={{ fill: "var(--ink)", fontWeight: 500 }} className="tnum">
                  {value}
                </tspan>
              </motion.text>
            ))}

            {/* the knot: the rule */}
            {stage >= 1 && (
              <>
                <motion.circle
                  cx={knot.x}
                  cy={knot.y}
                  r={narrow ? 11 : 9}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 22 }}
                  style={{ fill: "var(--paper)", stroke: "var(--trigger)", strokeWidth: 2.4, transformOrigin: `${knot.x}px ${knot.y}px` }}
                />
                <motion.circle
                  cx={knot.x}
                  cy={knot.y}
                  r={narrow ? 11 : 9}
                  initial={{ scale: 1, opacity: 0.5 }}
                  animate={{ scale: 2.6, opacity: 0 }}
                  transition={{ duration: 1.1, ease: "easeOut" }}
                  style={{ fill: "none", stroke: "var(--trigger)", strokeWidth: 1.5, transformOrigin: `${knot.x}px ${knot.y}px` }}
                />
                <motion.text
                  x={knot.x + (narrow ? 20 : 18)}
                  y={knot.y - (narrow ? 22 : 16)}
                  textAnchor="start"
                  fontSize={fs}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={{ fill: "var(--trigger)", fontWeight: 500, paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 8 }}
                >
                  {s.rule}
                </motion.text>
              </>
            )}

            {/* the trade leaves as one thread */}
            {stage >= 2 && (
              <motion.path
                d={out}
                fill="none"
                strokeWidth={narrow ? 3 : 2.4}
                strokeLinecap="round"
                style={{ stroke: "var(--long)" }}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.8, ease: [0.45, 0, 0.2, 1] }}
              />
            )}
          </motion.g>
        </AnimatePresence>
      </svg>

      {/* trade card, in HTML for crisp type */}
      <AnimatePresence>
        {stage >= 3 && (
          <motion.div
            key={scene}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className={narrow ? "mt-2 rounded-[12px] border border-line bg-card px-4 py-3 shadow-lift" : "absolute rounded-[12px] border border-line bg-card px-4 py-3 shadow-lift"}
            style={narrow ? undefined : { left: `${((knot.x + 60) / W) * 100}%`, top: `${((knot.y + 26) / H) * 100}%` }}
          >
            <div className="flex items-center gap-1.5 text-[12px] text-long">
              <span className="h-1.5 w-1.5 rounded-full bg-long" /> Order filled · paper
            </div>
            <div className="mt-1 whitespace-nowrap text-[15px] font-medium text-ink sm:text-[16px]">{s.trade}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{s.detail}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {narrow && stage < 3 && <div className="mt-2 h-[86px]" aria-hidden />}
      {/* scene picker */}
      <div className="mt-4 flex items-center gap-2 px-1" role="tablist" aria-label="Examples">
        {SCENES.map((x, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === scene}
            aria-label={x.trade}
            onClick={() => setScene(i)}
            className="group h-6 px-0.5"
          >
            <span className={`block h-[3px] rounded-full transition-all duration-500 ${i === scene ? "w-8 bg-ink" : "w-4 bg-line-2 group-hover:bg-ink/40"}`} />
          </button>
        ))}
      </div>
    </div>
  );
}
