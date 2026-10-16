"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { IconCheck, IconSend } from "../graph/icons";
import { Section } from "./Section";

/**
 * "Say it once": a short film of the whole loop. You type a trade in plain words, Weft turns the
 * sentence into rules (each phrase lights up as it becomes one), draws them as a diagram, then
 * watches the market tick by tick until every condition holds, and trades.
 */

const PROMPT = "Long ETH 20x with $50 if ETH breaks $2,600 and funding stays under 0.01% an hour. 20% stop.";

/** Phrases of the prompt and the rule each becomes. */
const PARTS = [
  { phrase: "Long ETH 20x with $50", tone: "long", rule: "Long ETH at 20× with $50", kind: "Do" },
  { phrase: "breaks $2,600", tone: "signal", rule: "ETH price above $2,600", kind: "When" },
  { phrase: "funding stays under 0.01% an hour", tone: "signal", rule: "Funding under 0.01% an hour", kind: "When" },
  { phrase: "20% stop", tone: "short", rule: "Stop at −20% on the position (price −1%)", kind: "Exit" },
] as const;

const TONE = { long: "var(--long)", signal: "var(--signal)", short: "var(--short)" } as const;

// Timeline (ms): type → rules → diagram → watch → trade → hold → restart.
const T = { type: 0, sent: 3600, rules: 4200, diagram: 6600, watch: 8200, met: 15800, filled: 16700, end: 22000 };
const TYPE_MS = T.sent - 400;
const THRESHOLD = 2600;

/** ETH ticks: drifts under the line, then breaks it near the end. Deterministic. */
function priceSeries(n: number): number[] {
  const out: number[] = [];
  let p = 2552;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < n; i++) {
    const pull = i < n * 0.86 ? (2584 - p) * 0.06 : (2612 - p) * 0.22;
    p += pull + rnd() * 9;
    if (i < n * 0.86) p = Math.min(p, THRESHOLD - 3);
    out.push(p);
  }
  out[n - 1] = 2604;
  return out;
}

