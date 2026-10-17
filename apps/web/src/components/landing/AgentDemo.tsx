"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { IconCheck, IconSend } from "../graph/icons";
import { Section } from "./Section";

/**
 * "Say it once": a short film of the whole loop, played for a few strategies in turn. You type a
 * trade in plain words, Weft turns the sentence into rules (each phrase lights up as it becomes
 * one), draws them as a diagram, then watches the market tick by tick until every condition holds,
 * and trades. Then the next strategy.
 */

type Tone = "long" | "signal" | "short";
type Scenario = {
  prompt: string;
  /** Phrases of the prompt and the rule each becomes. */
  parts: { phrase: string; tone: Tone; rule: string; kind: "Do" | "When" | "Exit" }[];
  /** The condition the film is about: a value that travels to its threshold and crosses it. */
  watch: { name: string; from: number; threshold: number; to: number; dir: "above" | "below"; fmt: (v: number) => string; seed: number };
  /** The other conditions, already true while the agent waits. */
  also: { label: string; value: string }[];
  /** Two or three conditions feed one rule, which feeds the trade. */
  diagram: { signals: [string, string][]; action: [string, string] };
  waiting: string;
  met: string;
  filled: [string, string];
  venue: string;
};

const usd0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (d: number) => (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;

const SCENARIOS: Scenario[] = [
  {
    prompt: "Long ETH 20x with $50 if ETH breaks $2,600 and funding stays under 0.01% an hour. 20% stop.",
    parts: [
      { phrase: "Long ETH 20x with $50", tone: "long", rule: "Long ETH at 20× with $50", kind: "Do" },
      { phrase: "breaks $2,600", tone: "signal", rule: "ETH price above $2,600", kind: "When" },
      { phrase: "funding stays under 0.01% an hour", tone: "signal", rule: "Funding under 0.01% an hour", kind: "When" },
      { phrase: "20% stop", tone: "short", rule: "Stop at −20% on the position (price −1%)", kind: "Exit" },
    ],
    watch: { name: "ETH", from: 2552, threshold: 2600, to: 2604, dir: "above", fmt: usd0, seed: 7 },
    also: [{ label: "funding 0.0041%", value: "funding" }],
    diagram: { signals: [["ETH price", "above $2,600"], ["ETH funding", "under 0.01% / h"]], action: ["Long ETH 20×", "$50 · stop −20%"] },
    waiting: "ETH is still under $2,600, so nothing happens yet.",
    met: "ETH broke $2,600 with funding still low. Sending the order…",
    filled: ["Long ETH 20× filled at $2,604", "Stop placed on Hyperliquid at $2,578 (−20% on the position)"],
    venue: "Hyperliquid",
  },
  {
    prompt: "If the Spurs win at least 10 of their first 15 games and their title odds pass 25%, put $1,000 on them winning the NBA title. Sell if the odds drop below 15%.",
    parts: [
      { phrase: "put $1,000 on them winning the NBA title", tone: "long", rule: "Buy YES on the Spurs winning the 2027 NBA title, $1,000", kind: "Do" },
      { phrase: "win at least 10 of their first 15 games", tone: "signal", rule: "Spurs: 10+ wins after 15 games", kind: "When" },
      { phrase: "title odds pass 25%", tone: "signal", rule: "Spurs title odds above 25%", kind: "When" },
      { phrase: "Sell if the odds drop below 15%", tone: "short", rule: "Sell if the odds fall below 15%", kind: "Exit" },
    ],
    watch: { name: "Spurs title odds", from: 21.1, threshold: 25, to: 25.6, dir: "above", fmt: (v) => `${v.toFixed(1)}%`, seed: 41 },
    also: [{ label: "Spurs 11–4", value: "record" }],
    diagram: { signals: [["Spurs record (NBA)", "10+ wins in 15 games"], ["Spurs title odds", "above 25%"]], action: ["Buy Spurs YES", "$1,000 · sell under 15%"] },
    waiting: "The Spurs are 11–4, but the market still has them under 25%.",
    met: "The odds hit 25.6% with the Spurs at 11–4. Buying YES…",
    filled: ["Bought Spurs YES at 25.6¢, 3,906 shares", "Sells on Hyperliquid if the odds fall below 15%"],
    venue: "ESPN + Hyperliquid",
  },
  {
    prompt: "If @elonmusk posts about Dogecoin while DOGE funding is under 0.01% an hour and mentions on X double, long DOGE 5x with $100. 25% stop.",
    parts: [
      { phrase: "long DOGE 5x with $100", tone: "long", rule: "Long DOGE at 5× with $100", kind: "Do" },
      { phrase: "@elonmusk posts about Dogecoin", tone: "signal", rule: "A new @elonmusk post about Dogecoin", kind: "When" },
      { phrase: "DOGE funding is under 0.01% an hour", tone: "signal", rule: "Funding under 0.01% an hour", kind: "When" },
      { phrase: "mentions on X double", tone: "signal", rule: "DOGE mentions on X up 100% in an hour", kind: "When" },
      { phrase: "25% stop", tone: "short", rule: "Stop at −25% on the position (price −5%)", kind: "Exit" },
    ],
    watch: { name: "DOGE mentions, 1h", from: 18, threshold: 100, to: 142, dir: "above", fmt: (v) => `+${Math.round(Math.max(0, v))}%`, seed: 23 },
    also: [
      { label: "Elon posted", value: "post" },
      { label: "funding 0.0038%", value: "funding" },
    ],
    diagram: {
      signals: [["@elonmusk on X", "posts about Dogecoin"], ["DOGE funding", "under 0.01% / h"], ["DOGE mentions", "up 100%+ in 1h"]],
      action: ["Long DOGE 5×", "$100 · stop −25%"],
    },
    waiting: "Elon posted and funding is low, but the buzz hasn’t doubled yet.",
    met: "Mentions are up 142% in an hour. All three are true. Sending the order…",
    filled: ["Long DOGE 5× filled at $0.0806", "Stop placed on Hyperliquid at $0.0766 (−25% on the position)"],
    venue: "X + Hyperliquid",
  },
  {
    prompt: "Buy $MET with 0.5 SOL if it drops 10% in an hour while liquidity stays above $5M. 20% stop.",
    parts: [
      { phrase: "Buy $MET with 0.5 SOL", tone: "long", rule: "Buy $MET (Meteora) with 0.5 SOL", kind: "Do" },
      { phrase: "drops 10% in an hour", tone: "signal", rule: "$MET down 10% or more in an hour", kind: "When" },
      { phrase: "liquidity stays above $5M", tone: "signal", rule: "Liquidity above $5M", kind: "When" },
      { phrase: "20% stop", tone: "short", rule: "Stop at −20%", kind: "Exit" },
    ],
    watch: { name: "MET 1h", from: -1.8, threshold: -10, to: -10.6, dir: "below", fmt: pct(1), seed: 19 },
    also: [{ label: "liquidity $8.4M", value: "liquidity" }],
    diagram: { signals: [["$MET, last hour", "down 10%+"], ["$MET liquidity", "above $5M"]], action: ["Buy $MET", "0.5 SOL · stop −20%"] },
    waiting: "$MET is down, but not 10% yet. No buy.",
    met: "$MET is down 10.6% in an hour and liquidity is deep. Swapping…",
    filled: ["Bought $MET with 0.5 SOL", "Swapped through Jupiter from your own wallet · stop at −20%"],
    venue: "Solana via Jupiter",
  },
  {
    prompt: "Short SOL 5x with $50 if funding stays above 0.02% an hour, SOL is below $110 and Fear & Greed is above 70. 15% stop.",
    parts: [
      { phrase: "Short SOL 5x with $50", tone: "short", rule: "Short SOL at 5× with $50", kind: "Do" },
      { phrase: "funding stays above 0.02% an hour", tone: "signal", rule: "Funding above 0.02% an hour", kind: "When" },
      { phrase: "SOL is below $110", tone: "signal", rule: "SOL price below $110", kind: "When" },
      { phrase: "Fear & Greed is above 70", tone: "signal", rule: "Crypto Fear & Greed above 70", kind: "When" },
      { phrase: "15% stop", tone: "short", rule: "Stop at −15% on the position (price +3%)", kind: "Exit" },
    ],
    watch: { name: "SOL funding", from: 0.011, threshold: 0.02, to: 0.021, dir: "above", fmt: (v) => `${v.toFixed(4)}%`, seed: 31 },
    also: [
      { label: "SOL $104.70", value: "price" },
      { label: "Fear & Greed 74", value: "greed 74" },
    ],
    diagram: { signals: [["SOL funding", "above 0.02% / h"], ["SOL price", "below $110"], ["Fear & Greed", "above 70"]], action: ["Short SOL 5×", "$50 · stop −15%"] },
    waiting: "The crowd is greedy, but funding is still under 0.02%. No short yet.",
    met: "Longs are paying 0.021% an hour and greed is at 74. Shorting…",
    filled: ["Short SOL 5× filled at $104.70", "Stop placed on Hyperliquid at $107.84 (−15% on the position)"],
    venue: "Hyperliquid",
  },
];

const TONE: Record<Tone, string> = { long: "var(--long)", signal: "var(--signal)", short: "var(--short)" };

// Timeline per strategy (ms): type → rules → diagram → watch → trade → hold → next strategy.
const T = { sent: 3600, rules: 4200, diagram: 6600, watch: 8200, met: 15800, filled: 16700, end: 22000 };
const TYPE_MS = T.sent - 400;
const TICKS = 64;

/** Ticks that stay on the wrong side of the threshold, then cross it near the end. Deterministic. */
function series(w: Scenario["watch"]): number[] {
  const out: number[] = [];
  const span = Math.abs(w.threshold - w.from);
  const gap = span * 0.06;
  const resting = w.dir === "above" ? w.threshold - span * 0.35 : w.threshold + span * 0.35;
  let v = w.from;
  let seed = w.seed;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < TICKS; i++) {
    const late = i >= TICKS * 0.86;
    v += ((late ? w.to : resting + (w.threshold - resting) * (i / TICKS)) - v) * (late ? 0.25 : 0.08) + rnd() * span * 0.09;
    if (!late) v = w.dir === "above" ? Math.min(v, w.threshold - gap) : Math.max(v, w.threshold + gap);
    out.push(v);
  }
  out[TICKS - 1] = w.to;
  return out;
}

