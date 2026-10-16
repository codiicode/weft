"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useInView, useReducedMotion, useWidth } from "@/lib/hooks";

/**
 * The hero visual. A weft is the thread woven across a loom: here every
 * thread is a signal Weft watches, passing over and under the warp (time),
 * until the threads meet in a knot (the rule) and leave as one trade.
 *
 * Drawn in real pixels across the full width of the page. The warp parts
 * around the pointer like cloth; values on the threads tick while you watch.
 */

type Thread = { label: string; value: number; fmt: (v: number) => string; jitter: number; icon?: string };
type Scene = { name: string; threads: Thread[]; rule: string; trade: string; detail: string };

const f5 = (v: number) => v.toFixed(5);
const sign2 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const pctS = (v: number) => `+${Math.round(v)}%`;
const pct = (v: number) => `${Math.round(v)}%`;
const usd = (d: number) => (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

const SCENES: Scene[] = [
  {
    name: "Memecoins",
    threads: [
      { icon: "/coins/PUMP.svg", label: "$PUMP price", value: 0.00398, fmt: f5, jitter: 0.00003 },
      { label: "Mood on X", value: 0.41, fmt: sign2, jitter: 0.02 },
      { label: "Mentions, last hour", value: 180, fmt: pctS, jitter: 6 },
      { label: "Liquidity", value: 2.07, fmt: (v) => `$${v.toFixed(2)}M`, jitter: 0.01 },
    ],
    rule: "Price and mood line up",
    trade: "Buy $PUMP with 0.5 SOL",
    detail: "Stop at −20% · Solana via Jupiter",
  },
  {
    name: "Perps",
    threads: [
      { icon: "/coins/ETH.svg", label: "ETH", value: 2604, fmt: usd(0), jitter: 3 },
      { label: "Funding, per hour", value: 0.004, fmt: (v) => `${v.toFixed(4)}%`, jitter: 0.0002 },
      { label: "Open interest, 24h", value: 3.8, fmt: (v) => `+${v.toFixed(1)}%`, jitter: 0.1 },
      { label: "24h volume", value: 1.38, fmt: (v) => `$${v.toFixed(2)}B`, jitter: 0.01 },
    ],
    rule: "Breakout, funding still cheap",
    trade: "Long ETH at 20×",
    detail: "Stop at −20% on the position · Hyperliquid",
  },
  {
    name: "Macro",
    threads: [
      { label: "Fed cut odds", value: 68, fmt: pct, jitter: 1 },
      { label: "2-year yield", value: 3.41, fmt: (v) => `${v.toFixed(2)}%`, jitter: 0.01 },
      { label: "Inflation nowcast", value: 2.6, fmt: (v) => `${v.toFixed(1)}%`, jitter: 0 },
      { icon: "/coins/BTC.svg", label: "Bitcoin", value: 118420, fmt: usd(0), jitter: 60 },
    ],
    rule: "Odds firm, yields fall",
    trade: "Long BTC at 2×",
    detail: "Stop at −5% · Hyperliquid",
  },
  {
    name: "Earnings",
    threads: [
      { icon: "/coins/NVDA.svg", label: "NVIDIA", value: 184.2, fmt: usd(2), jitter: 0.15 },
      { label: "Earnings in", value: 40, fmt: (v) => `${Math.round(v)} hours`, jitter: 0 },
      { label: "Analyst revisions", value: 3, fmt: (v) => `+${Math.round(v)} this week`, jitter: 0 },
      { label: "Options flow", value: 2, fmt: (v) => `calls ${v.toFixed(1)} : 1`, jitter: 0.05 },
    ],
    rule: "Two days before earnings",
    trade: "Long NVDA at 2×",
    detail: "Closes an hour before the report",
  },
];

const OPACITY = [1, 0.72, 0.86, 0.56];
const EASE = [0.45, 0, 0.2, 1] as const;
const SCENE_MS = 8200;

export function Loom() {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(wrap);
  const inView = useInView(wrap, { rootMargin: "0px" });
  const reduce = useReducedMotion();
  const narrow = width > 0 && width < 760;

  // Real-pixel geometry. The content gutter lines up with the page container.
  const W = Math.max(320, Math.round(width || 1440));
  const H = narrow ? 400 : 470;
  const g = narrow ? 20 : Math.max(32, (W - 1200) / 2 + 32);
  const inner = W - 2 * g;
  const straight = g + inner * (narrow ? 0.28 : 0.5);
  const knot = { x: g + inner * (narrow ? 0.5 : 0.66), y: H / 2 };
  const gap = narrow ? 18 : 22;
  const ys = narrow ? [64, 140, 260, 336] : [78, 172, 298, 392];
  const ambient = narrow ? [24, 102, 200, 298, 376] : [30, 125, 235, 345, 440];

  const [scene, setScene] = useState(0);
  const [stage, setStage] = useState(0); // 0 drawing, 1 knot, 2 trade, 3 card
  const [tick, setTick] = useState(0);
  const gatherUntil = useRef(0);
  const kickRef = useRef<() => void>(() => {});
  const knotRef = useRef({ x: 0, y: 0 });
  knotRef.current = knot;
  const s = SCENES[scene]!;

  useEffect(() => {
    if (reduce) {
      setStage(3);
      return;
    }
    if (!inView) return;
    setStage(0);
    const t = [
      setTimeout(() => setStage(1), 1450),
      setTimeout(() => setStage(2), 1750),
      setTimeout(() => setStage(3), 1950),
      setTimeout(() => setScene((i) => (i + 1) % SCENES.length), SCENE_MS),
    ];
    return () => t.forEach(clearTimeout);
  }, [scene, inView, reduce]);

  // When the rule is met, the cloth gathers toward the knot for a moment.
  useEffect(() => {
    if (stage !== 1 || reduce || narrow) return;
    gatherUntil.current = performance.now() + 420;
    kickRef.current();
  }, [stage, reduce, narrow]);

  // Values tick while you watch.
  useEffect(() => {
    if (reduce || !inView) return;
    const id = setInterval(() => setTick((n) => n + 1), 1100);
    return () => clearInterval(id);
  }, [reduce, inView]);
  const live = (t: Thread, i: number) => {
    if (!t.jitter || tick === 0) return t.fmt(t.value);
    const r = Math.sin((tick + 1) * (i + 2) * 12.9898) * 43758.5453;
    return t.fmt(t.value + (r - Math.floor(r) - 0.5) * 2 * t.jitter);
  };

  const warps = useMemo(() => Array.from({ length: Math.floor(W / gap) + 1 }, (_, k) => k * gap + gap / 2), [W, gap]);
  const paths = ys.map((y) => {
    const c1 = straight + (knot.x - straight) * 0.55;
    const c2 = knot.x - (knot.x - straight) * 0.35;
    return `M0 ${y} L${straight} ${y} C${c1} ${y} ${c2} ${knot.y} ${knot.x} ${knot.y}`;
  });

  // The warp parts around the pointer like cloth.
  useEffect(() => {
    const el = svg.current;
    if (!el || reduce || narrow) return;
    const lines = Array.from(el.querySelectorAll<SVGPathElement>("[data-warp]"));
    let px = -9999;
    let py = -9999;
    const cur = lines.map(() => 0);
    let raf = 0;
    const R = 220;
    const render = () => {
      let moving = false;
      lines.forEach((ln, k) => {
        const x = warps[k]!;
        const dx = x - px;
        const near = Math.abs(dx) < R && py > -R && py < H + R;
        // Pointer pushes threads apart; at the knot moment they gather toward it.
        const gathering = performance.now() < gatherUntil.current;
        const gdx = x - knotRef.current.x;
        const pull = gathering && Math.abs(gdx) < 170 ? -Math.sign(gdx) * (1 - Math.abs(gdx) / 170) * 14 : 0;
        const target = (near ? Math.sign(dx || 1) * (1 - Math.abs(dx) / R) ** 2 * 34 : 0) + pull;
        const v = cur[k]! + (target - cur[k]!) * 0.16;
        if (Math.abs(v - cur[k]!) > 0.04) moving = true;
        cur[k] = v;
        const y = gathering && !near ? knotRef.current.y : Math.min(H - 40, Math.max(40, py));
        ln.setAttribute("d", Math.abs(v) < 0.08 ? `M${x} 0 L${x} ${H}` : `M${x} 0 C${x} ${y - 120} ${x + v} ${y - 70} ${x + v} ${y} S${x} ${y + 120} ${x} ${H}`);
      });
      raf = moving || performance.now() < gatherUntil.current + 600 ? requestAnimationFrame(render) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(render);
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      px = e.clientX - r.left;
      py = e.clientY - r.top;
      kick();
    };
    const onLeave = () => {
      px = py = -9999;
      kick();
    };
    kickRef.current = kick;
    const host = el.closest("section") ?? el;
    host.addEventListener("pointermove", onMove as EventListener);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      host.removeEventListener("pointermove", onMove as EventListener);
      host.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, [warps, H, reduce, narrow]);

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg
        ref={svg}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block overflow-visible"
        role="img"
        aria-label={`Example: ${s.threads.map((t) => t.label).join(", ")} lead to: ${s.trade}`}
      >
        <defs>
          <linearGradient id="loom-fade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.16" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.84" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="loom-fade-x" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.08" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.92" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="loom-mask">
            <rect width={W} height={H} fill="url(#loom-fade)" />
          </mask>
          <mask id="loom-mask-x">
            <rect width={W} height={H} fill="url(#loom-fade-x)" />
          </mask>
        </defs>

        {/* warp */}
        <g mask="url(#loom-mask)">
          {warps.map((x) => (
            <path key={x} data-warp d={`M${x} 0 L${x} ${H}`} fill="none" style={{ stroke: "var(--warp)" }} strokeWidth={1} />
          ))}
        </g>

        {/* ambient weft: faint threads always drifting */}
        <g mask="url(#loom-mask-x)" aria-hidden>
          {ambient.map((y, i) => (
            <line
              key={y}
              x1={0}
              x2={W}
              y1={y}
              y2={y}
              strokeWidth={1.4}
              strokeDasharray={`${gap} ${gap}`}
              className={reduce ? "" : "loom-shuttle"}
              style={{ stroke: "var(--faint)", opacity: 0.2, animationDuration: `${16 + i * 4}s`, animationDirection: i % 2 ? "reverse" : "normal" }}
            />
          ))}
        </g>

        <AnimatePresence mode="wait">
          <motion.g key={scene} initial={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 90, transition: { duration: 0.5, ease: [0.55, 0, 0.75, 0] } }}>
            {paths.map((d, i) => (
              <motion.path
                key={i}
                d={d}
                fill="none"
                strokeWidth={narrow ? 2.4 : 3}
                strokeLinecap="round"
                style={{ stroke: "var(--signal)", opacity: OPACITY[i] }}
                initial={{ pathLength: reduce ? 1 : 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.1, delay: i * 0.09, ease: EASE }}
              />
            ))}
            {/* where the warp passes over the weft */}
            {ys.map((y, i) =>
              warps
                .filter((x, k) => x < straight - 6 && (k + i) % 2 === 0)
                .map((x) => (
                  <g key={`${i}-${x}`}>
                    <rect x={x - 2.6} y={y - 3.6} width={5.2} height={7.2} style={{ fill: "var(--paper)" }} />
                    <line x1={x} x2={x} y1={y - 4.5} y2={y + 4.5} style={{ stroke: "var(--warp)" }} strokeWidth={1.3} />
                  </g>
                )),
            )}
            {/* labels on the threads */}
            {s.threads.map((t, i) =>
              t.icon ? (
                <motion.image
                  key={`${t.label}-icon`}
                  href={t.icon}
                  x={g}
                  y={ys[i]! - 12 - (narrow ? 13 : 14)}
                  width={narrow ? 15 : 17}
                  height={narrow ? 15 : 17}
                  initial={{ opacity: reduce ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.45, delay: 0.1 + i * 0.09 }}
                />
              ) : null,
            )}
            {s.threads.map((t, i) => (
              <motion.text
                key={t.label}
                x={t.icon ? g + (narrow ? 21 : 24) : g}
                y={ys[i]! - 12}
                fontSize={narrow ? 12 : 13.5}
                initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: 0.1 + i * 0.09 }}
                style={{ paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 8, strokeLinejoin: "round" }}
              >
                <tspan style={{ fill: "var(--muted)" }}>{t.label}</tspan>
                <tspan dx={8} style={{ fill: "var(--ink)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
                  {live(t, i)}
                </tspan>
              </motion.text>
            ))}

            {stage >= 1 && (
              <>
                <motion.circle
                  cx={knot.x}
                  cy={knot.y}
                  r={narrow ? 10 : 12}
                  initial={{ scale: 0 }}
                  animate={{ scale: [0, 1.35, 1] }}
                  transition={{ duration: 0.55, times: [0, 0.55, 1], ease: [0.22, 1, 0.36, 1] }}
                  style={{ fill: "var(--paper)", stroke: "var(--trigger)", strokeWidth: 2.4, transformOrigin: `${knot.x}px ${knot.y}px` }}
                />
                <motion.circle
                  cx={knot.x}
                  cy={knot.y}
                  r={narrow ? 10 : 12}
                  initial={{ scale: 1, opacity: 0.55 }}
                  animate={{ scale: 3, opacity: 0 }}
                  transition={{ duration: 1.2, ease: "easeOut", repeat: reduce ? 0 : 2, repeatDelay: 1.3 }}
                  style={{ fill: "none", stroke: "var(--trigger)", strokeWidth: 1.5, transformOrigin: `${knot.x}px ${knot.y}px` }}
                />
                <motion.text
                  y={knot.y - 16}
                  fontSize={narrow ? 12 : 13.5}
                  initial={{ opacity: 0, x: knot.x + 10 }}
                  animate={{ opacity: 1, x: knot.x + 18 }}
                  style={{ fill: "var(--trigger)", fontWeight: 500, paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 8 }}
                >
                  {s.rule}
                </motion.text>
              </>
            )}
            {stage >= 2 && (
              <motion.path
                d={`M${knot.x} ${knot.y} L${W} ${knot.y}`}
                fill="none"
                strokeWidth={narrow ? 2.6 : 3}
                strokeLinecap="round"
                style={{ stroke: "var(--long)" }}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.7, ease: EASE }}
              />
            )}
          </motion.g>
        </AnimatePresence>
      </svg>

      <AnimatePresence>
        {stage >= 3 && (
          <motion.div
            key={scene}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className={
              narrow
                ? "mx-5 mt-1 rounded-[12px] border border-line bg-card px-4 py-3 shadow-lift"
                : "absolute rounded-[14px] border border-line bg-card px-5 py-4 shadow-lift"
            }
            style={narrow ? undefined : { left: knot.x + 56, top: knot.y + 28 }}
          >
            <div className="flex items-center gap-1.5 text-[12.5px] text-long">
              <span className="relative flex h-1.5 w-1.5">
                <span className="pulse-ring absolute inset-0 rounded-full bg-long" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-long" />
              </span>
              Order filled
            </div>
            <div className="mt-1 whitespace-nowrap text-[16px] font-medium tracking-[-0.01em] text-ink sm:text-[17px]">{s.trade}</div>
            <div className="mt-0.5 text-[13px] text-muted">{s.detail}</div>
          </motion.div>
        )}
      </AnimatePresence>
      {narrow && stage < 3 && <div className="mx-5 mt-1 h-[86px]" aria-hidden />}

      {/* scene picker with a running timer, on the cloth */}
      <div
        className={narrow ? "mt-4 flex items-center gap-2 pb-6" : "absolute bottom-3 flex items-center gap-2"}
        style={narrow ? { paddingLeft: g - 2 } : { left: g - 2 }}
        role="tablist"
        aria-label="Examples"
      >
        {SCENES.map((x, i) => (
          <button key={x.name} role="tab" aria-selected={i === scene} aria-label={x.name} onClick={() => setScene(i)} className="group h-6 px-0.5">
            <span className="block h-[3px] w-7 overflow-hidden rounded-full bg-line-2 transition-colors group-hover:bg-ink/25">
              {i === scene &&
                (reduce ? (
                  <span className="block h-full w-full bg-ink" />
                ) : (
                  <motion.span key={scene} className="block h-full bg-ink" initial={{ width: "0%" }} animate={{ width: "100%" }} transition={{ duration: SCENE_MS / 1000, ease: "linear" }} />
                ))}
            </span>
          </button>
        ))}
        <AnimatePresence mode="wait">
          <motion.span key={s.name} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="ml-3 text-[12.5px] text-muted">
            {s.name}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