const fmt = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const clock = (i: number) => {
  const s = 14 * 3600 + 2 * 60 + 7 + i * 4;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function Prompt({ shown, lit }: { shown: number; lit: number }) {
  // Split the typed text into plain runs and the phrases that have become rules.
  const text = PROMPT.slice(0, shown);
  const marks = PARTS.map((p, i) => ({ ...p, at: PROMPT.indexOf(p.phrase), on: i < lit })).sort((a, b) => a.at - b.at);
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.at >= text.length) break;
    if (m.at > pos) out.push(<span key={`t${pos}`}>{text.slice(pos, m.at)}</span>);
    const end = Math.min(text.length, m.at + m.phrase.length);
    out.push(
      <span
        key={m.phrase}
        className="rounded-[3px] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
        style={{
          backgroundImage: `linear-gradient(color-mix(in oklab, ${TONE[m.tone]} 26%, transparent), color-mix(in oklab, ${TONE[m.tone]} 26%, transparent))`,
          backgroundRepeat: "no-repeat",
          backgroundSize: m.on ? "100% 100%" : "0% 100%",
          transition: "background-size 0.6s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {text.slice(m.at, end)}
      </span>,
    );
    pos = end;
  }
  if (pos < text.length) out.push(<span key="rest">{text.slice(pos)}</span>);
  return <>{out}</>;
}

function Diagram({ on, met }: { on: number; met: boolean }) {
  // Two signals feed one rule, which feeds the trade.
  const node = (x: number, y: number, w: number, label: string, sub: string, color: string, i: number, done = false) => (
    <motion.g key={label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: on > i ? 1 : 0, y: on > i ? 0 : 6 }} transition={{ duration: 0.4 }}>
      <rect x={x} y={y} width={w} height={44} rx={10} style={{ fill: "var(--card)", stroke: done ? "var(--long)" : "var(--line-2)" }} strokeWidth={1.2} />
      <circle cx={x + 14} cy={y + 22} r={3.5} style={{ fill: color }} />
      <text x={x + 26} y={y + 19} fontSize={12} style={{ fill: "var(--ink)", fontWeight: 500 }}>
        {label}
      </text>
      <text x={x + 26} y={y + 34} fontSize={11} style={{ fill: "var(--muted)" }}>
        {sub}
      </text>
    </motion.g>
  );
  const edge = (d: string, i: number) => (
    <motion.path
      key={d}
      d={d}
      fill="none"
      strokeWidth={1.6}
      style={{ stroke: met ? "var(--long)" : "var(--line-2)" }}
      initial={{ pathLength: 0 }}
      animate={{ pathLength: on > i ? 1 : 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    />
  );
  return (
    <svg viewBox="0 0 520 132" className="h-auto w-full" aria-label="ETH price and ETH funding feed one rule, which opens the trade">
      {edge("M150 32 C185 32 185 66 216 66", 2)}
      {edge("M150 100 C185 100 185 66 216 66", 2)}
      {edge("M330 66 L366 66", 3)}
      {node(4, 10, 146, "ETH price", "above $2,600", "var(--signal)", 0)}
      {node(4, 78, 146, "ETH funding", "under 0.01% / h", "var(--signal)", 1)}
      {node(216, 44, 114, "Both true", "check every 15 s", "var(--trigger)", 2, met)}
      {node(366, 44, 150, "Long ETH 20×", "$50 · stop −20%", "var(--long)", 3, met)}
    </svg>
  );
}

export function AgentDemo() {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { rootMargin: "-15% 0px" });
  const reduce = useReducedMotion();
  const [t, setT] = useState(0);

  useEffect(() => {
    if (reduce) {
      setT(T.end - 1);
      return;
    }
    if (!inView) return;
    let start = performance.now() - t;
    let raf = 0;
    const loop = (now: number) => {
      let el = now - start;
      if (el > T.end) {
        start = now;
        el = 0;
      }
      setT(el);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, reduce]);

  const series = useMemo(() => priceSeries(64), []);
  const shown = Math.min(PROMPT.length, Math.floor((t / TYPE_MS) * PROMPT.length));
  const sent = t >= T.sent;
  const lit = t < T.rules ? 0 : Math.min(PARTS.length, 1 + Math.floor((t - T.rules) / 500));
  const diagramOn = t < T.diagram ? 0 : Math.min(4, 1 + Math.floor((t - T.diagram) / 350));
  const watching = t >= T.watch;
  const met = t >= T.met;
  const filled = t >= T.filled;
  // How many ticks the agent has checked so far.
  const ticks = !watching ? 0 : Math.min(series.length, 1 + Math.floor(((t - T.watch) / (T.met - T.watch)) * (series.length - 1)));
  const now = series[Math.max(0, ticks - 1)] ?? series[0]!;
  const funding = 0.0062 - (ticks / series.length) * 0.0021;
  const priceOk = now > THRESHOLD;

  // Chart geometry.
  const W = 520;
  const H = 120;
  const lo = 2530;
  const hi = 2625;
  const x = (i: number) => (i / (series.length - 1)) * (W - 8) + 4;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * (H - 10) - 5;
  const path = series
    .slice(0, Math.max(1, ticks))
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const log = Array.from({ length: ticks }, (_, i) => i)
    .filter((i) => i % 6 === 5 || i === ticks - 1)
    .slice(-4)
    .reverse();

  const status = filled ? "Order filled" : met ? "Rule met" : watching ? "Watching the market" : sent ? "Drafting your rules" : "Your idea";

  return (
    <Section
      id="demo"
      title="Say it once. Weft watches the market for you."
      lead="Write the trade the way you’d say it. Weft turns every part of the sentence into a rule, checks the market around the clock, and trades the moment all of it is true. Not a second before."
    >
      <div ref={box} className="mt-12 overflow-hidden rounded-[18px] border border-line bg-card shadow-window">
        {/* Window bar */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
          <span className="text-[13px] text-muted">New strategy</span>
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <span
              className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
              style={{ background: filled ? "var(--long)" : met ? "var(--trigger)" : watching ? "var(--signal)" : "var(--muted)" }}
            />
            {status}
          </span>
        </div>

        <div className="grid gap-px bg-line lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          {/* Left: the conversation and the rules it becomes */}
          <div className="space-y-5 bg-card p-4 sm:p-6">
            <div className={`rounded-[12px] border px-4 py-3.5 transition-colors duration-500 ${sent ? "border-line bg-paper-2/60" : "border-line-2 bg-card"}`}>
              <p className="min-h-[3.2em] text-[15px] leading-[1.6] text-ink sm:text-[16px]">
                <Prompt shown={shown} lit={lit} />
                {!sent && <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-pulse bg-ink" />}
              </p>
              <div className="mt-2 flex items-center justify-between text-[12px] text-faint">
                <span>{sent ? "You" : "Describe a trade in your own words"}</span>
                <span className={`grid h-7 w-7 place-items-center rounded-[8px] transition-colors ${sent ? "bg-ink text-paper" : "bg-paper-2 text-faint"}`}>
                  <IconSend size={13} />
                </span>
              </div>
            </div>

            <div>
              <p className="text-[12px] text-muted">{lit ? "Weft drafted these rules" : " "}</p>
              <ul className="mt-2 space-y-2">
                {PARTS.map((p, i) => (
                  <motion.li
                    key={p.rule}
                    initial={false}
                    animate={{ opacity: i < lit ? 1 : 0, x: i < lit ? 0 : -6 }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    className="flex items-center gap-3 text-[14px]"
                  >
                    <span className="w-11 shrink-0 text-[12px] text-muted">{p.kind}</span>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[p.tone] }} />
                    <span className="text-ink">{p.rule}</span>
                  </motion.li>
                ))}
              </ul>
            </div>
          </div>

          {/* Right: the diagram, then the agent at work */}
          <div className="space-y-5 bg-card p-4 sm:p-6">
            <div>
              <p className="text-[12px] text-muted">How it trades</p>
              <div className="mt-2">
                <Diagram on={diagramOn} met={met} />
              </div>
            </div>

            <div className={`transition-opacity duration-500 ${watching ? "opacity-100" : "opacity-30"}`}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12px] text-muted">Watching ETH · {ticks ? `${(ticks * 4).toLocaleString("en-US")} checks` : "starts when you press start"}</p>
                <span className="tnum text-[13px]">
                  <span className={priceOk ? "text-long" : "text-ink"}>{fmt(now)}</span>
                  <span className="text-faint"> · funding </span>
                  <span className="text-long">{funding.toFixed(4)}%</span>
                </span>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-auto w-full" aria-label="ETH price approaching and then breaking $2,600">
                <line x1={0} x2={W} y1={y(THRESHOLD)} y2={y(THRESHOLD)} strokeDasharray="4 6" strokeWidth={1.2} style={{ stroke: met ? "var(--long)" : "var(--trigger)" }} />
                <text x={W - 4} y={y(THRESHOLD) - 6} textAnchor="end" fontSize={11} style={{ fill: met ? "var(--long)" : "var(--trigger)" }}>
                  $2,600
                </text>
                {ticks > 0 && <path d={path} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: priceOk ? "var(--long)" : "var(--signal)" }} />}
                {ticks > 0 && <circle cx={x(ticks - 1)} cy={y(now)} r={3.6} style={{ fill: priceOk ? "var(--long)" : "var(--signal)" }} />}
              </svg>
              <ul className="mt-2 min-h-[82px] space-y-1 font-mono text-[11.5px]">
                {log.map((i) => {
                  const p = series[i]!;
                  const ok = p > THRESHOLD;
                  return (
                    <li key={i} className="flex gap-3 text-muted">
                      <span className="text-faint">{clock(i)}</span>
                      <span className={ok ? "text-long" : "text-ink-2"}>
                        ETH {fmt(p)} {ok ? "✓" : "✗"}
                      </span>
                      <span className="text-long">funding ✓</span>
                      <span className={ok ? "text-long" : ""}>{ok ? "rule met → buying" : "waiting"}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>

        {/* The outcome: always there, so the window never jumps; it says what the agent is doing. */}
        <div className="flex min-h-[72px] flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={filled ? "filled" : met ? "met" : watching ? "waiting" : "idle"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-3"
            >
              {filled ? (
                <>
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--long-soft)] text-long">
                    <IconCheck size={14} strokeWidth={2.4} />
                  </span>
                  <div>
                    <div className="text-[15px] font-medium text-ink">Long ETH 20× filled at $2,604</div>
                    <div className="text-[13px] text-muted">Stop placed on Hyperliquid at $2,578 (−20% on the position)</div>
                  </div>
                </>
              ) : (
                <>
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-paper-2">
                    <span className={`h-2 w-2 rounded-full ${watching ? "animate-pulse" : ""}`} style={{ background: watching ? "var(--signal)" : "var(--muted)" }} />
                  </span>
                  <div>
                    <div className="text-[15px] font-medium text-ink">{watching ? (met ? "Both conditions true: buying" : "Waiting: 1 of 2 conditions true") : "No trade yet"}</div>
                    <div className="text-[13px] text-muted">{met ? "ETH broke $2,600 with funding still low. Sending the order…" : watching ? "ETH is still under $2,600. Weft doesn’t guess, it waits." : "Nothing trades until every rule is true."}</div>
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          <span className="text-[13px] text-muted">From your own account · Weft can’t withdraw</span>
        </div>
      </div>
    </Section>
  );
}