const clock = (i: number) => {
  const s = 14 * 3600 + 2 * 60 + 7 + i * 4;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function Prompt({ s, shown, lit }: { s: Scenario; shown: number; lit: number }) {
  // Split the typed text into plain runs and the phrases that have become rules.
  const text = s.prompt.slice(0, shown);
  const marks = s.parts.map((p, i) => ({ ...p, at: s.prompt.indexOf(p.phrase), on: i < lit })).sort((a, b) => a.at - b.at);
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.at >= text.length) break;
    if (m.at > pos) out.push(<span key={`t${pos}`}>{text.slice(pos, m.at)}</span>);
    const end = Math.min(text.length, m.at + m.phrase.length);
    const tint = `color-mix(in oklab, ${TONE[m.tone]} 26%, transparent)`;
    out.push(
      <span
        key={m.phrase}
        className="rounded-[3px] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
        style={{
          backgroundImage: `linear-gradient(${tint}, ${tint})`,
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

function Diagram({ s, on, met }: { s: Scenario; on: number; met: boolean }) {
  // Two conditions feed one rule, which feeds the trade.
  const node = (x: number, y: number, w: number, [label, sub]: [string, string], color: string, i: number, done = false) => (
    <motion.g key={`${label}-${i}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: on > i ? 1 : 0, y: on > i ? 0 : 6 }} transition={{ duration: 0.4 }}>
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
  const actionTone = s.parts[0]!.tone === "short" ? "var(--short)" : "var(--long)";
  const sigs = s.diagram.signals;
  const n = sigs.length;
  const H = n * 68 - 4;
  const mid = H / 2;
  const rowY = (i: number) => 10 + i * 68 - (n > 2 ? 10 : 0);
  return (
    <svg viewBox={`0 0 520 ${H}`} className="h-auto w-full" aria-label={`${sigs.map((x) => x[0]).join(", ")} feed one rule, which opens: ${s.diagram.action[0]}`}>
      {sigs.map((_, i) => edge(`M150 ${rowY(i) + 22} C185 ${rowY(i) + 22} 185 ${mid} 216 ${mid}`, n))}
      {edge(`M330 ${mid} L366 ${mid}`, n + 1)}
      {sigs.map((sg, i) => node(4, rowY(i), 146, sg, "var(--signal)", i))}
      {node(216, mid - 22, 114, [n === 2 ? "Both true" : `All ${n} true`, "check every 15 s"], "var(--trigger)", n, met)}
      {node(366, mid - 22, 150, s.diagram.action, actionTone, n + 1, met)}
    </svg>
  );
}

export function AgentDemo() {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { rootMargin: "-15% 0px" });
  const reduce = useReducedMotion();
  const [t, setT] = useState(0);
  const [k, setK] = useState(0);

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
        // On to the next strategy.
        start = now;
        el = 0;
        setK((i) => (i + 1) % SCENARIOS.length);
      }
      setT(el);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, reduce]);

  const s = SCENARIOS[k]!;
  const w = s.watch;
  const ticksSeries = useMemo(() => series(w), [w]);
  const shown = Math.min(s.prompt.length, Math.floor((t / TYPE_MS) * s.prompt.length));
  const sent = t >= T.sent;
  const lit = t < T.rules ? 0 : Math.min(s.parts.length, 1 + Math.floor((t - T.rules) / 500));
  const diagramOn = t < T.diagram ? 0 : Math.min(s.diagram.signals.length + 2, 1 + Math.floor((t - T.diagram) / 350));
  const watching = t >= T.watch;
  const met = t >= T.met;
  const filled = t >= T.filled;
  // How many ticks the agent has checked so far.
  const ticks = !watching ? 0 : Math.min(TICKS, 1 + Math.floor(((t - T.watch) / (T.met - T.watch)) * (TICKS - 1)));
  const now = ticksSeries[Math.max(0, ticks - 1)] ?? ticksSeries[0]!;
  const crossed = (v: number) => (w.dir === "above" ? v > w.threshold : v < w.threshold);
  const ok = crossed(now);

  // Chart geometry.
  const W = 520;
  const H = 120;
  const vals = [...ticksSeries, w.threshold];
  const pad = (Math.max(...vals) - Math.min(...vals)) * 0.15;
  const lo = Math.min(...vals) - pad;
  const hi = Math.max(...vals) + pad;
  const x = (i: number) => (i / (TICKS - 1)) * (W - 8) + 4;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * (H - 10) - 5;
  const path = ticksSeries
    .slice(0, Math.max(1, ticks))
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const log = Array.from({ length: ticks }, (_, i) => i)
    .filter((i) => i % 6 === 5 || i === ticks - 1)
    .slice(-4)
    .reverse();
  const verb = s.parts[0]!.tone === "short" ? "shorting" : "buying";

  const status = filled ? "Order filled" : met ? "Rule met" : watching ? "Watching the market" : sent ? "Drafting your rules" : "Your idea";

  return (
    <Section
      id="demo"
      title="Say it once. Weft watches the market for you."
      lead="Type the trade the way you’d say it, with one condition or five: a price, a post on X, a wallet, the mood of the market. Each part becomes a rule. Weft checks them every 15 to 30 seconds, day and night, and places the order once all of them hold."
    >
      <div ref={box} className="mt-12 overflow-hidden rounded-[18px] border border-line bg-card shadow-window">
        {/* Window bar */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
          <span className="flex items-center gap-3 text-[13px] text-muted">
            New strategy
            <span className="flex items-center gap-1.5" aria-label={`Example ${k + 1} of ${SCENARIOS.length}`}>
              {SCENARIOS.map((_, i) => (
                <span key={i} className="h-1.5 w-1.5 rounded-full transition-colors" style={{ background: i === k ? "var(--ink)" : "var(--line-2)" }} />
              ))}
            </span>
          </span>
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
                <Prompt s={s} shown={shown} lit={lit} />
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
                {s.parts.map((p, i) => (
                  <motion.li
                    key={`${k}-${p.rule}`}
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
              <p className="text-[12px] text-muted">How it trades · {s.venue}</p>
              <div className="mt-2">
                <Diagram key={k} s={s} on={diagramOn} met={met} />
              </div>
            </div>

            <div className={`transition-opacity duration-500 ${watching ? "opacity-100" : "opacity-30"}`}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12px] text-muted">Watching {w.name} · {ticks ? `${(ticks * 4).toLocaleString("en-US")} checks` : "starts when you press start"}</p>
                <span className="tnum text-[13px]">
                  <span className={ok ? "text-long" : "text-ink"}>{w.fmt(now)}</span>
                  <span className="text-faint"> · </span>
                  <span className="text-long">{s.also.map((a) => a.label).join(" · ")}</span>
                </span>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-auto w-full" aria-label={`${w.name} moving toward ${w.fmt(w.threshold)}, then crossing it`}>
                <line x1={0} x2={W} y1={y(w.threshold)} y2={y(w.threshold)} strokeDasharray="4 6" strokeWidth={1.2} style={{ stroke: met ? "var(--long)" : "var(--trigger)" }} />
                <text x={W - 4} y={y(w.threshold) + (w.dir === "above" ? -6 : 14)} textAnchor="end" fontSize={11} style={{ fill: met ? "var(--long)" : "var(--trigger)" }}>
                  {w.fmt(w.threshold)}
                </text>
                {ticks > 0 && <path d={path} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: ok ? "var(--long)" : "var(--signal)" }} />}
                {ticks > 0 && <circle cx={x(ticks - 1)} cy={y(now)} r={3.6} style={{ fill: ok ? "var(--long)" : "var(--signal)" }} />}
              </svg>
              <ul className="mt-2 min-h-[82px] space-y-1 font-mono text-[11.5px]">
                {log.map((i) => {
                  const v = ticksSeries[i]!;
                  const hit = crossed(v);
                  return (
                    <li key={i} className="flex gap-3 text-muted">
                      <span className="text-faint">{clock(i)}</span>
                      <span className={hit ? "text-long" : "text-ink-2"}>
                        {w.name} {w.fmt(v)} {hit ? "✓" : "✗"}
                      </span>
                      <span className="text-long">{s.also.map((a) => `${a.value} ✓`).join(" ")}</span>
                      <span className={hit ? "text-long" : ""}>{hit ? `rule met → ${verb}` : "waiting"}</span>
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
              key={`${k}-${filled ? "filled" : met ? "met" : watching ? "waiting" : "idle"}`}
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
                    <div className="text-[15px] font-medium text-ink">{s.filled[0]}</div>
                    <div className="text-[13px] text-muted">{s.filled[1]}</div>
                  </div>
                </>
              ) : (
                <>
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-paper-2">
                    <span className={`h-2 w-2 rounded-full ${watching ? "animate-pulse" : ""}`} style={{ background: watching ? "var(--signal)" : "var(--muted)" }} />
                  </span>
                  <div>
                    <div className="text-[15px] font-medium text-ink">{watching ? (met ? (s.diagram.signals.length === 2 ? "Both conditions true" : `All ${s.diagram.signals.length} conditions true`) : `Waiting: ${s.diagram.signals.length - 1} of ${s.diagram.signals.length} conditions true`) : "No trade yet"}</div>
                    <div className="text-[13px] text-muted">{met ? s.met : watching ? s.waiting : "Nothing trades until every rule is true."}</div>
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
