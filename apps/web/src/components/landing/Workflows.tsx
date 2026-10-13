"use client";
import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { IconCheck } from "../graph/icons";
import { sparkPath } from "../ui/Sparkline";
import { walk } from "@/lib/rng";
import { useReducedMotion } from "@/lib/hooks";

/**
 * "Watch it work": a pinned section that plays four workflows as you scroll.
 * Each one runs the same loop: watch the signals, check the rule, trade,
 * then show how it went. Scroll position is the playhead.
 */

type Signal = { label: string; from: number; to: number; fmt: (v: number) => string };
type Flow = {
  tag: string;
  thesis: string;
  note: string;
  signals: Signal[];
  conditions: string[];
  action: string;
  fill: string;
  venue: string;
  pnl: number;
  seed: number;
  /** Phrases of the thesis and the condition that proves them (-1 = the trade itself). */
  marks: [phrase: string, condition: number][];
};

const pct = (v: number) => `${Math.round(v)}%`;
const usd = (d = 2) => (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

const FLOWS: Flow[] = [
  {
    tag: "Memecoins",
    thesis: "Buy $PUMP if it drops to 0.004 and the mood on X turns bullish.",
    note: "Matched by contract address, never by ticker. Rug checks run before every swap.",
    signals: [
      { label: "$PUMP price", from: 0.00431, to: 0.00398, fmt: (v) => v.toFixed(5) },
      { label: "Mood on X", from: 0.06, to: 0.41, fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}` },
      { label: "Mentions, last hour", from: 40, to: 180, fmt: (v) => `+${Math.round(v)}%` },
      { label: "Dev wallet sold", from: 0, to: 0, fmt: () => "0%" },
    ],
    conditions: ["Price at 0.004 or lower", "Mood above +0.3", "Dev wallet hasn’t sold"],
    action: "Buy $PUMP with 0.5 SOL",
    fill: "Filled at 0.00398 · stop at −20%",
    venue: "Solana via Jupiter",
    pnl: 18.2,
    seed: 31,
    marks: [
      ["Buy $PUMP", -1],
      ["drops to 0.004", 0],
      ["the mood on X turns bullish", 1],
    ],
  },
  {
    tag: "Weather",
    thesis: "El Niño is coming. What’s the trade?",
    note: "Reads NOAA’s forecast, compares it with the prediction market, and picks the crops that move.",
    signals: [
      { label: "Pacific temperature", from: 1.1, to: 1.7, fmt: (v) => `+${v.toFixed(1)}°C` },
      { label: "Market: El Niño by winter", from: 52, to: 61, fmt: pct },
      { label: "Weft’s forecast model", from: 71, to: 84, fmt: pct },
      { label: "Wheat", from: 5.52, to: 5.84, fmt: usd() },
    ],
    conditions: ["Pacific above +1.5°C", "Model 15+ points above the market"],
    action: "Long wheat at 2× and buy YES",
    fill: "Filled · stops at −6% and 48¢",
    venue: "Hyperliquid and Jupiter",
    pnl: 9.6,
    seed: 12,
    marks: [
      ["El Niño is coming.", 0],
      ["What’s the trade?", -1],
    ],
  },
  {
    tag: "Macro",
    thesis: "The Fed cuts in December and nobody’s positioned for it.",
    note: "Watches the odds, the bond market and inflation, and only acts when they agree.",
    signals: [
      { label: "Fed cut odds", from: 54, to: 68, fmt: pct },
      { label: "2-year yield", from: 3.55, to: 3.41, fmt: (v) => `${v.toFixed(2)}%` },
      { label: "Inflation nowcast", from: 2.9, to: 2.6, fmt: (v) => `${v.toFixed(1)}%` },
      { label: "Bitcoin", from: 112_400, to: 118_420, fmt: usd(0) },
    ],
    conditions: ["Cut odds above 65%", "Yield down 10+ bp in 5 days"],
    action: "Long BTC at 2×",
    fill: "Filled at $118,420 · stop at −5%",
    venue: "Hyperliquid",
    pnl: 6.1,
    seed: 44,
    marks: [
      ["The Fed cuts in December", 0],
      ["nobody’s positioned for it", 1],
    ],
  },
  {
    tag: "Stocks",
    thesis: "NVIDIA rallies into earnings. Be out before the report.",
    note: "Opens two days out and closes itself an hour before the numbers land.",
    signals: [
      { label: "NVIDIA", from: 176.4, to: 184.2, fmt: usd() },
      { label: "Earnings in", from: 72, to: 40, fmt: (v) => `${Math.round(v)} h` },
      { label: "Analyst revisions", from: 0, to: 3, fmt: (v) => `+${Math.round(v)}` },
    ],
    conditions: ["Within 48 hours of earnings", "Price above its 20-day average"],
    action: "Long NVDA at 2×, out before the report",
    fill: "Filled at $178.10 · closed at $184.20",
    venue: "Hyperliquid",
    pnl: 3.4,
    seed: 53,
    marks: [
      ["rallies into earnings", 0],
      ["Be out before the report", -1],
    ],
  },
];

// Playhead marks within one workflow (0..1): watch, check, trade, result.
const COND_AT = 0.24;
const COND_STEP = 0.06;
const FILL_AT = 0.48;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** The thesis with its phrases highlighted as the agent proves them, like a marker pen. */
function Thesis({ f, p }: { f: Flow; p: number }) {
  const parts: { text: string; mark?: number }[] = [];
  let rest = f.thesis;
  for (const [phrase, c] of f.marks) {
    const at = rest.indexOf(phrase);
    if (at < 0) continue;
    if (at > 0) parts.push({ text: rest.slice(0, at) });
    parts.push({ text: phrase, mark: c });
    rest = rest.slice(at + phrase.length);
  }
  if (rest) parts.push({ text: rest });
  return (
    <>
      “
      {parts.map((x, i) => {
        if (x.mark === undefined) return <span key={i}>{x.text}</span>;
        const on = x.mark === -1 ? p > FILL_AT : p > COND_AT + x.mark * COND_STEP;
        const tone = x.mark === -1 ? "var(--mark-long)" : "var(--mark)";
        return (
          <span
            key={i}
            className="rounded-[3px] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
            style={{
              backgroundImage: `linear-gradient(${tone}, ${tone})`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "0 85%",
              backgroundSize: on ? "100% 70%" : "0% 70%",
              transition: "background-size 0.7s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            {x.text}
          </span>
        );
      })}
      ”
    </>
  );
}

function Console({ f, p }: { f: Flow; p: number }) {
  const watch = ease(clamp01(p / 0.2));
  const ruleMet = p > COND_AT + f.conditions.length * COND_STEP;
  const sending = p > 0.42;
  const filled = p > FILL_AT;
  const result = clamp01((p - 0.5) / 0.3);
  const curve = useMemo(() => {
    const pts = walk(f.seed, 40, 0.5, 0.55);
    return sparkPath(pts, 300, 96, 3);
  }, [f.seed]);
  const status = filled ? (result > 0.98 ? "Done" : "In the trade") : ruleMet ? "Rule met" : "Watching";

  return (
    <div className="overflow-hidden rounded-[16px] border border-line bg-card shadow-window">
      <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5 sm:py-3.5">
        <span className="text-[13px] text-muted">{f.venue}</span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${filled ? "bg-long" : ruleMet ? "bg-trigger" : "bg-signal"}`}
          />
          {status}
        </span>
      </div>

      <div className="grid gap-px bg-line sm:grid-cols-2">
        {/* Watch */}
        <div className="bg-card px-4 py-3 sm:px-5 sm:py-4">
          <p className="text-[12px] text-muted">Watching</p>
          <ul className="mt-2 space-y-1.5 sm:mt-2.5 sm:space-y-2">
            {f.signals.map((s) => (
              <li key={s.label} className="flex items-baseline justify-between gap-3 text-[13.5px]">
                <span className="truncate text-ink-2">{s.label}</span>
                <span className="tnum shrink-0 font-medium text-ink">{s.fmt(s.from + (s.to - s.from) * watch)}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* When */}
        <div className="bg-card px-4 py-3 sm:px-5 sm:py-4">
          <p className="text-[12px] text-muted">When</p>
          <ul className="mt-2 space-y-1.5 sm:mt-2.5 sm:space-y-2">
            {f.conditions.map((c, j) => {
              const on = p > COND_AT + j * COND_STEP;
              return (
                <li key={c} className={`flex items-center gap-2 text-[13.5px] transition-colors duration-300 ${on ? "text-ink" : "text-faint"}`}>
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-all duration-300 ${
                      on ? "border-long bg-long text-paper" : "border-line-2"
                    }`}
                  >
                    {on && <IconCheck size={9} strokeWidth={3} />}
                  </span>
                  {c}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Do */}
      <div className="border-t border-line px-4 py-3 sm:px-5 sm:py-4">
        <p className="text-[12px] text-muted">Do</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className={`text-[15px] font-medium transition-colors duration-300 ${sending ? "text-ink" : "text-faint"}`}>{f.action}</span>
          <span className="shrink-0 text-[12.5px]">
            {filled ? (
              <span className="inline-flex items-center gap-1 text-long">
                <IconCheck size={12} strokeWidth={2.6} /> Filled
              </span>
            ) : sending ? (
              <span className="text-muted">Sending…</span>
            ) : (
              <span className="text-faint">Waiting</span>
            )}
          </span>
        </div>
        <p className={`mt-0.5 text-[12.5px] transition-opacity duration-300 ${filled ? "text-muted opacity-100" : "opacity-0"}`}>{f.fill}</p>
      </div>

      {/* Result */}
      <div className="border-t border-line px-4 pb-3 pt-3 sm:px-5 sm:pb-4">
        <div className="flex items-baseline justify-between">
          <p className="text-[12px] text-muted">Result on paper</p>
          <span className={`tnum text-[20px] font-medium tracking-[-0.02em] ${result > 0 ? "text-long" : "text-faint"}`}>
            +{(f.pnl * ease(result)).toFixed(1)}%
          </span>
        </div>
        <svg viewBox="0 0 300 96" className="mt-1 hidden h-auto w-full sm:block" aria-hidden>
          <line x1="0" x2="300" y1="95" y2="95" style={{ stroke: "var(--line)" }} />
          <path d={curve.line} fill="none" strokeWidth="1.8" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - result} style={{ stroke: "var(--long)" }} />
        </svg>
      </div>
    </div>
  );
}

export function Workflows() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const N = FLOWS.length;
  const [pos, setPos] = useState({ i: 0, p: 0 });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const t = clamp01(v) * N;
    const i = Math.min(N - 1, Math.floor(t));
    const p = Math.round(clamp01(t - i) * 100) / 100;
    setPos((o) => (o.i === i && o.p === p ? o : { i, p }));
  });

  if (reduce) {
    return (
      <section id="work" className="scroll-mt-16 border-t border-line">
        <div className="mx-auto max-w-[1200px] space-y-16 px-5 py-24 sm:px-8">
          <h2 className="display text-[clamp(2.2rem,4.4vw,3.6rem)] leading-[1.04] text-ink">Watch it work</h2>
          {FLOWS.map((f) => (
            <div key={f.tag} className="grid gap-8 lg:grid-cols-2 lg:items-center">
              <div>
                <p className="text-[13px] text-muted">{f.tag}</p>
                <p className="display mt-2 text-[28px] leading-[1.2] text-ink">
                  <Thesis f={f} p={1} />
                </p>
                <p className="mt-3 text-[15px] text-ink-2">{f.note}</p>
              </div>
              <Console f={f} p={1} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const f = FLOWS[pos.i]!;
  return (
    <section id="work" ref={ref} className="relative border-t border-line" style={{ height: `${N * 95 + 20}vh` }}>
      <div className="sticky top-0 flex h-[100svh] items-center overflow-hidden">
        <div className="mx-auto grid w-full max-w-[1200px] gap-8 px-5 pt-14 sm:px-8 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-center lg:gap-14">
          <div>
            <div className="flex items-center gap-3 text-[13px] text-muted">
              <span>How it works</span>
              <span className="tnum text-faint">
                {String(pos.i + 1).padStart(2, "0")} / {String(N).padStart(2, "0")}
              </span>
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={f.tag}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <p className="mt-4 text-[13px] font-medium text-ink sm:mt-6">{f.tag}</p>
                <p className="display mt-2 text-[clamp(1.5rem,3.4vw,2.9rem)] leading-[1.12] text-ink text-balance">
                  <Thesis f={f} p={pos.p} />
                </p>
                <p className="mt-4 hidden max-w-[30rem] text-[16px] leading-[1.6] text-ink-2 sm:block">{f.note}</p>
              </motion.div>
            </AnimatePresence>
            {/* where this workflow is: write, check, run */}
            <ol className="mt-6 flex items-center gap-2 text-[13.5px]" aria-label="Steps">
              {(["Write", "Check", "Run"] as const).map((step, k) => {
                const at = pos.p < 0.2 ? 0 : pos.p < FILL_AT ? 1 : 2;
                return (
                  <li key={step} className="flex items-center gap-2">
                    {k > 0 && <span className="h-px w-5 bg-line-2" aria-hidden />}
                    <span className={`transition-colors duration-300 ${k === at ? "font-medium text-ink" : k < at ? "text-ink-2" : "text-faint"}`}>
                      {k + 1}. {step}
                    </span>
                  </li>
                );
              })}
            </ol>
            {/* progress: one bar per workflow */}
            <div className="mt-5 flex gap-1.5 sm:mt-8" aria-hidden>
              {FLOWS.map((x, j) => (
                <span key={x.tag} className="h-[3px] w-12 overflow-hidden rounded-full bg-line-2">
                  <span className="block h-full bg-ink" style={{ width: `${j < pos.i ? 100 : j === pos.i ? pos.p * 100 : 0}%` }} />
                </span>
              ))}
            </div>
          </div>
          <Console f={f} p={pos.p} />
        </div>
      </div>
    </section>
  );
}
