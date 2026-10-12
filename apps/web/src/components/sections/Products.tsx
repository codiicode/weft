"use client";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { alertSamples, products, tokenProfiles, type Product, type ProductMarket } from "@/data/mock";
import { brand } from "@/config/brand";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { Sparkline } from "../ui/Sparkline";
import { TokenAvatar } from "../ui/TokenAvatar";
import { IconCheck, IconLock, IconX } from "../graph/icons";
import { Delta, Flash, MicroLabel, smoothPath, toPoints } from "../widgets/WidgetCard";
import { useInView, useInterval, useLiveSeries, useReducedMotion } from "@/lib/hooks";
import { clamp, fmtNum, mulberry32 } from "@/lib/rng";

const EASE = [0.22, 1, 0.36, 1] as const;
const SPRING = { type: "spring", stiffness: 140, damping: 20, mass: 0.8 } as const;

/** Price formatting that works from BTC down to a fresh memecoin. */
function fmtPx(v: number) {
  if (v >= 1000) return fmtNum(v, 1);
  if (v >= 10) return fmtNum(v, 2);
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.01) return v.toFixed(4);
  if (v >= 0.001) return v.toFixed(5);
  return v.toFixed(6);
}
const pxDigits = (v: number) => (v >= 1000 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 4 : v >= 0.001 ? 5 : 6);

/** A live price that starts exactly at the mock value. */
function useLivePrice(m: ProductMarket, live: boolean, { vol = 0.0016, ms = 1100, length = 44 } = {}) {
  const series = useLiveSeries(m.seed ?? 1, {
    length,
    start: m.px ?? 1,
    vol,
    drift: (m.ch ?? 0) >= 0 ? 0.00008 : -0.00008,
    ms,
    active: live,
  });
  const [anchor] = useState(() => series[series.length - 1]);
  const k = (m.px ?? 1) / anchor;
  const scaled = series.map((v) => v * k);
  const px = scaled[scaled.length - 1];
  const ch = (m.ch ?? 0) + (px / (m.px ?? 1) - 1) * 100;
  return { series: scaled, px, ch };
}

/* ------------------------------------------------------------------ */
/* Tile shell                                                          */
/* ------------------------------------------------------------------ */

function StatusPill({ status }: { status: Product["status"] }) {
  if (status === "soon")
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-[color-mix(in_oklab,var(--trigger)_55%,transparent)] bg-[var(--trigger-soft)] px-2 py-[3px] font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-trigger">
        Coming soon
      </span>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--long-soft)] px-2 py-[3px] font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-long">
      <span className="h-[5px] w-[5px] rounded-full bg-long" />
      In beta
    </span>
  );
}

function Chips({
  p,
  idx,
  setIdx,
  progress,
}: {
  p: Product;
  idx: number;
  setIdx: (i: number) => void;
  /** seconds for the auto-advance bar on the active chip, if any */
  progress?: number | null;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${p.name} example markets`}>
      {p.markets.map((m, i) => {
        const on = i === idx;
        return (
          <button
            key={m.sym}
            type="button"
            aria-pressed={on}
            onClick={(e) => {
              e.stopPropagation();
              setIdx(i);
            }}
            className={`relative overflow-hidden rounded-full border px-2.5 py-[5px] font-mono text-[11px] leading-none transition-colors duration-300 ${
              on ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink-2 hover:border-line-2 hover:text-ink"
            }`}
          >
            <span className="relative z-10">{m.sym}</span>
            {on && progress ? (
              <motion.span
                key={`${m.sym}-${progress}`}
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-volt"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: progress, ease: "linear" }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Signal → trigger → action: how the example thesis compiles into the graph. */
function Compiled({ m, blocked }: { m: ProductMarket; blocked?: boolean }) {
  const cells = [
    { k: "Signal", v: m.graph.signal, c: "var(--signal)" },
    { k: "Trigger", v: m.graph.trigger, c: "var(--trigger)" },
    { k: "Action", v: m.graph.action, c: blocked ? "var(--short)" : "var(--long)" },
  ];
  return (
    <div className="relative mt-3 grid grid-cols-3 divide-x divide-line rounded-[12px] border border-line bg-card-2">
      {/* chevrons first: divide-x borders every child but the last */}
      {[1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-1/2 grid h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line bg-card text-faint"
          style={{ left: `${(i / 3) * 100}%` }}
        >
          <svg width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 1.5 5.5 4 3 6.5" />
          </svg>
        </span>
      ))}
      {cells.map((c, i) => (
        <div key={c.k} className="min-w-0 px-2.5 py-2 sm:px-3">
          <div className="flex items-center gap-1.5 font-mono text-[9px] font-medium uppercase tracking-[0.14em]" style={{ color: c.c }}>
            <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: c.c }} />
            {c.k}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${m.sym}-${i}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.28, delay: i * 0.06, ease: EASE }}
              className={`mt-1 font-mono text-[10.5px] leading-[1.35] ${i === 2 && blocked ? "text-short line-through decoration-short/60" : "text-ink"}`}
            >
              {c.v}
            </motion.div>
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Tile({
  p,
  className = "",
  stageClass = "",
  delay = 0,
  auto = false,
  children,
}: {
  p: Product;
  className?: string;
  stageClass?: string;
  delay?: number;
  /** auto-advance through example markets until the visitor picks one */
  auto?: boolean;
  children: (m: ProductMarket, live: boolean, idx: number) => ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { rootMargin: "60px" });
  const reduce = useReducedMotion();
  const live = inView && !reduce;
  const [idx, setIdx] = useState(0);
  const [touched, setTouched] = useState(false);
  const AUTO_S = 6.5;
  const autoOn = auto && live && !touched;
  useInterval(() => setIdx((i) => (i + 1) % p.markets.length), autoOn ? AUTO_S * 1000 : null, autoOn);
  const m = p.markets[idx];
  const blocked = p.id === "tokens" && tokenProfiles[m.sym]?.checks.some((c) => !c.ok);

  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  return (
    <Reveal delay={delay} className={`min-w-0 ${className}`}>
      <motion.article
        ref={ref}
        id={`product-${p.id}`}
        onPointerMove={onMove}
        whileHover={reduce ? undefined : { y: -3 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="group relative flex h-full min-w-0 flex-col overflow-hidden rounded-[22px] border border-line bg-card p-5 shadow-card transition-shadow duration-500 hover:shadow-lift sm:p-6"
      >
        {/* cursor spotlight */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(380px circle at var(--mx, 50%) var(--my, 0%), color-mix(in oklab, var(--volt) 13%, transparent), transparent 55%)",
          }}
        />
        <header className="relative flex items-start gap-3">
          <span className="mt-[5px] font-mono text-[11px] text-faint">{p.n}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h3 className="text-[22px] font-semibold leading-none tracking-[-0.035em] text-ink">{p.name}</h3>
              <StatusPill status={p.status} />
            </div>
            <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-ink-2 text-pretty">{p.kicker}</p>
          </div>
        </header>
        <div className="relative mt-3 flex flex-wrap gap-1 pl-[26px]">
          {p.venues.map((v) => (
            <span key={v} className="rounded-full border border-line px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted">
              {v}
            </span>
          ))}
        </div>

        <div
          className={`dot-grid relative mt-5 flex min-h-[184px] flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-paper/60 transition-colors duration-500 group-hover:bg-paper ${stageClass}`}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={m.sym}
              className="relative flex flex-1 flex-col"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.35, ease: EASE }}
            >
              {children(m, live, idx)}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="relative mt-4">
          <Chips
            p={p}
            idx={idx}
            setIdx={(i) => {
              setTouched(true);
              setIdx(i);
            }}
            progress={autoOn ? AUTO_S : null}
          />
          <div className="mt-3 min-h-[2.7em] font-serif text-[18px] italic leading-[1.3] text-ink">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={m.sym}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: EASE }}
              >
                “{m.thesis}”
              </motion.p>
            </AnimatePresence>
          </div>
          <Compiled m={m} blocked={blocked} />
        </div>
      </motion.article>
    </Reveal>
  );
}

/* ------------------------------------------------------------------ */
/* Shared chart bits                                                   */
/* ------------------------------------------------------------------ */

const CW = 400;
const CH = 120;

function PriceHead({ m, px, ch, tag }: { m: ProductMarket; px: number; ch: number; tag?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">{m.sym}</span>
          {tag}
        </div>
        <div className="mt-1 font-mono text-[22px] font-medium leading-none tracking-[-0.02em] text-ink">
          <Flash value={Math.round(px * 10 ** pxDigits(m.px ?? px))}>
            <span className="tnum">{fmtPx(px)}</span>
          </Flash>
        </div>
      </div>
      <div className="text-right">
        <Delta value={ch} className="text-[11px]">
          {ch >= 0 ? "+" : "−"}
          {Math.abs(ch).toFixed(2)}%
        </Delta>
        <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">24h</div>
      </div>
    </div>
  );
}

function Tag({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "signal" }) {
  return (
    <span
      className={`rounded-[5px] px-1.5 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.08em] ${
        tone === "signal" ? "bg-[var(--signal-soft)] text-signal" : "bg-paper-2 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 01 Perps: live chart with entry, TP and SL                         */
/* ------------------------------------------------------------------ */

function PerpVisual({ m, live }: { m: ProductMarket; live: boolean }) {
  const { series, px, ch } = useLivePrice(m, live);
  const gid = useId().replace(/:/g, "");
  const [entry] = useState(() => (m.px ?? 1) * 0.9985);
  const tp = entry * 1.0075;
  const sl = entry * 0.9955;
  const lo = Math.min(sl, ...series);
  const hi = Math.max(tp, ...series);
  const pad = (hi - lo) * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  const pts = toPoints(series, CW, CH, min, max);
  const line = smoothPath(pts);
  const area = `${line} L${CW},${CH} L0,${CH} Z`;
  const yOf = (v: number) => ((max - v) / (max - min)) * 100;
  const pnl = ((px - entry) / entry) * 100 * parseFloat(m.lev ?? "1");
  const levels = [
    { k: "TP", v: tp, c: "var(--long)" },
    { k: "Entry", v: entry, c: "var(--ink-2)" },
    { k: "SL", v: sl, c: "var(--short)" },
  ];
  return (
    <div className="flex flex-1 flex-col p-4">
      <PriceHead m={m} px={px} ch={ch} tag={<><Tag>-PERP</Tag>{m.lev && <Tag tone="signal">{m.lev}</Tag>}</>} />
      <div className="relative mt-3 min-h-[92px] flex-1">
        <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={`pp${gid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" style={{ stopColor: "var(--long)", stopOpacity: 0.16 }} />
              <stop offset="1" style={{ stopColor: "var(--long)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <rect x={0} width={CW} y={(yOf(tp) / 100) * CH} height={((yOf(entry) - yOf(tp)) / 100) * CH} style={{ fill: "var(--long-soft)" }} opacity={0.6} />
          <rect x={0} width={CW} y={(yOf(entry) / 100) * CH} height={((yOf(sl) - yOf(entry)) / 100) * CH} style={{ fill: "var(--short-soft)" }} opacity={0.6} />
          {levels.map((l) => (
            <line key={l.k} x1={0} x2={CW} y1={(yOf(l.v) / 100) * CH} y2={(yOf(l.v) / 100) * CH} stroke={l.c} strokeDasharray="3 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill={`url(#pp${gid})`} />
          <path d={line} fill="none" stroke="var(--ink)" strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {levels.map((l) => (
          <span
            key={l.k}
            className="absolute left-0 -translate-y-1/2 rounded-[4px] bg-card/90 px-1 font-mono text-[9px] uppercase tracking-[0.1em]"
            style={{ top: `${yOf(l.v)}%`, color: l.c }}
          >
            {l.k}
          </span>
        ))}
        <span
          className="absolute right-0 h-[7px] w-[7px] -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-card bg-ink"
          style={{ top: `${yOf(px)}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted">
        <span>Long {m.lev} · open</span>
        <Delta value={pnl} className="text-[10.5px]">
          uPnL {pnl >= 0 ? "+" : "−"}
          {Math.abs(pnl).toFixed(2)}%
        </Delta>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 02 Stocks: trades through the closed bell                          */
/* ------------------------------------------------------------------ */

const CLOSED_BANDS: [number, number][] = [
  [0.12, 0.3],
  [0.52, 0.7],
];

function StocksVisual({ m, live }: { m: ProductMarket; live: boolean }) {
  const { series, px, ch } = useLivePrice(m, live, { vol: 0.0012, ms: 1300, length: 36 });
  const gid = useId().replace(/:/g, "");
  const tokenized = m.venue.includes("Solana");
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const pad = (hi - lo) * 0.45 || 1;
  const pts = toPoints(series, CW, CH, lo - pad, hi + pad);
  const line = smoothPath(pts);
  return (
    <div className="flex flex-1 flex-col p-4">
      <PriceHead m={m} px={px} ch={ch} tag={<Tag tone={tokenized ? "signal" : "ink"}>{tokenized ? "xStock · SPL" : "HIP-3 perp"}</Tag>} />
      <div className="relative mt-3 min-h-[92px] flex-1">
        <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <defs>
            <pattern id={`hatch${gid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--line-2)" }} strokeWidth="2" />
            </pattern>
          </defs>
          {CLOSED_BANDS.map(([a, b]) => (
            <rect key={a} x={a * CW} width={(b - a) * CW} y={0} height={CH} fill={`url(#hatch${gid})`} />
          ))}
          <path d={line} fill="none" stroke="var(--signal)" strokeWidth={1.7} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {CLOSED_BANDS.map(([a, b], i) => (
          <span
            key={a}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-[4px] bg-card/90 px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted"
            style={{ left: `${((a + b) / 2) * 100}%` }}
          >
            {i === 0 ? "Bell closed" : "Weekend"}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3.5 rounded-[2px] border border-line-2 bg-[repeating-linear-gradient(45deg,var(--line-2)_0_1.5px,transparent_1.5px_4px)]" />
          Still trading, 24/7
        </span>
        <span className="truncate">{m.name}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 03 Predictions: odds that wobble, and the model's line             */
/* ------------------------------------------------------------------ */

function PredictionVisual({ m, live }: { m: ProductMarket; live: boolean }) {
  const base = m.yes ?? 0.5;
  const model = m.model ?? 0.5;
  const [yes, setYes] = useState(base);
  const [hist, setHist] = useState(() => {
    const r = mulberry32(Math.round(base * 1000));
    const out: number[] = [];
    let v = base - 0.07;
    for (let i = 0; i < 32; i++) {
      v += (base - v) * 0.18 + (r() - 0.5) * 0.03;
      out.push(v);
    }
    out[31] = base;
    return out;
  });
  const rand = useRef(mulberry32(Math.round(model * 977)));
  useInterval(
    () => {
      const next = clamp(yes + (base - yes) * 0.3 + (rand.current() - 0.5) * 0.03, base - 0.04, base + 0.04);
      setYes(next);
      setHist((h) => [...h.slice(1), next]);
    },
    1300,
    live
  );
  const yesPct = yes * 100;
  const modelPct = model * 100;
  const edge = modelPct - yesPct;
  const side = edge >= 0 ? "YES" : "NO";
  const lo = Math.min(...hist, model) - 0.03;
  const hi = Math.max(...hist, model) + 0.03;
  const pts = toPoints(hist, CW, 60, lo, hi);
  const modelY = ((hi - model) / (hi - lo)) * 100;
  return (
    <div className="flex flex-1 flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[15px] font-semibold leading-snug tracking-[-0.02em] text-ink text-balance">{m.name}</div>
        <span className="shrink-0 pt-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-faint">{m.closes}</span>
      </div>
      <div className="mt-3 flex items-end gap-4">
        <div>
          <MicroLabel>Yes</MicroLabel>
          <div className="mt-0.5 font-mono text-[26px] font-medium leading-none tracking-[-0.02em] text-ink">
            <Flash value={Math.round(yesPct * 10)}>
              <span className="tnum">{yesPct.toFixed(1)}</span>
              <span className="text-[0.55em] text-muted">¢</span>
            </Flash>
          </div>
        </div>
        <div>
          <MicroLabel>Edge</MicroLabel>
          <div className="mt-0.5 whitespace-nowrap font-mono text-[15px] leading-none">
            <Delta value={Math.abs(edge)}>
              {Math.abs(edge).toFixed(1)}pp
            </Delta>
            <span className="ml-1.5 text-[10px] text-faint">→ {side}</span>
          </div>
        </div>
        <div className="relative ml-auto h-[40px] w-[42%] max-w-[150px]">
          <svg viewBox={`0 0 ${CW} 60`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            <line x1={0} x2={CW} y1={(modelY / 100) * 60} y2={(modelY / 100) * 60} stroke="var(--signal)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            <path d={smoothPath(pts)} fill="none" stroke="var(--ink)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      </div>
      <div className="relative mt-auto pb-5 pt-7">
        <span
          className="absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-volt px-1.5 py-[3px] font-mono text-[9.5px] font-semibold leading-none text-[#0b0c0f]"
          style={{ left: `${clamp(modelPct, 14, 86)}%` }}
        >
          Model {modelPct.toFixed(0)}%
        </span>
        <div className="relative h-2.5 overflow-hidden rounded-full bg-[var(--short-soft)]">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ background: "linear-gradient(90deg, color-mix(in oklab, var(--long) 65%, transparent), var(--long))" }}
            initial={false}
            animate={{ width: `${yesPct}%` }}
            transition={SPRING}
          />
          <motion.div
            className="absolute inset-y-0"
            style={{ backgroundImage: "repeating-linear-gradient(135deg, color-mix(in oklab, var(--signal) 60%, transparent) 0 1.5px, transparent 1.5px 5px)" }}
            initial={false}
            animate={{ left: `${Math.min(yesPct, modelPct)}%`, width: `${Math.abs(edge)}%` }}
            transition={SPRING}
          />
        </div>
        <div className="absolute top-[22px] h-[20px] w-[2px] -translate-x-1/2 rounded-full bg-ink" style={{ left: `${modelPct}%` }} />
        <div className="mt-1.5 flex justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
          <span>Yes</span>
          <span>{m.venue}</span>
          <span>No</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 04 Solana tokens: identity by mint + rug checks                    */
/* ------------------------------------------------------------------ */

function TokenVisual({ m, live }: { m: ProductMarket; live: boolean }) {
  const t = tokenProfiles[m.sym];
  const fresh = m.sym === "$LOOM";
  const { series, px, ch } = useLivePrice(m, live, { vol: fresh ? 0.02 : 0.006, ms: 950, length: 36 });
  const reduce = useReducedMotion();
  const n = t.checks.length;
  const [done, setDone] = useState(reduce ? n : 0);
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { rootMargin: "-40px", once: true });
  useEffect(() => {
    if (reduce) {
      setDone(n);
      return;
    }
    if (!seen) return;
    setDone(0);
    const ids = t.checks.map((_, i) => window.setTimeout(() => setDone(i + 1), 380 + i * 260));
    return () => ids.forEach(clearTimeout);
  }, [seen, reduce, n, t]);
  const failed = t.checks.filter((c) => !c.ok).length;
  const finished = done >= n;
  const sentPct = ((t.sentiment + 1) / 2) * 100;

  return (
    <div ref={ref} className="grid flex-1 gap-3 p-3 sm:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] sm:p-4">
      {/* identity card */}
      <div className="flex min-w-0 flex-col rounded-[14px] border border-line bg-card p-4 shadow-card">
        <div className="flex items-center gap-3">
          <TokenAvatar sym={m.sym} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">{m.sym}</span>
              {fresh && <Tag tone="signal">new</Tag>}
            </div>
            <div className="truncate font-mono text-[10px] text-muted">{t.origin}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[15px] text-ink">
              <Flash value={Math.round(px * 10 ** pxDigits(m.px ?? px))}>
                <span className="tnum">{fmtPx(px)}</span>
              </Flash>
            </div>
            <Delta value={ch} className="text-[10.5px]">
              {ch >= 0 ? "+" : "−"}
              {Math.abs(ch).toFixed(1)}%
            </Delta>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-[9px] border border-line bg-card-2 px-2.5 py-1.5">
          <MicroLabel>Mint</MicroLabel>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{t.mint}</span>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-long">
            <IconCheck size={10} strokeWidth={2.2} /> by mint
          </span>
        </div>
        <div className="relative mt-3 h-[44px]">
          <Sparkline data={series} width={300} height={44} color={ch >= 0 ? "var(--long)" : "var(--short)"} className="absolute inset-0 h-full w-full" />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
          {[
            ["Holders", t.holders],
            ["Liquidity", t.liquidity],
            ["Mentions", t.mentions],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt>
                <MicroLabel>{k}</MicroLabel>
              </dt>
              <dd className="tnum mt-0.5 truncate font-mono text-[12px] text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <div className="flex justify-between">
            <MicroLabel>Sentiment</MicroLabel>
            <span className="tnum font-mono text-[10px] text-ink-2">{t.sentiment >= 0 ? "+" : "−"}{Math.abs(t.sentiment).toFixed(2)}</span>
          </div>
          <div className="relative mt-1.5 h-[5px] rounded-full bg-[linear-gradient(90deg,var(--short-soft),var(--paper-2)_50%,var(--long-soft))]">
            <span className="absolute inset-y-[-3px] left-1/2 w-px bg-line-2" />
            <motion.span
              className="absolute top-1/2 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-long shadow-card"
              initial={false}
              animate={{ left: `${sentPct}%` }}
              transition={SPRING}
            />
          </div>
        </div>
      </div>

      {/* rug checks */}
      <div className="flex min-w-0 flex-col rounded-[14px] border border-line bg-card p-4 shadow-card">
        <div className="flex items-center justify-between">
          <MicroLabel className="!text-ink-2">Pre-trade rug checks</MicroLabel>
          <span className="tnum font-mono text-[10.5px] text-muted">
            {Math.min(done, n)}/{n}
          </span>
        </div>
        <ul className="mt-2 divide-y divide-line">
          {t.checks.map((c, i) => {
            const state = i < done ? (c.ok ? "ok" : "fail") : i === done ? "run" : "wait";
            return (
              <li key={c.label} className="flex items-center gap-2.5 py-[7px]">
                <span
                  className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full transition-colors duration-300 ${
                    state === "ok" ? "bg-[var(--long-soft)] text-long" : state === "fail" ? "bg-[var(--short-soft)] text-short" : "bg-paper-2 text-faint"
                  }`}
                >
                  {state === "ok" ? (
                    <IconCheck size={10} strokeWidth={2.4} />
                  ) : state === "fail" ? (
                    <IconX size={9} strokeWidth={2.4} />
                  ) : state === "run" ? (
                    <span className="spin-slow block h-[9px] w-[9px] rounded-full border-[1.5px] border-faint border-t-transparent" />
                  ) : (
                    <span className="h-[4px] w-[4px] rounded-full bg-line-2" />
                  )}
                </span>
                <span className={`min-w-0 flex-1 truncate text-[12.5px] ${state === "wait" ? "text-faint" : "text-ink"}`}>{c.label}</span>
                <span
                  className={`tnum shrink-0 font-mono text-[10.5px] transition-opacity duration-300 ${state === "fail" ? "text-short" : "text-ink-2"} ${
                    i < done ? "opacity-100" : "opacity-0"
                  }`}
                >
                  {c.value}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto pt-3">
          <AnimatePresence mode="wait" initial={false}>
            {finished ? (
              <motion.div
                key={failed ? "blocked" : "clear"}
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.35, ease: EASE }}
                className={`flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px] font-medium ${
                  failed ? "bg-[var(--short-soft)] text-short" : "bg-[var(--long-soft)] text-long"
                }`}
              >
                {failed ? <IconLock size={13} /> : <IconCheck size={13} strokeWidth={2.2} />}
                {failed ? `Blocked · ${failed} checks failed. No swap.` : "Clear to swap via Jupiter"}
              </motion.div>
            ) : (
              <motion.div
                key="run"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-[10px] bg-paper-2 px-3 py-2 font-mono text-[11px] text-muted"
              >
                <span className="spin-slow block h-[10px] w-[10px] rounded-full border-[1.5px] border-muted border-t-transparent" />
                Checking {m.sym} by mint…
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 05 Options: payoff diagram, defined risk                           */
/* ------------------------------------------------------------------ */

type Payoff = NonNullable<ProductMarket["payoff"]>;

function payoffPts(p: Payoff): [number, number][] {
  const prem = p.premium;
  if (p.kind === "call-spread") {
    const k2 = p.k2 ?? p.k1 + 0.2;
    return [[0, -prem], [p.k1, -prem], [k2, k2 - p.k1 - prem], [1, k2 - p.k1 - prem]];
  }
  if (p.kind === "long-put") return [[0, p.k1 - prem], [p.k1, -prem], [0.8, -prem], [1, -prem]];
  return [[0, -prem], [p.k1, -prem], [0.8, 0.8 - p.k1 - prem], [1, 1 - p.k1 - prem]];
}
function payoffAt(pts: [number, number][], x: number) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (x >= x1 && x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1 || 1);
  }
  return pts[pts.length - 1][1];
}

const OY: [number, number] = [-0.16, 0.56];

function OptionsVisual({ m, live }: { m: ProductMarket; live: boolean }) {
  const p = m.payoff!;
  const pts = useMemo(() => payoffPts(p), [p]);
  const [t, setT] = useState(0);
  useInterval(() => setT((v) => v + 1), 900, live);
  const base = p.kind === "long-put" ? 0.5 : 0.6;
  const spot = clamp(base + Math.sin(t * 0.55) * 0.07 + Math.sin(t * 1.7) * 0.015, 0.05, 0.95);
  const W = CW;
  const H = 130;
  const X = (x: number) => x * W;
  const Y = (y: number) => ((OY[1] - y) / (OY[1] - OY[0])) * H;
  const zero = Y(0);
  const d = `M${pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" L")}`;
  const area = `M0,${zero.toFixed(1)} L${pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" L")} L${W},${zero.toFixed(1)} Z`;
  const gid = useId().replace(/:/g, "");
  const pnlUnits = payoffAt(pts, spot);
  const pnlUsd = (pnlUnits / p.premium) * p.lossUsd;
  const be = p.kind === "long-put" ? p.k1 - p.premium : p.k1 + p.premium;
  return (
    <div className="flex flex-1 flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">{m.name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-muted">Breakeven {p.breakeven}</div>
        </div>
        <div className="text-right">
          <MicroLabel>P&amp;L at spot</MicroLabel>
          <div className="mt-0.5 font-mono text-[13px]">
            <Delta value={pnlUsd}>
              {pnlUsd >= 0 ? "+" : "−"}${Math.abs(pnlUsd).toFixed(0)}
            </Delta>
          </div>
        </div>
      </div>
      <div className="relative mt-3 min-h-[96px] flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <defs>
            <clipPath id={`up${gid}`}>
              <rect x={0} y={0} width={W} height={zero} />
            </clipPath>
            <clipPath id={`dn${gid}`}>
              <rect x={0} y={zero} width={W} height={H - zero} />
            </clipPath>
          </defs>
          <motion.path initial={false} animate={{ d: area }} transition={{ duration: 0.7, ease: EASE }} clipPath={`url(#up${gid})`} style={{ fill: "var(--long-soft)" }} />
          <motion.path initial={false} animate={{ d: area }} transition={{ duration: 0.7, ease: EASE }} clipPath={`url(#dn${gid})`} style={{ fill: "var(--short-soft)" }} />
          <line x1={0} x2={W} y1={zero} y2={zero} stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />
          <line x1={X(spot)} x2={X(spot)} y1={0} y2={H} stroke="var(--ink-2)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" opacity={0.6} />
          <motion.path initial={false} animate={{ d }} transition={{ duration: 0.7, ease: EASE }} fill="none" stroke="var(--ink)" strokeWidth={1.8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* breakeven tick */}
        <span className="absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 border-[1.5px] border-ink bg-card" style={{ left: `${be * 100}%`, top: `${(zero / H) * 100}%` }} />
        {/* spot dot */}
        <span
          className="absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow-card transition-[left,top] duration-700 ease-out"
          style={{ left: `${spot * 100}%`, top: `${(Y(pnlUnits) / H) * 100}%`, background: pnlUnits >= 0 ? "var(--long)" : "var(--short)" }}
        />
        <span className="absolute right-0 top-0 font-mono text-[9.5px] uppercase tracking-[0.1em] text-long">Max gain {p.maxGain}</span>
        <span className="absolute bottom-0 left-0 font-mono text-[9.5px] uppercase tracking-[0.1em] text-short">Max loss −${p.lossUsd}</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-muted">
        <IconLock size={10} /> Max loss known before the trade. No naked selling.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts-only strip                                                  */
/* ------------------------------------------------------------------ */

function AlertsStrip() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { rootMargin: "40px" });
  const reduce = useReducedMotion();
  const [mode, setMode] = useState<"alerts" | "auto">("alerts");
  const [head, setHead] = useState(0);
  useInterval(() => setHead((h) => (h + 1) % alertSamples.length), 3400, inView && !reduce);
  const order = alertSamples.map((_, i) => alertSamples[(head + i) % alertSamples.length]);

  return (
    <Reveal className="md:order-2 md:col-span-2 lg:order-none lg:col-span-12">
      <div ref={ref} className="night grain relative overflow-hidden rounded-[22px] border border-line px-5 py-8 sm:px-8 md:py-10">
        <div className="pointer-events-none absolute -left-24 top-1/2 h-[380px] w-[520px] -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--volt)_12%,transparent),transparent)] blur-2xl" />
        <div className="relative grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
          <div>
            <div className="inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
              <span className="h-[5px] w-[5px] rounded-full bg-volt" /> Any product · alerts-only mode
            </div>
            <h3 className="mt-4 max-w-[20ch] text-[clamp(1.6rem,3vw,2.3rem)] font-semibold leading-[1.05] tracking-[-0.04em] text-ink text-balance">
              Not ready to let it trade? Let it <span className="serif-em text-volt">tap you</span> on the shoulder.
            </h3>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-2">
              Every strategy can run in alerts-only mode. The graph keeps watching, and Telegram or a push notification tells you the moment a trigger fires. You decide whether to act.
            </p>
            <div className="mt-6 inline-grid grid-cols-2 rounded-full border border-line-2 bg-card/60 p-1 font-mono text-[11px] uppercase tracking-[0.1em]" role="group" aria-label="Strategy mode">
              {(["alerts", "auto"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)} className="relative z-10 rounded-full px-4 py-2">
                  {mode === k && <motion.span layoutId="alerts-mode-pill" className="absolute inset-0 -z-10 rounded-full bg-volt" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
                  <span className={mode === k ? "text-[#0b0c0f]" : "text-muted"}>{k === "alerts" ? "Alert me" : "Auto-trade"}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="relative mx-auto h-[220px] w-full max-w-[460px]" aria-live="off">
            {order.map((a, i) => (
              <motion.div
                key={a.title}
                className="absolute inset-x-0 top-0 origin-top rounded-[18px] border border-line-2 bg-card/90 p-4 shadow-[0_24px_60px_-24px_rgba(0,0,0,.8)] backdrop-blur"
                initial={false}
                animate={{ y: i * 16, scale: 1 - i * 0.05, opacity: i === 0 ? 1 : i === 1 ? 0.55 : 0.25, zIndex: 10 - i }}
                transition={{ type: "spring", stiffness: 260, damping: 30 }}
                aria-hidden={i !== 0}
              >
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                  <span className="grid h-5 w-5 place-items-center rounded-md bg-volt text-[10px] font-bold text-[#0b0c0f]">{brand.name.slice(0, 1)}</span>
                  {brand.name} · {a.channel}
                  <span className="ml-auto normal-case tracking-normal text-faint">{a.ago}</span>
                </div>
                <div className="mt-2.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">
                  {mode === "auto" ? `Executed: ${a.cta}` : a.title}
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-2">{a.body}</p>
                <div className="mt-3 flex items-center gap-2">
                  {mode === "alerts" ? (
                    <>
                      <span className="rounded-full bg-volt px-3 py-1.5 text-[12px] font-medium text-[#0b0c0f]">{a.cta}</span>
                      <span className="rounded-full border border-line-2 px-3 py-1.5 text-[12px] text-ink-2">Ignore</span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--long-soft)] px-3 py-1.5 text-[12px] font-medium text-long">
                      <IconCheck size={12} strokeWidth={2.2} /> Filled · stops set
                    </span>
                  )}
                  <span className="ml-auto truncate font-mono text-[10px] text-faint">{a.strategy}</span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

const P = Object.fromEntries(products.map((p) => [p.id, p])) as Record<Product["id"], Product>;

export function Products() {
  return (
    <section id="products" className="relative py-24 md:py-36">
      <div
        aria-hidden
        className="dot-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_70%_45%_at_50%_40%,black,transparent)]"
      />
      <div className="relative mx-auto max-w-[1240px] px-5">
        <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="What you can trade"
            title={
              <>
                Five markets. <span className="serif-em">One</span> graph.
              </>
            }
            sub="Perps, stocks, prediction markets, any Solana token and, soon, options. Every product runs on the same strategy graph, so one thesis can span all of them."
          />
          <Reveal delay={0.15} className="shrink-0">
            <dl className="grid grid-cols-3 divide-x divide-line rounded-[14px] border border-line bg-card/70 shadow-card backdrop-blur">
              {[
                ["Products", "5"],
                ["Chains", "2"],
                ["Graph", "1"],
              ].map(([k, v]) => (
                <div key={k} className="px-4 py-3 sm:px-5">
                  <dt className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">{k}</dt>
                  <dd className="tnum mt-1 font-mono text-[20px] font-medium tracking-[-0.03em] text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5 lg:grid-cols-12">
          <Tile p={P.perps} className="lg:col-span-4" delay={0}>
            {(m, live) => <PerpVisual m={m} live={live} />}
          </Tile>
          <Tile p={P.stocks} className="lg:col-span-4" delay={0.06}>
            {(m, live) => <StocksVisual m={m} live={live} />}
          </Tile>
          <Tile p={P.predictions} className="md:order-1 lg:order-none lg:col-span-4" delay={0.12}>
            {(m, live) => <PredictionVisual m={m} live={live} />}
          </Tile>
          <Tile p={P.tokens} className="md:col-span-2 lg:col-span-8" stageClass="min-h-[300px]" auto>
            {(m, live) => <TokenVisual m={m} live={live} />}
          </Tile>
          <Tile p={P.options} className="md:order-1 lg:order-none lg:col-span-4" delay={0.06}>
            {(m, live) => <OptionsVisual m={m} live={live} />}
          </Tile>
          <AlertsStrip />
        </div>
        <p className="mt-6 text-center font-mono text-[11px] text-faint">
          Pick a market on any card to see its thesis compile. Demo data · tokens are matched by mint address, never by ticker alone.
        </p>
      </div>
    </section>
  );
}
